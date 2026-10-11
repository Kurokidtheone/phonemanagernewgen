//! Wire format shared by the desktop, the phone and the tests.
//!
//! A request or response is JSON, sealed with XChaCha20-Poly1305. The mailbox
//! name and the device id are bound in as associated data, so a message cannot
//! be replayed in another mailbox or for another device. Sealed messages longer
//! than [`MAX_PART_CHARS`] are split into numbered parts and joined on arrival.

use std::collections::HashMap;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Longest single mailbox body, in characters.
pub const MAX_PART_CHARS: usize = 300_000;
/// Longest whole message (sealed text), in characters.
pub const MAX_MESSAGE_CHARS: usize = 6 * 1024 * 1024;
/// Length of a mailbox name: 32 bytes as unpadded base64url.
pub const MAILBOX_LEN: usize = 43;
const MAX_PARTS: usize = MAX_MESSAGE_CHARS / MAX_PART_CHARS + 1;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("bad_key")]
    BadKey,
    #[error("bad_mailbox")]
    BadMailbox,
    #[error("cannot_open")]
    CannotOpen,
    #[error("bad_message")]
    BadMessage,
    #[error("message_too_large")]
    TooLarge,
}

pub type Result<T> = std::result::Result<T, WireError>;

pub type Key = [u8; 32];

fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).expect("system random source");
    b
}

/// 32 random key bytes.
pub fn new_key() -> Key {
    random::<32>()
}

/// A mailbox name: 32 random bytes, base64url without padding (43 characters).
pub fn new_mailbox() -> String {
    B64.encode(random::<32>())
}

pub fn is_mailbox(s: &str) -> bool {
    s.len() == MAILBOX_LEN
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

pub fn key_to_string(k: &Key) -> String {
    B64.encode(k)
}

pub fn key_from_string(s: &str) -> Result<Key> {
    let v = B64.decode(s).map_err(|_| WireError::BadKey)?;
    v.try_into().map_err(|_| WireError::BadKey)
}

/// A sealed message: `n` is the nonce, `c` the ciphertext, both base64url.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sealed {
    pub n: String,
    pub c: String,
}

fn aad(mailbox: &str, device_id: &str) -> Vec<u8> {
    let mut a = Vec::with_capacity(mailbox.len() + device_id.len() + 1);
    a.extend_from_slice(mailbox.as_bytes());
    a.push(0);
    a.extend_from_slice(device_id.as_bytes());
    a
}

pub fn seal(key: &Key, mailbox: &str, device_id: &str, plain: &[u8]) -> Result<Sealed> {
    if !is_mailbox(mailbox) {
        return Err(WireError::BadMailbox);
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = random::<24>();
    let c = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &aad(mailbox, device_id),
            },
        )
        .map_err(|_| WireError::CannotOpen)?;
    Ok(Sealed {
        n: B64.encode(nonce),
        c: B64.encode(c),
    })
}

pub fn open(key: &Key, mailbox: &str, device_id: &str, sealed: &Sealed) -> Result<Vec<u8>> {
    let nonce = B64.decode(&sealed.n).map_err(|_| WireError::CannotOpen)?;
    if nonce.len() != 24 {
        return Err(WireError::CannotOpen);
    }
    let c = B64.decode(&sealed.c).map_err(|_| WireError::CannotOpen)?;
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &c,
                aad: &aad(mailbox, device_id),
            },
        )
        .map_err(|_| WireError::CannotOpen)
}

/// The plain request sent by the phone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub id: String,
    /// Unix milliseconds on the phone.
    pub ts: i64,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub body: Value,
}

/// The plain response sent by the PC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Response {
    pub id: String,
    pub status: u16,
    #[serde(default)]
    pub body: Value,
}

/// One numbered part of a split message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub id: String,
    pub i: usize,
    pub of: usize,
    pub part: String,
}

/// Turns a sealed message into the mailbox bodies to send: one body when it
/// fits, otherwise numbered parts. `id` ties the parts together (use the
/// request id).
pub fn pack(id: &str, sealed: &Sealed) -> Result<Vec<String>> {
    let whole = serde_json::to_string(sealed).map_err(|_| WireError::BadMessage)?;
    if whole.len() > MAX_MESSAGE_CHARS {
        return Err(WireError::TooLarge);
    }
    if whole.len() <= MAX_PART_CHARS {
        return Ok(vec![whole]);
    }
    // Part bodies carry the id and counters as well, so leave room for them.
    let chunk = MAX_PART_CHARS - 200;
    let pieces: Vec<&str> = whole
        .as_bytes()
        .chunks(chunk)
        .map(|c| std::str::from_utf8(c).expect("sealed json is ascii"))
        .collect();
    let of = pieces.len();
    pieces
        .iter()
        .enumerate()
        .map(|(i, p)| {
            serde_json::to_string(&Part {
                id: id.to_string(),
                i: i + 1,
                of,
                part: (*p).to_string(),
            })
            .map_err(|_| WireError::BadMessage)
        })
        .collect()
}

/// Joins mailbox bodies back into sealed messages. Keep one per mailbox
/// direction. A body that is a whole message is returned at once; parts are
/// held until the last one arrives, in any order.
#[derive(Debug, Default)]
pub struct Assembler {
    partial: HashMap<String, (usize, HashMap<usize, String>)>,
}

impl Assembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `Some((id, sealed))` when a message is complete. `id` is the
    /// part id for split messages and `None` inside for whole ones.
    pub fn push(&mut self, body: &str) -> Result<Option<(Option<String>, Sealed)>> {
        if body.len() > MAX_PART_CHARS {
            return Err(WireError::TooLarge);
        }
        if let Ok(p) = serde_json::from_str::<Part>(body) {
            if p.of == 0 || p.of > MAX_PARTS || p.i == 0 || p.i > p.of {
                return Err(WireError::BadMessage);
            }
            let entry = self
                .partial
                .entry(p.id.clone())
                .or_insert_with(|| (p.of, HashMap::new()));
            if entry.0 != p.of {
                self.partial.remove(&p.id);
                return Err(WireError::BadMessage);
            }
            entry.1.insert(p.i, p.part);
            if entry.1.len() < entry.0 {
                return Ok(None);
            }
            let (of, mut parts) = self.partial.remove(&p.id).expect("present");
            let mut whole = String::new();
            for i in 1..=of {
                whole.push_str(&parts.remove(&i).ok_or(WireError::BadMessage)?);
                if whole.len() > MAX_MESSAGE_CHARS {
                    return Err(WireError::TooLarge);
                }
            }
            let sealed: Sealed = serde_json::from_str(&whole).map_err(|_| WireError::BadMessage)?;
            return Ok(Some((Some(p.id), sealed)));
        }
        let sealed: Sealed = serde_json::from_str(body).map_err(|_| WireError::BadMessage)?;
        Ok(Some((None, sealed)))
    }

    /// Forget half-received messages (call now and then so they cannot pile up).
    pub fn clear(&mut self) {
        self.partial.clear();
    }

    pub fn pending(&self) -> usize {
        self.partial.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "device-1";

    fn setup() -> (Key, String) {
        (new_key(), new_mailbox())
    }

    #[test]
    fn mailbox_shape() {
        let m = new_mailbox();
        assert_eq!(m.len(), 43);
        assert!(is_mailbox(&m));
        assert!(!is_mailbox("short"));
        assert!(!is_mailbox(&format!("{}!", &m[..42])));
    }

    #[test]
    fn round_trip() {
        let (k, m) = setup();
        let req = Request {
            id: "a".into(),
            ts: 1,
            method: "POST".into(),
            path: "/api".into(),
            body: serde_json::json!({"x": "é"}),
        };
        let s = seal(&k, &m, DEV, &serde_json::to_vec(&req).unwrap()).unwrap();
        let back: Request = serde_json::from_slice(&open(&k, &m, DEV, &s).unwrap()).unwrap();
        assert_eq!(back, req);
    }

    #[test]
    fn nonce_is_fresh() {
        let (k, m) = setup();
        let a = seal(&k, &m, DEV, b"same").unwrap();
        let b = seal(&k, &m, DEV, b"same").unwrap();
        assert_ne!(a.n, b.n);
        assert_ne!(a.c, b.c);
    }

    #[test]
    fn wrong_key_fails() {
        let (k, m) = setup();
        let s = seal(&k, &m, DEV, b"hi").unwrap();
        assert_eq!(open(&new_key(), &m, DEV, &s), Err(WireError::CannotOpen));
    }

    #[test]
    fn changed_associated_data_fails() {
        let (k, m) = setup();
        let s = seal(&k, &m, DEV, b"hi").unwrap();
        assert!(open(&k, &new_mailbox(), DEV, &s).is_err());
        assert!(open(&k, &m, "device-2", &s).is_err());
    }

    #[test]
    fn flipped_byte_fails() {
        let (k, m) = setup();
        let s = seal(&k, &m, DEV, b"hello world").unwrap();
        let mut c = B64.decode(&s.c).unwrap();
        c[0] ^= 1;
        assert!(open(
            &k,
            &m,
            DEV,
            &Sealed {
                n: s.n.clone(),
                c: B64.encode(&c)
            }
        )
        .is_err());
        let mut n = B64.decode(&s.n).unwrap();
        n[3] ^= 1;
        assert!(open(
            &k,
            &m,
            DEV,
            &Sealed {
                n: B64.encode(&n),
                c: s.c
            }
        )
        .is_err());
    }

    #[test]
    fn small_message_is_one_body() {
        let (k, m) = setup();
        let s = seal(&k, &m, DEV, b"small").unwrap();
        let bodies = pack("id", &s).unwrap();
        assert_eq!(bodies.len(), 1);
        let mut a = Assembler::new();
        assert_eq!(a.push(&bodies[0]).unwrap(), Some((None, s)));
    }

    #[test]
    fn two_megabytes_survive_splitting_in_any_order() {
        let (k, m) = setup();
        let plain: Vec<u8> = (0..2_000_000u32).map(|i| (i % 251) as u8).collect();
        let s = seal(&k, &m, DEV, &plain).unwrap();
        let mut bodies = pack("big", &s).unwrap();
        assert!(bodies.len() > 5);
        assert!(bodies.iter().all(|b| b.len() <= MAX_PART_CHARS));
        bodies.reverse();
        let mut a = Assembler::new();
        let mut done = None;
        for b in &bodies {
            if let Some(x) = a.push(b).unwrap() {
                done = Some(x);
            }
        }
        let (id, sealed) = done.expect("joined");
        assert_eq!(id.as_deref(), Some("big"));
        assert_eq!(open(&k, &m, DEV, &sealed).unwrap(), plain);
        assert_eq!(a.pending(), 0);
    }

    #[test]
    fn over_six_megabytes_is_refused() {
        let (k, m) = setup();
        let s = seal(&k, &m, DEV, &vec![7u8; 5_000_000]).unwrap();
        assert_eq!(pack("x", &s), Err(WireError::TooLarge));
    }

    #[test]
    fn bad_parts_are_rejected() {
        let mut a = Assembler::new();
        let p = |i, of| {
            serde_json::to_string(&Part {
                id: "q".into(),
                i,
                of,
                part: "x".into(),
            })
            .unwrap()
        };
        assert!(a.push(&p(0, 2)).is_err());
        assert!(a.push(&p(3, 2)).is_err());
        assert!(a.push(&p(1, 500)).is_err());
        assert!(a.push("not json").is_err());
    }
}

#[cfg(test)]
mod vector_tests {
    use super::*;

    /// Messages sealed by the Rust crate and by the TypeScript copy (src/shared/remote/wire.ts) must open here.
    #[test]
    fn opens_the_shared_vectors() {
        let v: serde_json::Value = serde_json::from_str(include_str!("../vectors.json")).unwrap();
        for name in ["from_rust", "from_ts"] {
            let e = &v[name];
            let key = key_from_string(e["key"].as_str().unwrap()).unwrap();
            let sealed: Sealed = serde_json::from_value(e["sealed"].clone()).unwrap();
            let plain = open(
                &key,
                e["mailbox"].as_str().unwrap(),
                e["device"].as_str().unwrap(),
                &sealed,
            )
            .unwrap();
            assert_eq!(
                std::str::from_utf8(&plain).unwrap(),
                e["plain"].as_str().unwrap(),
                "{name}"
            );
        }
    }
}

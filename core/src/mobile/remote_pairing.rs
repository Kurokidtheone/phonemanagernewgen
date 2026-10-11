// Linking a phone that is not on the shop Wi-Fi. The PC shows a one-time code with 80 random bits. Both sides turn it
// into a private pairing mailbox name and key (HKDF-SHA256), so the code itself is never sent anywhere. One at a time,
// valid 10 minutes, used up by the first phone that completes it. Memory only.
use crate::util::{ms_to_iso, now_ms};
use base64::Engine;
use rand::RngCore;
use sha2::Sha256;
use std::sync::Mutex;

pub const REMOTE_CODE_TTL_MS: i64 = 10 * 60_000;
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
pub const PAIR_CODE_LENGTH: usize = 16;
/// The device id bound into pairing messages (a real device id is a UUID, so it cannot collide).
pub const PAIRING_DEVICE_ID: &str = "pairing";

/// 16 characters from a 32-letter alphabet: 80 bits.
pub fn new_pair_code() -> String {
    let mut b = [0u8; PAIR_CODE_LENGTH];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| ALPHABET[(*x % 32) as usize] as char).collect()
}

/// XXXX-XXXX-XXXX-XXXX
pub fn format_pair_code(code: &str) -> String {
    code.as_bytes().chunks(4).map(|c| String::from_utf8_lossy(c).into_owned()).collect::<Vec<_>>().join("-")
}

fn derive(code: &str, info: &str) -> String {
    let hk = hkdf::Hkdf::<Sha256>::new(Some(b"psm-remote-pair-v1"), code.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(info.as_bytes(), &mut out).expect("hkdf length");
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(out)
}

/// The private mailbox name and key for a code.
pub fn pairing_channel(code: &str) -> (String, String) {
    (derive(code, "mailbox"), derive(code, "key"))
}

struct Pending {
    mailbox: String,
    key: String,
    expires_at: i64,
    used: bool,
    paired_device_id: Option<String>,
}

#[derive(Default)]
pub struct RemotePairing {
    pending: Mutex<Option<Pending>>,
}

row! { pub struct RemoteCode { pub code: String, pub expires_at: String } }

impl RemotePairing {
    /// Starts a new code (the old one stops working). The code is shown to the owner once.
    pub fn start(&self) -> RemoteCode {
        let code = new_pair_code();
        let (mailbox, key) = pairing_channel(&code);
        let expires_at = now_ms() + REMOTE_CODE_TTL_MS;
        *self.pending.lock().unwrap() = Some(Pending { mailbox, key, expires_at, used: false, paired_device_id: None });
        RemoteCode { code: format_pair_code(&code), expires_at: ms_to_iso(expires_at) }
    }

    /// The private mailbox to listen to while a code is valid and unused: (mailbox, key).
    pub fn active(&self) -> Option<(String, String)> {
        let p = self.pending.lock().unwrap();
        p.as_ref().filter(|p| !p.used && now_ms() < p.expires_at).map(|p| (p.mailbox.clone(), p.key.clone()))
    }

    pub fn status(&self) -> super::pairing::PairingStatus {
        let active = self.active().is_some();
        let p = self.pending.lock().unwrap();
        match p.as_ref() {
            None => super::pairing::PairingStatus { active: false, expires_at: None, paired_device_id: None },
            Some(p) => super::pairing::PairingStatus { active, expires_at: Some(ms_to_iso(p.expires_at)), paired_device_id: p.paired_device_id.clone() },
        }
    }

    /// The first phone to finish uses the code up.
    pub fn use_up(&self, device_id: &str) {
        if let Some(p) = self.pending.lock().unwrap().as_mut() {
            p.used = true;
            p.paired_device_id = Some(device_id.to_owned());
        }
    }

    pub fn cancel(&self) {
        *self.pending.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes() {
        let c = new_pair_code();
        assert_eq!(c.len(), 16);
        assert_eq!(format_pair_code("ABCDEFGHIJKLMNOP"), "ABCD-EFGH-IJKL-MNOP");
        let (m, k) = pairing_channel("ABCDEFGHIJKLMNOP");
        assert_eq!(m.len(), 43);
        assert_ne!(m, k);
    }
}

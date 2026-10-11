// The pairing code: 6 digits, memory only, valid 2 minutes, single use.
// Five wrong codes block pairing for five minutes, whoever sends them.
use crate::error::{app, app_with, Res};
use crate::util::{ms_to_iso, now_ms};
use rand::Rng;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

pub const CODE_TTL_MS: i64 = 2 * 60_000;
const MAX_WRONG: u32 = 5;
const BLOCK_MS: i64 = 5 * 60_000;

struct Pending {
    code: Option<String>, // None once used
    expires_at: i64,
    paired_device_id: Option<String>,
}

#[derive(Default)]
struct State {
    pending: Option<Pending>,
    wrong: u32,
    blocked_until: i64,
}

#[derive(Default)]
pub struct Pairing {
    state: Mutex<State>,
    /// Tests move time with this offset.
    pub clock_offset_ms: std::sync::atomic::AtomicI64,
}

row! { pub struct NewCode { pub code: String, pub expires_at: String } }
row! { pub struct PairingStatus { pub active: bool, pub expires_at: Option<String>, pub paired_device_id: Option<String> } }

impl Pairing {
    fn now(&self) -> i64 {
        now_ms() + self.clock_offset_ms.load(std::sync::atomic::Ordering::Relaxed)
    }

    pub fn new_code(&self) -> NewCode {
        let code = format!("{:06}", rand::thread_rng().gen_range(0..1_000_000));
        let expires_at = self.now() + CODE_TTL_MS;
        self.state.lock().unwrap().pending = Some(Pending { code: Some(code.clone()), expires_at, paired_device_id: None });
        NewCode { code, expires_at: ms_to_iso(expires_at) }
    }

    pub fn status(&self) -> PairingStatus {
        let s = self.state.lock().unwrap();
        match &s.pending {
            None => PairingStatus { active: false, expires_at: None, paired_device_id: None },
            Some(p) => PairingStatus {
                active: p.code.is_some() && self.now() < p.expires_at,
                expires_at: Some(ms_to_iso(p.expires_at)),
                paired_device_id: p.paired_device_id.clone(),
            },
        }
    }

    /// Checks the code and uses it up. Fails with invalid_code, code_expired or pairing_blocked.
    pub fn consume(&self, code: &str) -> Res<()> {
        let mut s = self.state.lock().unwrap();
        let now = self.now();
        if now < s.blocked_until {
            return Err(app_with("pairing_blocked", [("seconds", ((s.blocked_until - now + 999) / 1000).into())]));
        }
        let fail = |s: &mut State, code: &str| {
            s.wrong += 1;
            if s.wrong >= MAX_WRONG {
                s.wrong = 0;
                s.blocked_until = now + BLOCK_MS;
            }
            app(code)
        };
        let expected = match &s.pending {
            Some(Pending { code: Some(c), .. }) => c.clone(),
            _ => return Err(fail(&mut s, "invalid_code")),
        };
        let mut padded: Vec<u8> = code.bytes().chain(std::iter::repeat(b' ')).take(6).collect();
        padded.truncate(6);
        if code.len() != 6 || !bool::from(padded.ct_eq(expected.as_bytes())) {
            return Err(fail(&mut s, "invalid_code"));
        }
        if now >= s.pending.as_ref().unwrap().expires_at {
            s.pending = None;
            return Err(fail(&mut s, "code_expired"));
        }
        s.pending.as_mut().unwrap().code = None;
        s.wrong = 0;
        Ok(())
    }

    pub fn mark_paired(&self, device_id: &str) {
        if let Some(p) = self.state.lock().unwrap().pending.as_mut() {
            p.paired_device_id = Some(device_id.to_owned());
        }
    }

    pub fn cancel(&self) {
        self.state.lock().unwrap().pending = None;
    }

    pub fn reset(&self) {
        *self.state.lock().unwrap() = State::default();
    }
}

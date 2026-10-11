// Manager password, recovery code, protected sections.
// The unlocked state lives only in memory: closing the app locks everything again.
use super::codes::LOCKABLE_SECTIONS;
use super::settings::{delete_value, get_value, set_value};
use crate::core::Ctx;
use crate::error::{app, app_with, bail, Res};
use rand::RngCore;
use serde::Serialize;
use subtle::ConstantTimeEq;

const HASH_KEY: &str = "auth.passwordHash";
const RECOVERY_KEY: &str = "auth.recoveryHash";
const PROTECTED_KEY: &str = "auth.protected";
const MAX_ATTEMPTS: u32 = 5;
const DELAY_MS: i64 = 30_000;

/// Node's scryptSync defaults: N = 16384, r = 8, p = 1.
fn scrypt(secret: &str, salt: &[u8], len: usize) -> Vec<u8> {
    let params = scrypt::Params::new(14, 8, 1, len).expect("scrypt params");
    let mut out = vec![0u8; len];
    scrypt::scrypt(secret.as_bytes(), salt, &params, &mut out).expect("scrypt");
    out
}

fn hash(secret: &str) -> String {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    format!("{}:{}", hex::encode(salt), hex::encode(scrypt(secret, &salt, 32)))
}

fn matches(secret: &str, stored: Option<String>) -> bool {
    let Some(stored) = stored else { return false };
    let Some((salt_hex, hash_hex)) = stored.split_once(':') else { return false };
    let (Ok(salt), Ok(expected)) = (hex::decode(salt_hex), hex::decode(hash_hex)) else { return false };
    if expected.is_empty() {
        return false;
    }
    let actual = scrypt(secret, &salt, expected.len());
    actual.ct_eq(&expected).into()
}

fn normalize_recovery(code: &str) -> String {
    code.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect()
}

fn make_recovery_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let chars: Vec<char> = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

fn issue_recovery_code(ctx: &Ctx) -> Res<String> {
    let code = make_recovery_code();
    set_value(ctx.db, RECOVERY_KEY, &hash(&normalize_recovery(&code)))?;
    Ok(code)
}

fn guard_attempts(ctx: &Ctx) -> Res<()> {
    let state = ctx.core.auth.lock().unwrap();
    let now = ctx.now_ms();
    if now < state.blocked_until_ms {
        let seconds = (state.blocked_until_ms - now + 999) / 1000;
        return Err(app_with("too_many_attempts", [("seconds", seconds.into())]));
    }
    Ok(())
}

fn record_failure(ctx: &Ctx, code: &str) -> crate::error::Error {
    let mut state = ctx.core.auth.lock().unwrap();
    state.failed_attempts += 1;
    if state.failed_attempts >= MAX_ATTEMPTS {
        state.failed_attempts = 0;
        state.blocked_until_ms = ctx.now_ms() + DELAY_MS;
    }
    app(code)
}

fn reset_failures(ctx: &Ctx) {
    ctx.core.auth.lock().unwrap().failed_attempts = 0;
}

fn set_unlocked(ctx: &Ctx, value: bool) {
    ctx.core.auth.lock().unwrap().unlocked = value;
}

fn require_password(ctx: &Ctx, password: &str) -> Res<()> {
    guard_attempts(ctx)?;
    if !matches(password, get_value(ctx.db, HASH_KEY)?) {
        return Err(record_failure(ctx, "wrong_password"));
    }
    reset_failures(ctx);
    Ok(())
}

pub fn has_password(ctx: &Ctx) -> Res<bool> {
    Ok(get_value::<String>(ctx.db, HASH_KEY)?.is_some())
}

pub fn protected_sections(ctx: &Ctx) -> Res<Vec<String>> {
    let stored: Vec<String> = get_value(ctx.db, PROTECTED_KEY)?.unwrap_or_default();
    Ok(stored.into_iter().filter(|s| LOCKABLE_SECTIONS.contains(&s.as_str())).collect())
}

row! {
    pub struct AuthStatus {
        pub has_password: bool,
        pub unlocked: bool,
        #[ts(type = "SectionId[]")]
        pub protected_sections: Vec<String>,
    }
}

pub fn status(ctx: &Ctx) -> Res<AuthStatus> {
    Ok(AuthStatus { has_password: has_password(ctx)?, unlocked: ctx.core.auth.lock().unwrap().unlocked, protected_sections: protected_sections(ctx)? })
}

/// True when a handler of this section must be refused right now.
pub fn is_locked(ctx: &Ctx, section: &str) -> Res<bool> {
    if !has_password(ctx)? || ctx.core.auth.lock().unwrap().unlocked {
        return Ok(false);
    }
    Ok(protected_sections(ctx)?.iter().any(|s| s == section))
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct RecoveryCode {
    pub recovery_code: String,
}

/// First-time setup. Returns the recovery code, which is shown once and never stored in clear.
pub fn set_password(ctx: &Ctx, password: &str) -> Res<RecoveryCode> {
    if has_password(ctx)? {
        bail!("password_already_set");
    }
    set_value(ctx.db, HASH_KEY, &hash(password))?;
    set_unlocked(ctx, true);
    Ok(RecoveryCode { recovery_code: issue_recovery_code(ctx)? })
}

pub fn change_password(ctx: &Ctx, current: &str, next: &str) -> Res<()> {
    require_password(ctx, current)?;
    set_value(ctx.db, HASH_KEY, &hash(next))
}

pub fn remove_password(ctx: &Ctx, current: &str) -> Res<()> {
    require_password(ctx, current)?;
    for key in [HASH_KEY, RECOVERY_KEY, PROTECTED_KEY] {
        delete_value(ctx.db, key)?;
    }
    set_unlocked(ctx, false);
    Ok(())
}

pub fn new_recovery_code(ctx: &Ctx, current: &str) -> Res<RecoveryCode> {
    require_password(ctx, current)?;
    Ok(RecoveryCode { recovery_code: issue_recovery_code(ctx)? })
}

pub fn unlock(ctx: &Ctx, password: &str) -> Res<()> {
    require_password(ctx, password)?;
    set_unlocked(ctx, true);
    Ok(())
}

/// For one-off overrides (a price below the minimum): the manager types the password again, even when
/// unlocked. With no password configured nobody can type one, so the override is allowed.
pub fn confirm_manager(ctx: &Ctx, password: Option<&str>) -> Res<()> {
    if !has_password(ctx)? {
        return Ok(());
    }
    match password {
        None | Some("") => bail!("manager_password_required"),
        Some(p) => require_password(ctx, p),
    }
}

pub fn lock(ctx: &Ctx) -> Res<()> {
    set_unlocked(ctx, false);
    Ok(())
}

/// Forgotten password: the recovery code sets a new password and issues a new code.
pub fn reset_with_recovery(ctx: &Ctx, code: &str, next: &str) -> Res<RecoveryCode> {
    guard_attempts(ctx)?;
    if !matches(&normalize_recovery(code), get_value(ctx.db, RECOVERY_KEY)?) {
        return Err(record_failure(ctx, "wrong_recovery_code"));
    }
    reset_failures(ctx);
    set_value(ctx.db, HASH_KEY, &hash(next))?;
    set_unlocked(ctx, true);
    Ok(RecoveryCode { recovery_code: issue_recovery_code(ctx)? })
}

pub fn set_protected_sections(ctx: &Ctx, sections: &[String]) -> Res<()> {
    if !has_password(ctx)? {
        bail!("password_required_first");
    }
    if !ctx.core.auth.lock().unwrap().unlocked {
        bail!("locked");
    }
    let keep: Vec<&String> = sections.iter().filter(|s| LOCKABLE_SECTIONS.contains(&s.as_str())).collect();
    set_value(ctx.db, PROTECTED_KEY, &keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_compatible_hash() {
        // Made by Node: `${salt}:${scryptSync('1234', salt, 32)}` with salt = 16 bytes of 7.
        let node = "07070707070707070707070707070707:4f2df7f7a43b518f33f7f88102cae53c3ca8474e8cc36fd72c9ae5d3c19ff5a2";
        assert!(matches("1234", Some(node.to_owned())));
        let h = hash("1234");
        assert!(matches("1234", Some(h.clone())));
        assert!(!matches("12345", Some(h)));
        let code = make_recovery_code();
        assert_eq!(code.len(), 19);
    }
}

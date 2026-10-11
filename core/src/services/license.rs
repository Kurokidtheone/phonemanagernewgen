// Offline, device-bound license. Key format (shared with tools/license-desk.html and tools/license-tool.mjs):
//   key = base32( signature[64 bytes] + UTF-8 JSON payload ), in groups of 5
//   payload = { p: product code, d: device id, n: customer, e: edition, i: issued date }
// The Ed25519 signature covers the payload bytes exactly as they appear in the key.
use super::settings::{get_value, set_value};
use crate::core::Ctx;
use crate::error::{app, Res};
use crate::util::DAY_MS;
use ed25519_dalek::pkcs8::DecodePublicKey;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Written by `npm run license:init`. This is the only key the app trusts.
pub const LICENSE_PUBLIC_KEY: &str = include_str!("../../../license-keys/license-public.pem");
pub const PRODUCT_CODE: &str = "PSM";
pub const TRIAL_DAYS: i64 = 14;

const KEY: &str = "license.key";
const TRIAL_START: &str = "license.trialStart";
const LAST_SEEN: &str = "license.lastSeen";
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const SIGNATURE_LENGTH: usize = 64;

/// The machine id node-machine-id returned (raw, lower case), so device ids and sold keys stay the same.
#[cfg(not(target_os = "android"))]
pub fn system_machine_id() -> String {
    machine_uid::get().map(|s| s.trim().to_lowercase()).unwrap_or_default()
}

/// On Android the shell supplies it (Settings.Secure.ANDROID_ID, see `Core::set_machine_id`).
#[cfg(target_os = "android")]
pub fn system_machine_id() -> String {
    String::new()
}

/// Which product a license is for: the PC with up to three phones, or one phone on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Edition {
    #[default]
    Shop,
    Phone,
}

impl Edition {
    pub fn as_str(self) -> &'static str {
        match self {
            Edition::Shop => "shop",
            Edition::Phone => "phone",
        }
    }
}

/// How many phones a shop edition can pair (besides the PC itself).
pub const MAX_PAIRED_DEVICES: i64 = 3;

/// THE place that reads an edition. A key says "phone" or "shop"; anything else, including the old "lifetime" and
/// "lifetime+mobile3", counts as shop.
pub fn edition_of(text: &str) -> Edition {
    let phone = text.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "phone");
    if phone {
        Edition::Phone
    } else {
        Edition::Shop
    }
}

/// The edition of the active license: None while there is none (trial, expired).
pub fn edition(ctx: &Ctx) -> Res<Option<Edition>> {
    let s = status(ctx)?;
    Ok(if s.state == "licensed" { s.edition.as_deref().map(edition_of) } else { None })
}

pub fn base32_encode(bytes: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for &b in bytes {
        value = ((value << 8) | b as u32) & 0xffff;
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let (mut bits, mut value, mut out) = (0u32, 0u32, Vec::new());
    for ch in text.bytes() {
        let index = ALPHABET.iter().position(|&a| a == ch)? as u32;
        value = ((value << 5) | index) & 0xffff;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    Some(out)
}

pub fn normalize_device_id(id: &str) -> String {
    id.to_uppercase().chars().filter(|c| c.is_ascii_hexdigit()).collect()
}

pub fn group_text(text: &str, size: usize) -> String {
    text.chars().collect::<Vec<_>>().chunks(size).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

#[derive(Debug, Clone, Deserialize)]
pub struct LicensePayload {
    pub p: Option<String>,
    pub d: String,
    #[serde(default)]
    pub n: String,
    #[serde(default)]
    pub e: String,
    #[serde(default)]
    pub i: String,
}

pub struct ParsedKey {
    pub signature: [u8; 64],
    pub payload_bytes: Vec<u8>,
    pub payload: LicensePayload,
}

/// Err is "invalid_characters", "too_short" or "corrupted".
pub fn parse_license_key(key: &str) -> Result<ParsedKey, &'static str> {
    let cleaned: String = key.to_uppercase().chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    if cleaned.is_empty() || cleaned.bytes().any(|b| !ALPHABET.contains(&b)) {
        return Err("invalid_characters");
    }
    let raw = base32_decode(&cleaned).ok_or("invalid_characters")?;
    if raw.len() <= SIGNATURE_LENGTH {
        return Err("too_short");
    }
    let mut signature = [0u8; 64];
    signature.copy_from_slice(&raw[..SIGNATURE_LENGTH]);
    let payload_bytes = raw[SIGNATURE_LENGTH..].to_vec();
    let text = std::str::from_utf8(&payload_bytes).map_err(|_| "corrupted")?;
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| "corrupted")?;
    if !value.get("d").is_some_and(|d| d.is_string()) {
        return Err("corrupted");
    }
    let payload = LicensePayload {
        p: value.get("p").and_then(|v| v.as_str()).map(str::to_owned),
        d: value["d"].as_str().unwrap_or_default().to_owned(),
        n: value.get("n").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
        e: value.get("e").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
        i: value.get("i").and_then(|v| v.as_str()).unwrap_or_default().to_owned(),
    };
    Ok(ParsedKey { signature, payload_bytes, payload })
}

/// The shop edition pairs up to MAX_PAIRED_DEVICES phones; the phone edition pairs none (it runs alone).
pub fn mobile_allowance(edition: Option<&str>) -> MobileAccess {
    match edition.map(edition_of) {
        Some(Edition::Shop) => MobileAccess { allowed: true, limit: Some(MAX_PAIRED_DEVICES) },
        _ => MobileAccess { allowed: false, limit: None },
    }
}

row! {
    pub struct MobileAccess {
        pub allowed: bool,
        pub limit: Option<i64>,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub struct LicenseStatus {
    /// unconfigured = no public key embedded yet (development).
    #[ts(type = "'licensed' | 'trial' | 'expired' | 'unconfigured'")]
    pub state: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub customer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub edition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub issued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub days_left: Option<i64>,
    /// Why the trial ended early, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "'clock_changed'")]
    pub reason: Option<String>,
}

impl LicenseStatus {
    fn base(state: &str, device_id: String) -> Self {
        Self { state: state.into(), device_id, customer: None, edition: None, issued: None, days_left: None, reason: None }
    }
}

/// 16 hex characters shown as XXXX-XXXX-XXXX-XXXX, the same on every launch of this PC.
pub fn device_id(ctx: &Ctx) -> String {
    if let Some(id) = ctx.core.license.read().unwrap().cached_device_id.clone() {
        return id;
    }
    let mut env = ctx.core.license.write().unwrap();
    let digest = Sha256::digest(format!("nldl:{}", (env.machine_id)()).as_bytes());
    let id = group_text(&hex::encode(digest)[..16].to_uppercase(), 4);
    env.cached_device_id = Some(id.clone());
    id
}

fn clock(ctx: &Ctx) -> i64 {
    let c = ctx.core.license.read().unwrap().clock.clone();
    c()
}

fn public_key(ctx: &Ctx) -> String {
    ctx.core.license.read().unwrap().public_key_pem.clone()
}

struct Checked {
    customer: String,
    edition: String,
    issued: String,
}

fn check(ctx: &Ctx, key: &str) -> Res<Checked> {
    let parsed = parse_license_key(key).map_err(|e| app(&format!("license_{e}")))?;
    let verifying = VerifyingKey::from_public_key_pem(public_key(ctx).trim()).map_err(|_| app("license_not_configured"))?;
    let signature = Signature::from_bytes(&parsed.signature);
    if verifying.verify_strict(&parsed.payload_bytes, &signature).is_err() {
        return Err(app("license_bad_signature"));
    }
    if parsed.payload.p.as_deref() != Some(PRODUCT_CODE) {
        return Err(app("license_wrong_product"));
    }
    // The desktop app takes only shop keys, the stand-alone phone only phone keys.
    if edition_of(&parsed.payload.e) != ctx.core.license.read().unwrap().accepts {
        return Err(app("license_wrong_edition"));
    }
    if normalize_device_id(&parsed.payload.d) != normalize_device_id(&device_id(ctx)) {
        return Err(app("license_wrong_device"));
    }
    Ok(Checked { customer: parsed.payload.n, edition: parsed.payload.e, issued: parsed.payload.i })
}

fn trial_start(ctx: &Ctx) -> Res<i64> {
    let from_db: Option<f64> = get_value(ctx.db, TRIAL_START)?;
    let marker = ctx.core.paths.trial_marker();
    let from_file: Option<f64> = std::fs::read_to_string(marker).ok().and_then(|s| s.trim().parse::<f64>().ok()).filter(|v| *v != 0.0);
    // Earliest known start wins, so deleting one of the two does not restart the trial.
    let start = [from_db, from_file, Some(clock(ctx) as f64)].into_iter().flatten().fold(f64::INFINITY, f64::min) as i64;
    if from_db.map(|v| v as i64) != Some(start) {
        set_value(ctx.db, TRIAL_START, &start)?;
    }
    if from_file.map(|v| v as i64) != Some(start) {
        let _ = std::fs::write(marker, start.to_string()); // read-only location: the database copy is enough
    }
    Ok(start)
}

pub fn status(ctx: &Ctx) -> Res<LicenseStatus> {
    let id = device_id(ctx);
    if public_key(ctx).trim().is_empty() {
        return Ok(LicenseStatus::base("unconfigured", id));
    }
    if let Some(stored) = get_value::<String>(ctx.db, KEY)? {
        // A stored key no longer valid (hardware changed) falls through to the trial.
        if let Ok(c) = check(ctx, &stored) {
            let mut s = LicenseStatus::base("licensed", id);
            s.customer = Some(c.customer);
            s.edition = Some(c.edition);
            s.issued = Some(c.issued);
            return Ok(s);
        }
    }
    let now = clock(ctx);
    let last_seen = get_value::<f64>(ctx.db, LAST_SEEN)?.unwrap_or(0.0) as i64;
    let start = trial_start(ctx)?;
    if now < last_seen - DAY_MS {
        let mut s = LicenseStatus::base("expired", id);
        s.days_left = Some(0);
        s.reason = Some("clock_changed".into());
        return Ok(s);
    }
    if now > last_seen {
        set_value(ctx.db, LAST_SEEN, &now)?;
    }
    let days_left = (TRIAL_DAYS - (now - start).div_euclid(DAY_MS)).max(0);
    let mut s = LicenseStatus::base(if days_left > 0 { "trial" } else { "expired" }, id);
    s.days_left = Some(days_left);
    Ok(s)
}

/// Fails with the exact reason when the key is rejected.
pub fn activate(ctx: &Ctx, key: &str) -> Res<LicenseStatus> {
    if public_key(ctx).trim().is_empty() {
        return Err(app("license_not_configured"));
    }
    check(ctx, key)?;
    set_value(ctx.db, KEY, &key.trim())?;
    status(ctx)
}

pub fn current_key(ctx: &Ctx) -> Res<Option<String>> {
    get_value(ctx.db, KEY)
}

/// Phones are a paid option: the edition must contain "mobile". Development builds without a key allow it.
pub fn mobile_access(ctx: &Ctx) -> Res<MobileAccess> {
    let s = status(ctx)?;
    Ok(match s.state.as_str() {
        "unconfigured" => MobileAccess { allowed: true, limit: None },
        "licensed" => mobile_allowance(s.edition.as_deref()),
        _ => MobileAccess { allowed: false, limit: None },
    })
}

/// True when changes must be refused: the trial is over and there is no license. Reading and backup still work.
pub fn is_read_only(ctx: &Ctx) -> Res<bool> {
    Ok(status(ctx)?.state == "expired")
}

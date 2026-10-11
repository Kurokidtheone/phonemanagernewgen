mod common;
use common::*;
use ed25519_dalek::pkcs8::{spki::der::pem::LineEnding, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use psm_core::services::license::{self, base32_encode, group_text, mobile_allowance};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

const DAY: i64 = 86_400_000;

struct T {
    app: App,
    key: SigningKey,
    now: Arc<AtomicI64>,
}

fn setup() -> T {
    let app = fresh();
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    let now = Arc::new(AtomicI64::new(chrono::NaiveDate::from_ymd_opt(2026, 10, 6).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis()));
    {
        let mut env = app.core.license.write().unwrap();
        env.public_key_pem = key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
        let clock = now.clone();
        env.clock = Arc::new(move || clock.load(Ordering::SeqCst));
    }
    T { app, key, now }
}

fn make_key(payload: &Value, signer: &SigningKey) -> String {
    let bytes = serde_json::to_vec(payload).unwrap();
    let mut raw = signer.sign(&bytes).to_bytes().to_vec();
    raw.extend_from_slice(&bytes);
    group_text(&base32_encode(&raw), 5)
}

impl T {
    fn good(&self) -> Value {
        json!({ "p": "PSM", "d": self.device(), "n": "أكاديمية النجاح", "e": "lifetime", "i": "2026-10-06" })
    }
    fn device(&self) -> String {
        self.app.ok(|c| Ok(license::device_id(c)))
    }
    fn activate(&self, key: &str) -> psm_core::Res<license::LicenseStatus> {
        self.app.ctx(|c| license::activate(c, key))
    }
    fn status(&self) -> license::LicenseStatus {
        self.app.ok(license::status)
    }
    fn advance(&self, ms: i64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }
}

#[test]
fn has_a_stable_16_hex_device_id() {
    let t = setup();
    let id = t.device();
    assert!(regex::Regex::new(r"^[0-9A-F]{4}(-[0-9A-F]{4}){3}$").unwrap().is_match(&id));
    assert_eq!(id, t.device());
    // The same as the Electron app for this machine id: sha256("nldl:machine-a").
    assert_eq!(id, "1F27-2A35-F0D7-7D75");
}

#[test]
fn accepts_a_key_made_by_the_node_license_tool() {
    let t = setup();
    t.app.core.license.write().unwrap().public_key_pem =
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA145VsGOvGsIvHNDZaEqmvsd56epfdhXS7jyTnHZHW6A=\n-----END PUBLIC KEY-----\n".into();
    let key = "NCREH-EFZKR-RMGYX-7KKDN-QVY5K-BND4C-QAMBM-CXI57-JEEUU-SFTTS-LZ76R-KNIQT-C4WM2-LMDI7-ELYSO-PH3SM-PIGEY-6PQWS-B2EWU-WXP22-6DD3E-JYCEO-RCKBJ-U2IRM-EJSCE-ORCGF-DDENZ-NGJAT-GNJNI-YYEIN-ZNG5C-DONJC-FQRG4-IR2EL-MKHWM-D3CT5-RL6ZR-LMYLW-MK3CU-SBWFH-3GCNT-BWYVT-MKPWF-NEIWC-EZJCH-IRGY2-LGMV2-GS3LF-FNWW6-YTJNR-STGIR-MEJUS-EORCG-IYDEN-RNGEY-C2MBW-EJ6Q";
    let s = t.activate(key).unwrap();
    assert_eq!((s.state.as_str(), s.customer.as_deref(), s.edition.as_deref()), ("licensed", Some("أكاديمية النجاح"), Some("lifetime+mobile3")));
    assert_eq!(t.app.ok(license::mobile_access), license::MobileAccess { allowed: true, limit: Some(3) });
}

#[test]
fn activates_with_a_key_signed_for_this_device_and_product() {
    let t = setup();
    assert_eq!(t.status().state, "trial");
    let s = t.activate(&make_key(&t.good(), &t.key)).unwrap();
    assert_eq!((s.state.as_str(), s.customer.as_deref()), ("licensed", Some("أكاديمية النجاح")));
    assert!(!t.app.ok(license::is_read_only));
}

#[test]
fn names_the_exact_reason_when_it_rejects_a_key() {
    let t = setup();
    assert_eq!(code(t.activate("not a key!")), "license_invalid_characters");
    assert_eq!(code(t.activate("ABCDE")), "license_too_short");
    assert_eq!(code(t.activate(&make_key(&merge(t.good(), json!({ "d": "0000-0000-0000-0000" })), &t.key))), "license_wrong_device");
    assert_eq!(code(t.activate(&make_key(&merge(t.good(), json!({ "p": "OTHER" })), &t.key))), "license_wrong_product");
    let stranger = SigningKey::generate(&mut rand::rngs::OsRng);
    assert_eq!(code(t.activate(&make_key(&t.good(), &stranger))), "license_bad_signature");
    let key = make_key(&t.good(), &t.key);
    let mut chars: Vec<char> = key.chars().collect();
    chars[20] = if chars[20] == 'A' { 'B' } else { 'A' };
    let tampered: String = chars.into_iter().collect();
    assert!(matches!(code(t.activate(&tampered)).as_str(), "license_bad_signature" | "license_corrupted"));
}

#[test]
fn rejects_keys_without_the_product_code_or_for_another_product() {
    let t = setup();
    let mut without = t.good();
    without.as_object_mut().unwrap().remove("p");
    assert_eq!(code(t.activate(&make_key(&without, &t.key))), "license_wrong_product");
    assert_eq!(code(t.activate(&make_key(&merge(t.good(), json!({ "p": "ACA" })), &t.key))), "license_wrong_product");
    assert_eq!(code(t.activate(&make_key(&merge(t.good(), json!({ "p": "psm" })), &t.key))), "license_wrong_product"); // the code is exact
    assert_eq!(t.status().state, "trial");
    // A key from the academy app is signed with another private key.
    let academy = SigningKey::generate(&mut rand::rngs::OsRng);
    assert_eq!(code(t.activate(&make_key(&merge(t.good(), json!({ "p": "ACA" })), &academy))), "license_bad_signature");
    assert_eq!(code(t.activate(&make_key(&t.good(), &academy))), "license_bad_signature");
}

#[test]
fn runs_a_trial_then_becomes_read_only() {
    let t = setup();
    let s = t.status();
    assert_eq!((s.state.as_str(), s.days_left), ("trial", Some(license::TRIAL_DAYS)));
    t.advance(5 * DAY);
    assert_eq!(t.status().days_left, Some(license::TRIAL_DAYS - 5));
    t.advance(license::TRIAL_DAYS * DAY);
    assert_eq!(t.status().state, "expired");
    assert!(t.app.ok(license::is_read_only));
    // Writes are refused, reads and backup still work.
    assert_eq!(t.app.call("brands.create", json!({ "name": "X" })).error_code(), Some("read_only"));
    assert!(t.app.call("brands.list", Value::Null).is_ok());
    t.activate(&make_key(&t.good(), &t.key)).unwrap();
    assert!(!t.app.ok(license::is_read_only));
}

#[test]
fn ends_the_trial_when_the_clock_is_turned_back() {
    let t = setup();
    t.status();
    t.advance(10 * DAY);
    t.status();
    t.advance(-8 * DAY);
    let s = t.status();
    assert_eq!((s.state.as_str(), s.reason.as_deref()), ("expired", Some("clock_changed")));
}

#[test]
fn deleting_the_database_copy_does_not_restart_the_trial() {
    let t = setup();
    t.status();
    t.advance(20 * DAY);
    t.app.exec("DELETE FROM settings WHERE key LIKE 'license.%'", []);
    assert_eq!(t.status().state, "expired"); // the marker file still has the first start
}

#[test]
fn stays_open_while_no_public_key_is_configured() {
    let t = setup();
    t.app.core.license.write().unwrap().public_key_pem = String::new();
    assert_eq!(t.status().state, "unconfigured");
    assert!(!t.app.ok(license::is_read_only));
}

#[test]
fn reads_the_edition_in_one_place_and_counts_the_old_lifetime_as_shop() {
    use license::Edition::{Phone, Shop};
    for text in ["shop", "Shop", "lifetime", "lifetime+mobile3", "mobile", "", "anything else"] {
        assert_eq!(license::edition_of(text), Shop, "{text}");
    }
    for text in ["phone", "Phone", "PHONE", "phone-only", "lifetime+phone"] {
        assert_eq!(license::edition_of(text), Phone, "{text}");
    }
    // The shop edition is the PC with up to three phones; the phone edition pairs none.
    assert_eq!(mobile_allowance(Some("shop")), license::MobileAccess { allowed: true, limit: Some(license::MAX_PAIRED_DEVICES) });
    assert_eq!(mobile_allowance(Some("lifetime")), license::MobileAccess { allowed: true, limit: Some(3) });
    assert_eq!(mobile_allowance(Some("phone")), license::MobileAccess { allowed: false, limit: None });
    assert_eq!(mobile_allowance(None), license::MobileAccess { allowed: false, limit: None });
}

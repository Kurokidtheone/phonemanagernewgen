// Phones are a paid option, and the PC hands out the phone app.
mod common;
use common::*;
use ed25519_dalek::pkcs8::{spki::der::pem::LineEnding, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use psm_core::mobile::{devices, manager};
use psm_core::services::license::{self, base32_encode, group_text};
use psm_core::services::settings;
use serde_json::{json, Value};
use std::sync::Arc;

struct S {
    app: App,
    key: SigningKey,
    base: String,
    http: reqwest::Client,
}

fn setup() -> S {
    let app = fresh();
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    app.core.license.write().unwrap().public_key_pem = key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    app.ok(|c| settings::update_public(c.db, serde_json::from_value(json!({ "storeName": "Boutique Test" })).unwrap()));
    S { app, key, base: String::new(), http: reqwest::Client::builder().no_proxy().build().unwrap() }
}

impl S {
    fn make_key(&self, edition: &str) -> String {
        let device = self.app.ok(|c| Ok(license::device_id(c)));
        let bytes = serde_json::to_vec(&json!({ "p": "PSM", "d": device, "n": "Boutique", "e": edition, "i": "2026-10-06" })).unwrap();
        let mut raw = self.key.sign(&bytes).to_bytes().to_vec();
        raw.extend_from_slice(&bytes);
        group_text(&base32_encode(&raw), 5)
    }
    fn activate(&self, edition: &str) {
        let key = self.make_key(edition);
        self.app.ok(|c| license::activate(c, &key));
    }
    fn no_key(&self) {
        self.app.core.license.write().unwrap().public_key_pem = String::new();
    }
    async fn start_server(&mut self) {
        manager::set_config(&self.app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await.unwrap();
        self.base = format!("http://127.0.0.1:{}", manager::overview(&self.app.core).unwrap().port);
    }
    async fn pair_one(&self, name: &str) -> (u16, Value) {
        let code = manager::start_pairing(&self.app.core).unwrap().code;
        self.pair_with(&code, name).await
    }
    async fn pair_with(&self, code: &str, name: &str) -> (u16, Value) {
        let res = self.http.post(format!("{}/pair", self.base)).json(&json!({ "code": code, "deviceName": name })).send().await.unwrap();
        (res.status().as_u16(), res.json().await.unwrap())
    }
    fn overview(&self) -> manager::MobileOverview {
        manager::overview(&self.app.core).unwrap()
    }
    fn apk_dir(&self) -> std::path::PathBuf {
        let dir = self.app.core.paths.apk_dir().to_path_buf();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}

impl Drop for S {
    fn drop(&mut self) {
        let core: Arc<_> = self.app.core.clone();
        std::thread::spawn(move || rt().block_on(manager::shutdown(&core))).join().ok();
    }
}

fn err_code<T>(r: psm_core::Res<T>) -> String {
    match r {
        Ok(_) => panic!("expected an error"),
        Err(e) => e.code().to_owned(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_phone_edition_never_pairs_or_serves_phones() {
    let s = setup();
    // The stand-alone phone app takes only phone keys; it has no phones to pair.
    s.app.core.set_edition(license::Edition::Phone);
    s.activate("phone");
    let o = s.overview();
    assert_eq!((o.licensed, o.device_limit), (false, None));
    assert_eq!(err_code(manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await), "mobile_not_licensed");
    assert_eq!(s.overview().state, "stopped");
    let r = psm_core::api::run_channel(&s.app.core, "mobile.configure", json!({ "enabled": true, "port": 4780 }), psm_core::Caller::Desktop).await;
    assert_eq!(r.error_code(), Some("mobile_not_licensed"));
    assert_eq!(err_code(manager::start_pairing(&s.app.core)), "mobile_not_licensed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trial_pc_does_not_get_phones_either() {
    let s = setup();
    assert_eq!(s.app.ok(license::status).state, "trial");
    assert_eq!(err_code(manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await), "mobile_not_licensed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_left_on_in_the_settings_does_not_start_on_the_phone_edition() {
    let s = setup();
    s.app.core.set_edition(license::Edition::Phone);
    s.activate("phone");
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: false, port: 0 }).await.unwrap();
    // The setting says on (it was bought, then the key changed): applying the config still keeps it off.
    s.app.ok(|c| settings::set_value(c.db, "mobile.enabled", &true));
    manager::apply_config(&s.app.core).await.ok();
    assert_eq!(s.overview().state, "stopped");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_shop_edition_pairs_three_phones_refuses_a_fourth_and_counts_a_revoked_phone_as_free() {
    let mut s = setup();
    s.activate("shop");
    assert_eq!(s.app.ok(license::mobile_access), license::MobileAccess { allowed: true, limit: Some(license::MAX_PAIRED_DEVICES) });
    s.start_server().await;
    let o = s.overview();
    assert_eq!((o.licensed, o.device_limit, o.device_count), (true, Some(3), 0));

    let first = s.pair_one("A").await;
    assert_eq!(first.0, 200);
    assert_eq!(s.pair_one("B").await.0, 200);
    assert_eq!(s.pair_one("C").await.0, 200);
    assert_eq!(s.overview().device_count, 3);

    assert_eq!(err_code(manager::start_pairing(&s.app.core)), "mobile_device_limit");
    let refused = s.pair_with("123456", "D").await; // the fourth phone
    assert_eq!((refused.0, refused.1["error"]["code"].as_str()), (403, Some("mobile_device_limit")));

    let id = first.1["device"]["id"].as_str().unwrap().to_owned();
    s.app.ok(|c| devices::revoke_device(c, &id));
    assert_eq!(s.overview().device_count, 2);
    assert_eq!(s.pair_one("E").await.0, 200);
}

fn apk_bytes() -> Vec<u8> {
    let mut v = b"PK\x03\x04".to_vec();
    v.extend(vec![7u8; 2048]);
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn serves_the_apk_without_a_token_and_hello_reports_its_version() {
    let mut s = setup();
    s.no_key();
    let bytes = apk_bytes();
    let dir = s.apk_dir();
    std::fs::write(dir.join("app.apk"), &bytes).unwrap();
    std::fs::write(dir.join("app.json"), json!({ "versionName": "1.2.0", "versionCode": 24000000, "size": bytes.len() }).to_string()).unwrap();
    s.start_server().await;

    let res = s.http.get(format!("{}/app.apk", s.base)).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers()["content-type"], "application/vnd.android.package-archive");
    assert!(res.headers()["content-disposition"].to_str().unwrap().contains(r#"attachment; filename="phone-store-1.2.0.apk""#));
    assert_eq!(res.bytes().await.unwrap().to_vec(), bytes);

    let hello: Value = s.http.get(format!("{}/hello", s.base)).send().await.unwrap().json().await.unwrap();
    assert_eq!(hello["apk"], json!({ "versionName": "1.2.0", "versionCode": 24000000, "size": bytes.len() }));
    let o = s.overview();
    assert!(o.apk_urls.iter().all(|u| u.ends_with(&format!(":{}/app.apk", o.port))));
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_404_and_reports_no_apk_when_the_installer_did_not_include_one() {
    let mut s = setup();
    s.no_key();
    s.start_server().await;
    assert_eq!(s.http.get(format!("{}/app.apk", s.base)).send().await.unwrap().status().as_u16(), 404);
    let hello: Value = s.http.get(format!("{}/hello", s.base)).send().await.unwrap().json().await.unwrap();
    assert!(hello["apk"].is_null());
    assert!(s.overview().apk.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_answering_when_the_server_is_switched_off() {
    let mut s = setup();
    s.no_key();
    let bytes = apk_bytes();
    let dir = s.apk_dir();
    std::fs::write(dir.join("app.apk"), &bytes).unwrap();
    std::fs::write(dir.join("app.json"), json!({ "versionName": "1.0.0", "versionCode": 1, "size": bytes.len() }).to_string()).unwrap();
    s.start_server().await;
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: false, port: 0 }).await.unwrap();
    assert!(s.http.get(format!("{}/app.apk", s.base)).send().await.is_err());
}

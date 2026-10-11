// The stand-alone core through the same JSON functions the Android plugin calls, on the host.
use psm_android::bridge;
use serde_json::{json, Value};
use std::sync::Mutex;

// The bridge holds one core per process: tests take turns.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn call(channel: &str, payload: Value) -> Value {
    serde_json::from_str(&bridge::run(channel, &payload.to_string())).unwrap()
}

fn start() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    bridge::reset_for_tests();
    let r: Value = serde_json::from_str(&bridge::init(
        dir.path().to_str().unwrap(),
        "9774d56d682e549c",
        "1.0.0",
    ))
    .unwrap();
    assert_eq!(r["ok"], true, "{r}");
    dir
}

#[test]
fn runs_channels_as_the_owner_with_the_same_names_and_types() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let _dir = start();
    let brands = call("brands.list", Value::Null);
    assert_eq!(brands["ok"], true);
    assert!(
        brands["data"].as_array().unwrap().len() > 20,
        "the popular brands were added at the first start"
    );
    let made = call("brands.create", json!({ "name": "Mine" }));
    assert_eq!(made["ok"], true);
    // Errors come back as the usual envelope.
    let refused = call("brands.create", json!({ "name": "Mine" }));
    assert_eq!(refused["ok"], false);
    assert!(refused["error"]["code"].is_string());
    assert_eq!(call("nothing.here", Value::Null)["ok"], false);
    bridge::shutdown();
}

#[test]
fn takes_only_phone_keys_and_shows_a_device_id_in_the_documented_form() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let _dir = start();
    let status = call("license.status", Value::Null);
    assert_eq!(status["data"]["state"], "trial");
    let id = status["data"]["deviceId"].as_str().unwrap();
    assert_eq!(id.len(), 19);
    assert!(id
        .split('-')
        .all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_hexdigit())));
    // A made-up key is refused with a clear reason (the check order is: characters, signature, product, edition, device).
    let bad = call("license.activate", json!({ "key": "AAAAA-AAAAA" }));
    assert_eq!(bad["ok"], false);
    bridge::shutdown();
}

#[test]
fn exports_and_restores_a_backup_and_remembers_when_it_was_exported() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let dir = start();
    assert!(bridge::last_exported().is_none());
    call("brands.create", json!({ "name": "Zeta" }));
    let zip = dir.path().join("out.zip");
    let r: Value = serde_json::from_str(&bridge::export_backup(zip.to_str().unwrap())).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    assert!(std::fs::metadata(&zip).unwrap().len() > 1000);
    assert!(bridge::last_exported().is_some());
    call("brands.create", json!({ "name": "After" }));
    let r: Value = serde_json::from_str(&bridge::restore_backup(zip.to_str().unwrap())).unwrap();
    assert_eq!(r["ok"], true, "{r}");
    let names: Vec<String> = call("brands.list", Value::Null)["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"Zeta".to_owned()) && !names.contains(&"After".to_owned()));
    bridge::shutdown();
}

#[test]
fn wiping_erases_the_data_and_the_next_start_is_empty() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    let dir = start();
    call("brands.create", json!({ "name": "Zeta" }));
    let r: Value = serde_json::from_str(&bridge::wipe_data(dir.path().to_str().unwrap())).unwrap();
    assert_eq!(r["ok"], true);
    assert!(!dir.path().join("psm").exists());
    let r: Value = serde_json::from_str(&bridge::init(
        dir.path().to_str().unwrap(),
        "9774d56d682e549c",
        "1.0.0",
    ))
    .unwrap();
    assert_eq!(r["ok"], true);
    let names: Vec<String> = call("brands.list", Value::Null)["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(!names.contains(&"Zeta".to_owned()));
    bridge::shutdown();
}

#[test]
fn says_not_started_before_init() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
    bridge::reset_for_tests();
    assert_eq!(
        call("brands.list", Value::Null)["error"]["code"],
        "not_started"
    );
}

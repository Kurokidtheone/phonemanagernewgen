// The phone app (an APK) that the PC hands out over the shop Wi-Fi, so a phone can install it without a cable.
use serde::Deserialize;
use std::path::{Path, PathBuf};

row! {
    pub struct ApkInfo {
        pub version_name: String,
        pub version_code: i64,
        pub size: i64,
    }
}

pub fn apk_path(dir: &Path) -> PathBuf {
    dir.join("app.apk")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    version_name: Option<serde_json::Value>,
    version_code: Option<serde_json::Value>,
    size: Option<serde_json::Value>,
}

/// What the PC holds, from app.json written next to the APK by `npm run android:apk`. None when there is no APK.
pub fn apk_info(dir: &Path) -> Option<ApkInfo> {
    if dir.as_os_str().is_empty() || !apk_path(dir).exists() {
        return None;
    }
    let meta: Meta = serde_json::from_str(&std::fs::read_to_string(dir.join("app.json")).ok()?).ok()?;
    let version_name = meta.version_name?.as_str()?.to_owned();
    let version_code = meta.version_code?.as_f64()? as i64;
    let size = meta.size.and_then(|s| s.as_f64().or_else(|| s.as_str().and_then(|t| t.parse().ok()))).unwrap_or(0.0) as i64;
    Some(ApkInfo { version_name, version_code, size })
}

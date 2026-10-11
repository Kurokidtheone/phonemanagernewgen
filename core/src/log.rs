use std::io::Write;
use std::path::Path;

const MAX_BYTES: u64 = 1024 * 1024;

/// Appends to <data>/logs/app.log (rotated at 1 MB). Logging never fails the caller.
pub fn log_error(logs_dir: &Path, place: &str, err: &dyn std::fmt::Display) {
    eprintln!("[{place}] {err}");
    let file = logs_dir.join("app.log");
    if std::fs::metadata(&file).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&file, logs_dir.join("app.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(f, "{} [{place}] {err}", crate::util::now());
    }
}

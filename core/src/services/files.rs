// Uploaded files (logo, photos, receipts) are copied into <data>/files and referenced by name only.
use crate::core::Ctx;
use crate::error::{app_with, bail, Res};
use std::path::{Path, PathBuf};

pub const IMAGE_TYPES: &[&str] = &[".jpg", ".jpeg", ".png", ".webp"];
pub const DOCUMENT_TYPES: &[&str] = &[".jpg", ".jpeg", ".png", ".webp", ".pdf"];
const MAX_BYTES: u64 = 10 * 1024 * 1024;

fn extension(path: &Path) -> String {
    path.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default()
}

pub fn import_file(ctx: &Ctx, source: &str, allowed: &[&str]) -> Res<String> {
    let source = Path::new(source);
    let ext = extension(source);
    if !allowed.contains(&ext.as_str()) {
        return Err(app_with("file_type_not_allowed", [("types", allowed.join(" ").into())]));
    }
    let Ok(meta) = std::fs::metadata(source) else { bail!("file_not_found") };
    if meta.len() > MAX_BYTES {
        return Err(app_with("file_too_large", [("mb", (MAX_BYTES / 1024 / 1024).into())]));
    }
    let name = format!("{}{ext}", crate::util::uuid());
    std::fs::copy(source, ctx.core.paths.files_dir().join(&name))?;
    Ok(name)
}

/// Stores bytes received from a phone. The caller has already checked the type and size.
pub fn save_bytes(files_dir: &Path, bytes: &[u8], ext: &str) -> Res<String> {
    let name = format!("{}{ext}", crate::util::uuid());
    std::fs::write(files_dir.join(&name), bytes)?;
    Ok(name)
}

/// Absolute path of a stored file. Only the last component is kept, which blocks "../" tricks.
pub fn stored_file_path(files_dir: &Path, name: &str) -> PathBuf {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    files_dir.join(base)
}

pub fn remove_file(ctx: &Ctx, name: Option<&str>) {
    if let Some(n) = name.filter(|n| !n.is_empty()) {
        let _ = std::fs::remove_file(stored_file_path(&ctx.core.paths.files_dir(), n));
    }
}

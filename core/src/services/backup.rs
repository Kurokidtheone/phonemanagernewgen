// One zip holds everything: the database, the uploaded files and a manifest.
use crate::core::Core;
use crate::error::{app, internal, Res};
use crate::migrations::SCHEMA_VERSION;
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;

const KEEP_AUTOMATIC: usize = 14;
const DB_ENTRY: &str = "database.db";
pub const SLUG: &str = "phone-store-manager";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    product: String,
    schema_version: u32,
    app_version: String,
    created_at: String,
}

fn stamp() -> String {
    Local::now().format("%Y-%m-%d-%H%M").to_string()
}

pub fn default_backup_name() -> String {
    format!("{SLUG}-backup-{}.zip", stamp())
}

pub fn create_backup(core: &Core, destination: &Path) -> Res<()> {
    core.desktop(|ctx| {
        ctx.db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    })?;
    write_zip(core, destination)
}

fn write_zip(core: &Core, destination: &Path) -> Res<()> {
    let tmp = destination.with_extension("zip.part");
    let file = std::fs::File::create(&tmp)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated).large_file(true);
    zip.start_file(DB_ENTRY, opts).map_err(internal)?;
    zip.write_all(&std::fs::read(core.paths.db_path())?)?;
    let files = core.paths.files_dir();
    if files.exists() {
        for entry in std::fs::read_dir(&files)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                zip.start_file(format!("files/{}", entry.file_name().to_string_lossy()), opts).map_err(internal)?;
                zip.write_all(&std::fs::read(entry.path())?)?;
            }
        }
    }
    let manifest = Manifest {
        product: super::license::PRODUCT_CODE.into(),
        schema_version: SCHEMA_VERSION,
        app_version: core.app_version.clone(),
        created_at: crate::util::now(),
    };
    zip.start_file("manifest.json", opts).map_err(internal)?;
    zip.write_all(serde_json::to_string_pretty(&manifest)?.as_bytes())?;
    zip.finish().map_err(internal)?;
    std::fs::rename(&tmp, destination)?;
    Ok(())
}

/// Replaces all current data. A safety copy of the current data is written to the backups folder first.
pub fn restore_backup(core: &Core, zip_path: &Path) -> Res<()> {
    let invalid = || app("backup_invalid");
    let file = std::fs::File::open(zip_path).map_err(|_| invalid())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| invalid())?;
    let manifest: Manifest = {
        let mut f = zip.by_name("manifest.json").map_err(|_| invalid())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|_| invalid())?;
        serde_json::from_str(&s).map_err(|_| invalid())?
    };
    if manifest.product != super::license::PRODUCT_CODE || zip.by_name(DB_ENTRY).is_err() {
        return Err(invalid());
    }
    if manifest.schema_version > SCHEMA_VERSION {
        return Err(app("backup_newer_version"));
    }
    create_backup(core, &core.paths.backups_dir().join(format!("before-restore-{}.zip", stamp())))?;
    core.reopen(|| {
        let db = core.paths.db_path();
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
        }
        let files = core.paths.files_dir();
        let _ = std::fs::remove_dir_all(&files);
        std::fs::create_dir_all(&files)?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(internal)?;
            let name = entry.name().to_owned();
            let target = if name == DB_ENTRY {
                db.clone()
            } else if let Some(rest) = name.strip_prefix("files/") {
                // Only the file name: "../" in an entry cannot escape the files folder.
                let base = rest.rsplit(['/', '\\']).next().unwrap_or("");
                if base.is_empty() || entry.is_dir() {
                    continue;
                }
                files.join(base)
            } else {
                continue;
            };
            let mut out = std::fs::File::create(&target)?;
            std::io::copy(&mut entry, &mut out)?;
        }
        Ok(())
    }) // opening again runs any migrations the backup is missing
}

/// At startup: one automatic backup per day, the last 14 kept.
pub fn auto_backup(core: &Core) -> Res<()> {
    let dir = core.paths.backups_dir();
    let today = stamp()[..10].to_owned();
    let mut existing: Vec<String> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter(|f| f.starts_with("auto-") && f.ends_with(".zip"))
        .collect();
    existing.sort();
    if !existing.iter().any(|f| f.starts_with(&format!("auto-{today}"))) {
        let name = format!("auto-{}.zip", stamp());
        create_backup(core, &dir.join(&name))?;
        existing.push(name);
    }
    let excess = existing.len().saturating_sub(KEEP_AUTOMATIC);
    for old in &existing[..excess] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(())
}

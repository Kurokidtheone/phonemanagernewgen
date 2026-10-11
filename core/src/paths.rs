// Every path the app writes to, fixed once at startup (or by a test).
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    root: PathBuf,
    trial_marker: PathBuf,
    apk_dir: PathBuf,
}

impl Paths {
    /// Creates the data folders. `trial_marker` is a second copy of the trial start, outside the data folder.
    pub fn new(root: impl Into<PathBuf>, trial_marker: Option<PathBuf>, apk_dir: Option<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        let p = Self { trial_marker: trial_marker.unwrap_or_else(|| root.join(".t")), apk_dir: apk_dir.unwrap_or_else(|| root.join("mobile")), root };
        for d in [p.root.clone(), p.files_dir(), p.backups_dir(), p.logs_dir()] {
            std::fs::create_dir_all(d)?;
        }
        Ok(p)
    }
    pub fn data_dir(&self) -> &Path {
        &self.root
    }
    pub fn db_path(&self) -> PathBuf {
        self.root.join("store.db")
    }
    pub fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }
    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }
    pub fn trial_marker(&self) -> &Path {
        &self.trial_marker
    }
    /// Where the phone app (app.apk and app.json) is kept: the installer's resources, or build/mobile in development.
    pub fn apk_dir(&self) -> &Path {
        &self.apk_dir
    }
}

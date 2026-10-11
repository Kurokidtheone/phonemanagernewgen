// The running app: the database, the paths, in-memory state (manager unlock, license clock) and the host
// (the Tauri window, or a stub in tests) for what needs the OS: dialogs, printing, opening folders.
use crate::caller::Caller;
use crate::db::open_db;
use crate::error::{internal, Res};
use crate::paths::Paths;
use futures_util::future::BoxFuture;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

/// What the core asks of the desktop shell.
pub trait Host: Send + Sync {
    /// A "Save as" dialog. None when cancelled.
    fn save_dialog(&self, default_name: String, filter_name: &'static str, extensions: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>>;
    /// An "Open" dialog. None when cancelled.
    fn open_dialog(&self, filter_name: &'static str, extensions: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>>;
    /// Prints a complete HTML document through the system print dialog. False when cancelled or failed.
    fn print_html(&self, html: String) -> BoxFuture<'static, bool>;
    /// Prints without any dialog on the named printer (empty: the default printer).
    fn print_silent(&self, html: String, printer: String) -> BoxFuture<'static, bool>;
    fn list_printers(&self) -> BoxFuture<'static, Vec<String>>;
    /// Asks the desktop window to build and print a document a phone asked for. False when there is no window.
    fn request_print(&self, id: String, kind: &'static str, data: serde_json::Value) -> bool;
    fn open_path(&self, path: PathBuf);
    /// Restart the app (after a restore).
    fn relaunch(&self);
}

/// A host that does nothing: tests and headless use.
pub struct NullHost;

impl Host for NullHost {
    fn save_dialog(&self, _: String, _: &'static str, _: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>> {
        Box::pin(async { None })
    }
    fn open_dialog(&self, _: &'static str, _: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>> {
        Box::pin(async { None })
    }
    fn print_html(&self, _: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    fn print_silent(&self, _: String, _: String) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
    fn list_printers(&self) -> BoxFuture<'static, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
    fn request_print(&self, _: String, _: &'static str, _: serde_json::Value) -> bool {
        false
    }
    fn open_path(&self, _: PathBuf) {}
    fn relaunch(&self) {}
}

#[derive(Debug, Default)]
pub struct AuthState {
    pub unlocked: bool,
    pub failed_attempts: u32,
    pub blocked_until_ms: i64,
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct LicenseEnv {
    pub public_key_pem: String,
    /// The raw machine id (Windows MachineGuid), lower case, as node-machine-id returned it.
    pub machine_id: Arc<dyn Fn() -> String + Send + Sync>,
    pub clock: Clock,
    pub cached_device_id: Option<String>,
    /// The edition of key this app accepts: Shop on the desktop, Phone in the stand-alone Android app.
    pub accepts: crate::services::license::Edition,
}

pub struct Core {
    db: Mutex<Option<Connection>>,
    pub paths: Paths,
    pub app_version: String,
    pub auth: Mutex<AuthState>,
    pub license: RwLock<LicenseEnv>,
    pub host: Arc<dyn Host>,
    pub print: crate::print::PrintBridge,
    pub mobile: crate::mobile::Mobile,
}

/// One call's view of the app: the open database, the core and who is calling.
pub struct Ctx<'a> {
    pub db: &'a Connection,
    pub core: &'a Core,
    pub caller: Caller,
}

impl Core {
    pub fn new(paths: Paths, app_version: &str, host: Arc<dyn Host>) -> Res<Arc<Core>> {
        let conn = open_db(&paths.db_path())?;
        Ok(Arc::new(Self::with_connection(conn, paths, app_version, host)))
    }

    pub fn with_connection(conn: Connection, paths: Paths, app_version: &str, host: Arc<dyn Host>) -> Core {
        Core {
            db: Mutex::new(Some(conn)),
            paths,
            app_version: app_version.to_owned(),
            auth: Mutex::new(AuthState::default()),
            license: RwLock::new(LicenseEnv {
                public_key_pem: crate::services::license::LICENSE_PUBLIC_KEY.to_owned(),
                machine_id: Arc::new(crate::services::license::system_machine_id),
                clock: Arc::new(crate::util::now_ms),
                cached_device_id: None,
                accepts: crate::services::license::Edition::Shop,
            }),
            host,
            print: Default::default(),
            mobile: Default::default(),
        }
    }

    /// Runs `f` with the database. Calls are serialized by the connection lock.
    pub fn with<T>(&self, caller: &Caller, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        let guard = self.db.lock().unwrap_or_else(|p| p.into_inner());
        let conn = guard.as_ref().ok_or_else(|| internal("Database is not open"))?;
        let ctx = Ctx { db: conn, core: self, caller: caller.clone() };
        f(&ctx)
    }

    /// The shell supplies the machine id where the system has none for us to read (Android: ANDROID_ID).
    pub fn set_machine_id(&self, id: &str) {
        let id = id.trim().to_lowercase();
        let mut env = self.license.write().unwrap();
        env.machine_id = Arc::new(move || id.clone());
        env.cached_device_id = None;
    }

    /// The stand-alone phone app accepts only phone keys, and never pairs or syncs.
    pub fn set_edition(&self, edition: crate::services::license::Edition) {
        self.license.write().unwrap().accepts = edition;
    }

    pub fn desktop<T>(&self, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        self.with(&Caller::Desktop, f)
    }

    /// Closes the database, runs `f` (which may replace the files), and opens it again.
    pub fn reopen<T>(&self, f: impl FnOnce() -> Res<T>) -> Res<T> {
        let mut guard = self.db.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(conn) = guard.take() {
            let _ = conn.close();
        }
        let out = f();
        *guard = Some(open_db(&self.paths.db_path())?);
        out
    }

    pub fn log(&self, place: &str, err: &dyn std::fmt::Display) {
        crate::log::log_error(&self.paths.logs_dir(), place, err);
    }
}

impl<'a> Ctx<'a> {
    /// One transaction (a savepoint, so it nests): committed when `f` succeeds, rolled back otherwise.
    pub fn tx<T>(&self, f: impl FnOnce() -> Res<T>) -> Res<T> {
        self.db.execute_batch("SAVEPOINT tx")?;
        match f() {
            Ok(v) => {
                self.db.execute_batch("RELEASE tx")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self.db.execute_batch("ROLLBACK TO tx; RELEASE tx");
                Err(e)
            }
        }
    }
    /// The same call and database, as another caller (a conflict resolved on the PC, applied as the phone that made the op).
    pub fn with_caller<T>(&self, caller: Caller, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        f(&Ctx { db: self.db, core: self.core, caller })
    }
    pub fn actor(&self) -> Option<String> {
        self.caller.actor()
    }
    pub fn via(&self) -> Option<&'static str> {
        self.caller.via()
    }
    pub fn device(&self) -> Option<&str> {
        self.caller.device()
    }
    pub fn now_ms(&self) -> i64 {
        crate::util::now_ms()
    }
}

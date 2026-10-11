use psm_core::services::license::Edition;
use psm_core::services::{backup, settings};
use psm_core::{api, Caller, Core, NullHost, Paths};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Arc, Mutex};

struct State {
    core: Arc<Core>,
    rt: tokio::runtime::Runtime,
}

static STATE: Mutex<Option<Arc<State>>> = Mutex::new(None);

fn state() -> Option<Arc<State>> {
    STATE.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

fn failure(code: &str) -> String {
    json!({ "ok": false, "error": { "code": code, "params": {} } }).to_string()
}

fn done(data: Value) -> String {
    json!({ "ok": true, "data": data }).to_string()
}

/// Opens the data in `files_dir`, as the stand-alone phone: it accepts only phone keys and its machine id is the
/// Android id the Kotlin side read. Safe to call again (it does nothing the second time). Returns an IpcResult JSON.
pub fn init(files_dir: &str, machine_id: &str, app_version: &str) -> String {
    if state().is_some() {
        return done(Value::Null);
    }
    let root = Path::new(files_dir);
    // The trial marker sits beside the data folder, like the desktop's: deleting one copy does not restart the trial.
    let paths = match Paths::new(
        root.join("psm"),
        Some(root.join(".psm-t")),
        Some(root.join("psm-apk")),
    ) {
        Ok(p) => p,
        Err(e) => return failure(&format!("io: {e}")),
    };
    let core = match Core::new(paths, app_version, Arc::new(NullHost)) {
        Ok(c) => c,
        Err(e) => return failure(e.code()),
    };
    core.set_edition(Edition::Phone);
    core.set_machine_id(machine_id);
    psm_core::startup::prepare(&core);
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return failure(&format!("runtime: {e}")),
    };
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = Some(Arc::new(State { core, rt }));
    done(Value::Null)
}

/// One channel call as the owner (there is no one else on a stand-alone phone). Returns the IpcResult as JSON.
pub fn run(channel: &str, payload_json: &str) -> String {
    let Some(st) = state() else {
        return failure("not_started");
    };
    let payload: Value = if payload_json.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(payload_json).unwrap_or(Value::Null)
    };
    let result = st.rt.block_on(api::run_channel(
        &st.core,
        channel,
        payload,
        Caller::Desktop,
    ));
    serde_json::to_string(&result).unwrap_or_else(|_| failure("unexpected"))
}

/// Writes a backup zip (the desktop's format) to `destination`, for the share menu.
pub fn export_backup(destination: &str) -> String {
    let Some(st) = state() else {
        return failure("not_started");
    };
    match backup::create_backup(&st.core, Path::new(destination)) {
        Ok(()) => {
            let _ = st.core.desktop(|c| {
                settings::set_value(c.db, "backup.lastExported", &psm_core::util::now())
            });
            done(Value::Null)
        }
        Err(e) => failure(e.code()),
    }
}

/// Replaces all data with a backup zip (from the desktop or another phone).
pub fn restore_backup(source: &str) -> String {
    let Some(st) = state() else {
        return failure("not_started");
    };
    match backup::restore_backup(&st.core, Path::new(source)) {
        Ok(()) => done(Value::Null),
        Err(e) => failure(e.code()),
    }
}

/// When the last backup was handed to the share menu, as an ISO time, or null: the Home banner after 7 days.
pub fn last_exported() -> Option<String> {
    let st = state()?;
    st.core
        .desktop(|c| settings::get_value::<String>(c.db, "backup.lastExported"))
        .ok()
        .flatten()
}

/// Erases this phone's own data (the database, the files, the backups): moving to a shop PC. The next `init` starts empty.
pub fn wipe_data(files_dir: &str) -> String {
    shutdown();
    match std::fs::remove_dir_all(Path::new(files_dir).join("psm")) {
        Ok(()) => done(Value::Null),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => done(Value::Null),
        Err(e) => failure(&format!("io: {e}")),
    }
}

pub fn shutdown() {
    *STATE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Tests only: forget the open core, so the next `init` opens a fresh folder.
#[doc(hidden)]
pub fn reset_for_tests() {
    shutdown();
}

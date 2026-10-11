// Shared by the integration tests: a fresh data folder and database for every test, and short helpers.
#![allow(dead_code)]
use psm_core::db::DbExt;
use psm_core::valid::Validate;
use psm_core::{Caller, Core, Ctx, IpcResult, NullHost, Paths, Res};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::sync::Arc;

pub struct App {
    pub core: Arc<Core>,
    pub dir: tempfile::TempDir,
}

pub fn fresh() -> App {
    let dir = tempfile::Builder::new().prefix("psm-test-").tempdir().unwrap();
    let paths = Paths::new(dir.path(), None, Some(dir.path().join("mobile"))).unwrap();
    let core = Core::new(paths, "9.9.9", Arc::new(NullHost)).unwrap();
    // A fixed machine: the device id is the same on every run.
    core.license.write().unwrap().machine_id = Arc::new(|| "machine-a".to_owned());
    App { core, dir }
}

impl App {
    /// Runs `f` as the desktop window.
    pub fn ctx<T>(&self, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        self.core.desktop(f)
    }
    /// Like `ctx`, panicking on an error.
    pub fn ok<T>(&self, f: impl FnOnce(&Ctx) -> Res<T>) -> T {
        match self.core.desktop(f) {
            Ok(v) => v,
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
    pub fn as_caller<T>(&self, caller: &Caller, f: impl FnOnce(&Ctx) -> Res<T>) -> Res<T> {
        self.core.with(caller, f)
    }
    /// One API call, as the window makes it.
    pub fn call(&self, channel: &str, payload: Value) -> IpcResult {
        rt().block_on(psm_core::api::run_channel(&self.core, channel, payload, Caller::Desktop))
    }
    pub fn rows<T: DeserializeOwned>(&self, sql: &str) -> Vec<T> {
        self.ok(|c| c.db.all(sql, []))
    }
    pub fn val<T: rusqlite::types::FromSql>(&self, sql: &str) -> T {
        self.ok(|c| c.db.val(sql, []))
    }
    pub fn exec(&self, sql: &str, params: impl rusqlite::Params) {
        self.ok(|c| c.db.exec(sql, params));
    }
}

pub fn rt() -> &'static tokio::runtime::Runtime {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap())
}

/// Like Zod's schema.parse: defaults, trimming and checks. Panics when the input is refused.
pub fn parse<T: DeserializeOwned + Validate>(v: Value) -> T {
    try_parse(v).unwrap_or_else(|e| panic!("refused input: {e}"))
}

pub fn try_parse<T: DeserializeOwned + Validate>(v: Value) -> Res<T> {
    let mut t: T = serde_json::from_value(v).map_err(|e| psm_core::error::invalid(e.to_string()))?;
    t.validate()?;
    Ok(t)
}

/// The error code of a result that must fail.
pub fn code<T: std::fmt::Debug>(r: Res<T>) -> String {
    match r {
        Ok(v) => panic!("expected an error, got {v:?}"),
        Err(e) => e.code().to_owned(),
    }
}

/// `{ ...base, ...over }` for JSON objects.
pub fn merge(mut base: Value, over: Value) -> Value {
    if let (Value::Object(b), Value::Object(o)) = (&mut base, over) {
        for (k, v) in o {
            if v.is_null() {
                b.remove(&k);
            } else {
                b.insert(k, v);
            }
        }
    }
    base
}

pub fn now() -> String {
    psm_core::util::now()
}

pub fn make_imei(body: &str) -> String {
    psm_core::services::codes::make_imei(body)
}

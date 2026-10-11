// SQLite access. One connection, opened at startup and shared by every call (calls are serialized,
// like they were on Electron's main thread). Rows are read into structs by column name.
use crate::error::{internal, Res};
use crate::migrations::{Migration, MIGRATIONS};
use rusqlite::types::{FromSql, ToSql, Value as SqlValue};
use rusqlite::{Connection, OptionalExtension, Params};
use serde::de::DeserializeOwned;
use std::path::Path;

/// Open (or create) the database and bring it to the latest schema. Use ":memory:" in tests.
pub fn open_db(path: &Path) -> Res<Connection> {
    let memory = path.as_os_str() == ":memory:";
    let conn = if memory { Connection::open_in_memory()? } else { Connection::open(path)? };
    if !memory {
        conn.pragma_update(None, "journal_mode", "WAL")?;
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Res<()> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if current as usize > MIGRATIONS.len() {
        return Err(internal("This data was created by a newer version of the app."));
    }
    for (i, step) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        conn.execute_batch("BEGIN")?;
        let result = (|| -> Res<()> {
            match step {
                Migration::Sql(sql) => conn.execute_batch(sql)?,
                Migration::PhoneUnitsNullableImei => nullable_imei(conn)?,
                Migration::SyncFeed => conn.execute_batch(&crate::services::sync::feed_sql())?,
            }
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
            Ok(())
        })();
        match result {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}

// SQLite cannot drop NOT NULL with ALTER, and rebuilding phone_units would break every reference to it, so
// the table definition is edited in place, which SQLite documents as safe for removing a NOT NULL or CHECK.
fn nullable_imei(conn: &Connection) -> Res<()> {
    let before = "imei1 TEXT NOT NULL CHECK (length(imei1) = 15)";
    let after = "imei1 TEXT CHECK (imei1 IS NULL OR length(imei1) = 15)";
    let version: i64 = conn.pragma_query_value(None, "schema_version", |r| r.get(0))?;
    conn.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DEFENSIVE, false)?;
    conn.pragma_update(None, "writable_schema", "ON")?;
    let changed = conn.execute("UPDATE sqlite_master SET sql = replace(sql, ?1, ?2) WHERE type = 'table' AND name = 'phone_units'", [before, after])?;
    conn.pragma_update(None, "schema_version", version + 1)?;
    conn.pragma_update(None, "writable_schema", "OFF")?;
    if changed != 1 {
        return Err(internal("migration 10: phone_units definition not found"));
    }
    Ok(())
}

/// Query helpers. Struct fields are matched to column names (snake_case in SQL).
pub trait DbExt {
    fn all<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Res<Vec<T>>;
    fn get<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Res<Option<T>>;
    fn val<T: FromSql>(&self, sql: &str, params: impl Params) -> Res<T>;
    fn opt_val<T: FromSql>(&self, sql: &str, params: impl Params) -> Res<Option<T>>;
    fn exec(&self, sql: &str, params: impl Params) -> Res<usize>;
    fn exists(&self, sql: &str, params: impl Params) -> Res<bool>;
}

impl DbExt for Connection {
    fn all<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Res<Vec<T>> {
        let mut stmt = self.prepare_cached(sql)?;
        let rows = stmt.query(params)?;
        let out: Result<Vec<T>, _> = serde_rusqlite::from_rows::<T>(rows).collect();
        Ok(out?)
    }
    fn get<T: DeserializeOwned>(&self, sql: &str, params: impl Params) -> Res<Option<T>> {
        let mut stmt = self.prepare_cached(sql)?;
        let rows = stmt.query(params)?;
        let first = serde_rusqlite::from_rows::<T>(rows).next().transpose()?;
        Ok(first)
    }
    fn val<T: FromSql>(&self, sql: &str, params: impl Params) -> Res<T> {
        Ok(self.prepare_cached(sql)?.query_row(params, |r| r.get(0))?)
    }
    fn opt_val<T: FromSql>(&self, sql: &str, params: impl Params) -> Res<Option<T>> {
        Ok(self.prepare_cached(sql)?.query_row(params, |r| r.get(0)).optional()?)
    }
    fn exec(&self, sql: &str, params: impl Params) -> Res<usize> {
        Ok(self.prepare_cached(sql)?.execute(params)?)
    }
    fn exists(&self, sql: &str, params: impl Params) -> Res<bool> {
        Ok(self.prepare_cached(sql)?.exists(params)?)
    }
}

/// Parameters built at run time, for queries with optional filters.
#[derive(Default)]
pub struct Args(pub Vec<SqlValue>);

impl Args {
    pub fn new() -> Self {
        Self(Vec::new())
    }
    pub fn push(&mut self, v: impl Into<SqlValue>) -> &mut Self {
        self.0.push(v.into());
        self
    }
    pub fn params(&self) -> rusqlite::ParamsFromIter<std::slice::Iter<'_, SqlValue>> {
        rusqlite::params_from_iter(self.0.iter())
    }
}

/// `WHERE a AND b ...` from optional conditions, collecting their parameters.
#[derive(Default)]
pub struct Filter {
    conds: Vec<String>,
    pub args: Args,
}

impl Filter {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn add(&mut self, cond: &str) -> &mut Self {
        self.conds.push(cond.to_owned());
        self
    }
    pub fn add_with(&mut self, cond: &str, v: impl Into<SqlValue>) -> &mut Self {
        self.conds.push(cond.to_owned());
        self.args.push(v);
        self
    }
    pub fn add_with2(&mut self, cond: &str, a: impl Into<SqlValue>, b: impl Into<SqlValue>) -> &mut Self {
        self.conds.push(cond.to_owned());
        self.args.push(a);
        self.args.push(b);
        self
    }
    /// " WHERE ..." or "" when there is no condition.
    pub fn sql(&self) -> String {
        if self.conds.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.conds.join(" AND "))
        }
    }
}

pub fn opt<T: ToSql>(v: &Option<T>) -> &dyn ToSql {
    v
}

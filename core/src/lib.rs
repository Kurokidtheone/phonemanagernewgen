//! Phone Store Manager core: the SQLite database, every service, the API channels the window and the
//! phones call, and the phone server. It has no UI dependency, so it is tested with `cargo test`.

/// An output row: snake_case columns in, camelCase JSON out, with a TypeScript declaration.
macro_rules! row {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $f:ident : $t:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
        #[serde(rename_all(serialize = "camelCase"))]
        #[ts(rename_all = "camelCase")]
        $(#[$m])*
        pub struct $name { $($(#[$fm])* pub $f: $t),* }
    };
}

/// A channel input: camelCase JSON in, unknown keys ignored (like Zod objects).
macro_rules! input {
    ($(#[$m:meta])* pub struct $name:ident { $($(#[$fm:meta])* pub $f:ident : $t:ty),* $(,)? }) => {
        #[derive(Debug, Clone, PartialEq, serde::Deserialize, serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        $(#[$m])*
        pub struct $name { $($(#[$fm])* pub $f: $t),* }
    };
}

pub mod api;
pub mod caller;
pub mod core;
pub mod db;
pub mod error;
pub mod log;
pub mod migrations;
pub mod mobile;
pub mod paths;
pub mod print;
pub mod rows;
pub mod services;
pub mod startup;
pub mod util;
pub mod valid;

#[cfg(test)]
mod tests;

pub use crate::core::{Core, Ctx, Host, NullHost};
pub use caller::{Caller, DeviceCaller, Via};
pub use error::{Error, IpcResult, Res};
pub use paths::Paths;

// Errors that cross the API boundary. `code` is an i18n key under "errors.<code>" in the renderer.
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// A refusal the user can act on, shown in their language.
    App { code: String, params: Map<String, Value> },
    /// The input did not pass validation.
    Invalid(String),
    /// A bug or an I/O failure: logged, shown as "unexpected".
    Internal(String),
}

pub type Res<T> = Result<T, Error>;

impl Error {
    pub fn code(&self) -> &str {
        match self {
            Error::App { code, .. } => code,
            Error::Invalid(_) => "invalid_input",
            Error::Internal(_) => "unexpected",
        }
    }
}

/// `Err(app("not_found"))`
pub fn app(code: &str) -> Error {
    Error::App { code: code.to_owned(), params: Map::new() }
}

/// `Err(app_with("too_many_attempts", [("seconds", 30.into())]))`
pub fn app_with<const N: usize>(code: &str, params: [(&str, Value); N]) -> Error {
    Error::App { code: code.to_owned(), params: params.into_iter().map(|(k, v)| (k.to_owned(), v)).collect() }
}

pub fn invalid(why: impl Into<String>) -> Error {
    Error::Invalid(why.into())
}

pub fn internal(why: impl std::fmt::Display) -> Error {
    Error::Internal(why.to_string())
}

macro_rules! bail {
    ($code:literal) => {
        return Err($crate::error::app($code))
    };
    ($code:expr, $($k:literal => $v:expr),+ $(,)?) => {
        return Err($crate::error::app_with($code, [$(($k, serde_json::json!($v))),+]))
    };
}
pub(crate) use bail;

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::App { code, params } => write!(f, "{code} {}", Value::Object(params.clone())),
            Error::Invalid(why) => write!(f, "invalid_input: {why}"),
            Error::Internal(why) => write!(f, "internal: {why}"),
        }
    }
}
impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Internal(format!("sqlite: {e}"))
    }
}
impl From<serde_rusqlite::Error> for Error {
    fn from(e: serde_rusqlite::Error) -> Self {
        Error::Internal(format!("row: {e}"))
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Internal(format!("io: {e}"))
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Internal(format!("json: {e}"))
    }
}

/// What every API call returns: `{ ok: true, data }` or `{ ok: false, error: { code, params } }`.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum IpcResult {
    Ok { ok: bool, data: Value },
    Err { ok: bool, error: ErrorBody },
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    pub code: String,
    pub params: Map<String, Value>,
}

impl IpcResult {
    pub fn ok(data: Value) -> Self {
        IpcResult::Ok { ok: true, data }
    }
    pub fn err(e: &Error) -> Self {
        let params = match e {
            Error::App { params, .. } => params.clone(),
            _ => Map::new(),
        };
        IpcResult::Err { ok: false, error: ErrorBody { code: e.code().to_owned(), params } }
    }
    pub fn is_ok(&self) -> bool {
        matches!(self, IpcResult::Ok { .. })
    }
    pub fn data(&self) -> Option<&Value> {
        match self {
            IpcResult::Ok { data, .. } => Some(data),
            _ => None,
        }
    }
    pub fn error_code(&self) -> Option<&str> {
        match self {
            IpcResult::Err { error, .. } => Some(&error.code),
            _ => None,
        }
    }
}

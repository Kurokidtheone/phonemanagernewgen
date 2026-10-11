use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

/// Project URL and anon key. Both are public by design.
#[derive(Debug, Clone)]
pub struct Config {
    pub url: String,
    pub anon_key: String,
}

impl Config {
    pub fn new(url: &str, anon_key: &str) -> Self {
        Self {
            url: url.trim_end_matches('/').to_string(),
            anon_key: anon_key.to_string(),
        }
    }

    pub(crate) fn websocket_url(&self) -> String {
        let base = if let Some(rest) = self.url.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = self.url.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            self.url.clone()
        };
        format!(
            "{base}/realtime/v1/websocket?apikey={}&vsn=1.0.0",
            self.anon_key
        )
    }
}

/// Message direction. The numbers are the ones stored in the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    ToPc = 0,
    ToPhone = 1,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    /// The shop was blocked in Supabase.
    #[error("mailbox_blocked")]
    Blocked,
    #[error("mailbox_full")]
    Full,
    /// The PC never registered this mailbox.
    #[error("mailbox_unknown")]
    Unknown,
    #[error("body_too_large")]
    TooLarge,
    #[error("bad_mailbox")]
    BadMailbox,
    #[error("too_many_new_shops")]
    TooManyNewShops,
    /// No internet, DNS failure, timeout.
    #[error("no_internet")]
    NoInternet,
    /// Anything else the server said.
    #[error("server: {0}")]
    Server(String),
}

impl Error {
    fn from_message(m: &str) -> Self {
        match m {
            "mailbox_blocked" => Error::Blocked,
            "mailbox_full" => Error::Full,
            "mailbox_unknown" => Error::Unknown,
            "body_too_large" => Error::TooLarge,
            "bad_mailbox" => Error::BadMailbox,
            "too_many_new_shops" => Error::TooManyNewShops,
            other => Error::Server(other.to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Row {
    pub id: i64,
    pub body: String,
}

#[derive(Clone)]
pub struct Mailbox {
    http: reqwest::Client,
    cfg: Config,
}

impl Mailbox {
    pub fn new(cfg: Config) -> Self {
        Self::with_timeout(cfg, Duration::from_secs(15))
    }

    pub fn with_timeout(cfg: Config, timeout: Duration) -> Self {
        crate::install_tls();
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .build()
            .expect("http client");
        Self { http, cfg }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    async fn rpc(&self, name: &str, args: Value) -> Result<Value, Error> {
        let res = self
            .http
            .post(format!("{}/rest/v1/rpc/{name}", self.cfg.url))
            .header("apikey", &self.cfg.anon_key)
            .bearer_auth(&self.cfg.anon_key)
            .json(&args)
            .send()
            .await
            .map_err(|_| Error::NoInternet)?;
        let status = res.status();
        let text = res.text().await.map_err(|_| Error::NoInternet)?;
        if status.is_success() {
            if text.is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|_| Error::Server("bad_reply".into()));
        }
        let message = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str().map(str::to_string))
            })
            .unwrap_or_else(|| format!("http_{}", status.as_u16()));
        Err(Error::from_message(&message))
    }

    /// The PC's heartbeat. Returns true when the shop is blocked.
    pub async fn beat(&self, mailbox: &str, shop_id: &str, name: &str) -> Result<bool, Error> {
        let v = self
            .rpc(
                "mb_beat",
                json!({"p_mailbox": mailbox, "p_shop_id": shop_id, "p_name": name}),
            )
            .await?;
        Ok(v.as_bool().unwrap_or(false))
    }

    /// Seconds since the PC's last beat, or None when never seen.
    pub async fn seen(&self, mailbox: &str) -> Result<Option<i64>, Error> {
        let v = self.rpc("mb_seen", json!({"p_mailbox": mailbox})).await?;
        Ok(v.as_i64())
    }

    pub async fn send(&self, mailbox: &str, dir: Dir, body: &str) -> Result<i64, Error> {
        let v = self
            .rpc(
                "mb_send",
                json!({"p_mailbox": mailbox, "p_dir": dir as i16, "p_body": body}),
            )
            .await?;
        v.as_i64().ok_or_else(|| Error::Server("bad_reply".into()))
    }

    /// Up to 50 rows after `after_id`, oldest first.
    pub async fn fetch(&self, mailbox: &str, dir: Dir, after_id: i64) -> Result<Vec<Row>, Error> {
        let v = self
            .rpc(
                "mb_fetch",
                json!({"p_mailbox": mailbox, "p_dir": dir as i16, "p_after_id": after_id}),
            )
            .await?;
        serde_json::from_value(v).map_err(|_| Error::Server("bad_reply".into()))
    }

    /// Delete delivered rows up to and including `up_to_id`.
    pub async fn ack(&self, mailbox: &str, dir: Dir, up_to_id: i64) -> Result<(), Error> {
        self.rpc(
            "mb_ack",
            json!({"p_mailbox": mailbox, "p_dir": dir as i16, "p_up_to_id": up_to_id}),
        )
        .await
        .map(|_| ())
    }
}

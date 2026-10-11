// Starts and stops the phone server and the mailbox service, and answers "what is their state". The server runs only
// while the setting mobile.enabled is on; a busy port is reported as a state, never thrown at the user.
use super::apk::{apk_info, ApkInfo};
use super::devices::{active_device_count, create_device, Device};
use super::mailbox::{self, RemoteStatus};
use super::server::{self, Answer};
use crate::core::{Core, Ctx};
use crate::error::{app, app_with, bail, Error, Res};
use crate::services::license::{mobile_access, status as license_status};
use crate::services::settings::{get_public, get_value, set_value};
use crate::util::uuid;
use crate::valid::{self, Validate};
use serde_json::json;
use std::sync::Arc;

pub const MOBILE_DEFAULT_PORT: i64 = 4780;
/// The Supabase project used as a mailbox for access from outside the shop (see supabase/README.md). Both values are
/// public by design. Never put the service_role key here.
pub const REMOTE_URL: &str = "https://ggkevpmjabokmgkcdhzx.supabase.co";
pub const REMOTE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdna2V2cG1qYWJva21na2NkaHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MjE5NjYsImV4cCI6MjEwNzE5Nzk2Nn0.uZugUM1HLSykqIguNXdTbzaO3ZbGlqpfKHDq2C0lORA";

#[derive(Debug, Clone, PartialEq)]
pub struct ServerStatus {
    pub state: &'static str,
    pub port: Option<i64>,
    pub error: Option<String>,
}

impl Default for ServerStatus {
    fn default() -> Self {
        Self { state: "stopped", port: None, error: None }
    }
}

pub struct Running {
    shutdown: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

row! { pub struct MobileConfig { pub enabled: bool, pub port: i64 } }

input! { pub struct MobileConfigInput { pub enabled: bool, pub port: i64 } }
impl Validate for MobileConfigInput {
    fn validate(&mut self) -> Res<()> {
        valid::range(self.port, 1024, 65535, "port")
    }
}

input! { pub struct RemoteConfigInput { pub mode: String } }
impl Validate for RemoteConfigInput {
    fn validate(&mut self) -> Res<()> {
        valid::one_of(&self.mode, &["off", "full", "view"], "mode")
    }
}

pub fn get_config(ctx: &Ctx) -> Res<MobileConfig> {
    Ok(MobileConfig { enabled: get_value(ctx.db, "mobile.enabled")?.unwrap_or(false), port: get_value(ctx.db, "mobile.port")?.unwrap_or(MOBILE_DEFAULT_PORT) })
}

/// Random once, then kept: a phone recognises this PC by it even if the IP address changes.
pub fn server_id(ctx: &Ctx) -> Res<String> {
    if let Some(id) = get_value::<String>(ctx.db, "mobile.serverId")? {
        return Ok(id);
    }
    let id = uuid();
    set_value(ctx.db, "mobile.serverId", &id)?;
    Ok(id)
}

pub fn lan_addresses() -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some(v4.ip.to_string()),
            _ => None,
        })
        .collect()
}

/// Off, full, or view only: what phones may do from outside the shop.
pub fn remote_mode(ctx: &Ctx) -> Res<String> {
    let mode: Option<String> = get_value(ctx.db, "mobile.remote.mode")?;
    Ok(match mode.as_deref() {
        Some("full") => "full".into(),
        Some("view") => "view".into(),
        _ => "off".into(),
    })
}

/// Remote access needs an activated license (not a trial) that includes phones. Development builds without a key
/// embedded (state 'unconfigured') are allowed, like phones themselves.
pub fn remote_licensed(ctx: &Ctx) -> Res<bool> {
    let state = license_status(ctx)?.state;
    Ok((state == "licensed" || state == "unconfigured") && mobile_access(ctx)?.allowed)
}

/// Phones are a paid option, limited to the number after "mobile" in the license edition.
pub fn assert_can_pair(ctx: &Ctx) -> Res<()> {
    let access = mobile_access(ctx)?;
    if !access.allowed {
        bail!("mobile_not_licensed");
    }
    if let Some(limit) = access.limit {
        if active_device_count(ctx)? >= limit {
            return Err(app_with("mobile_device_limit", [("max", limit.into())]));
        }
    }
    Ok(())
}

// ---------- the shop server ----------

pub async fn stop_mobile(core: &Arc<Core>) {
    let running = core.mobile.server.lock().await.take();
    *core.mobile.state.lock().unwrap() = ServerStatus::default();
    if let Some(r) = running {
        let _ = r.shutdown.send(());
        // Open keep-alive connections must not hold the port: give them a moment, then cut.
        let abort = r.task.abort_handle();
        if tokio::time::timeout(std::time::Duration::from_secs(2), r.task).await.is_err() {
            abort.abort();
        }
    }
}

pub async fn start_mobile(core: &Arc<Core>) -> Res<()> {
    stop_mobile(core).await;
    let port = core.desktop(get_config)?.port;
    match tokio::net::TcpListener::bind(("0.0.0.0", port as u16)).await {
        Ok(listener) => {
            let actual = listener.local_addr().map(|a| a.port() as i64).unwrap_or(port);
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let app = server::router(core.clone(), false);
            let task = tokio::spawn(async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async move {
                        let _ = rx.await;
                    })
                    .await;
            });
            *core.mobile.server.lock().await = Some(Running { shutdown: tx, task });
            *core.mobile.state.lock().unwrap() = ServerStatus { state: "running", port: Some(actual), error: None };
        }
        Err(e) => {
            let busy = matches!(e.kind(), std::io::ErrorKind::AddrInUse | std::io::ErrorKind::PermissionDenied);
            let code = match e.kind() {
                std::io::ErrorKind::AddrInUse => "EADDRINUSE".to_owned(),
                std::io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
                _ => e.to_string(),
            };
            if !busy {
                core.log("mobile.start", &e);
            }
            *core.mobile.state.lock().unwrap() = ServerStatus { state: if busy { "port_busy" } else { "error" }, port: Some(port), error: Some(code) };
        }
    }
    Ok(())
}

/// The server runs only when the option is on AND the license includes phones.
pub async fn apply_config(core: &Arc<Core>) -> Res<()> {
    let (enabled, allowed) = core.desktop(|c| Ok((get_config(c)?.enabled, mobile_access(c)?.allowed)))?;
    if enabled && allowed {
        start_mobile(core).await
    } else {
        stop_mobile(core).await;
        Ok(())
    }
}

pub async fn set_config(core: &Arc<Core>, config: MobileConfigInput) -> Res<()> {
    core.desktop(|c| {
        if config.enabled && !mobile_access(c)?.allowed {
            bail!("mobile_not_licensed");
        }
        set_value(c.db, "mobile.enabled", &config.enabled)?;
        set_value(c.db, "mobile.port", &config.port)
    })?;
    apply_config(core).await
}

row! {
    pub struct RemoteOverview {
        #[ts(type = "'off' | 'full' | 'view'")]
        pub mode: String,
        pub licensed: bool,
        #[serde(flatten)]
        #[ts(flatten)]
        pub status: RemoteStatus,
        pub configured: bool,
    }
}

row! {
    pub struct MobileOverview {
        pub enabled: bool,
        pub port: i64,
        #[ts(type = "'stopped' | 'running' | 'port_busy' | 'error'")]
        pub state: String,
        pub error: Option<String>,
        pub addresses: Vec<String>,
        pub server_id: String,
        pub store_name: String,
        pub licensed: bool,
        pub device_limit: Option<i64>,
        pub device_count: i64,
        pub apk: Option<ApkInfo>,
        pub apk_urls: Vec<String>,
        pub remote: RemoteOverview,
    }
}

pub fn overview(core: &Arc<Core>) -> Res<MobileOverview> {
    let state = core.mobile.state.lock().unwrap().clone();
    let remote_status = core.mobile.remote_status();
    let configured = {
        let (url, key) = core.mobile.remote_config();
        !url.is_empty() && !key.is_empty()
    };
    core.desktop(|c| {
        let config = get_config(c)?;
        let access = mobile_access(c)?;
        let port = state.port.unwrap_or(config.port);
        let addresses = lan_addresses();
        Ok(MobileOverview {
            enabled: config.enabled,
            port,
            state: state.state.into(),
            error: state.error.clone(),
            apk_urls: addresses.iter().map(|a| format!("http://{a}:{port}/app.apk")).collect(),
            addresses,
            server_id: server_id(c)?,
            store_name: get_public(c.db)?.store_name,
            licensed: access.allowed,
            device_limit: access.limit,
            device_count: active_device_count(c)?,
            apk: apk_info(core.paths.apk_dir()),
            remote: RemoteOverview { mode: remote_mode(c)?, licensed: remote_licensed(c)?, status: remote_status, configured },
        })
    })
}

row! { pub struct PairQr { pub v: i64, pub id: String, pub name: String, pub hosts: Vec<String>, pub port: i64, pub code: String } }
row! { pub struct PairStart { pub code: String, pub expires_at: String, pub qr: PairQr } }

/// A fresh pairing code and the JSON the QR code carries.
pub fn start_pairing(core: &Arc<Core>) -> Res<PairStart> {
    core.desktop(assert_can_pair)?;
    let state = core.mobile.state.lock().unwrap().clone();
    let port = match (state.state, state.port) {
        ("running", Some(p)) if p != 0 => p,
        _ => bail!("mobile_not_running"),
    };
    let code = core.mobile.pairing.new_code();
    let (id, name) = core.desktop(|c| Ok((server_id(c)?, get_public(c.db)?.store_name)))?;
    Ok(PairStart { qr: PairQr { v: 1, id, name, hosts: lan_addresses(), port, code: code.code.clone() }, code: code.code, expires_at: code.expires_at })
}

// ---------- outside the shop: the Supabase mailbox ----------

pub async fn stop_remote(core: &Arc<Core>) {
    let service = core.mobile.service.lock().await.take();
    if let Some(s) = service {
        s.stop();
    }
}

/// Starts or stops the mailbox service to match the setting and the license.
pub async fn apply_remote(core: &Arc<Core>) -> Res<()> {
    let (mode, licensed) = core.desktop(|c| Ok((remote_mode(c)?, remote_licensed(c)?)))?;
    if mode == "off" || !licensed {
        stop_remote(core).await;
        return Ok(());
    }
    let mut slot = core.mobile.service.lock().await;
    if slot.is_none() {
        *slot = Some(mailbox::Service::start(core));
    }
    Ok(())
}

pub async fn set_remote_mode(core: &Arc<Core>, mode: &str) -> Res<()> {
    core.desktop(|c| {
        if mode != "off" && !remote_licensed(c)? {
            bail!("mobile_not_licensed");
        }
        set_value(c.db, "mobile.remote.mode", &mode)
    })?;
    // Full <-> view only needs no reconnect (every request reads the setting); off <-> on starts or stops the service.
    apply_remote(core).await
}

/// A one-time code for a phone that cannot reach the shop Wi-Fi. Needs outside access to be on.
pub async fn start_remote_pair(core: &Arc<Core>) -> Res<super::remote_pairing::RemoteCode> {
    core.desktop(assert_can_pair)?;
    let mode = core.desktop(remote_mode)?;
    let service = core.mobile.service.lock().await;
    let Some(service) = service.as_ref().filter(|_| mode != "off") else { bail!("remote_off") };
    let started = core.mobile.remote_pairing.start();
    service.beat_now(); // the pairing mailbox must be known to Supabase before the phone looks for it
    Ok(started)
}

/// A phone away from the shop finishing a remote pairing: it arrived in the private mailbox of a one-time code, sealed
/// with a key only the code holder can derive. The answer carries the phone's real token, mailbox and key.
pub fn handle_pair_request(core: &Arc<Core>, request: &wire::Request) -> Answer {
    let result = core.desktop(|c| -> Res<(super::devices::Created, String, String, String)> {
        assert_can_pair(c)?;
        let name: String = request.body.get("deviceName").and_then(|n| n.as_str()).map(|n| n.chars().take(60).collect()).unwrap_or_default();
        let created = create_device(c, &name)?;
        Ok((created, server_id(c)?, get_public(c.db)?.store_name, remote_mode(c)?))
    });
    match result {
        Ok((created, id, store, mode)) => {
            core.mobile.remote_pairing.use_up(&created.device.id);
            core.mobile.beat_now(); // the new phone's own mailbox must exist in Supabase before it first looks for the PC
            let device: &Device = &created.device;
            Answer {
                status: 200,
                body: json!({
                    "token": created.token,
                    "device": device,
                    "serverId": id,
                    "storeName": store,
                    "mode": mode,
                    "remote": { "mailbox": created.remote.mailbox, "key": created.remote.key, "deviceId": device.id, "url": REMOTE_URL, "anonKey": REMOTE_ANON_KEY },
                }),
            }
        }
        Err(Error::App { code, params }) => Answer {
            status: if code == "mobile_device_limit" || code == "mobile_not_licensed" { 403 } else { 400 },
            body: json!({ "ok": false, "error": { "code": code, "params": params } }),
        },
        Err(_) => server::failed(400, "unexpected"),
    }
}

/// Everything off: the shop server and the mailbox service.
pub async fn shutdown(core: &Arc<Core>) {
    stop_remote(core).await;
    stop_mobile(core).await;
}

/// At startup: bring both in line with the settings. Errors are logged, never shown.
pub async fn start_all(core: &Arc<Core>) {
    if let Err(e) = apply_config(core).await {
        core.log("mobile.start", &e);
    }
    if let Err(e) = apply_remote(core).await {
        core.log("mobile.remote", &e);
    }
}

pub fn not_running() -> Error {
    app("mobile_not_running")
}

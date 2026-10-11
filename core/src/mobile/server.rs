// The HTTP face of the app for paired phones. It never holds business logic: /api/{channel} hands the payload to the
// same run_channel() the desktop window uses. This file only decides who may call what.
use super::allowlist::{is_allowed, ACTOR_CHANNELS};
use super::apk::{apk_info, apk_path};
use super::devices::{create_device, find_by_id, find_by_token, get_device, touch};
use super::manager::{assert_can_pair, remote_mode, server_id, REMOTE_ANON_KEY, REMOTE_URL};
use crate::caller::{Caller, DeviceCaller, Via};
use crate::core::Core;
use crate::error::{app, app_with, Error, IpcResult, Res};
use crate::services::files::{save_bytes, stored_file_path};
use crate::services::license::{is_read_only, PRODUCT_CODE};
use crate::services::settings::get_public;
use crate::util::now_ms;
use axum::body::{to_bytes, Body, Bytes};
use axum::extract::{FromRequest, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::Arc;

pub const API_VERSION: i64 = 1;
/// Header set on a request injected from the mailbox: the id of the device whose key opened the message. The
/// remote router never listens on a port, so nothing outside can send it.
pub const DEVICE_HEADER: &str = "x-psm-device";
const MAX_FILE: usize = 10 * 1024 * 1024;
const RATE_LIMIT: usize = 20; // requests per second per device

#[derive(Clone)]
pub struct ServerState {
    pub core: Arc<Core>,
    /// True for the router that serves the mailbox: every request comes from outside the shop, and the device is named
    /// by DEVICE_HEADER instead of a token (the message was already opened with the device's key).
    pub remote: bool,
}

impl ServerState {
    fn via(&self) -> Via {
        if self.remote {
            Via::Remote
        } else {
            Via::Lan
        }
    }
}

/// An error answered in the usual envelope, with an HTTP status that matches it.
pub struct ApiError(pub Error);

impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        ApiError(e)
    }
}

fn status_for(code: &str) -> StatusCode {
    let n = match code {
        "unauthorized" => 401,
        "device_revoked"
        | "forbidden"
        | "invalid_code"
        | "code_expired"
        | "read_only"
        | "mobile_not_licensed"
        | "mobile_device_limit"
        | "remote_read_only"
        | "pairing_lan_only" => 403,
        "rate_limited" | "pairing_blocked" => 429,
        "file_too_large" => 413,
        "file_type_not_allowed" => 415,
        "not_found" => 404,
        "unexpected" => 500,
        _ => 400,
    };
    StatusCode::from_u16(n).unwrap()
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = IpcResult::err(&self.0);
        (status_for(self.0.code()), Json(body)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

/// The file type is decided by the first bytes, never by the name or Content-Type the phone claims.
fn image_extension(b: &[u8]) -> Option<&'static str> {
    if b.len() > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff {
        return Some(".jpg");
    }
    if b.len() > 8 && b[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(".png");
    }
    if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(".webp");
    }
    None
}

static SECRET_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)cost|profit|margin|commission").unwrap());

/// Costs and profit never leave the PC for a phone that is not an OWNER: every cost, profit, margin and commission
/// field is removed from the response, so a handler that forgets cannot leak it.
pub fn strip_costs(value: Value) -> Value {
    match value {
        Value::Array(a) => Value::Array(a.into_iter().map(strip_costs).collect()),
        Value::Object(o) => Value::Object(o.into_iter().filter(|(k, _)| !SECRET_KEY.is_match(k)).map(|(k, v)| (k, strip_costs(v))).collect()),
        other => other,
    }
}

pub fn router(core: Arc<Core>, remote: bool) -> Router {
    let state = ServerState { core, remote };
    Router::new()
        .route("/hello", get(hello))
        .route("/app.apk", get(apk))
        .route("/pair", post(pair))
        .route("/api/{channel}", post(api))
        .route("/me", get(me))
        .route("/files", post(upload))
        .route("/files/{name}", get(download))
        .fallback(|| async { ApiError(app("not_found")) })
        .layer(axum::extract::DefaultBodyLimit::max(MAX_FILE + 1024 * 1024))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

/// CORS: any origin. The token is the security, not the origin.
async fn cors(req: Request, next: Next) -> Response {
    let options = req.method() == Method::OPTIONS;
    let mut res = if options { StatusCode::NO_CONTENT.into_response() } else { next.run(req).await };
    let h = res.headers_mut();
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    h.insert("access-control-allow-headers", HeaderValue::from_static("Authorization, Content-Type"));
    h.insert("access-control-allow-methods", HeaderValue::from_static("GET, POST, OPTIONS"));
    h.insert("access-control-max-age", HeaderValue::from_static("600"));
    res
}

async fn hello(State(s): State<ServerState>) -> ApiResult<Json<Value>> {
    let core = &s.core;
    let (id, store, mode) = core.desktop(|c| Ok((server_id(c)?, get_public(c.db)?.store_name, remote_mode(c)?)))?;
    Ok(Json(json!({
        "app": PRODUCT_CODE,
        "serverId": id,
        "storeName": store,
        "appVersion": core.app_version,
        "apiVersion": API_VERSION,
        "apk": apk_info(core.paths.apk_dir()),
        "remote": { "mode": mode },
    })))
}

/// The phone app itself, so a phone on the shop Wi-Fi can download and install it (no token: it has none yet).
async fn apk(State(s): State<ServerState>) -> ApiResult<Response> {
    let dir = s.core.paths.apk_dir();
    let info = match apk_info(dir) {
        Some(i) if !s.remote => i, // never from outside the shop
        _ => return Err(app("not_found").into()),
    };
    let bytes = tokio::fs::read(apk_path(dir)).await.map_err(|_| ApiError(app("not_found")))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.android.package-archive".to_owned()),
            (header::CONTENT_DISPOSITION, format!("attachment; filename=\"phone-store-{}.apk\"", info.version_name)),
        ],
        bytes,
    )
        .into_response())
}

/// JSON body, or nothing (channels without input). Anything unparsable is invalid_input.
async fn json_body(body: Body) -> ApiResult<Value> {
    let bytes = to_bytes(body, MAX_FILE + 1024 * 1024).await.map_err(|_| ApiError(app_with("file_too_large", [("mb", 10.into())])))?;
    let text = String::from_utf8_lossy(&bytes);
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text.trim()).map_err(|_| ApiError(app("invalid_input")))
}

async fn pair(State(s): State<ServerState>, body: Body) -> ApiResult<Json<Value>> {
    if s.remote {
        return Err(app("pairing_lan_only").into()); // pairing is for the shop Wi-Fi only
    }
    let body = json_body(body).await?;
    let core = &s.core;
    core.desktop(assert_can_pair)?; // before the code is used up: a refused phone can try again after the owner fixes it
    core.mobile.pairing.consume(body.get("code").and_then(|c| c.as_str()).map(str::trim).unwrap_or(""))?;
    let name: String = body.get("deviceName").and_then(|n| n.as_str()).map(|n| n.chars().take(60).collect()).unwrap_or_default();
    let created = core.desktop(|c| create_device(c, &name))?;
    core.mobile.pairing.mark_paired(&created.device.id);
    // The mailbox name and the key travel once, here, on the shop Wi-Fi. The Supabase address and anon key are public.
    Ok(Json(json!({
        "token": created.token,
        "device": created.device,
        "remote": { "mailbox": created.remote.mailbox, "key": created.remote.key, "deviceId": created.device.id, "url": REMOTE_URL, "anonKey": REMOTE_ANON_KEY },
    })))
}

fn rate_limited(core: &Core, device_id: &str) -> bool {
    let at = now_ms();
    let mut hits = core.mobile.rate.lock().unwrap();
    let recent = hits.entry(device_id.to_owned()).or_default();
    recent.retain(|t| at - t < 1000);
    recent.push(at);
    recent.len() > RATE_LIMIT
}

/// Bearer token -> device (or, from the mailbox, the device named by DEVICE_HEADER). Looked up on every request, so a
/// revoked device is refused immediately.
fn authenticate(s: &ServerState, headers: &HeaderMap) -> Res<DeviceCaller> {
    let core = &s.core;
    let device = core.desktop(|c| {
        if s.remote {
            match headers.get(DEVICE_HEADER).and_then(|v| v.to_str().ok()) {
                Some(id) => find_by_id(c, id),
                None => Ok(None),
            }
        } else {
            static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^Bearer\s+(\S+)$").unwrap());
            let header = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("");
            match BEARER.captures(header) {
                Some(m) => find_by_token(c, &m[1]),
                None => Ok(None),
            }
        }
    })?;
    let Some(device) = device else { return Err(app("unauthorized")) };
    if device.revoked_at.is_some() {
        return Err(app("device_revoked"));
    }
    if rate_limited(core, &device.id) {
        return Err(app("rate_limited"));
    }
    core.desktop(|c| touch(core, c, &device.id, s.via()))?;
    Ok(DeviceCaller { device_id: device.id, role: device.role, employee_id: device.employee_id, via: s.via() })
}

/// Phones cannot choose who they are: the device's employee replaces any employeeId in the input.
fn with_actor(channel: &str, payload: Value, caller: &DeviceCaller) -> Value {
    let Value::Object(mut input) = payload else { return payload };
    // invoicePath names a file on the PC to copy: a phone may only refer to a photo it uploaded (invoiceFile).
    if channel == "purchases.create" {
        input.insert("invoicePath".into(), Value::Null);
    }
    if ACTOR_CHANNELS.contains(&channel) {
        if let Some(e) = &caller.employee_id {
            input.insert("employeeId".into(), json!(e));
        } else if caller.role.as_deref() != Some("OWNER") {
            input.insert("employeeId".into(), Value::Null);
        }
    }
    Value::Object(input)
}

async fn api(State(s): State<ServerState>, Path(channel): Path<String>, headers: HeaderMap, body: Body) -> ApiResult<Json<Value>> {
    let caller = authenticate(&s, &headers)?;
    if !is_allowed(&channel, caller.role.as_deref()) {
        return Err(app("forbidden").into());
    }
    if caller.via == Via::Remote && s.core.desktop(remote_mode)? != "full" && crate::api::is_write_channel(&channel) {
        return Err(app("remote_read_only").into());
    }
    let payload = with_actor(&channel, json_body(body).await?, &caller);
    let owner = caller.role.as_deref() == Some("OWNER");
    let result = crate::api::run_channel(&s.core, &channel, payload, Caller::Device(caller)).await;
    let mut value = serde_json::to_value(&result).map_err(|e| ApiError(crate::error::internal(e)))?;
    if result.is_ok() && !owner {
        if let Some(data) = value.get_mut("data") {
            *data = strip_costs(data.take());
        }
    }
    Ok(Json(value))
}

async fn me(State(s): State<ServerState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let caller = authenticate(&s, &headers)?;
    let (device, mode) = s.core.desktop(|c| Ok((get_device(c, &caller.device_id)?, remote_mode(c)?)))?;
    let mut data = serde_json::to_value(device).unwrap_or_default();
    // `remote` tells the phone whether it may change things from outside the shop, so it can hide those actions.
    data["remote"] = json!({ "writes": mode == "full" });
    Ok(Json(json!({ "ok": true, "data": data })))
}

async fn upload(State(s): State<ServerState>, req: Request) -> ApiResult<Json<Value>> {
    let caller = authenticate(&s, req.headers())?;
    if caller.role.is_none() {
        return Err(app("forbidden").into());
    }
    if caller.via == Via::Remote && s.core.desktop(remote_mode)? != "full" {
        return Err(app("remote_read_only").into());
    }
    if s.core.desktop(is_read_only)? {
        return Err(app("read_only").into());
    }
    let too_large = || ApiError(app_with("file_too_large", [("mb", 10.into())]));
    let wrong_type = || ApiError(app_with("file_type_not_allowed", [("types", ".jpg .png .webp".into())]));
    let content_type = req.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
    let bytes: Bytes = if content_type.starts_with("multipart/form-data") {
        let mut form = axum::extract::Multipart::from_request(req, &()).await.map_err(|_| ApiError(app("invalid_input")))?;
        let field = form.next_field().await.map_err(|_| too_large())?.ok_or_else(|| ApiError(app("invalid_input")))?;
        field.bytes().await.map_err(|_| too_large())?
    } else if ["image/jpeg", "image/png", "image/webp"].iter().any(|t| content_type.starts_with(t)) {
        to_bytes(req.into_body(), MAX_FILE + 1).await.map_err(|_| too_large())?
    } else {
        return Err(wrong_type());
    };
    if bytes.len() > MAX_FILE {
        return Err(too_large());
    }
    let ext = image_extension(&bytes).ok_or_else(wrong_type)?;
    let name = save_bytes(&s.core.paths.files_dir(), &bytes, ext)?;
    Ok(Json(json!({ "name": name })))
}

static STORED: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f-]{36}\.(jpe?g|png|webp)$").unwrap());

async fn download(State(s): State<ServerState>, Path(name): Path<String>, headers: HeaderMap) -> ApiResult<Response> {
    let caller = authenticate(&s, &headers)?;
    if caller.role.is_none() {
        return Err(app("forbidden").into());
    }
    if !STORED.is_match(&name) {
        return Err(app("not_found").into());
    }
    let path = stored_file_path(&s.core.paths.files_dir(), &name);
    let bytes = tokio::fs::read(&path).await.map_err(|_| ApiError(app("not_found")))?;
    let kind = if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Ok(([(header::CONTENT_TYPE, kind), (header::CACHE_CONTROL, "private, max-age=3600")], bytes).into_response())
}

// ---------- requests from the mailbox ----------

pub struct Answer {
    pub status: u16,
    pub body: Value,
}

pub fn failed(status: u16, code: &str) -> Answer {
    Answer { status, body: json!({ "ok": false, "error": { "code": code, "params": {} } }) }
}

const MAX_ANSWER_BYTES: usize = 4 * 1024 * 1024; // the sealed answer must stay under 6 MB (base64 grows it by a third)
static REMOTE_PATH: Lazy<Regex> = Lazy::new(|| Regex::new(r"^/(api/[A-Za-z0-9_.-]+|me|files(/[0-9a-f-]{36}\.(jpe?g|png|webp))?)$").unwrap());

/// Photos leave the shop at most 1024 px wide, as JPEG.
pub fn resize_image(bytes: &[u8]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(bytes).ok()?;
    let img = if img.width() > 1024 { img.resize(1024, u32::MAX, image::imageops::FilterType::Triangle) } else { img };
    let mut out = std::io::Cursor::new(Vec::new());
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 70);
    img.to_rgb8().write_with_encoder(encoder).ok()?;
    Some(out.into_inner())
}

/// A request from the mailbox goes through the very same HTTP handling as one from the shop Wi-Fi.
pub async fn handle_remote_request(core: Arc<Core>, device_id: &str, request: &wire::Request) -> Answer {
    use base64::Engine;
    use tower::ServiceExt;
    let b64 = base64::engine::general_purpose::STANDARD;
    if request.method != "GET" && request.method != "POST" {
        return failed(405, "invalid_input");
    }
    if !REMOTE_PATH.is_match(&request.path) {
        return failed(400, "invalid_input");
    }
    let mut builder = axum::http::Request::builder().method(request.method.as_str()).uri(&request.path).header(DEVICE_HEADER, device_id);
    let body = match (&request.body, request.path.as_str()) {
        (Value::Object(o), "/files") if o.get("b64").is_some_and(|v| v.is_string()) && o.get("type").is_some_and(|v| v.is_string()) => {
            // A photo: the bytes travel as base64 inside the message.
            builder = builder.header(header::CONTENT_TYPE, o["type"].as_str().unwrap());
            Body::from(b64.decode(o["b64"].as_str().unwrap()).unwrap_or_default())
        }
        _ if request.method == "POST" => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            let v = if request.body.is_null() { json!({}) } else { request.body.clone() };
            Body::from(v.to_string())
        }
        _ => Body::empty(),
    };
    let Ok(req) = builder.body(body) else { return failed(400, "invalid_input") };
    let Ok(res) = router(core, true).oneshot(req).await;
    let status = res.status().as_u16();
    let kind = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let Ok(raw) = to_bytes(res.into_body(), usize::MAX).await else { return failed(502, "response_too_large") };
    if kind.to_lowercase().starts_with("application/json") {
        if raw.len() > MAX_ANSWER_BYTES {
            return failed(502, "response_too_large");
        }
        let body = if raw.is_empty() { Value::Null } else { serde_json::from_slice(&raw).unwrap_or(Value::Null) };
        return Answer { status, body };
    }
    // A photo, sent resized: outside the shop every byte costs mobile data and free-plan space.
    let mut out_type = kind.split(';').next().filter(|t| !t.is_empty()).unwrap_or("image/jpeg").to_owned();
    let mut raw = raw.to_vec();
    if status == 200 && kind.starts_with("image/") {
        if let Some(small) = resize_image(&raw).filter(|s| s.len() < raw.len()) {
            raw = small;
            out_type = "image/jpeg".into();
        }
    }
    if raw.len() > MAX_ANSWER_BYTES {
        return failed(502, "response_too_large");
    }
    Answer { status, body: json!({ "b64": b64.encode(&raw), "type": out_type }) }
}

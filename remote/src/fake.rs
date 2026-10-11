//! A small in-process fake of the five `mb_*` functions and of the Realtime
//! socket, following `supabase/schema.sql`. For tests only.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::StatusCode,
    response::IntoResponse,
    routing::{any, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::broadcast, task::JoinHandle};

struct Shop {
    blocked: bool,
    first_seen: Instant,
    last_seen: Instant,
}

struct Msg {
    id: i64,
    mailbox: String,
    dir: i64,
    body: String,
}

#[derive(Default)]
struct Inner {
    shops: HashMap<String, Shop>,
    msgs: Vec<Msg>,
    next_id: i64,
    sockets: usize,
    joins: usize,
    ws_enabled: bool,
    offline: bool,
    calls: Vec<(String, Value)>,
}

#[derive(Clone)]
struct Shared {
    inner: Arc<Mutex<Inner>>,
    wake: broadcast::Sender<String>,
    kill: broadcast::Sender<()>,
}

pub struct FakeSupabase {
    pub url: String,
    pub anon_key: String,
    shared: Shared,
    task: JoinHandle<()>,
}

pub const MAX_NEW_SHOPS_PER_HOUR: usize = 200;
pub const MAX_WAITING: usize = 500;
pub const MAX_BODY: usize = 350_000;

impl FakeSupabase {
    pub async fn start() -> Self {
        let shared = Shared {
            inner: Arc::new(Mutex::new(Inner {
                next_id: 1,
                ws_enabled: true,
                ..Default::default()
            })),
            wake: broadcast::channel(256).0,
            kill: broadcast::channel(8).0,
        };
        let app = Router::new()
            .route("/rest/v1/rpc/{name}", post(rpc))
            .route("/realtime/v1/websocket", any(ws))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            url,
            anon_key: "anon-test-key".into(),
            shared,
            task,
        }
    }

    pub fn config(&self) -> crate::Config {
        crate::Config::new(&self.url, &self.anon_key)
    }

    pub fn block(&self, mailbox: &str, blocked: bool) {
        if let Some(s) = self.shared.inner.lock().unwrap().shops.get_mut(mailbox) {
            s.blocked = blocked;
        }
    }

    /// Pretend the PC's last beat was this long ago.
    pub fn age_last_seen(&self, mailbox: &str, ago: Duration) {
        if let Some(s) = self.shared.inner.lock().unwrap().shops.get_mut(mailbox) {
            s.last_seen = Instant::now() - ago;
        }
    }

    /// Rows still waiting (not acked): (mailbox, dir, body).
    pub fn waiting(&self) -> Vec<(String, i64, String)> {
        let g = self.shared.inner.lock().unwrap();
        g.msgs
            .iter()
            .map(|m| (m.mailbox.clone(), m.dir, m.body.clone()))
            .collect()
    }

    pub fn shop_count(&self) -> usize {
        self.shared.inner.lock().unwrap().shops.len()
    }

    /// Wake-ups stop being delivered and new sockets are refused (a firewall).
    pub fn set_realtime(&self, on: bool) {
        self.shared.inner.lock().unwrap().ws_enabled = on;
        if !on {
            let _ = self.shared.kill.send(());
        }
    }

    /// Close every open socket (the client should reconnect).
    pub fn kill_sockets(&self) {
        let _ = self.shared.kill.send(());
    }

    /// Sockets that completed the join, in total since start.
    pub fn joins(&self) -> usize {
        self.shared.inner.lock().unwrap().joins
    }

    pub fn open_sockets(&self) -> usize {
        self.shared.inner.lock().unwrap().sockets
    }

    /// Every RPC call received so far: (function name, arguments).
    pub fn calls(&self) -> Vec<(String, Value)> {
        self.shared.inner.lock().unwrap().calls.clone()
    }

    /// While on, every RPC call fails as if Supabase could not be reached.
    pub fn set_offline(&self, offline: bool) {
        self.shared.inner.lock().unwrap().offline = offline;
    }
}

impl Drop for FakeSupabase {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn valid(m: &str) -> bool {
    m.len() == 43
        && m.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn err(code: &str) -> (StatusCode, Json<Value>) {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"code": "P0001", "message": code, "details": null, "hint": null})),
    )
}

type Reply = Result<Json<Value>, (StatusCode, Json<Value>)>;

async fn rpc(State(s): State<Shared>, Path(name): Path<String>, Json(a): Json<Value>) -> Reply {
    let mailbox = a["p_mailbox"].as_str().unwrap_or_default().to_string();
    if !valid(&mailbox) {
        return Err(err("bad_mailbox"));
    }
    let dir = a["p_dir"].as_i64();
    let mut g = s.inner.lock().unwrap();
    if g.offline {
        return Err((StatusCode::SERVICE_UNAVAILABLE, Json(Value::Null)));
    }
    g.calls.push((name.clone(), a.clone()));
    match name.as_str() {
        "mb_beat" => {
            let now = Instant::now();
            if let Some(shop) = g.shops.get_mut(&mailbox) {
                shop.last_seen = now;
                return Ok(Json(json!(shop.blocked)));
            }
            let recent = g
                .shops
                .values()
                .filter(|x| x.first_seen.elapsed() < Duration::from_secs(3600))
                .count();
            if recent >= MAX_NEW_SHOPS_PER_HOUR {
                return Err(err("too_many_new_shops"));
            }
            g.shops.insert(
                mailbox,
                Shop {
                    blocked: false,
                    first_seen: now,
                    last_seen: now,
                },
            );
            Ok(Json(json!(false)))
        }
        "mb_seen" => Ok(Json(match g.shops.get(&mailbox) {
            Some(x) => json!(x.last_seen.elapsed().as_secs()),
            None => Value::Null,
        })),
        "mb_send" => {
            let Some(dir @ (0 | 1)) = dir else {
                return Err(err("bad_dir"));
            };
            let body = a["p_body"].as_str().unwrap_or_default().to_string();
            match g.shops.get(&mailbox) {
                None => return Err(err("mailbox_unknown")),
                Some(x) if x.blocked => return Err(err("mailbox_blocked")),
                _ => {}
            }
            if body.is_empty() || body.len() > MAX_BODY {
                return Err(err("body_too_large"));
            }
            if g.msgs
                .iter()
                .filter(|m| m.mailbox == mailbox && m.dir == dir)
                .count()
                >= MAX_WAITING
            {
                return Err(err("mailbox_full"));
            }
            let id = g.next_id;
            g.next_id += 1;
            g.msgs.push(Msg {
                id,
                mailbox: mailbox.clone(),
                dir,
                body,
            });
            let _ = s.wake.send(mailbox);
            Ok(Json(json!(id)))
        }
        "mb_fetch" => {
            let after = a["p_after_id"].as_i64().unwrap_or(0);
            let rows: Vec<Value> = g
                .msgs
                .iter()
                .filter(|m| m.mailbox == mailbox && Some(m.dir) == dir && m.id > after)
                .take(50)
                .map(|m| json!({"id": m.id, "body": m.body}))
                .collect();
            Ok(Json(Value::Array(rows)))
        }
        "mb_ack" => {
            let up = a["p_up_to_id"].as_i64().unwrap_or(0);
            g.msgs
                .retain(|m| !(m.mailbox == mailbox && Some(m.dir) == dir && m.id <= up));
            Ok(Json(Value::Null))
        }
        _ => Err((StatusCode::NOT_FOUND, Json(json!({"message": "not_found"})))),
    }
}

async fn ws(State(s): State<Shared>, up: WebSocketUpgrade) -> impl IntoResponse {
    if !s.inner.lock().unwrap().ws_enabled {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    up.on_upgrade(move |sock| socket(s, sock)).into_response()
}

async fn socket(s: Shared, mut sock: WebSocket) {
    s.inner.lock().unwrap().sockets += 1;
    let mut wake = s.wake.subscribe();
    let mut kill = s.kill.subscribe();
    let mut topic: Option<String> = None;
    loop {
        tokio::select! {
            _ = kill.recv() => break,
            m = wake.recv() => {
                let Ok(mailbox) = m else { continue };
                if topic.as_deref() == Some(&format!("realtime:mb:{mailbox}")) {
                    let msg = json!({"topic": topic, "event": "broadcast", "ref": null,
                        "payload": {"event": "wake", "type": "broadcast", "payload": {"dir": 0}}});
                    if sock.send(Message::text(msg.to_string())).await.is_err() { break; }
                }
            }
            m = sock.recv() => {
                let Some(Ok(Message::Text(t))) = m else {
                    if matches!(m, Some(Ok(Message::Close(_))) | None | Some(Err(_))) { break; }
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                let reply = |r: &Value, t: &Value| json!({"topic": t, "event": "phx_reply", "ref": r, "payload": {"status": "ok", "response": {}}});
                match v["event"].as_str() {
                    Some("phx_join") => {
                        topic = v["topic"].as_str().map(str::to_string);
                        s.inner.lock().unwrap().joins += 1;
                        if sock.send(Message::text(reply(&v["ref"], &v["topic"]).to_string())).await.is_err() { break; }
                    }
                    Some("heartbeat") => {
                        let r = reply(&v["ref"], &json!("phoenix"));
                        if sock.send(Message::text(r.to_string())).await.is_err() { break; }
                    }
                    _ => {}
                }
            }
        }
    }
    s.inner.lock().unwrap().sockets -= 1;
}

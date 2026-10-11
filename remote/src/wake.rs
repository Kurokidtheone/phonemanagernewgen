use std::{sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    sync::{watch, Notify},
    task::JoinHandle,
    time,
};
use tokio_tungstenite::tungstenite::Message;

use crate::Config;

/// Reconnect delays: start, doubling up to a maximum.
#[derive(Debug, Clone, Copy)]
pub struct Backoff {
    pub min: Duration,
    pub max: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self {
            min: Duration::from_secs(2),
            max: Duration::from_secs(60),
        }
    }
}

/// Keeps one Realtime socket joined to the topic of a mailbox. Every wake-up
/// calls `notify`. Dropping the listener closes the socket.
pub struct WakeListener {
    connected: watch::Receiver<bool>,
    task: JoinHandle<()>,
}

const HEARTBEAT: Duration = Duration::from_secs(25);

impl WakeListener {
    pub fn start(cfg: &Config, mailbox: &str, notify: Arc<Notify>) -> Self {
        Self::start_with(cfg, mailbox, notify, Backoff::default(), HEARTBEAT)
    }

    pub fn start_with(
        cfg: &Config,
        mailbox: &str,
        notify: Arc<Notify>,
        backoff: Backoff,
        heartbeat: Duration,
    ) -> Self {
        crate::install_tls();
        let (tx, rx) = watch::channel(false);
        let url = cfg.websocket_url();
        let topic = format!("realtime:mb:{mailbox}");
        let task = tokio::spawn(async move {
            let mut delay = backoff.min;
            loop {
                if run_once(
                    &url,
                    &topic,
                    &notify,
                    &tx,
                    heartbeat,
                    &mut delay,
                    backoff.min,
                )
                .await
                {
                    delay = backoff.min;
                }
                let _ = tx.send(false);
                time::sleep(delay).await;
                delay = (delay * 2).min(backoff.max);
            }
        });
        Self {
            connected: rx,
            task,
        }
    }

    /// True while the socket is joined to the topic.
    pub fn connected(&self) -> bool {
        *self.connected.borrow()
    }

    pub fn watch(&self) -> watch::Receiver<bool> {
        self.connected.clone()
    }
}

impl Drop for WakeListener {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// One connection. Returns true when the join succeeded (so the backoff resets).
async fn run_once(
    url: &str,
    topic: &str,
    notify: &Notify,
    connected: &watch::Sender<bool>,
    heartbeat: Duration,
    _delay: &mut Duration,
    _min: Duration,
) -> bool {
    let Ok((mut ws, _)) = tokio_tungstenite::connect_async(url).await else {
        return false;
    };
    // Protocol 1.0.0: JSON objects. (2.0.0 sends broadcasts as binary frames.)
    let join = json!({"topic": topic, "event": "phx_join", "ref": "1", "join_ref": "1", "payload": {
        "config": {
            "broadcast": {"ack": false, "self": false},
            "presence": {"enabled": false},
            "postgres_changes": [],
            "private": false
        }
    }});
    if ws.send(Message::text(join.to_string())).await.is_err() {
        return false;
    }
    let mut joined = false;
    let mut beat = time::interval(heartbeat);
    beat.tick().await;
    let mut n = 1u64;
    loop {
        tokio::select! {
            _ = beat.tick() => {
                n += 1;
                let hb = json!({"topic": "phoenix", "event": "heartbeat", "ref": n.to_string(), "payload": {}});
                if ws.send(Message::text(hb.to_string())).await.is_err() {
                    return joined;
                }
            }
            msg = ws.next() => {
                let Some(Ok(msg)) = msg else { return joined };
                match msg {
                    Message::Text(t) => {
                        let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                        if v["topic"].as_str() != Some(topic) {
                            continue;
                        }
                        match v["event"].as_str() {
                            Some("phx_reply") if !joined => {
                                if v["payload"]["status"].as_str() == Some("ok") {
                                    joined = true;
                                    let _ = connected.send(true);
                                    // Anything sent while we were not joined.
                                    notify.notify_one();
                                }
                            }
                            Some("broadcast") => notify.notify_one(),
                            Some("phx_close") | Some("phx_error") => return joined,
                            _ => {}
                        }
                    }
                    Message::Ping(p) => {
                        let _ = ws.send(Message::Pong(p)).await;
                    }
                    Message::Close(_) => return joined,
                    _ => {}
                }
            }
        }
    }
}

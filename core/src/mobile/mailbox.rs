// Access from outside the shop. The PC and a phone leave each other end-to-end encrypted messages in a Supabase
// mailbox (see supabase/): this service beats every 20 seconds so the phone can see the PC is alive, fetches what is
// waiting (on a wake-up and at least every 20 seconds), opens each message with the phone's own key and hands it to
// the same HTTP handling as a request from the shop Wi-Fi. It only makes outgoing connections, so the shop's router
// needs no open port.
use super::devices::remote_devices;
use super::manager::handle_pair_request;
use super::remote_pairing::PAIRING_DEVICE_ID;
use super::server::{failed, handle_remote_request, Answer};
use crate::core::Core;
use crate::services::license::device_id;
use crate::services::settings::get_public;
use crate::util::{now, now_ms};
use remote::{send_sealed, Config, Dir, Inbox, Incoming, Mailbox, WakeListener};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tokio::sync::Notify;

row! {
    pub struct RemoteStatus {
        #[ts(type = "'off' | 'not_configured' | 'no_phone' | 'connecting' | 'connected' | 'blocked' | 'no_internet' | 'paused'")]
        pub state: String,
        /// The network or server error behind no_internet, when known.
        pub reason: Option<String>,
        pub since: String,
        /// Messages that did not open since the service started.
        pub dropped: i64,
    }
}

impl RemoteStatus {
    pub fn off() -> Self {
        Self { state: "off".into(), reason: None, since: crate::util::ms_to_iso(0), dropped: 0 }
    }
}

/// Timers and the Supabase project, changeable by tests.
#[derive(Clone)]
pub struct Tuning {
    pub url: String,
    pub anon_key: String,
    pub beat: Duration,
    pub fetch: Duration,
    pub max_age_ms: i64,
    pub seen_for_ms: i64,
    pub fail_limit: usize,
    pub fail_window_ms: i64,
    pub pause_ms: i64,
    /// Keep Realtime sockets open for wake-ups (off: polling only).
    pub wake: bool,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            url: super::manager::REMOTE_URL.into(),
            anon_key: super::manager::REMOTE_ANON_KEY.into(),
            beat: Duration::from_secs(20),
            fetch: Duration::from_secs(20),
            max_age_ms: 120_000,
            seen_for_ms: 20 * 60_000,
            fail_limit: 20,
            fail_window_ms: 60_000,
            pause_ms: 5 * 60_000,
            wake: true,
        }
    }
}

#[derive(Clone)]
struct Target {
    id: String,
    mailbox: String,
    key: String,
    /// The private mailbox of a one-time pairing code: it only ever answers /pair.
    pairing: bool,
}

pub struct Service {
    status: Arc<Mutex<RemoteStatus>>,
    beat_now: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl Service {
    pub fn start(core: &Arc<Core>) -> Service {
        let tuning = core.mobile.tuning.lock().unwrap().clone();
        let status = Arc::new(Mutex::new(RemoteStatus { state: "connecting".into(), reason: None, since: now(), dropped: 0 }));
        let beat_now = Arc::new(Notify::new());
        let worker = Worker {
            core: Arc::downgrade(core),
            tuning: tuning.clone(),
            status: status.clone(),
            mb: Mailbox::with_timeout(Config::new(&tuning.url, &tuning.anon_key), Duration::from_secs(15)),
            inboxes: HashMap::new(),
            listeners: HashMap::new(),
            wake: Arc::new(Notify::new()),
            seen: HashMap::new(),
            failures: Vec::new(),
            paused_until: 0,
            dropped: 0,
        };
        let beat = beat_now.clone();
        let task = tokio::spawn(worker.run(beat));
        Service { status, beat_now, task }
    }

    pub fn status(&self) -> RemoteStatus {
        self.status.lock().unwrap().clone()
    }

    /// Beat now (a new phone or pairing mailbox must exist in Supabase before the phone looks for it).
    pub fn beat_now(&self) {
        self.beat_now.notify_one();
    }

    pub fn stop(self) {
        self.task.abort();
    }
}

struct Worker {
    core: Weak<Core>,
    tuning: Tuning,
    status: Arc<Mutex<RemoteStatus>>,
    mb: Mailbox,
    inboxes: HashMap<String, (String, Inbox)>,
    listeners: HashMap<String, WakeListener>,
    wake: Arc<Notify>,
    seen: HashMap<String, i64>,
    failures: Vec<i64>,
    paused_until: i64,
    dropped: i64,
}

impl Worker {
    fn set(&self, state: &str, reason: Option<String>) {
        let mut s = self.status.lock().unwrap();
        if s.state != state || s.reason != reason {
            *s = RemoteStatus { state: state.into(), reason, since: now(), dropped: self.dropped };
        } else {
            s.dropped = self.dropped;
        }
    }

    fn state(&self) -> String {
        self.status.lock().unwrap().state.clone()
    }

    async fn run(mut self, beat_now: Arc<Notify>) {
        if self.tuning.url.is_empty() || self.tuning.anon_key.is_empty() {
            self.set("not_configured", None);
            return;
        }
        self.set("connecting", None);
        self.beat().await;
        self.fetch_all().await;
        let mut beat = tokio::time::interval(self.tuning.beat);
        let mut fetch = tokio::time::interval(self.tuning.fetch);
        beat.tick().await;
        fetch.tick().await;
        let wake = self.wake.clone();
        loop {
            tokio::select! {
                _ = beat.tick() => self.beat().await,
                _ = beat_now.notified() => self.beat().await,
                _ = fetch.tick() => self.fetch_all().await,
                _ = wake.notified() => self.fetch_all().await,
            }
            if self.core.upgrade().is_none() {
                return;
            }
        }
    }

    /// The phones' mailboxes, plus the pairing mailbox while a code is waiting.
    fn targets(&self) -> Vec<Target> {
        let Some(core) = self.core.upgrade() else { return vec![] };
        let mut list: Vec<Target> =
            core.desktop(remote_devices).unwrap_or_default().into_iter().map(|d| Target { id: d.id, mailbox: d.mailbox, key: d.key, pairing: false }).collect();
        if let Some((mailbox, key)) = core.mobile.remote_pairing.active() {
            list.push(Target { id: PAIRING_DEVICE_ID.into(), mailbox, key, pairing: true });
        }
        list
    }

    /// One beat for every phone's mailbox. Also keeps one wake-up socket per mailbox.
    async fn beat(&mut self) {
        let Some(core) = self.core.upgrade() else { return };
        let targets = self.targets();
        if self.tuning.wake {
            self.listeners.retain(|m, _| targets.iter().any(|t| &t.mailbox == m));
            for t in &targets {
                if !self.listeners.contains_key(&t.mailbox) {
                    let l = WakeListener::start(self.mb.config(), &t.mailbox, self.wake.clone());
                    self.listeners.insert(t.mailbox.clone(), l);
                }
            }
        }
        if targets.is_empty() {
            return self.set("no_phone", None);
        }
        if now_ms() < self.paused_until {
            return self.set("paused", None);
        }
        if self.state() == "paused" {
            self.set("connecting", None);
        }
        let (shop, name) = match core.desktop(|c| Ok((device_id(c), get_public(c.db)?.store_name))) {
            Ok(v) => v,
            Err(_) => return,
        };
        drop(core);
        let mut blocked = false;
        for t in &targets {
            match self.mb.beat(&t.mailbox, &shop, &name).await {
                Ok(true) => blocked = true,
                Ok(false) => {}
                Err(e) => return self.set("no_internet", Some(e.to_string())),
            }
        }
        self.set(if blocked { "blocked" } else { "connected" }, None);
    }

    async fn fetch_all(&mut self) {
        for t in self.targets() {
            self.fetch_mailbox(&t).await;
        }
    }

    fn failure(&mut self) {
        let at = now_ms();
        self.dropped += 1;
        let window = self.tuning.fail_window_ms;
        self.failures.retain(|t| at - t < window);
        self.failures.push(at);
        if self.failures.len() >= self.tuning.fail_limit {
            self.failures.clear();
            self.paused_until = at + self.tuning.pause_ms;
            self.set("paused", None);
        } else {
            self.status.lock().unwrap().dropped = self.dropped;
        }
    }

    async fn fetch_mailbox(&mut self, target: &Target) {
        if now_ms() < self.paused_until || self.state() == "blocked" {
            return;
        }
        let fresh = !matches!(self.inboxes.get(&target.mailbox), Some((key, _)) if *key == target.key);
        if fresh {
            self.inboxes.insert(target.mailbox.clone(), (target.key.clone(), Inbox::new(self.mb.clone(), &target.mailbox, Dir::ToPc)));
        }
        let polled = self.inboxes.get_mut(&target.mailbox).unwrap().1.poll().await;
        match polled {
            Ok(items) => {
                for item in items {
                    if now_ms() < self.paused_until {
                        break;
                    }
                    self.handle_one(target, item).await;
                }
            }
            Err(remote::Error::Blocked) => self.set("blocked", None),
            Err(remote::Error::NoInternet) => self.set("no_internet", Some("no_internet".into())),
            Err(_) => {}
        }
    }

    async fn ack(&self, mailbox: &str, row: i64) {
        if let Some((_, inbox)) = self.inboxes.get(mailbox) {
            let _ = inbox.ack(row).await;
        }
    }

    async fn handle_one(&mut self, target: &Target, item: Incoming) {
        let last_row = item.last_row();
        let Incoming::Message { sealed, .. } = item else {
            self.failure();
            return self.ack(&target.mailbox, last_row).await;
        };
        let opened = wire::key_from_string(&target.key)
            .ok()
            .and_then(|key| wire::open(&key, &target.mailbox, &target.id, &sealed).ok())
            .and_then(|plain| serde_json::from_slice::<wire::Request>(&plain).ok());
        let Some(request) = opened else {
            self.failure(); // sealed with another key, damaged, or not ours: dropped and counted
            return self.ack(&target.mailbox, last_row).await;
        };

        // A message seen before is a replay: dropped without an answer.
        let at = now_ms();
        let keep = self.tuning.seen_for_ms;
        self.seen.retain(|_, when| at - *when <= keep);
        if self.seen.contains_key(&request.id) {
            return self.ack(&target.mailbox, last_row).await;
        }
        self.seen.insert(request.id.clone(), at);

        // Older than 2 minutes: the phone gave up long ago, so a late sale must not be applied behind its back.
        let Some(core) = self.core.upgrade() else { return };
        // The one exception is sync.push: its operations carry their own time and an id, so applying them late is safe.
        let late_ok = request.path == "/api/sync.push";
        let answer: Answer = if (at - request.ts).abs() > self.tuning.max_age_ms && !late_ok {
            failed(408, "request_expired")
        } else if target.pairing {
            if request.method == "POST" && request.path == "/pair" {
                handle_pair_request(&core, &request)
            } else {
                failed(400, "invalid_input")
            }
        } else {
            handle_remote_request(core.clone(), &target.id, &request).await
        };
        drop(core);
        let response = wire::Response { id: request.id.clone(), status: answer.status, body: answer.body };
        let Ok(key) = wire::key_from_string(&target.key) else { return };
        let Ok(plain) = serde_json::to_vec(&response) else { return };
        if let Ok(sealed) = wire::seal(&key, &target.mailbox, &target.id, &plain) {
            if send_sealed(&self.mb, &target.mailbox, Dir::ToPhone, &request.id, &sealed).await.is_err() {
                return; // not acked: answered again on the next fetch
            }
        }
        self.ack(&target.mailbox, last_row).await;
    }
}

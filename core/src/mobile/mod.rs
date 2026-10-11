//! Phones: the HTTP server on the shop Wi-Fi, pairing, and outside access through the Supabase mailbox.
pub mod allowlist;
pub mod apk;
pub mod devices;
pub mod mailbox;
pub mod manager;
pub mod pairing;
pub mod remote_pairing;
pub mod server;

use crate::caller::Via;
use std::collections::HashMap;
use std::sync::Mutex;

/// In-memory state of the phone side, held by the core.
#[derive(Default)]
pub struct Mobile {
    pub pairing: pairing::Pairing,
    pub remote_pairing: remote_pairing::RemotePairing,
    pub(crate) last_seen: Mutex<HashMap<String, (i64, Via)>>,
    pub(crate) rate: Mutex<HashMap<String, Vec<i64>>>,
    pub(crate) server: tokio::sync::Mutex<Option<manager::Running>>,
    pub(crate) state: Mutex<manager::ServerStatus>,
    pub(crate) service: tokio::sync::Mutex<Option<mailbox::Service>>,
    /// Supabase project and timers for the mailbox service (tests point it at a fake).
    pub tuning: Mutex<mailbox::Tuning>,
}

impl Mobile {
    pub fn remote_status(&self) -> mailbox::RemoteStatus {
        match self.service.try_lock() {
            Ok(s) => s.as_ref().map(|s| s.status()).unwrap_or_else(mailbox::RemoteStatus::off),
            Err(_) => mailbox::RemoteStatus::off(),
        }
    }

    pub fn remote_config(&self) -> (String, String) {
        let t = self.tuning.lock().unwrap();
        (t.url.clone(), t.anon_key.clone())
    }

    pub fn beat_now(&self) {
        if let Ok(s) = self.service.try_lock() {
            if let Some(s) = s.as_ref() {
                s.beat_now();
            }
        }
    }

    pub fn server_state(&self) -> manager::ServerStatus {
        self.state.lock().unwrap().clone()
    }
}

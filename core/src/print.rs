// A phone asks the PC to print a receipt or a slip. The documents are built by the desktop window (one place for
// the layout, in the shop's language); the core hands it the data and waits for the paper.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

const WAIT: Duration = Duration::from_secs(20);

#[derive(Default)]
pub struct PrintBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl PrintBridge {
    /// Registers a job and returns its id and the receiver of its outcome.
    pub fn register(&self) -> (String, oneshot::Receiver<bool>) {
        let id = crate::util::uuid();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Waits for the window's answer; false after 20 seconds.
    pub async fn wait(&self, id: &str, rx: oneshot::Receiver<bool>) -> bool {
        let ok = tokio::time::timeout(WAIT, rx).await.ok().and_then(|r| r.ok()).unwrap_or(false);
        self.pending.lock().unwrap().remove(id);
        ok
    }

    /// The window reports how the print went.
    pub fn done(&self, id: &str, ok: bool) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(ok);
        }
    }
}

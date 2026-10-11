// What the core asks of the desktop: dialogs, printing, opening folders, restarting. Everything here runs through
// Tauri and its plugins; the core itself knows nothing about the window.
use futures_util::future::BoxFuture;
use psm_core::Host;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct TauriHost {
    pub app: AppHandle,
}

impl TauriHost {
    fn main_window(&self) -> Option<tauri::WebviewWindow> {
        self.app.get_webview_window("main")
    }
}

impl Host for TauriHost {
    fn save_dialog(&self, default_name: String, filter_name: &'static str, extensions: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut dialog = self.app.dialog().file().set_file_name(default_name).add_filter(filter_name, extensions);
        if let Some(w) = self.main_window() {
            dialog = dialog.set_parent(&w);
        }
        dialog.save_file(move |p| {
            let _ = tx.send(p.and_then(|p| p.into_path().ok()));
        });
        Box::pin(async move { rx.await.ok().flatten() })
    }

    fn open_dialog(&self, filter_name: &'static str, extensions: &'static [&'static str]) -> BoxFuture<'static, Option<PathBuf>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut dialog = self.app.dialog().file().add_filter(filter_name, extensions);
        if let Some(w) = self.main_window() {
            dialog = dialog.set_parent(&w);
        }
        dialog.pick_file(move |p| {
            let _ = tx.send(p.and_then(|p| p.into_path().ok()));
        });
        Box::pin(async move { rx.await.ok().flatten() })
    }

    /// The window prints the document itself (a hidden frame and the system print dialog).
    fn print_html(&self, html: String) -> BoxFuture<'static, bool> {
        let sent = self.main_window().map(|w| w.emit("print:html", html).is_ok()).unwrap_or(false);
        Box::pin(async move { sent })
    }

    fn print_silent(&self, html: String, printer: String) -> BoxFuture<'static, bool> {
        let app = self.app.clone();
        Box::pin(async move { crate::print::print_silent(app, html, printer).await })
    }

    fn list_printers(&self) -> BoxFuture<'static, Vec<String>> {
        Box::pin(async { crate::print::list_printers() })
    }

    fn request_print(&self, id: String, kind: &'static str, data: serde_json::Value) -> bool {
        match self.main_window() {
            Some(w) => w.emit("print:request", serde_json::json!({ "id": id, "kind": kind, "data": data })).is_ok(),
            None => false,
        }
    }

    fn open_path(&self, path: PathBuf) {
        let _ = self.app.opener().open_path(path.display().to_string(), None::<&str>);
    }

    fn relaunch(&self) {
        self.app.restart();
    }
}

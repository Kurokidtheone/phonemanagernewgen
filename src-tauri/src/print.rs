// Printing without a dialog, for what a phone sends to the counter: the document is loaded in a hidden window and
// printed with WebView2 on the printer chosen in Settings (empty: the default printer).
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
#[cfg(windows)]
use std::time::Duration;
use tauri::AppHandle;

/// Documents waiting to be printed, served to the hidden window by the printdoc:// protocol.
pub static DOCUMENTS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn document(id: &str) -> Option<String> {
    DOCUMENTS.lock().unwrap().get(id).cloned()
}

#[cfg(windows)]
pub async fn print_silent(app: AppHandle, html: String, printer: String) -> bool {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let id = uuid::Uuid::new_v4().to_string();
    DOCUMENTS.lock().unwrap().insert(id.clone(), html);
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = Mutex::new(Some(loaded_tx));
    let url = format!("http://printdoc.localhost/{id}");
    let window = WebviewWindowBuilder::new(&app, format!("print-{}", &id[..8]), WebviewUrl::External(url.parse().unwrap()))
        .visible(false)
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        })
        .build();
    let result = match window {
        Ok(w) => {
            let ok = match tokio::time::timeout(Duration::from_secs(15), loaded_rx).await {
                Ok(Ok(())) => print_loaded(&w, printer).await,
                _ => false,
            };
            let _ = w.close();
            ok
        }
        Err(_) => false,
    };
    DOCUMENTS.lock().unwrap().remove(&id);
    result
}

#[cfg(windows)]
async fn print_loaded(window: &tauri::WebviewWindow, printer: String) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2PrintSettings2, ICoreWebView2_16, COREWEBVIEW2_PRINT_STATUS_SUCCEEDED,
    };
    use webview2_com::PrintCompletedHandler;
    use windows_core::{Interface, HSTRING};
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    let started = window.with_webview(move |pw| {
        let tx = std::sync::Arc::new(Mutex::new(Some(tx)));
        let fail = tx.clone();
        let run = || -> windows_core::Result<()> {
            unsafe {
                let core = pw.controller().CoreWebView2()?;
                let webview: ICoreWebView2_16 = core.cast()?;
                let env: ICoreWebView2Environment6 = pw.environment().cast()?;
                let settings = env.CreatePrintSettings()?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                if !printer.is_empty() {
                    let named: ICoreWebView2PrintSettings2 = settings.cast()?;
                    named.SetPrinterName(&HSTRING::from(printer.as_str()))?;
                }
                let done = tx.clone();
                webview.Print(
                    &settings,
                    &PrintCompletedHandler::create(Box::new(move |result, status| {
                        if let Some(tx) = done.lock().unwrap().take() {
                            let _ = tx.send(result.is_ok() && status == COREWEBVIEW2_PRINT_STATUS_SUCCEEDED);
                        }
                        Ok(())
                    })),
                )?;
            }
            Ok(())
        };
        if run().is_err() {
            if let Some(tx) = fail.lock().unwrap().take() {
                let _ = tx.send(false);
            }
        }
    });
    if started.is_err() {
        return false;
    }
    matches!(tokio::time::timeout(Duration::from_secs(60), rx).await, Ok(Ok(true)))
}

/// Outside Windows there is no silent printing: the phone is told the print failed.
#[cfg(not(windows))]
pub async fn print_silent(_app: AppHandle, _html: String, _printer: String) -> bool {
    false
}

#[cfg(windows)]
pub fn list_printers() -> Vec<String> {
    use windows::Win32::Graphics::Printing::{EnumPrintersW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_4W};
    unsafe {
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut count) = (0u32, 0u32);
        let _ = EnumPrintersW(flags, None, 4, None, &mut needed, &mut count);
        if needed == 0 {
            return vec![];
        }
        let mut buf = vec![0u8; needed as usize];
        if EnumPrintersW(flags, None, 4, Some(&mut buf), &mut needed, &mut count).is_err() {
            return vec![];
        }
        let infos = std::slice::from_raw_parts(buf.as_ptr() as *const PRINTER_INFO_4W, count as usize);
        infos.iter().filter_map(|i| i.pPrinterName.to_string().ok()).collect()
    }
}

#[cfg(not(windows))]
pub fn list_printers() -> Vec<String> {
    vec![]
}

// Phone Store Manager on Tauri 2. The Rust core (psm-core) holds the database and every service; this crate opens
// the window, routes the window's api() calls to the core, serves stored files and prints.
mod host;
mod print;

use percent_encoding::percent_decode_str;
use psm_core::services::{backup, catalog, expenses, files, services as service_catalog, settings};
use psm_core::{api, Caller, Core, IpcResult, Paths};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tauri::http::{header, Response, StatusCode};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;

const TITLE: &str = "Phone Store Manager";

/// Every call from the window. The same table and checks as a phone's call, with the desktop as the caller.
#[tauri::command]
async fn api(core: tauri::State<'_, Arc<Core>>, channel: String, payload: Option<Value>) -> Result<IpcResult, ()> {
    Ok(api::run_channel(&core, &channel, payload.unwrap_or(Value::Null), Caller::Desktop).await)
}

#[derive(Serialize, Deserialize, Default)]
struct Bounds {
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    maximized: Option<bool>,
}

fn mime(name: &str) -> &'static str {
    match name.rsplit('.').next().map(|e| e.to_lowercase()).as_deref() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// The stored file a URL points to: appfile://localhost/<name> (or http://appfile.localhost/<name> on Windows).
fn stored_name(path: &str) -> String {
    let last = path.rsplit('/').next().unwrap_or("");
    percent_decode_str(last).decode_utf8_lossy().into_owned()
}

fn is_stored_file_url(url: &tauri::Url) -> bool {
    url.scheme() == "appfile" || url.host_str() == Some("appfile.localhost")
}

/// Startup work on the database: default lists, the popular brands once, the daily backup.
fn prepare(core: &Core) {
    let result = core.desktop(|c| {
        let lang = settings::get_public(c.db)?.language;
        expenses::ensure_default_categories(c, expenses::default_categories(&lang))?;
        service_catalog::ensure_default_services(c)?;
        // The popular brands are offered once; after that the shop's own list is left alone (Settings can add them again).
        if !settings::get_value::<bool>(c.db, "brands.seeded")?.unwrap_or(false) {
            catalog::add_popular_brands(c)?;
            settings::set_value(c.db, "brands.seeded", &true)?;
        }
        Ok(())
    });
    if let Err(e) = result {
        core.log("startup", &e);
    }
    if let Err(e) = backup::auto_backup(core) {
        core.log("autoBackup", &e);
    }
}

fn create_window(app: &tauri::AppHandle, core: &Arc<Core>) -> tauri::Result<WebviewWindow> {
    let bounds: Option<Bounds> = core.desktop(|c| settings::get_value(c.db, "window.bounds")).ok().flatten();
    let files_dir = core.paths.files_dir();
    let opener = app.clone();
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(bounds.as_ref().map(|b| b.width).unwrap_or(1280.0), bounds.as_ref().map(|b| b.height).unwrap_or(800.0))
        .min_inner_size(1100.0, 700.0)
        .visible(false)
        // Links (wa.me, websites) open in the real browser, never inside the app; stored files open in the system viewer.
        .on_new_window(move |url, _| {
            if is_stored_file_url(&url) {
                let path = files::stored_file_path(&files_dir, &stored_name(url.path()));
                let _ = opener.opener().open_path(path.display().to_string(), None::<&str>);
            } else if url.scheme() == "http" || url.scheme() == "https" {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|w, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = w.show();
            }
        });
    if let Some(b) = &bounds {
        if let (Some(x), Some(y)) = (b.x, b.y) {
            builder = builder.position(x, y);
        }
    }
    let window = builder.build()?;
    if bounds.as_ref().and_then(|b| b.maximized).unwrap_or(false) {
        let _ = window.maximize();
    }
    Ok(window)
}

fn save_bounds(window: &tauri::Window, core: &Core) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let maximized = window.is_maximized().unwrap_or(false);
    let previous: Option<Bounds> = core.desktop(|c| settings::get_value(c.db, "window.bounds")).ok().flatten();
    let bounds = if maximized || window.is_minimized().unwrap_or(false) {
        // Keep the last normal size and position, so un-maximizing next time goes back to them.
        Bounds { maximized: Some(maximized), ..previous.unwrap_or(Bounds { width: 1280.0, height: 800.0, ..Default::default() }) }
    } else {
        let size: LogicalSize<f64> = window.inner_size().map(|s| s.to_logical(scale)).unwrap_or(LogicalSize::new(1280.0, 800.0));
        let pos: Option<LogicalPosition<f64>> = window.outer_position().ok().map(|p| p.to_logical(scale));
        Bounds { width: size.width, height: size.height, x: pos.map(|p| p.x), y: pos.map(|p| p.y), maximized: Some(false) }
    };
    if let Err(e) = core.desktop(|c| settings::set_value(c.db, "window.bounds", &bounds)) {
        core.log("window.bounds", &e);
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Uploaded files (logo, photos, receipts) are shown in the window from here.
        .register_uri_scheme_protocol("appfile", |ctx, request| {
            let core = ctx.app_handle().state::<Arc<Core>>();
            let path = files::stored_file_path(&core.paths.files_dir(), &stored_name(request.uri().path()));
            match std::fs::read(&path) {
                Ok(bytes) => Response::builder().header(header::CONTENT_TYPE, mime(&path.display().to_string())).body(bytes).unwrap(),
                Err(_) => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
            }
        })
        // Documents printed silently (see print.rs).
        .register_uri_scheme_protocol("printdoc", |_, request| match print::document(&stored_name(request.uri().path())) {
            Some(html) => Response::builder().header(header::CONTENT_TYPE, "text/html; charset=utf-8").body(html.into_bytes()).unwrap(),
            None => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
        })
        .invoke_handler(tauri::generate_handler![api])
        .setup(|app| {
            let handle = app.handle().clone();
            // Data lives in %APPDATA%/<slug>, whatever the installer or product name is (the Electron app's folder).
            let base = app.path().config_dir()?;
            let apk_dir = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../build/mobile")
            } else {
                app.path().resource_dir()?.join("mobile")
            };
            // The same folders as the Electron app: %APPDATA%\phone-store-manager and its trial marker beside it.
            let paths = Paths::new(base.join(backup::SLUG), Some(base.join(format!(".{}-m", backup::SLUG))), Some(apk_dir))?;
            let version = app.package_info().version.to_string();
            let core = Core::new(paths, &version, Arc::new(host::TauriHost { app: handle.clone() })).map_err(|e| e.to_string())?;
            prepare(&core);
            app.manage(core.clone());
            let starter = core.clone();
            tauri::async_runtime::spawn(async move { psm_core::mobile::manager::start_all(&starter).await });
            create_window(&handle, &core)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    let core = window.state::<Arc<Core>>();
                    save_bounds(window, &core);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the app");

    app.run(|handle, event| {
        // Close the phone server cleanly before quitting, so the port is free again at the next start.
        if let RunEvent::Exit = event {
            if let Some(core) = handle.try_state::<Arc<Core>>() {
                let core = core.inner().clone();
                tauri::async_runtime::block_on(async move { psm_core::mobile::manager::shutdown(&core).await });
            }
        }
    });
}

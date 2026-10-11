// The phone server, started on a free port against a temp database.
mod common;
use common::*;
use psm_core::mobile::{allowlist::ALLOWLIST, devices, manager, pairing::CODE_TTL_MS};
use psm_core::services::{cash, catalog, employees, stock, suppliers};
use psm_core::Caller;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

struct S {
    app: App,
    base: String,
    http: reqwest::Client,
}

async fn start() -> S {
    let app = fresh();
    app.core.license.write().unwrap().public_key_pem = String::new(); // no key embedded: every option is on
    app.ok(|c| psm_core::services::settings::update_public(c.db, serde_json::from_value(json!({ "storeName": "Boutique Test" })).unwrap()));
    manager::set_config(&app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await.unwrap();
    let base = format!("http://127.0.0.1:{}", manager::overview(&app.core).unwrap().port);
    S { app, base, http: reqwest::Client::builder().no_proxy().build().unwrap() }
}

struct Res {
    status: u16,
    body: Value,
}

impl S {
    async fn call(&self, path: &str, body: Option<Value>, token: Option<&str>, method: &str) -> Res {
        let mut req = if method == "GET" { self.http.get(format!("{}{path}", self.base)) } else { self.http.post(format!("{}{path}", self.base)) };
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        Res { status, body: res.json().await.unwrap_or(Value::Null) }
    }
    async fn post(&self, path: &str, body: Value, token: &str) -> Res {
        self.call(path, Some(body), Some(token), "POST").await
    }
    async fn post0(&self, path: &str, token: &str) -> Res {
        self.call(path, None, Some(token), "POST").await
    }
    async fn pair_now(&self) -> (String, String) {
        let code = manager::start_pairing(&self.app.core).unwrap().code;
        let r = self.call("/pair", Some(json!({ "code": code, "deviceName": "Phone" })), None, "POST").await;
        (r.body["token"].as_str().unwrap().to_owned(), r.body["device"]["id"].as_str().unwrap().to_owned())
    }
    /// A paired phone with its role saved, as the owner does in Settings.
    async fn phone(&self, role: &str, employee: Option<&str>) -> (String, String) {
        let (token, id) = self.pair_now().await;
        let input = parse(json!({ "id": id, "name": "Phone", "role": role, "employeeId": employee }));
        self.app.ok(|c| devices::update_device(c, &input));
        (token, id)
    }
    async fn upload(&self, token: &str) -> String {
        let r = self.http.post(format!("{}/files", self.base)).bearer_auth(token).header("content-type", "image/png").body(png()).send().await.unwrap();
        r.json::<Value>().await.unwrap()["name"].as_str().unwrap().to_owned()
    }
    fn count(&self, from: &str) -> i64 {
        self.app.val(&format!("SELECT count(*) FROM {from}"))
    }
    fn unit(&self, n: u32, min: i64) -> stock::UnitAdded {
        let brand = match self.app.ok(catalog::list_brands).first() {
            Some(b) => b.id.clone(),
            None => self.app.ok(|c| catalog::create_brand(c, "Samsung")).id,
        };
        let input: stock::UnitAddInput =
            parse(json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "minPrice": min,
                                                       "model": { "brandId": brand, "name": "A15", "storage": "128GB", "color": "Noir" } }));
        self.app.ok(|c| stock::add_unit(c, &input))
    }
    fn open_day(&self) {
        self.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 0 }))));
    }
}

impl Drop for S {
    fn drop(&mut self) {
        let core = self.app.core.clone();
        std::thread::spawn(move || rt().block_on(manager::shutdown(&core))).join().ok();
    }
}

fn png() -> Vec<u8> {
    let mut v = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    v.extend(vec![0u8; 32]);
    v
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_hello_without_a_token_with_a_stable_server_id() {
    let s = start().await;
    let hello = s.call("/hello", None, None, "GET").await;
    assert_eq!(hello.status, 200);
    assert_eq!(
        (hello.body["app"].as_str(), hello.body["storeName"].as_str(), hello.body["appVersion"].as_str(), hello.body["apiVersion"].as_i64()),
        (Some("PSM"), Some("Boutique Test"), Some("9.9.9"), Some(1))
    );
    assert_eq!(hello.body["serverId"].as_str().unwrap().len(), 36);
    assert_eq!(s.call("/hello", None, None, "GET").await.body["serverId"], hello.body["serverId"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn allows_any_origin_and_the_authorization_header() {
    let s = start().await;
    let res = s
        .http
        .request(reqwest::Method::OPTIONS, format!("{}/api/units.list", s.base))
        .header("Origin", "http://x.example")
        .header("Access-Control-Request-Method", "POST")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 204);
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
    assert!(res.headers()["access-control-allow-headers"].to_str().unwrap().contains("Authorization"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_code_is_refused_the_right_one_works_once_and_only_the_hash_is_stored() {
    let s = start().await;
    let code = manager::start_pairing(&s.app.core).unwrap().code;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let r = s.call("/pair", Some(json!({ "code": wrong, "deviceName": "A" })), None, "POST").await;
    assert_eq!((r.body["ok"].as_bool(), r.body["error"]["code"].as_str()), (Some(false), Some("invalid_code")));
    let ok = s.call("/pair", Some(json!({ "code": code, "deviceName": "Ali phone" })), None, "POST").await;
    assert_eq!(ok.status, 200);
    let token = ok.body["token"].as_str().unwrap().to_owned();
    assert!(regex::Regex::new(r"^[A-Za-z0-9_-]{43}$").unwrap().is_match(&token)); // 32 bytes, base64url
    assert_eq!((ok.body["device"]["name"].as_str(), ok.body["device"]["role"].is_null()), (Some("Ali phone"), true));
    let all: Vec<Value> = s.app.ok(|c| {
        Ok(psm_core::db::DbExt::all::<psm_core::rows::MobileDevice>(c.db, "SELECT * FROM mobile_devices", [])?
            .into_iter()
            .map(|d| serde_json::to_value(d).unwrap())
            .collect())
    });
    assert!(!serde_json::to_string(&all).unwrap().contains(&token));
    let again = s.call("/pair", Some(json!({ "code": code, "deviceName": "B" })), None, "POST").await;
    assert_eq!(again.body["error"]["code"], "invalid_code"); // single use
    assert_eq!(s.app.core.mobile.pairing.status().paired_device_id.as_deref(), ok.body["device"]["id"].as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_expired_code() {
    let s = start().await;
    let code = manager::start_pairing(&s.app.core).unwrap().code;
    s.app.core.mobile.pairing.clock_offset_ms.store(CODE_TTL_MS + 1000, Ordering::Relaxed);
    let r = s.call("/pair", Some(json!({ "code": code, "deviceName": "Late" })), None, "POST").await;
    assert_eq!(r.body["error"]["code"], "code_expired");
}

#[tokio::test(flavor = "multi_thread")]
async fn blocks_pairing_after_five_wrong_codes_even_for_the_right_one() {
    let s = start().await;
    let code = manager::start_pairing(&s.app.core).unwrap().code;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        s.call("/pair", Some(json!({ "code": wrong, "deviceName": "X" })), None, "POST").await;
    }
    let blocked = s.call("/pair", Some(json!({ "code": code, "deviceName": "X" })), None, "POST").await;
    assert_eq!((blocked.status, blocked.body["error"]["code"].as_str()), (429, Some("pairing_blocked")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_without_a_role_is_forbidden_everywhere() {
    let s = start().await;
    let (token, _) = s.pair_now().await;
    assert_eq!(s.post("/api/units.list", json!({}), &token).await.body["error"]["code"], "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn needs_a_token_and_a_revoked_device_is_refused_at_once() {
    let s = start().await;
    assert_eq!(s.call("/api/units.list", Some(json!({})), None, "POST").await.body["error"]["code"], "unauthorized");
    assert_eq!(s.post("/api/units.list", json!({}), "not-a-token").await.status, 401);
    let (token, id) = s.phone("OWNER", None).await;
    assert_eq!(s.post0("/api/brands.list", &token).await.body["ok"], true);
    s.app.ok(|c| devices::revoke_device(c, &id));
    let refused = s.post0("/api/brands.list", &token).await;
    assert_eq!((refused.status, refused.body["error"]["code"].as_str()), (403, Some("device_revoked")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_seller_calling_an_owner_only_channel_is_forbidden() {
    let s = start().await;
    let (seller, _) = s.phone("SELLER", None).await;
    assert_eq!(
        s.post("/api/finance.summary", json!({ "from": "2026-01-01T00:00:00.000Z", "to": "2026-12-31T00:00:00.000Z" }), &seller).await.body["error"]["code"],
        "forbidden"
    );
    assert_eq!(s.post("/api/purchases.cancel", json!({ "id": "x" }), &seller).await.body["error"]["code"], "forbidden");
    assert_eq!(s.post0("/api/brands.list", &seller).await.body["ok"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_channels_off_the_allowlist_even_for_an_owner() {
    let s = start().await;
    let (owner, _) = s.phone("OWNER", None).await;
    for channel in [
        "settings.update",
        "auth.unlock",
        "auth.setPassword",
        "backup.create",
        "license.activate",
        "system.info",
        "cash.close",
        "seed.load",
        "print.html",
        "mobile.devices",
        "mobile.revoke",
        "nonexistent.channel",
    ] {
        let r = s.post(&format!("/api/{channel}"), json!({}), &owner).await;
        assert_eq!((r.status, r.body["error"]["code"].as_str()), (403, Some("forbidden")), "{channel}");
    }
    let dangerous = regex::Regex::new(r"^(settings|auth|backup|license|system|mobile|import|seed|print|file)\.").unwrap();
    for channel in ALLOWLIST.keys() {
        assert!(!dangerous.is_match(channel), "{channel}");
    }
    assert!(!ALLOWLIST.contains_key("cash.close"));
}

#[tokio::test(flavor = "multi_thread")]
async fn validates_input_and_uses_the_same_error_envelope() {
    let s = start().await;
    let (owner, _) = s.phone("OWNER", None).await;
    assert_eq!(
        s.post("/api/brands.create", json!({ "name": "" }), &owner).await.body,
        json!({ "ok": false, "error": { "code": "invalid_input", "params": {} } })
    );
    let bad =
        s.http.post(format!("{}/api/brands.create", s.base)).bearer_auth(&owner).header("content-type", "application/json").body("{oops").send().await.unwrap();
    assert_eq!(bad.status().as_u16(), 400);
    let created = s.post("/api/brands.create", json!({ "name": "Nokia" }), &owner).await;
    assert_eq!((created.body["ok"].as_bool(), created.body["data"]["name"].as_str()), (Some(true), Some("Nokia")));
}

#[tokio::test(flavor = "multi_thread")]
async fn hides_costs_from_every_role_except_owner() {
    let s = start().await;
    let unit = s.unit(1, 5_500_000);
    let (owner, _) = s.phone("OWNER", None).await;
    let (seller, _) = s.phone("SELLER", None).await;
    assert_eq!(s.post("/api/units.get", json!({ "id": unit.id }), &owner).await.body["data"]["cost"], 4_000_000);
    let seen = s.post("/api/units.get", json!({ "id": unit.id }), &seller).await.body["data"].clone();
    assert!(seen.get("cost").is_none()); // removed by the server, not just nulled
    let searched = s.post("/api/stock.search", json!({ "q": "a15" }), &seller).await.body;
    assert!(!searched.to_string().to_lowercase().contains("cost"));
    let found = s.post("/api/stock.search", json!({ "q": "a15" }), &owner).await.body["data"].clone();
    assert_eq!(found["units"].as_array().unwrap().len(), 1);
    assert_eq!(found["units"][0]["cost"], 4_000_000);
    let lookup = s.post("/api/stock.lookup", json!({ "code": make_imei("35000000000001") }), &seller).await.body["data"].clone();
    assert_eq!(lookup, json!({ "type": "unit", "id": unit.id }));
}

#[tokio::test(flavor = "multi_thread")]
async fn limits_a_device_to_20_requests_per_second() {
    let s = start().await;
    let (owner, _) = s.phone("OWNER", None).await;
    let calls = (0..30).map(|_| s.post0("/api/brands.list", &owner));
    let results = futures_util::future::join_all(calls).await;
    assert!(results.iter().filter(|r| r.status == 429).count() >= 5);
    assert!(results.iter().any(|r| r.body["error"]["code"] == "rate_limited"));
}

#[tokio::test(flavor = "multi_thread")]
async fn updates_last_seen_at_most_once_a_minute() {
    let s = start().await;
    let (owner, id) = s.phone("OWNER", None).await;
    s.post0("/api/brands.list", &owner).await;
    let seen = |s: &S| s.app.ok(|c| psm_core::db::DbExt::val::<Option<String>>(c.db, "SELECT last_seen_at FROM mobile_devices WHERE id = ?1", [&id]));
    let first = seen(&s);
    assert!(first.is_some());
    tokio::time::sleep(std::time::Duration::from_millis(15)).await;
    s.post0("/api/brands.list", &owner).await;
    assert_eq!(seen(&s), first);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sale_over_http_writes_the_same_rows_with_the_device_employee_as_actor() {
    let s = start().await;
    s.open_day();
    let employee = s.app.ok(|c| employees::create_employee(c, &parse(json!({ "name": "Karim", "role": "SELLER" })))).id;
    let a = s.unit(1, 5_500_000);
    let b = s.unit(2, 5_500_000);
    let input =
        |unit: &str| json!({ "employeeId": employee, "paid": 6_000_000, "paymentMethod": "CASH", "lines": [{ "unitId": unit, "unitPrice": 6_000_000 }] });
    let ipc = psm_core::api::run_channel(&s.app.core, "sales.create", input(&a.id), Caller::Desktop).await;
    let (seller, _) = s.phone("SELLER", Some(&employee)).await;
    // The phone tries to sell as someone else: its own employee is used anyway.
    let http = s.post("/api/sales.create", merge(input(&b.id), json!({ "employeeId": "someone-else" })), &seller).await;
    assert!(ipc.is_ok());
    assert_eq!(http.body["ok"], true);
    let row = |sql: &str, id: &str| -> String { s.app.ok(|c| psm_core::db::DbExt::val::<String>(c.db, sql, [id])) };
    let rows = |sale: &str, unit: &str| {
        vec![
            row("SELECT coalesce(customer_id,'') || employee_id || subtotal || discount || total || paid || trade_in_value || payment_method FROM sales WHERE id = ?1", sale),
            row("SELECT product_id || quantity || unit_price || unit_cost_at_sale || discount FROM sale_lines WHERE sale_id = ?1", sale),
            row("SELECT status || cost FROM phone_units WHERE id = ?1", unit),
            row("SELECT type || quantity || unit_cost || reason || ref_table FROM stock_movements WHERE ref_id = ?1 AND type = 'SALE'", sale),
            row("SELECT type || direction || amount FROM cash_movements WHERE ref_id = ?1", sale),
        ]
    };
    let ipc_id = ipc.data().unwrap()["id"].as_str().unwrap().to_owned();
    let http_id = http.body["data"]["id"].as_str().unwrap().to_owned();
    assert_eq!(rows(&http_id, &b.id), rows(&ipc_id, &a.id));
    let actor = |sale: &str| {
        s.app.ok(|c| psm_core::db::DbExt::val::<Option<String>>(c.db, "SELECT employee_id FROM stock_movements WHERE ref_id = ?1 AND type = 'SALE'", [sale]))
    };
    assert_eq!(actor(&http_id), Some(employee.clone()));
    assert_eq!(actor(&ipc_id), None);
    assert_eq!(s.count("sales"), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn stores_images_raw_or_as_a_form_serves_them_with_a_token_and_refuses_other_types() {
    let s = start().await;
    let (token, _) = s.phone("TECHNICIAN", None).await;
    let name = s.upload(&token).await;
    assert!(name.ends_with(".png"));
    let form = reqwest::multipart::Form::new().part("file", reqwest::multipart::Part::bytes(png()).file_name("photo.png").mime_str("image/png").unwrap());
    let multi = s.http.post(format!("{}/files", s.base)).bearer_auth(&token).multipart(form).send().await.unwrap();
    assert!(multi.json::<Value>().await.unwrap()["name"].as_str().unwrap().ends_with(".png"));
    assert_eq!(s.http.get(format!("{}/files/{name}", s.base)).send().await.unwrap().status().as_u16(), 401);
    let served = s.http.get(format!("{}/files/{name}", s.base)).bearer_auth(&token).send().await.unwrap();
    assert_eq!(served.status().as_u16(), 200);
    assert_eq!(served.bytes().await.unwrap().to_vec(), png());
    assert_eq!(s.http.get(format!("{}/files/..%2F..%2Fstore.db", s.base)).bearer_auth(&token).send().await.unwrap().status().as_u16(), 404);
    let html = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::bytes(b"<script>1</script>".to_vec()).file_name("x.png").mime_str("image/png").unwrap());
    let refused = s.http.post(format!("{}/files", s.base)).bearer_auth(&token).multipart(html).send().await.unwrap();
    assert_eq!(refused.status().as_u16(), 415);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_an_image_over_10_mb() {
    let s = start().await;
    let (token, _) = s.phone("TECHNICIAN", None).await;
    let mut big = png();
    big.extend(vec![0u8; 10 * 1024 * 1024]);
    let form = reqwest::multipart::Form::new().part("file", reqwest::multipart::Part::bytes(big).file_name("big.png").mime_str("image/png").unwrap());
    let res = s.http.post(format!("{}/files", s.base)).bearer_auth(&token).multipart(form).send().await.unwrap();
    assert_eq!(res.status().as_u16(), 413);
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_answering_when_switched_off_and_answers_again_when_on() {
    let mut s = start().await;
    assert_eq!(manager::overview(&s.app.core).unwrap().state, "running");
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: false, port: 0 }).await.unwrap();
    assert_eq!(manager::overview(&s.app.core).unwrap().state, "stopped");
    assert!(s.http.get(format!("{}/hello", s.base)).send().await.is_err());
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await.unwrap();
    s.base = format!("http://127.0.0.1:{}", manager::overview(&s.app.core).unwrap().port);
    assert_eq!(s.http.get(format!("{}/hello", s.base)).send().await.unwrap().status().as_u16(), 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_busy_port_instead_of_crashing() {
    let s = start().await;
    let taken = manager::overview(&s.app.core).unwrap().port;
    manager::shutdown(&s.app.core).await;
    let blocker = std::net::TcpListener::bind(("0.0.0.0", taken as u16)).unwrap();
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: true, port: taken }).await.unwrap();
    let o = manager::overview(&s.app.core).unwrap();
    assert_eq!((o.state.as_str(), o.port), ("port_busy", taken));
    drop(blocker);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_to_start_pairing_while_the_server_is_stopped() {
    let s = start().await;
    manager::set_config(&s.app.core, manager::MobileConfigInput { enabled: false, port: 0 }).await.unwrap();
    assert_eq!(code(manager::start_pairing(&s.app.core)), "mobile_not_running");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retried_purchase_creates_one_purchase_with_the_uploaded_invoice() {
    let s = start().await;
    s.unit(1, 0);
    let model = s.app.ok(stock::list_models)[0].id.clone();
    let supplier = s.app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Grossiste" })))).id;
    let (keeper, _) = s.phone("STOCK", None).await;
    let name = s.upload(&keeper).await;
    let body = json!({
        "supplierId": supplier, "date": now(), "paid": 0, "requestId": "phone-req-0001", "invoiceFile": name,
        "invoicePath": "/etc/hosts.jpg", // a phone cannot make the PC copy one of its own files
        "phoneLines": [{ "imei1": make_imei("35000000000002"), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "productId": model }],
    });
    let first = s.post("/api/purchases.create", body.clone(), &keeper).await;
    let second = s.post("/api/purchases.create", body, &keeper).await;
    assert_eq!(first.body["ok"], true);
    assert_eq!(second.body, first.body);
    assert_eq!(s.count("purchases"), 1);
    assert_eq!(s.count("phone_units"), 2);
    assert_eq!(s.app.val::<String>("SELECT invoice_file FROM purchases"), name);
}

#[tokio::test(flavor = "multi_thread")]
async fn counts_over_http_with_roles_shared_scope_and_no_costs_for_a_stock_keeper() {
    let s = start().await;
    let unit = s.unit(1, 0);
    let (keeper, _) = s.phone("STOCK", None).await;
    let (keeper2, _) = s.phone("STOCK", None).await;
    let (owner, _) = s.phone("OWNER", None).await;
    let (seller, _) = s.phone("SELLER", None).await;
    assert_eq!(s.post("/api/stockCount.start", json!({ "scope": "PHONES" }), &seller).await.body["error"]["code"], "forbidden");
    let started = s.post("/api/stockCount.start", json!({ "scope": "PHONES" }), &keeper).await;
    let joined = s.post("/api/stockCount.start", json!({ "scope": "PHONES" }), &keeper2).await;
    let id = started.body["data"]["id"].as_str().unwrap().to_owned();
    assert_eq!(joined.body["data"], json!({ "id": id, "joined": true }));
    let view = s.post("/api/stockCount.get", json!({ "id": id }), &keeper2).await.body["data"].clone();
    assert_eq!(view["missing"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), vec![unit.id.as_str()]);
    assert!(!view.to_string().to_lowercase().contains("cost"));
    assert_eq!(s.post("/api/stockCount.get", json!({ "id": id }), &owner).await.body["data"]["missingCost"], 4_000_000);
    assert_eq!(
        s.post("/api/stockCount.scanUnit", json!({ "countId": id, "code": make_imei("35000000000001") }), &keeper).await.body["data"]["status"],
        "counted"
    );
    assert_eq!(s.post("/api/stockCount.get", json!({ "id": id }), &keeper2).await.body["data"]["counted"], 1);
    assert_eq!(s.post("/api/stockCount.apply", json!({ "id": id }), &keeper).await.body["error"]["code"], "forbidden");
    assert_eq!(s.post("/api/stockCount.apply", json!({ "id": id }), &owner).await.body["ok"], true);
}

fn sale_body(unit: &str, request: &str) -> Value {
    json!({ "paid": 6_000_000, "paymentMethod": "CASH", "requestId": request, "lines": [{ "unitId": unit, "unitPrice": 6_000_000 }] })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sale_sent_twice_with_the_same_request_id_sells_once() {
    let s = start().await;
    s.open_day();
    let unit = s.unit(1, 5_000_000);
    let (seller, _) = s.phone("SELLER", None).await;
    let first = s.post("/api/sales.create", sale_body(&unit.id, "sale-req-0001"), &seller).await;
    let second = s.post("/api/sales.create", sale_body(&unit.id, "sale-req-0001"), &seller).await;
    assert_eq!(first.body["ok"], true);
    assert_eq!(second.body["data"]["id"], first.body["data"]["id"]);
    assert_eq!(second.body["data"]["receiptNumber"], first.body["data"]["receiptNumber"]);
    assert_eq!(s.count("sales"), 1);
    assert_eq!(s.count("stock_movements WHERE type = 'SALE'"), 1);
    assert_eq!(s.count("cash_movements WHERE type = 'SALE'"), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn two_phones_selling_the_same_imei_one_sells_and_stock_stays_consistent() {
    let s = start().await;
    s.open_day();
    let unit = s.unit(2, 5_000_000);
    let (a, _) = s.phone("SELLER", None).await;
    let (b, _) = s.phone("OWNER", None).await;
    let (ra, rb) = tokio::join!(
        s.post("/api/sales.create", sale_body(&unit.id, "device-a-0001"), &a),
        s.post("/api/sales.create", sale_body(&unit.id, "device-b-0001"), &b)
    );
    let results = [ra.body, rb.body];
    assert_eq!(results.iter().filter(|r| r["ok"] == true).count(), 1);
    assert_eq!(results.iter().find(|r| r["ok"] == false).unwrap()["error"]["code"], "unit_not_available");
    assert_eq!(s.count("sales"), 1);
    assert_eq!(s.app.val::<String>(&format!("SELECT status FROM phone_units WHERE id = '{}'", unit.id)), "SOLD");
    assert_eq!(s.count("stock_movements WHERE type = 'SALE'"), 1);
    assert_eq!(s.count("cash_movements WHERE type = 'SALE'"), 1);
    assert_eq!(s.app.val::<i64>(&format!("SELECT quantity FROM products WHERE id = '{}'", unit.product_id)), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_phone_sale_when_no_cash_day_is_open() {
    let s = start().await;
    let unit = s.unit(3, 5_000_000);
    let (seller, _) = s.phone("SELLER", None).await;
    let refused = s.post("/api/sales.create", sale_body(&unit.id, "no-session-01"), &seller).await;
    assert_eq!(refused.body["error"]["code"], "no_cash_session");
    assert_eq!(s.count("sales"), 0);
    assert_eq!(s.app.val::<String>(&format!("SELECT status FROM phone_units WHERE id = '{}'", unit.id)), "IN_STOCK");
    assert_eq!(s.post0("/api/cash.state", &seller).await.body["ok"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_technicians_and_stock_keepers_out_of_sales_and_printing() {
    let s = start().await;
    s.open_day();
    let unit = s.unit(4, 5_000_000);
    for role in ["TECHNICIAN", "STOCK"] {
        let (device, _) = s.phone(role, None).await;
        for channel in ["sales.create", "sales.mine", "sales.printReceipt", "returns.create"] {
            assert_eq!(
                s.post(&format!("/api/{channel}"), sale_body(&unit.id, "x-request-0001"), &device).await.body["error"]["code"],
                "forbidden",
                "{role} {channel}"
            );
        }
    }
    let (seller, _) = s.phone("SELLER", None).await;
    assert_eq!(s.post("/api/repairs.printSlip", json!({ "id": "x" }), &seller).await.body["error"]["code"], "forbidden");
    assert_eq!(s.count("sales"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_only_what_this_phone_sold() {
    let s = start().await;
    s.open_day();
    let one = s.unit(5, 5_000_000);
    let two = s.unit(6, 5_000_000);
    let (a, a_id) = s.phone("SELLER", None).await;
    let (b, _) = s.phone("SELLER", None).await;
    s.post("/api/sales.create", sale_body(&one.id, "mine-a-00001"), &a).await;
    s.post("/api/sales.create", sale_body(&two.id, "mine-b-00001"), &b).await;
    let day = json!({ "from": psm_core::util::ms_to_iso(psm_core::util::now_ms() - 3_600_000), "to": psm_core::util::ms_to_iso(psm_core::util::now_ms() + 3_600_000) });
    let mine = s.post("/api/sales.mine", day, &a).await.body["data"].clone();
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(s.app.val::<String>(&format!("SELECT device_id FROM sales WHERE id = '{}'", mine[0]["id"].as_str().unwrap())), a_id);
}

#[tokio::test(flavor = "multi_thread")]
async fn takes_in_a_repair_with_photos_and_refuses_a_seventh() {
    let s = start().await;
    let (tech, _) = s.phone("TECHNICIAN", None).await;
    let customer =
        s.post("/api/customers.create", json!({ "name": "Walid", "phone": "0550000000" }), &tech).await.body["data"]["id"].as_str().unwrap().to_owned();
    let photos = vec![s.upload(&tech).await, s.upload(&tech).await, s.upload(&tech).await];
    let made =
        s.post("/api/repairs.create", json!({ "customerId": customer, "brand": "Samsung", "model": "A15", "fault": "Screen", "photos": photos }), &tech).await;
    assert_eq!(made.body["ok"], true);
    let id = made.body["data"]["id"].as_str().unwrap().to_owned();
    let ticket = s.post("/api/repairs.get", json!({ "id": id }), &tech).await.body["data"].clone();
    assert_eq!(ticket["photos"].as_array().unwrap().iter().map(|p| p["fileName"].as_str().unwrap().to_owned()).collect::<Vec<_>>(), photos);
    for _ in 0..3 {
        let name = s.upload(&tech).await;
        assert_eq!(s.post("/api/repairs.addPhoto", json!({ "repairId": id, "fileName": name }), &tech).await.body["ok"], true);
    }
    let name = s.upload(&tech).await;
    assert_eq!(s.post("/api/repairs.addPhoto", json!({ "repairId": id, "fileName": name }), &tech).await.body["error"]["code"], "too_many_photos");
    assert_eq!(
        s.post("/api/repairs.addPhoto", json!({ "repairId": id, "fileName": "00000000-0000-0000-0000-000000000000.jpg" }), &tech).await.body["error"]["code"],
        "file_not_found"
    );
    let seven = vec![photos[0].clone(); 7];
    assert_eq!(
        s.post("/api/repairs.create", json!({ "customerId": customer, "fault": "x", "photos": seven }), &tech).await.body["error"]["code"],
        "invalid_input"
    );
    assert_eq!(s.count("repair_photos"), 6);
}

// Access from outside the shop: the PC's mailbox service, and the rules for requests that arrive through it.
// Supabase is replaced by the in-memory fake from the remote crate; the "phone" talks through the real wire format.
mod common;
use common::*;
use ed25519_dalek::pkcs8::{spki::der::pem::LineEnding, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use psm_core::mobile::remote_pairing::{format_pair_code, new_pair_code, pairing_channel, PAIRING_DEVICE_ID};
use psm_core::mobile::{devices, manager, server};
use psm_core::services::license::{self, base32_encode, group_text};
use psm_core::services::{cash, catalog, settings, stock};
use psm_core::Caller;
use remote::fake::FakeSupabase;
use remote::{send_sealed, Dir, Inbox, Incoming, Mailbox};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

struct T {
    app: App,
    key: SigningKey,
    fake: FakeSupabase,
    http: reqwest::Client,
}

async fn setup() -> T {
    let app = fresh();
    let key = SigningKey::generate(&mut rand::rngs::OsRng);
    app.core.license.write().unwrap().public_key_pem = key.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    app.ok(|c| settings::update_public(c.db, serde_json::from_value(json!({ "storeName": "Boutique Test" })).unwrap()));
    let fake = FakeSupabase::start().await;
    {
        let mut t = app.core.mobile.tuning.lock().unwrap();
        t.url = fake.url.clone();
        t.anon_key = fake.anon_key.clone();
        t.beat = Duration::from_millis(40);
        t.fetch = Duration::from_millis(40);
    }
    T { app, key, fake, http: reqwest::Client::builder().no_proxy().build().unwrap() }
}

impl Drop for T {
    fn drop(&mut self) {
        let core = self.app.core.clone();
        std::thread::spawn(move || rt().block_on(manager::shutdown(&core))).join().ok();
    }
}

/// A paired phone: its mailbox and key, as it received them in the /pair answer.
struct Phone {
    id: String,
    token: String,
    mailbox: String,
    key: String,
    mb: Mailbox,
    inbox: Inbox,
}

impl Phone {
    fn new(fake: &FakeSupabase, id: String, token: String, mailbox: String, key: String) -> Phone {
        let mb = Mailbox::new(fake.config());
        let inbox = Inbox::new(mb.clone(), &mailbox, Dir::ToPhone);
        Phone { id, token, mailbox, key, mb, inbox }
    }
}

async fn until(check: impl Fn() -> bool, ms: u64) {
    let end = Instant::now() + Duration::from_millis(ms);
    while !check() {
        assert!(Instant::now() < end, "timed out waiting");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn request(method: &str, path: &str, body: Value, ts: i64) -> wire::Request {
    wire::Request { id: uuid::Uuid::new_v4().to_string(), ts, method: method.into(), path: path.into(), body }
}

fn seal(p: &Phone, req: &wire::Request) -> wire::Sealed {
    wire::seal(&wire::key_from_string(&p.key).unwrap(), &p.mailbox, &p.id, &serde_json::to_vec(req).unwrap()).unwrap()
}

impl T {
    fn edition_key(&self, edition: &str) -> String {
        let device = self.app.ok(|c| Ok(license::device_id(c)));
        let bytes = serde_json::to_vec(&json!({ "p": "PSM", "d": device, "n": "Boutique", "e": edition, "i": "2026-10-10" })).unwrap();
        let mut raw = self.key.sign(&bytes).to_bytes().to_vec();
        raw.extend_from_slice(&bytes);
        group_text(&base32_encode(&raw), 5)
    }
    fn activate(&self, edition: &str) {
        let key = self.edition_key(edition);
        self.app.ok(|c| license::activate(c, &key));
    }
    fn state(&self) -> String {
        self.app.core.mobile.remote_status().state
    }
    fn phone(&self, role: &str) -> Phone {
        let created = self.app.ok(|c| devices::create_device(c, "Phone"));
        let input = parse(json!({ "id": created.device.id, "name": "Phone", "role": role, "employeeId": null }));
        self.app.ok(|c| devices::update_device(c, &input));
        Phone::new(&self.fake, created.device.id, created.token, created.remote.mailbox, created.remote.key)
    }
    /// Licensed with the phone option, outside access in the given mode, and the service connected.
    async fn on(&self, mode: &str) {
        self.activate("lifetime+mobile3");
        manager::set_remote_mode(&self.app.core, mode).await.unwrap();
        until(|| self.state() != "connecting", 3000).await;
    }
    async fn lan(&self) -> String {
        manager::set_config(&self.app.core, manager::MobileConfigInput { enabled: true, port: 0 }).await.unwrap();
        format!("http://127.0.0.1:{}", manager::overview(&self.app.core).unwrap().port)
    }
    fn brands(&self) -> Vec<String> {
        self.app.ok(catalog::list_brands).into_iter().map(|b| b.name).collect()
    }
    fn devices_count(&self) -> i64 {
        self.app.val("SELECT count(*) FROM mobile_devices")
    }
    fn sent_bodies(&self) -> String {
        self.fake
            .calls()
            .into_iter()
            .filter(|(f, _)| f == "mb_send")
            .map(|(_, a)| a["p_body"].as_str().unwrap_or_default().to_owned())
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn add_unit(&self, n: &str, price: i64) -> String {
        let brand = match self.app.ok(catalog::list_brands).first() {
            Some(b) => b.id.clone(),
            None => self.app.ok(|c| catalog::create_brand(c, "Samsung")).id,
        };
        let input: stock::UnitAddInput =
            parse(json!({ "imei1": make_imei(n), "condition": "NEW", "cost": 4_000_000, "salePrice": price, "minPrice": 5_000_000,
                                                       "model": { "brandId": brand, "name": "A15", "storage": "128GB", "color": "Noir" } }));
        self.app.ok(|c| stock::add_unit(c, &input)).id
    }
}

/// Sends a request the way a phone does and waits for the answer with the same id; None when none comes.
async fn ask(p: &mut Phone, method: &str, path: &str, body: Value) -> Option<wire::Response> {
    ask_with(p, request(method, path, body, now_ms()), 2500).await.unwrap()
}

async fn ask_with(p: &mut Phone, req: wire::Request, wait_ms: u64) -> Result<Option<wire::Response>, remote::Error> {
    send_sealed(&p.mb, &p.mailbox, Dir::ToPc, &req.id, &seal(p, &req)).await?;
    Ok(answer_for(p, &req.id, wait_ms).await)
}

async fn answer_for(p: &mut Phone, id: &str, wait_ms: u64) -> Option<wire::Response> {
    let end = Instant::now() + Duration::from_millis(wait_ms);
    let key = wire::key_from_string(&p.key).unwrap();
    while Instant::now() < end {
        for item in p.inbox.poll().await.unwrap_or_default() {
            let Incoming::Message { sealed, last_row } = item else { continue };
            let res: wire::Response = serde_json::from_slice(&wire::open(&key, &p.mailbox, &p.id, &sealed).unwrap()).unwrap();
            p.inbox.ack(last_row).await.unwrap();
            if res.id == id {
                return Some(res);
            }
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    None
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn has(v: &Value, pattern: Value) -> bool {
    match (v, &pattern) {
        (Value::Object(a), Value::Object(b)) => b.iter().all(|(k, pv)| a.get(k).is_some_and(|av| has(av, pv.clone()))),
        _ => *v == pattern,
    }
}

// ---------- the mailbox service ----------

#[tokio::test(flavor = "multi_thread")]
async fn needs_an_activated_license_that_includes_phones() {
    let t = setup().await;
    assert_eq!(code(manager::set_remote_mode(&t.app.core, "full").await), "mobile_not_licensed"); // trial
    t.app.core.set_edition(license::Edition::Phone);
    t.activate("phone");
    assert_eq!(code(manager::set_remote_mode(&t.app.core, "full").await), "mobile_not_licensed"); // the phone edition has no phones
    assert_eq!(t.state(), "off");
}

#[tokio::test(flavor = "multi_thread")]
async fn says_there_is_no_phone_to_reach_until_one_is_linked_then_beats_for_it() {
    let t = setup().await;
    t.on("full").await;
    assert_eq!(t.state(), "no_phone");
    let p = t.phone("OWNER");
    until(|| t.state() == "connected", 3000).await;
    assert!(p.mb.seen(&p.mailbox).await.unwrap().unwrap() < 5); // the phone can see the PC is alive
    let device = t.app.ok(|c| Ok(license::device_id(c)));
    let beat = t.fake.calls().into_iter().find(|(f, _)| f == "mb_beat").unwrap().1;
    assert_eq!((beat["p_shop_id"].as_str(), beat["p_name"].as_str()), (Some(device.as_str()), Some("Boutique Test")));
    let remote = manager::overview(&t.app.core).unwrap().remote;
    assert_eq!((remote.mode.as_str(), remote.licensed, remote.status.state.as_str()), ("full", true, "connected"));
}

#[tokio::test(flavor = "multi_thread")]
async fn shows_blocked_and_no_internet_and_recovers() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    until(|| t.state() == "connected", 3000).await;
    t.fake.block(&p.mailbox, true);
    until(|| t.state() == "blocked", 3000).await;
    let refused = ask_with(&mut p, request("GET", "/me", Value::Null, now_ms()), 200).await;
    assert_eq!(refused.err(), Some(remote::Error::Blocked)); // the phone is told too
    t.fake.block(&p.mailbox, false);
    until(|| t.state() == "connected", 3000).await;
    t.fake.set_offline(true);
    until(|| t.state() == "no_internet", 3000).await;
    t.fake.set_offline(false);
    until(|| t.state() == "connected", 3000).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_a_missing_supabase_setup() {
    let t = setup().await;
    {
        let mut tuning = t.app.core.mobile.tuning.lock().unwrap();
        tuning.url = String::new();
        tuning.anon_key = String::new();
    }
    t.on("full").await;
    let remote = manager::overview(&t.app.core).unwrap().remote;
    assert_eq!((remote.status.state.as_str(), remote.configured), ("not_configured", false));
}

#[tokio::test(flavor = "multi_thread")]
async fn stops_when_switched_off_and_when_the_phone_is_revoked_and_forgets_the_mailbox() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    until(|| t.state() == "connected", 3000).await;
    t.app.ok(|c| devices::revoke_device(c, &p.id));
    let row: Vec<(Option<String>, Option<String>)> = t.app.rows(&format!("SELECT mailbox, wire_key FROM mobile_devices WHERE id = '{}'", p.id));
    assert_eq!(row, vec![(None, None)]);
    assert!(ask_with(&mut p, request("GET", "/me", Value::Null, now_ms()), 300).await.unwrap().is_none());
    manager::set_remote_mode(&t.app.core, "off").await.unwrap();
    assert_eq!(t.state(), "off");
}

#[tokio::test(flavor = "multi_thread")]
async fn local_mode_does_not_change_and_nothing_is_sent_to_supabase() {
    let t = setup().await;
    t.activate("lifetime+mobile3");
    let lan = t.lan().await;
    let hello: Value = t.http.get(format!("{lan}/hello")).send().await.unwrap().json().await.unwrap();
    assert_eq!(hello["remote"], json!({ "mode": "off" }));
    let owner = t.phone("OWNER");
    let write: Value =
        t.http.post(format!("{lan}/api/brands.create")).bearer_auth(&owner.token).json(&json!({ "name": "Nokia" })).send().await.unwrap().json().await.unwrap();
    assert_eq!(write["ok"], true);
    assert!(t.fake.calls().is_empty());
    assert_eq!(t.app.ok(|c| devices::get_device(c, &owner.id)).last_seen_via.as_deref(), Some("lan"));
    manager::set_remote_mode(&t.app.core, "view").await.unwrap();
    let hello: Value = t.http.get(format!("{lan}/hello")).send().await.unwrap().json().await.unwrap();
    assert_eq!(hello["remote"], json!({ "mode": "view" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn gives_each_phone_its_own_mailbox_and_key_at_pairing() {
    let t = setup().await;
    t.activate("lifetime+mobile3");
    let lan = t.lan().await;
    let code = manager::start_pairing(&t.app.core).unwrap().code;
    let res: Value = t.http.post(format!("{lan}/pair")).json(&json!({ "code": code, "deviceName": "Ali" })).send().await.unwrap().json().await.unwrap();
    let b64 = regex::Regex::new(r"^[A-Za-z0-9_-]{43}$").unwrap();
    assert!(b64.is_match(res["remote"]["mailbox"].as_str().unwrap()));
    assert!(b64.is_match(res["remote"]["key"].as_str().unwrap()));
    assert!(!res["remote"]["deviceId"].as_str().unwrap().is_empty());
    let other = t.app.ok(|c| devices::create_device(c, "Other"));
    assert_ne!(other.remote.mailbox, res["remote"]["mailbox"].as_str().unwrap());
}

// ---------- requests that arrive through the mailbox ----------

#[tokio::test(flavor = "multi_thread")]
async fn answers_a_read_like_on_the_shop_wifi_and_notes_that_it_came_from_outside() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    t.app.ok(|c| catalog::create_brand(c, "Samsung"));
    let res = ask(&mut p, "POST", "/api/brands.list", json!({})).await.unwrap();
    assert_eq!(res.status, 200);
    assert_eq!((res.body["ok"].as_bool(), res.body["data"][0]["name"].as_str()), (Some(true), Some("Samsung")));
    assert_eq!(t.app.ok(|c| devices::get_device(c, &p.id)).last_seen_via.as_deref(), Some("remote"));
    until(|| t.fake.waiting().is_empty(), 3000).await; // the request was acked and the answer read: nothing is left behind
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sale_from_outside_gives_the_same_database_result_as_in_the_shop() {
    let t = setup().await;
    t.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 0 }))));
    let sale = |unit: String, request_id: &str| json!({ "paid": 6_000_000, "paymentMethod": "CASH", "requestId": request_id, "lines": [{ "unitId": unit, "unitPrice": 6_000_000 }] });
    let mut owner = t.phone("OWNER");
    t.on("full").await;

    let remote = ask(&mut owner, "POST", "/api/sales.create", sale(t.add_unit("35000000000001", 6_000_000), "remote-sale-0001")).await.unwrap();
    assert_eq!(remote.body["ok"], true, "{:?}", remote.body);
    let lan = t.lan().await;
    let res: Value = t
        .http
        .post(format!("{lan}/api/sales.create"))
        .bearer_auth(&owner.token)
        .json(&sale(t.add_unit("35000000000002", 6_000_000), "lan-sale-0000001"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(res["ok"], true, "{res:?}");

    let rows = |sql: &str| -> Vec<BTreeMap<String, Value>> { t.app.rows(sql) };
    let mut sales = rows("SELECT total, paid, discount, status, employee_id, via FROM sales ORDER BY rowid");
    let vias: Vec<Value> = sales.iter_mut().map(|s| s.remove("via").unwrap()).collect();
    assert_eq!(sales[0], sales[1]); // the same sale, whichever way it came in
    assert_eq!(vias, vec![json!("remote"), json!("lan")]);
    assert_eq!(rows("SELECT type, quantity FROM stock_movements WHERE type = 'SALE'").len(), 2);
    let cash = rows("SELECT type, direction, amount FROM cash_movements WHERE type = 'SALE'");
    assert_eq!(
        serde_json::to_value(cash).unwrap(),
        json!([{ "type": "SALE", "direction": "IN", "amount": 6_000_000 }, { "type": "SALE", "direction": "IN", "amount": 6_000_000 }])
    );
    let lines = rows("SELECT unit_price, unit_cost_at_sale FROM sale_lines");
    assert_eq!(
        serde_json::to_value(lines).unwrap(),
        json!([{ "unit_price": 6_000_000, "unit_cost_at_sale": 4_000_000 }, { "unit_price": 6_000_000, "unit_cost_at_sale": 4_000_000 }])
    );
    let vias = rows("SELECT via FROM stock_movements WHERE type = 'SALE' ORDER BY rowid");
    assert_eq!(serde_json::to_value(vias).unwrap(), json!([{ "via": "remote" }, { "via": "lan" }]));
}

#[tokio::test(flavor = "multi_thread")]
async fn view_only_refuses_changes_printing_and_uploads_and_full_allows_the_change() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("view").await;
    let refused = ask(&mut p, "POST", "/api/brands.create", json!({ "name": "Nokia" })).await.unwrap();
    assert_eq!((refused.status, refused.body["ok"].as_bool(), refused.body["error"]["code"].as_str()), (403, Some(false), Some("remote_read_only")));
    assert!(t.brands().is_empty());
    for channel in ["sales.printReceipt", "repairs.printSlip"] {
        let r = ask(&mut p, "POST", &format!("/api/{channel}"), json!({ "id": "x" })).await.unwrap();
        assert_eq!(r.body["error"]["code"], "remote_read_only", "{channel}");
    }
    use base64::Engine;
    let upload =
        ask(&mut p, "POST", "/files", json!({ "b64": base64::engine::general_purpose::STANDARD.encode([1u8; 40]), "type": "image/png" })).await.unwrap();
    assert_eq!(upload.body["error"]["code"], "remote_read_only");
    assert_eq!(ask(&mut p, "POST", "/api/brands.list", json!({})).await.unwrap().status, 200);
    assert_eq!(ask(&mut p, "GET", "/me", Value::Null).await.unwrap().body["data"]["remote"]["writes"], false);

    manager::set_remote_mode(&t.app.core, "full").await.unwrap(); // no reconnect needed
    let ok = ask(&mut p, "POST", "/api/brands.create", json!({ "name": "Nokia" })).await.unwrap();
    assert!(has(&ok.body, json!({ "ok": true, "data": { "name": "Nokia" } })));
    assert_eq!(t.brands(), vec!["Nokia"]);
    assert_eq!(ask(&mut p, "GET", "/me", Value::Null).await.unwrap().body["data"]["remote"]["writes"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn keeps_the_roles_a_seller_outside_gets_what_a_seller_gets_in_the_shop_and_no_costs() {
    let t = setup().await;
    let mut seller = t.phone("SELLER");
    t.on("full").await;
    assert_eq!(ask(&mut seller, "POST", "/api/purchases.create", json!({})).await.unwrap().body["error"]["code"], "forbidden");
    t.add_unit("35000000000001", 6_000_000);
    let list = ask(&mut seller, "POST", "/api/units.list", json!({})).await.unwrap().body.to_string();
    assert!(list.contains("A15"));
    assert!(!list.to_lowercase().contains("cost"));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_replayed_message_applied_once_and_never_answered_twice() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    let req = request("POST", "/api/brands.create", json!({ "name": "Nokia" }), now_ms());
    let sealed = seal(&p, &req);
    send_sealed(&p.mb, &p.mailbox, Dir::ToPc, &req.id, &sealed).await.unwrap();
    assert_eq!(answer_for(&mut p, &req.id, 2000).await.unwrap().body["ok"], true);
    send_sealed(&p.mb, &p.mailbox, Dir::ToPc, &req.id, &sealed).await.unwrap(); // an attacker puts the very same bytes back
    assert!(answer_for(&mut p, &req.id, 400).await.is_none());
    assert_eq!(t.brands().len(), 1);
    until(|| t.fake.waiting().is_empty(), 3000).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_a_request_older_than_2_minutes() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    let old = ask_with(&mut p, request("POST", "/api/brands.create", json!({ "name": "Late" }), now_ms() - 3 * 60_000), 2500).await.unwrap().unwrap();
    assert_eq!((old.status, old.body["ok"].as_bool(), old.body["error"]["code"].as_str()), (408, Some(false), Some("request_expired")));
    assert!(t.brands().is_empty());
    let fresh = ask_with(&mut p, request("POST", "/api/brands.create", json!({ "name": "Fresh" }), now_ms() - 60_000), 2500).await.unwrap().unwrap();
    assert_eq!(fresh.body["ok"], true); // a minute is fine
}

#[tokio::test(flavor = "multi_thread")]
async fn drops_a_message_sealed_with_another_key_counts_it_and_acks_it() {
    let t = setup().await;
    let p = t.phone("OWNER");
    t.on("full").await;
    let mut stranger = Phone::new(&t.fake, p.id.clone(), p.token.clone(), p.mailbox.clone(), wire::key_to_string(&wire::new_key()));
    assert!(ask_with(&mut stranger, request("POST", "/api/brands.create", json!({ "name": "Evil" }), now_ms()), 500).await.unwrap().is_none());
    assert!(t.brands().is_empty());
    assert_eq!(t.app.core.mobile.remote_status().dropped, 1);
    until(|| t.fake.waiting().is_empty(), 3000).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn pauses_outside_access_after_20_bad_messages_in_a_minute() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    until(|| t.state() == "connected", 3000).await;
    for i in 0..20 {
        p.mb.send(&p.mailbox, Dir::ToPc, &format!("garbage {i}")).await.unwrap();
    }
    until(|| t.state() == "paused", 3000).await;
    assert_eq!(t.app.core.mobile.remote_status().dropped, 20);
    assert!(ask_with(&mut p, request("GET", "/me", Value::Null, now_ms()), 300).await.unwrap().is_none());
    // paused: nothing is answered
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_pairing_through_the_mailbox_and_does_not_serve_the_apk() {
    let t = setup().await;
    let mut p = t.phone("OWNER");
    t.on("full").await;
    t.lan().await;
    let code = manager::start_pairing(&t.app.core).unwrap().code; // a real, valid code is on screen
    let before = t.devices_count();
    let res = ask(&mut p, "POST", "/pair", json!({ "code": code, "deviceName": "Intruder" })).await.unwrap();
    assert_eq!((res.status, res.body["error"]["code"].as_str()), (400, Some("invalid_input"))); // not even a path the mailbox accepts
    let direct = server::handle_remote_request(t.app.core.clone(), &p.id, &request("POST", "/pair", json!({ "code": code }), now_ms())).await;
    assert_eq!(direct.status, 400);
    assert_eq!(t.devices_count(), before);
    assert!(t.app.core.mobile.pairing.status().active);
    assert_eq!(server::handle_remote_request(t.app.core.clone(), &p.id, &request("GET", "/app.apk", Value::Null, now_ms())).await.status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn puts_nothing_readable_in_the_mailbox() {
    let t = setup().await;
    t.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 0 }))));
    let unit = t.add_unit("35000000000001", 6_123_456);
    let customer =
        psm_core::api::run_channel(&t.app.core, "customers.create", json!({ "name": "Zohra Bensalem", "phone": "0550123456" }), Caller::Desktop).await;
    let customer_id = customer.data().unwrap()["id"].as_str().unwrap().to_owned();
    let mut p = t.phone("OWNER");
    t.on("full").await;
    let sale = json!({ "paid": 6_123_456, "paymentMethod": "CASH", "requestId": "secret-sale-001", "customerId": customer_id, "lines": [{ "unitId": unit, "unitPrice": 6_123_456 }] });
    assert_eq!(ask(&mut p, "POST", "/api/sales.create", sale).await.unwrap().body["ok"], true);
    // Everything that ever went into the mailbox, in both directions.
    let all = t.sent_bodies();
    assert!(all.len() > 100);
    for secret in ["Zohra", "Bensalem", "0550123456", "35000000000001", "6123456", "sales.create", "Samsung"] {
        assert!(!all.contains(secret), "{secret} is readable");
    }
}

// ---------- linking a phone from another network ----------

/// The phone's side of a remote pairing: the private mailbox derived from the code, then one /pair request.
async fn phone_side(t: &T, code: &str, device_name: &str) -> Result<wire::Response, &'static str> {
    let raw = code.replace('-', "");
    let (mailbox, key) = pairing_channel(&raw);
    let mut link = Phone::new(&t.fake, PAIRING_DEVICE_ID.into(), String::new(), mailbox, key);
    let end = Instant::now() + Duration::from_millis(500);
    while link.mb.seen(&link.mailbox).await.ok().flatten().is_none() {
        if Instant::now() > end {
            return Err("shop_offline");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    match ask_with(&mut link, request("POST", "/pair", json!({ "deviceName": device_name }), now_ms()), 1500).await {
        Ok(Some(res)) => Ok(res),
        _ => Err("shop_timeout"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_pairing_needs_outside_access_to_be_on() {
    let t = setup().await;
    t.activate("lifetime+mobile3");
    assert_eq!(code(manager::start_remote_pair(&t.app.core).await), "remote_off");
}

#[tokio::test(flavor = "multi_thread")]
async fn links_a_phone_with_a_one_time_code_and_the_new_phone_works() {
    let t = setup().await;
    t.on("full").await;
    let pair_code = manager::start_remote_pair(&t.app.core).await.unwrap().code;
    assert!(regex::Regex::new(r"^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$").unwrap().is_match(&pair_code));
    let res = phone_side(&t, &pair_code, "Far phone").await.unwrap();
    assert_eq!(res.status, 200, "{:?}", res.body);
    let b = &res.body;
    let id = b["device"]["id"].as_str().unwrap().to_owned();
    assert!(!b["token"].as_str().unwrap().is_empty());
    assert_eq!(b["remote"]["deviceId"].as_str(), Some(id.as_str()));
    let status = t.app.core.mobile.remote_pairing.status();
    assert_eq!((status.active, status.paired_device_id.as_deref()), (false, Some(id.as_str())));

    // The owner gives it a role, then the phone uses its own mailbox and key.
    let input = parse(json!({ "id": id, "name": "Far phone", "role": "OWNER", "employeeId": null }));
    t.app.ok(|c| devices::update_device(c, &input));
    let mut far = Phone::new(
        &t.fake,
        id,
        b["token"].as_str().unwrap().into(),
        b["remote"]["mailbox"].as_str().unwrap().into(),
        b["remote"]["key"].as_str().unwrap().into(),
    );
    until(|| t.state() == "connected", 3000).await;
    let me = ask(&mut far, "GET", "/me", Value::Null).await.unwrap();
    assert!(has(&me.body, json!({ "ok": true, "data": { "name": "Far phone", "role": "OWNER" } })), "{:?}", me.body);
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_pairing_is_single_use() {
    let t = setup().await;
    t.on("full").await;
    let pair_code = manager::start_remote_pair(&t.app.core).await.unwrap().code;
    assert_eq!(phone_side(&t, &pair_code, "Far phone").await.unwrap().status, 200);
    let before = t.devices_count();
    assert_eq!(phone_side(&t, &pair_code, "Second").await.err(), Some("shop_timeout"));
    assert_eq!(t.devices_count(), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_code_finds_nothing_and_nothing_readable_is_in_the_mailbox() {
    let t = setup().await;
    t.on("full").await;
    let pair_code = manager::start_remote_pair(&t.app.core).await.unwrap().code;
    let mut other = new_pair_code();
    while other == pair_code.replace('-', "") {
        other = new_pair_code();
    }
    assert_eq!(phone_side(&t, &format_pair_code(&other), "Far phone").await.err(), Some("shop_offline"));
    phone_side(&t, &pair_code, "Far phone").await.unwrap();
    let all = t.sent_bodies();
    assert!(!all.contains("Far phone"));
    assert!(!all.contains(&pair_code.replace('-', "")));
    assert!(!all.contains("token"));
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_pairing_respects_the_phone_limit_and_a_cancelled_code() {
    let t = setup().await;
    t.activate("shop");
    manager::set_remote_mode(&t.app.core, "full").await.unwrap();
    let phones: Vec<_> = (0..3).map(|_| t.phone("OWNER")).collect(); // the three allowed phones
    assert_eq!(code(manager::start_remote_pair(&t.app.core).await), "mobile_device_limit");
    t.app.ok(|c| devices::revoke_device(c, &phones[0].id));
    let pair_code = manager::start_remote_pair(&t.app.core).await.unwrap().code;
    let (mailbox, _) = pairing_channel(&pair_code.replace('-', ""));
    let mb = Mailbox::new(t.fake.config());
    let end = Instant::now() + Duration::from_secs(3);
    while mb.seen(&mailbox).await.ok().flatten().is_none() {
        assert!(Instant::now() < end, "the pairing mailbox was never registered");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    t.app.core.mobile.remote_pairing.cancel();
    assert_eq!(phone_side(&t, &pair_code, "Far phone").await.err(), Some("shop_timeout"));
}

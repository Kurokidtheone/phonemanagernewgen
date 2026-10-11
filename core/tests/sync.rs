// Phase 17: the sync engine on a real core with a simulated phone (no network). The phone is just a DeviceCaller
// that pulls and pushes through the same functions the channels use.
mod common;
use common::*;
use psm_core::caller::{DeviceCaller, Via};
use psm_core::mobile::devices;
use psm_core::services::{cash, catalog, customers, stock, sync};
use psm_core::Caller;
use serde_json::{json, Value};

fn phone(app: &App, role: &str) -> DeviceCaller {
    let made = app.ok(|c| devices::create_device(c, "Test phone"));
    let input = parse(json!({ "id": made.device.id, "name": "Test phone", "role": role, "employeeId": null }));
    app.ok(|c| devices::update_device(c, &input));
    DeviceCaller { device_id: made.device.id, role: Some(role.to_owned()), employee_id: None, via: Via::Lan }
}

fn push(app: &App, d: &DeviceCaller, ops: Vec<Value>) -> Vec<sync::OpResult> {
    let input: sync::PushInput = parse(json!({ "ops": ops }));
    app.as_caller(&Caller::Device(d.clone()), |c| sync::push(c, &input)).unwrap().results
}

fn pull(app: &App, d: &DeviceCaller, cursor: i64) -> sync::PullResult {
    app.as_caller(&Caller::Device(d.clone()), |c| sync::pull(c, &parse(json!({ "cursor": cursor })))).unwrap()
}

fn op(kind: &str, payload: Value) -> Value {
    json!({ "opId": uuid(), "type": kind, "madeAt": "2026-10-09T10:15:00.000Z", "payload": payload })
}
fn uuid() -> String {
    psm_core::util::uuid()
}

struct Shop {
    app: App,
    samsung: String,
    category: String,
}

fn shop() -> Shop {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let category = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    Shop { app, samsung, category }
}

impl Shop {
    fn item(&self, name: &str, qty: i64) -> String {
        let id = self
            .app
            .ok(|c| stock::create_item(c, &parse(json!({ "name": name, "categoryId": self.category, "salePrice": 100_000, "minPrice": 0, "avgCost": 50_000 }))))
            .id;
        if qty != 0 {
            self.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": id, "delta": qty, "reason": "COUNT_CORRECTION" }))));
        }
        id
    }
    fn unit(&self, n: u32) -> String {
        let input: stock::UnitAddInput = parse(
            json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "minPrice": 5_000_000,
                                                       "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" } }),
        );
        self.app.ok(|c| stock::add_unit(c, &input)).id
    }
}

fn applied(r: &sync::OpResult) -> &Value {
    assert_eq!(r.status, "applied", "{:?}", r);
    &r.result
}

// ---------- pull ----------

#[test]
fn pull_from_zero_is_a_snapshot_and_a_change_arrives_in_the_next_pull() {
    let s = shop();
    s.item("Chargeur", 5);
    s.unit(1);
    let d = phone(&s.app, "OWNER");

    let first = pull(&s.app, &d, 0);
    assert!(!first.reset && !first.more);
    assert_eq!(first.tables["products"].as_array().unwrap().len(), 2); // the item and the phone model
    assert_eq!(first.tables["phone_units"].as_array().unwrap().len(), 1);
    assert_eq!(first.tables["brands"].as_array().unwrap().len(), 1);
    assert!(first.tables.get("settings").is_none()); // nothing saved yet
    assert!(first.cursor > 0);

    // Nothing changed: an empty page and the same cursor.
    let quiet = pull(&s.app, &d, first.cursor);
    assert_eq!(quiet.cursor, first.cursor);
    assert!(quiet.tables.as_object().unwrap().is_empty());

    let newer = s.item("Cable", 3);
    s.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": newer, "delta": 2, "reason": "COUNT_CORRECTION" }))));
    let next = pull(&s.app, &d, first.cursor);
    let rows = next.tables["products"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "one row once, even though it changed twice");
    assert_eq!(rows[0]["name"], "Cable");
    assert_eq!(rows[0]["quantity"], 5);
    assert!(next.cursor > first.cursor);
}

#[test]
fn a_cursor_older_than_the_kept_changes_is_reset_and_a_cursor_from_the_future_too() {
    let s = shop();
    let item = s.item("Chargeur", 1);
    let d = phone(&s.app, "OWNER");
    let first = pull(&s.app, &d, 0);
    // The item is removed for good, long ago.
    s.app.exec("DELETE FROM stock_movements", []);
    s.app.exec("DELETE FROM products WHERE id = ?1", [&item]);
    s.app.exec("UPDATE changes SET at = '2020-01-01T00:00:00.000Z' WHERE op = 'DELETE'", []);
    let gone = pull(&s.app, &d, first.cursor.saturating_sub(1).max(1));
    assert!(gone.reset, "the deletion was forgotten, so the phone must start over");
    assert_eq!(gone.cursor, 0);
    // A fresh pull from 0 works again.
    assert!(!pull(&s.app, &d, 0).reset);
    assert!(pull(&s.app, &d, 9_999_999).reset);
}

#[test]
fn deletes_arrive_and_changes_older_than_30_days_are_trimmed_but_never_lose_a_row() {
    let s = shop();
    let item = s.item("Chargeur", 0);
    s.app.exec("UPDATE changes SET at = '2020-01-01T00:00:00.000Z'", []);
    let d = phone(&s.app, "OWNER");
    let all = pull(&s.app, &d, 0);
    assert!(all.tables["products"].as_array().unwrap().iter().any(|r| r["id"] == item.as_str()), "a row that never changed is still in the snapshot");
    s.app.exec("DELETE FROM stock_movements", []);
    s.app.exec("DELETE FROM products WHERE id = ?1", [&item]);
    let next = pull(&s.app, &d, all.cursor);
    assert_eq!(next.deletes["products"], json!([item]));
}

#[test]
fn a_seller_never_receives_a_cost_or_a_profit_but_an_owner_does() {
    let s = shop();
    s.item("Chargeur", 5);
    s.unit(1);
    let seller = phone(&s.app, "SELLER");
    let owner = phone(&s.app, "OWNER");
    let text = serde_json::to_string(&pull(&s.app, &seller, 0).tables).unwrap();
    for banned in ["avgCost", "\"cost\"", "profit", "margin", "commission", "salary", "sourcePurchase"] {
        assert!(!text.contains(banned), "{banned} leaked to a seller");
    }
    assert!(text.contains("salePrice"));
    let owner_text = serde_json::to_string(&pull(&s.app, &owner, 0).tables).unwrap();
    assert!(owner_text.contains("avgCost") && owner_text.contains("\"cost\""));
    // Employees: name and role only, even for an owner.
    s.app.ok(|c| psm_core::services::employees::create_employee(c, &parse(json!({ "name": "Sami", "role": "SELLER", "monthlySalary": 5_000_000 }))));
    let emp = serde_json::to_string(&pull(&s.app, &owner, 0).tables["employees"]).unwrap();
    assert!(emp.contains("Sami") && !emp.to_lowercase().contains("salary"));
}

#[test]
fn pull_pages_at_2000_rows_and_includes_customer_debts() {
    let s = shop();
    s.app.ok(|c| {
        for i in 0..2_050 {
            c.db.execute(
                "INSERT INTO brands (id, name, created_at, updated_at) VALUES (?1, ?2, '2026-01-01', '2026-01-01')",
                rusqlite::params![format!("b{i:05}"), format!("Brand {i}")],
            )?;
        }
        Ok(())
    });
    let d = phone(&s.app, "OWNER");
    let a = pull(&s.app, &d, 0);
    assert!(a.more);
    assert_eq!(a.tables["brands"].as_array().unwrap().len() + a.tables.get("categories").and_then(Value::as_array).map_or(0, Vec::len), 2000);
    let b = pull(&s.app, &d, a.cursor);
    assert!(!b.more);
    assert!(b.tables["brands"].as_array().unwrap().len() >= 50);

    // A credit sale makes a debt that comes with the pull.
    let item = s.item("Chargeur", 5);
    let customer = s.app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid", "phone": "0550000000" })))).id;
    let sale = parse(json!({ "paid": 0, "customerId": customer, "lines": [{ "productId": item, "quantity": 2, "unitPrice": 100_000 }] }));
    s.app.ok(|c| psm_core::services::sales::create_sale(c, &sale, Default::default()));
    let debts = pull(&s.app, &d, 0).debts;
    assert_eq!(debts.len(), 1);
    assert_eq!((debts[0].customer_id.as_str(), debts[0].balance), (customer.as_str(), 200_000));
}

// ---------- push: idempotency ----------

#[test]
fn the_same_op_pushed_twice_is_applied_once_with_the_same_result() {
    let s = shop();
    let item = s.item("Chargeur", 10);
    let d = phone(&s.app, "OWNER");
    let o = op(
        "sale",
        json!({ "tempId": uuid(), "tempReceipt": "T-ABCD-1", "paid": 200_000, "lines": [{ "productId": item, "quantity": 2, "unitPrice": 100_000 }] }),
    );
    let first = push(&s.app, &d, vec![o.clone()]);
    let second = push(&s.app, &d, vec![o.clone()]);
    assert_eq!(applied(&first[0]), applied(&second[0]));
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM sales"), 1);
    assert_eq!(s.app.val::<i64>("SELECT quantity FROM products WHERE id = (SELECT id FROM products WHERE name = 'Chargeur')"), 8);
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM applied_ops"), 1);
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM stock_movements WHERE type = 'SALE'"), 1);
}

fn scenario(s: &Shop) -> Vec<Value> {
    let item = s.item("Chargeur", 10);
    let cust = uuid();
    vec![
        op("customer_create", json!({ "tempId": cust, "name": "Nadia", "phone": "0661000000" })),
        op(
            "sale",
            json!({ "tempId": uuid(), "tempReceipt": "T-AAAA-1", "paid": 100_000, "customerId": cust, "lines": [{ "productId": item, "quantity": 2, "unitPrice": 100_000 }] }),
        ),
        op("customer_payment", json!({ "customerId": cust, "amount": 50_000, "method": "CASH" })),
        op(
            "sale",
            json!({ "tempId": uuid(), "tempReceipt": "T-AAAA-2", "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] }),
        ),
        op("price_change", json!({ "target": "item", "id": item, "salePrice": 120_000 })),
        op(
            "sale",
            json!({ "tempId": uuid(), "tempReceipt": "T-AAAA-3", "paid": 120_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 120_000 }] }),
        ),
    ]
}

fn fingerprint(app: &App) -> Value {
    json!({
        "sales": app.val::<i64>("SELECT count(*) FROM sales"),
        "total": app.val::<i64>("SELECT COALESCE(sum(total), 0) FROM sales"),
        "paid": app.val::<i64>("SELECT COALESCE(sum(paid), 0) FROM sales"),
        "qty": app.val::<i64>("SELECT quantity FROM products WHERE name = 'Chargeur'"),
        "price": app.val::<i64>("SELECT sale_price FROM products WHERE name = 'Chargeur'"),
        "customers": app.val::<i64>("SELECT count(*) FROM customers"),
        "payments": app.val::<i64>("SELECT COALESCE(sum(amount), 0) FROM customer_payments"),
        "held": app.val::<i64>("SELECT COALESCE(sum(amount), 0) FROM cash_movements WHERE held_by_device IS NOT NULL"),
        "movements": app.val::<i64>("SELECT count(*) FROM stock_movements"),
        "ops": app.val::<i64>("SELECT count(*) FROM applied_ops"),
    })
}

#[test]
fn a_batch_cut_in_the_middle_and_sent_again_ends_in_the_same_state_as_an_uninterrupted_one() {
    let whole = shop();
    let cut = shop();
    let ops_whole = scenario(&whole);
    let ops_cut = scenario(&cut);
    let dw = phone(&whole.app, "OWNER");
    let dc = phone(&cut.app, "OWNER");

    push(&whole.app, &dw, ops_whole);
    // The connection died after three ops: the phone never saw the answer and sends everything again.
    push(&cut.app, &dc, ops_cut[..3].to_vec());
    let again = push(&cut.app, &dc, ops_cut.clone());
    assert!(again.iter().all(|r| r.status == "applied"));
    assert_eq!(fingerprint(&whole.app), fingerprint(&cut.app));
    // And once more, for good measure.
    push(&cut.app, &dc, ops_cut);
    assert_eq!(fingerprint(&whole.app), fingerprint(&cut.app));
}

// ---------- conflicts ----------

#[test]
fn an_offline_sale_of_a_unit_the_pc_sold_meanwhile_is_a_conflict_and_changes_nothing() {
    let s = shop();
    let unit = s.unit(1);
    let item = s.item("Chargeur", 5);
    let d = phone(&s.app, "OWNER");
    // The PC sells the phone while the phone is offline.
    let sale = parse(json!({ "paid": 6_000_000, "lines": [{ "unitId": unit, "unitPrice": 6_000_000 }] }));
    s.app.ok(|c| psm_core::services::sales::create_sale(c, &sale, Default::default()));
    let sales_before = s.app.val::<i64>("SELECT count(*) FROM sales");
    let qty_before = s.app.val::<i64>("SELECT quantity FROM products WHERE name = 'Chargeur'");

    // The offline sale has the unit and an accessory: nothing of it may land.
    let o = op(
        "sale",
        json!({ "tempId": uuid(), "tempReceipt": "T-AAAA-1", "paid": 6_100_000, "lines": [{ "unitId": unit, "unitPrice": 6_000_000 }, { "productId": item, "quantity": 1, "unitPrice": 100_000 }] }),
    );
    let r = push(&s.app, &d, vec![o]);
    assert_eq!((r[0].status.as_str(), r[0].reason.as_deref()), ("conflict", Some("imei_already_sold")));
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM sales"), sales_before);
    assert_eq!(s.app.val::<i64>("SELECT quantity FROM products WHERE name = 'Chargeur'"), qty_before);
    let open: Vec<(String, String)> = s.app.rows::<(String, String)>("SELECT status, reason FROM sync_conflicts").into_iter().collect();
    assert_eq!(open, vec![("OPEN".to_owned(), "imei_already_sold".to_owned())]);
    let listed = s.app.ok(|c| sync::list_conflicts(c, true));
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].pc_has["status"], "SOLD");
    assert!(listed[0].pc_has["receiptNumber"].is_string());
}

#[test]
fn the_manager_can_apply_a_conflicting_sale_with_another_unit_or_discard_it() {
    let s = shop();
    let gone = s.unit(1);
    let other = s.unit(2);
    let d = phone(&s.app, "OWNER");
    let sale = parse(json!({ "paid": 6_000_000, "lines": [{ "unitId": gone, "unitPrice": 6_000_000 }] }));
    s.app.ok(|c| psm_core::services::sales::create_sale(c, &sale, Default::default()));
    let o = op("sale", json!({ "tempId": uuid(), "paid": 6_000_000, "lines": [{ "unitId": gone, "unitPrice": 6_000_000 }] }));
    push(&s.app, &d, vec![o.clone()]);
    let id = s.app.ok(|c| sync::list_conflicts(c, true))[0].id.clone();

    let done = s.app.ok(|c| sync::resolve_conflict(c, &parse(json!({ "id": id, "action": "apply", "unitId": other }))));
    assert_eq!(done.resolution, "applied_with_other_unit");
    assert_eq!(s.app.val::<String>(&format!("SELECT status FROM phone_units WHERE id = '{other}'")), "SOLD");
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM sales"), 2);
    assert_eq!(s.app.val::<String>("SELECT status FROM sync_conflicts"), "RESOLVED");
    assert!(s.app.val::<String>("SELECT resolved_by FROM sync_conflicts") == "manager");
    assert!(s.app.val::<String>("SELECT resolved_at FROM sync_conflicts").starts_with("20"));
    assert_eq!(common::code(s.app.ctx(|c| sync::resolve_conflict(c, &parse(json!({ "id": id, "action": "discard" }))))), "already_resolved");
    // The phone asking about the op again learns the decision.
    let again = push(&s.app, &d, vec![o]);
    assert_eq!(again[0].status, "conflict");
    assert_eq!(again[0].result["resolution"], "applied_with_other_unit");

    // Discard: a second conflict is closed without selling anything.
    let third = s.unit(3);
    let sale = parse(json!({ "paid": 6_000_000, "lines": [{ "unitId": third, "unitPrice": 6_000_000 }] }));
    s.app.ok(|c| psm_core::services::sales::create_sale(c, &sale, Default::default()));
    push(&s.app, &d, vec![op("sale", json!({ "paid": 6_000_000, "lines": [{ "unitId": third, "unitPrice": 6_000_000 }] }))]);
    let id2 = s.app.ok(|c| sync::list_conflicts(c, true))[0].id.clone();
    let sales = s.app.val::<i64>("SELECT count(*) FROM sales");
    s.app.ok(|c| sync::resolve_conflict(c, &parse(json!({ "id": id2, "action": "discard" }))));
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM sales"), sales);
    assert!(s.app.ok(|c| sync::list_conflicts(c, true)).is_empty());
}

#[test]
fn a_new_phone_with_an_imei_that_exists_is_a_conflict() {
    let s = shop();
    s.unit(1);
    let d = phone(&s.app, "OWNER");
    let payload = json!({ "tempId": uuid(), "imei1": make_imei("35000000000001"), "condition": "NEW", "cost": 1, "salePrice": 2, "minPrice": 1,
                          "model": { "brandId": s.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" } });
    let r = push(&s.app, &d, vec![op("stock_add_unit", payload)]);
    assert_eq!((r[0].status.as_str(), r[0].reason.as_deref()), ("conflict", Some("imei_exists")));
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM phone_units"), 1);
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM sync_conflicts WHERE status = 'OPEN'"), 1);
}

#[test]
fn an_offline_sale_of_three_accessories_with_one_in_stock_is_applied_negative_and_flagged() {
    let s = shop();
    let item = s.item("Chargeur", 1);
    let d = phone(&s.app, "OWNER");
    let r =
        push(&s.app, &d, vec![op("sale", json!({ "tempId": uuid(), "paid": 300_000, "lines": [{ "productId": item, "quantity": 3, "unitPrice": 100_000 }] }))]);
    assert_eq!(applied(&r[0])["flag"], "negative_stock");
    assert_eq!(s.app.val::<i64>("SELECT quantity FROM products WHERE name = 'Chargeur'"), -2);
    assert_eq!(s.app.val::<String>("SELECT sync_flag FROM sales"), "negative_stock");
    // The exception is for this op only: the PC's own till still refuses.
    let again = parse(json!({ "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] }));
    assert_eq!(common::code(s.app.ctx(|c| psm_core::services::sales::create_sale(c, &again, Default::default()))), "insufficient_stock");
}

#[test]
fn a_price_change_applies_last_arrival_wins_and_logs_old_and_new() {
    let s = shop();
    let item = s.item("Chargeur", 1);
    let d = phone(&s.app, "OWNER");
    let r = push(
        &s.app,
        &d,
        vec![
            op("price_change", json!({ "target": "item", "id": item, "salePrice": 90_000 })),
            op("price_change", json!({ "target": "item", "id": item, "salePrice": 95_000 })),
        ],
    );
    assert_eq!(applied(&r[0])["old"], 100_000);
    assert_eq!((applied(&r[1])["old"].as_i64(), applied(&r[1])["new"].as_i64()), (Some(90_000), Some(95_000)));
    assert_eq!(s.app.val::<i64>("SELECT sale_price FROM products WHERE name = 'Chargeur'"), 95_000);
}

// ---------- ids and customers ----------

#[test]
fn a_new_customer_then_a_credit_sale_in_the_same_push_lands_on_the_real_id_with_the_right_debt() {
    let s = shop();
    let item = s.item("Chargeur", 5);
    let d = phone(&s.app, "OWNER");
    let temp = uuid();
    let r = push(
        &s.app,
        &d,
        vec![
            op("customer_create", json!({ "tempId": temp, "name": "Nadia", "phone": "0661000000" })),
            op("sale", json!({ "tempId": uuid(), "paid": 50_000, "customerId": temp, "lines": [{ "productId": item, "quantity": 2, "unitPrice": 100_000 }] })),
        ],
    );
    let real = applied(&r[0])["customerId"].as_str().unwrap().to_owned();
    assert_ne!(real, temp);
    assert_eq!(s.app.val::<String>("SELECT customer_id FROM sales"), real);
    assert_eq!(s.app.ok(|c| psm_core::services::balance::customer_balance(c, &real)), 150_000);

    // Same phone number again: the existing customer is reused, and ops that name the new temp id follow it.
    let temp2 = uuid();
    let r2 = push(
        &s.app,
        &d,
        vec![
            op("customer_create", json!({ "tempId": temp2, "name": "Nadia B.", "phone": "0661000000" })),
            op("customer_payment", json!({ "customerId": temp2, "amount": 40_000, "method": "CASH" })),
        ],
    );
    assert_eq!(applied(&r2[0])["customerId"], real.as_str());
    assert_eq!(applied(&r2[0])["reused"], true);
    assert_eq!(s.app.val::<i64>("SELECT count(*) FROM customers"), 1);
    assert_eq!(s.app.ok(|c| psm_core::services::balance::customer_balance(c, &real)), 110_000);
}

#[test]
fn a_later_push_still_knows_a_temporary_id_from_an_earlier_one() {
    let s = shop();
    let d = phone(&s.app, "OWNER");
    let temp = uuid();
    push(&s.app, &d, vec![op("customer_create", json!({ "tempId": temp, "name": "Nadia", "phone": "0661000000" }))]);
    let r = push(&s.app, &d, vec![op("customer_payment", json!({ "customerId": temp, "amount": 10_000, "method": "CASH" }))]);
    assert_eq!(r[0].status, "applied");
}

#[test]
fn ops_are_checked_against_the_phone_s_role_and_bad_input_is_rejected_not_lost() {
    let s = shop();
    let item = s.item("Chargeur", 5);
    let seller = phone(&s.app, "SELLER");
    let r = push(
        &s.app,
        &seller,
        vec![
            op("price_change", json!({ "target": "item", "id": item, "salePrice": 1 })),
            op("sale", json!({ "paid": 0, "lines": [] })),
            op("teleport", json!({})),
            op("sale", json!({ "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] })),
        ],
    );
    let got: Vec<(&str, Option<&str>)> = r.iter().map(|x| (x.status.as_str(), x.reason.as_deref())).collect();
    assert_eq!(got, vec![("rejected", Some("forbidden")), ("rejected", Some("invalid_input")), ("rejected", Some("unknown_op")), ("applied", None)]);
    assert_eq!(s.app.val::<i64>("SELECT sale_price FROM products WHERE name = 'Chargeur'"), 100_000);
}

#[test]
fn stock_items_units_and_repairs_arrive_with_final_ids() {
    let s = shop();
    let d = phone(&s.app, "OWNER");
    let item_temp = uuid();
    let cust = uuid();
    let r = push(
        &s.app,
        &d,
        vec![
            op("stock_add_item", json!({ "tempId": item_temp, "name": "Coque", "categoryId": s.category, "salePrice": 50_000 })),
            op("customer_create", json!({ "tempId": cust, "name": "Karim", "phone": "0770000000" })),
            op(
                "repair_create",
                json!({ "customerId": cust, "brand": "Samsung", "model": "A15", "fault": "Screen", "estimatedPrice": 400_000, "deposit": 100_000 }),
            ),
        ],
    );
    assert!(r.iter().all(|x| x.status == "applied"), "{r:?}");
    let repair = applied(&r[2])["repairId"].as_str().unwrap().to_owned();
    assert!(applied(&r[2])["ticketNumber"].as_str().unwrap().starts_with("R-") || applied(&r[2])["ticketNumber"].is_string());
    // The repair keeps the time the phone made it, and the status change after it too.
    assert_eq!(s.app.val::<String>("SELECT received_at FROM repairs"), "2026-10-09T10:15:00.000Z");
    let r2 = push(&s.app, &d, vec![op("repair_status", json!({ "id": repair, "status": "DIAGNOSING" }))]);
    assert_eq!(r2[0].status, "applied");
    assert_eq!(s.app.val::<String>(&format!("SELECT status FROM repairs WHERE id = '{repair}'")), "DIAGNOSING");
    // The deposit in cash is held by the phone.
    assert_eq!(s.app.val::<i64>("SELECT COALESCE(sum(amount), 0) FROM cash_movements WHERE held_by_device IS NOT NULL"), 100_000);
}

// ---------- dates, receipts, cash ----------

#[test]
fn offline_sales_keep_the_phone_time_and_get_consecutive_final_receipt_numbers_in_order() {
    let s = shop();
    let item = s.item("Chargeur", 50);
    let d = phone(&s.app, "OWNER");
    let ops: Vec<Value> = (1..=10).map(|n| op("sale", json!({ "tempId": uuid(), "tempReceipt": format!("T-AB12-{n}"), "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] }))).collect();
    let r = push(&s.app, &d, ops);
    let numbers: Vec<String> = r.iter().map(|x| applied(x)["receiptNumber"].as_str().unwrap().to_owned()).collect();
    let seq: Vec<i64> = numbers.iter().map(|n| n.split('-').nth(1).unwrap().parse().unwrap()).collect();
    assert_eq!(seq, (seq[0]..seq[0] + 10).collect::<Vec<_>>(), "ten consecutive numbers: {numbers:?}");
    for n in 1..=10 {
        let found: String = s.app.val(&format!("SELECT receipt_number FROM sales WHERE temp_receipt = 'T-AB12-{n}'"));
        assert_eq!(found, numbers[n - 1]);
    }
    assert_eq!(s.app.val::<String>("SELECT date FROM sales LIMIT 1"), "2026-10-09T10:15:00.000Z");
    assert!(s.app.val::<String>("SELECT applied_at FROM sales LIMIT 1").as_str() > "2026-10-10");
    // The sale date, not the apply time, is on the stock movement.
    assert_eq!(s.app.val::<String>("SELECT at FROM stock_movements WHERE type = 'SALE' LIMIT 1"), "2026-10-09T10:15:00.000Z");
}

#[test]
fn an_offline_cash_sale_is_phone_cash_to_hand_over_until_the_manager_confirms() {
    let s = shop();
    let item = s.item("Chargeur", 5);
    let d = phone(&s.app, "OWNER");
    let session = s.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 1_000_000 })))).id;
    let drawer = |app: &App| app.ok(|c| cash::expected_cash(c, &session));
    assert_eq!(drawer(&s.app), 1_000_000);

    push(&s.app, &d, vec![op("sale", json!({ "tempId": uuid(), "paid": 200_000, "lines": [{ "productId": item, "quantity": 2, "unitPrice": 100_000 }] }))]);
    assert_eq!(drawer(&s.app), 1_000_000, "not in the drawer yet");
    let held = s.app.ok(sync::held_cash);
    assert_eq!((held.len(), held[0].amount, held[0].count), (1, 200_000, 1));
    assert_eq!(held[0].device_name.as_deref(), Some("Test phone"));

    // Closing and reopening a day does not swallow it either.
    let got = s.app.ok(|c| sync::confirm_held_cash(c, &parse(json!({ "deviceId": d.device_id }))));
    assert_eq!(got, 200_000);
    assert_eq!(drawer(&s.app), 1_200_000);
    assert!(s.app.ok(sync::held_cash).is_empty());
}

#[test]
fn held_cash_needs_an_open_day_to_confirm_and_is_not_adopted_by_a_new_day() {
    let s = shop();
    let item = s.item("Chargeur", 5);
    let d = phone(&s.app, "OWNER");
    push(&s.app, &d, vec![op("sale", json!({ "tempId": uuid(), "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] }))]);
    assert_eq!(common::code(s.app.ctx(|c| sync::confirm_held_cash(c, &parse(json!({ "deviceId": d.device_id }))))), "no_cash_session");
    let session = s.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 0 })))).id;
    assert_eq!(s.app.ok(|c| cash::expected_cash(c, &session)), 0);
    assert_eq!(s.app.ok(sync::held_cash).len(), 1);
}

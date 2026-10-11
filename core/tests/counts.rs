mod common;
use common::*;
use psm_core::services::{catalog, counts, purchases, stock, suppliers};
use serde::{Deserialize, Serialize};
use serde_json::json;

struct T {
    app: App,
    item: String,
    accessories: String,
    units: Vec<String>,
}

fn imei(n: u32) -> String {
    make_imei(&format!("3500000000000{n}"))
}

fn setup() -> T {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let accessories = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    let item = app.ok(|c| stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": accessories, "salePrice": 100_000, "avgCost": 50_000 })))).id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": item, "delta": 10, "reason": "COUNT_CORRECTION" }))));
    let units = [1, 2, 3]
        .iter()
        .map(|n| {
            let input: stock::UnitAddInput = parse(json!({ "imei1": imei(*n), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000,
                                                           "model": { "brandId": samsung, "name": "A15", "storage": "128GB", "color": "Noir" } }));
            app.ok(|c| stock::add_unit(c, &input)).id
        })
        .collect();
    T { app, item, accessories, units }
}

impl T {
    fn start(&self, v: serde_json::Value) -> counts::CountStarted {
        self.app.ok(|c| counts::start_count(c, &parse(v)))
    }
    fn scan(&self, count: &str, code: &str) -> psm_core::Res<counts::ScanOutcome> {
        self.app.ctx(|c| counts::scan_unit(c, count, code))
    }
    fn count_item(&self, count: &str, qty: i64) -> psm_core::Res<()> {
        self.app.ctx(|c| counts::count_item(c, count, &self.item, qty))
    }
    fn result(&self, id: &str) -> counts::CountResult {
        self.app.ok(|c| counts::result(c, id))
    }
    fn close(&self, id: &str, apply: bool) {
        self.app.ok(|c| counts::close_count(c, id, apply));
    }
    fn decide(&self, count: &str, unit: &str, action: &str) -> psm_core::Res<counts::CountResult> {
        self.app.ctx(|c| counts::decide_unit(c, &parse(json!({ "countId": count, "unitId": unit, "action": action }))))
    }
    fn n(&self, from: &str) -> i64 {
        self.app.val(&format!("SELECT count(*) FROM {from}"))
    }
    fn qty(&self) -> i64 {
        self.app.ok(|c| stock::get_item(c, &self.item)).quantity
    }
    fn status(&self, id: &str) -> String {
        self.app.ok(|c| stock::get_unit(c, id)).unit.status
    }
}

#[test]
fn reports_exactly_one_missing_phone() {
    let t = setup();
    let c = t.start(json!({ "scope": "PHONES" }));
    assert_eq!(t.scan(&c.id, &imei(1)).unwrap().status, "counted");
    assert_eq!(t.scan(&c.id, &imei(2)).unwrap().status, "counted");
    let r = t.result(&c.id);
    assert_eq!(r.missing.iter().map(|m| m.imei.clone().unwrap()).collect::<Vec<_>>(), vec![imei(3)]);
    assert_eq!(r.counted, 2);
    assert!(r.unexpected.is_empty() && r.differences.is_empty());
    assert_eq!(r.missing_cost, Some(4_000_000));
}

#[test]
fn reports_exactly_one_difference_for_an_accessory() {
    let t = setup();
    let c = t.start(json!({ "scope": "ITEMS" }));
    t.count_item(&c.id, 7).unwrap();
    let r = t.result(&c.id);
    assert_eq!(
        r.differences,
        vec![counts::ItemDifference {
            product_id: t.item.clone(),
            name: "Chargeur".into(),
            system: 10,
            counted: 7,
            difference: -3,
            difference_cost: Some(-150_000)
        }]
    );
    assert!(r.missing.is_empty() && r.unexpected.is_empty());
    assert_eq!(r.difference_cost, Some(-150_000));
}

#[test]
fn flags_a_sold_phone_and_an_unknown_imei_and_ignores_repeats() {
    let t = setup();
    t.app.exec("UPDATE phone_units SET status = 'SOLD' WHERE id = ?1", [&t.units[0]]);
    let c = t.start(json!({ "scope": "PHONES" }));
    let a = t.scan(&c.id, &imei(1)).unwrap();
    assert_eq!((a.status.as_str(), a.reason.as_deref()), ("unexpected", Some("not_in_stock")));
    let unknown = make_imei("35999999999999");
    let b = t.scan(&c.id, &unknown).unwrap();
    assert_eq!((b.status.as_str(), b.reason.as_deref(), b.unit.is_none()), ("unexpected", Some("unknown"), true));
    assert_eq!(t.scan(&c.id, &imei(1)).unwrap().status, "already");
    assert_eq!(t.scan(&c.id, &unknown).unwrap().status, "already");
    let mut reasons: Vec<String> = t.result(&c.id).unexpected.into_iter().map(|u| u.reason).collect();
    reasons.sort();
    assert_eq!(reasons, vec!["not_in_stock", "unknown"]);
    assert_eq!(t.n("stock_count_lines"), 2);
}

#[test]
fn two_phones_count_the_same_scope_together() {
    let t = setup();
    let first = t.start(json!({ "scope": "PHONES" }));
    let second = t.start(json!({ "scope": "PHONES" }));
    assert_eq!((second.id.as_str(), second.joined), (first.id.as_str(), true));
    assert!(!t.start(json!({ "scope": "ITEMS" })).joined);
    t.scan(&first.id, &imei(1)).unwrap();
    t.scan(&second.id, &imei(2)).unwrap();
    assert_eq!(t.result(&first.id).counted, 2);
}

#[test]
fn a_category_count_keeps_to_that_category() {
    let t = setup();
    let c = t.start(json!({ "scope": "CATEGORY", "categoryId": t.accessories }));
    assert!(t.count_item(&c.id, 5).is_ok());
    let s = t.scan(&c.id, &imei(1)).unwrap();
    assert_eq!((s.status.as_str(), s.reason.as_deref()), ("unexpected", Some("out_of_scope")));
    let phones = t.start(json!({ "scope": "PHONES" }));
    assert_eq!(code(t.count_item(&phones.id, 5)), "count_out_of_scope");
}

#[derive(Deserialize, Serialize, Debug, PartialEq)]
struct UnitState {
    id: String,
    status: String,
    cost: i64,
    sale_price: i64,
}

#[test]
fn applying_writes_the_adjustment_and_nothing_else() {
    let t = setup();
    let units_sql = "SELECT id, status, cost, sale_price FROM phone_units ORDER BY id";
    let before = (t.n("stock_movements"), t.n("cash_movements"), t.n("sales"), t.app.rows::<UnitState>(units_sql));
    let phones = t.start(json!({ "scope": "PHONES" }));
    t.scan(&phones.id, &imei(1)).unwrap();
    let items = t.start(json!({ "scope": "ITEMS" }));
    t.count_item(&items.id, 7).unwrap();
    t.close(&items.id, true);
    t.close(&phones.id, true); // a phone count has nothing to apply: units 2 and 3 are missing, not changed
    assert_eq!(t.qty(), 7);
    #[derive(Deserialize, Debug, PartialEq)]
    struct M {
        r#type: String,
        quantity: i64,
        unit_cost: i64,
        reason: String,
        ref_table: String,
        ref_id: String,
        unit_id: Option<String>,
    }
    let added: Vec<M> =
        t.app.rows("SELECT type, quantity, unit_cost, reason, ref_table, ref_id, unit_id FROM stock_movements ORDER BY created_at DESC, rowid DESC LIMIT 1");
    assert_eq!(
        added,
        vec![M {
            r#type: "ADJUSTMENT".into(),
            quantity: -3,
            unit_cost: 50_000,
            reason: "COUNT_CORRECTION".into(),
            ref_table: "stock_counts".into(),
            ref_id: items.id.clone(),
            unit_id: None
        }]
    );
    assert_eq!(t.n("stock_movements"), before.0 + 1);
    assert_eq!(t.n("cash_movements"), before.1);
    assert_eq!(t.n("sales"), before.2);
    assert_eq!(t.app.rows::<UnitState>(units_sql), before.3);
    assert_eq!(t.app.ok(|c| psm_core::db::DbExt::val::<String>(c.db, "SELECT status FROM stock_counts WHERE id = ?1", [&items.id])), "CLOSED");
}

#[test]
fn closing_without_applying_changes_no_quantity() {
    let t = setup();
    let c = t.start(json!({ "scope": "ITEMS" }));
    t.count_item(&c.id, 4).unwrap();
    let moves = t.n("stock_movements");
    t.close(&c.id, false);
    assert_eq!(t.qty(), 10);
    assert_eq!(t.n("stock_movements"), moves);
    let r = t.result(&c.id);
    assert_eq!((r.status.as_str(), r.applied), ("CLOSED", false));
}

#[test]
fn the_result_is_frozen_when_closed_and_takes_no_more_scans() {
    let t = setup();
    let c = t.start(json!({ "scope": "PHONES" }));
    t.scan(&c.id, &imei(1)).unwrap();
    t.close(&c.id, true);
    t.app.exec("UPDATE phone_units SET status = 'SOLD' WHERE id = ?1", [&t.units[1]]); // sold after the count
    let mut missing: Vec<String> = t.result(&c.id).missing.into_iter().map(|m| m.imei.unwrap()).collect();
    missing.sort();
    assert_eq!(missing, vec![imei(2), imei(3)]);
    assert_eq!(code(t.scan(&c.id, &imei(3))), "count_closed");
    assert_eq!(code(t.count_item(&c.id, 1)), "count_closed");
}

#[test]
fn missing_phones_are_decided_one_by_one() {
    let t = setup();
    let c = t.start(json!({ "scope": "PHONES" }));
    t.scan(&c.id, &imei(1)).unwrap();
    assert_eq!(code(t.decide(&c.id, &t.units[1], "KEEP")), "count_open");
    t.close(&c.id, true);
    assert_eq!(t.n("phone_units WHERE status = 'IN_STOCK'"), 3);
    t.decide(&c.id, &t.units[1], "WRITE_OFF").unwrap();
    t.decide(&c.id, &t.units[2], "KEEP").unwrap();
    assert_eq!(t.status(&t.units[1]), "WRITTEN_OFF");
    assert_eq!(t.status(&t.units[2]), "IN_STOCK");
    let mut decisions: Vec<String> = t.result(&c.id).missing.into_iter().map(|m| m.decision.unwrap()).collect();
    decisions.sort();
    assert_eq!(decisions, vec!["KEEP", "WRITE_OFF"]);
    assert_eq!(code(t.decide(&c.id, &t.units[1], "KEEP")), "not_found");
}

#[test]
fn a_repeated_purchase_request_id_creates_one_purchase() {
    let t = setup();
    let supplier = t.app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Grossiste" })))).id;
    let model = t.app.ok(stock::list_models)[0].id.clone();
    let body = json!({ "supplierId": supplier, "date": now(), "paid": 1_000_000, "requestId": "req-0001-abcd",
                       "phoneLines": [{ "imei1": imei(4), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "productId": model }],
                       "itemLines": [{ "productId": t.item, "quantity": 5, "unitCost": 50_000 }] });
    let input: purchases::PurchaseInput = parse(body.clone());
    let first = t.app.ok(|c| purchases::create_purchase(c, &input));
    let again = t.app.ok(|c| purchases::create_purchase(c, &input));
    assert_eq!(again, first);
    assert_eq!(t.n("purchases"), 1);
    assert_eq!(t.n("purchase_lines"), 2);
    assert_eq!(t.n("phone_units"), 4);
    assert_eq!(t.n("stock_movements WHERE type = 'PURCHASE'"), 2);
    assert_eq!(t.n("cash_movements WHERE type = 'PURCHASE'"), 1);
    assert_eq!(t.qty(), 15);
    // Another id is another purchase (and the IMEI is now taken).
    let other: purchases::PurchaseInput = parse(merge(body, json!({ "requestId": "req-0002-abcd" })));
    assert_eq!(code(t.app.ctx(|c| purchases::create_purchase(c, &other))), "imei_duplicate");
}

#[test]
fn refuses_a_stored_invoice_file_that_does_not_exist() {
    let t = setup();
    let supplier = t.app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "G" })))).id;
    let bad: purchases::PurchaseInput = parse(json!({ "supplierId": supplier, "date": now(), "invoiceFile": "00000000-0000-0000-0000-000000000000.jpg",
                                                      "itemLines": [{ "productId": t.item, "quantity": 1, "unitCost": 1 }] }));
    assert_eq!(code(t.app.ctx(|c| purchases::create_purchase(c, &bad))), "file_not_found");
}

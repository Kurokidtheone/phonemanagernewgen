mod common;
use common::*;
use psm_core::services::{cash, catalog, customers, expenses, purchases, sales, services, stock, suppliers};
use serde::Deserialize;
use serde_json::{json, Value};

struct T {
    app: App,
    item: String,
    flexy: String,
}

fn setup() -> T {
    let app = fresh();
    let category = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    let item = app.ok(|c| stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": category, "salePrice": 100_000, "avgCost": 50_000 })))).id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": item, "delta": 100, "reason": "COUNT_CORRECTION" }))));
    app.ok(services::ensure_default_services);
    let flexy = app.ok(|c| services::list_services(c, false)).into_iter().find(|s| s.name == "Flexy Mobilis").unwrap().id;
    app.ok(|c| expenses::ensure_default_categories(c, &["Supplies"]));
    T { app, item, flexy }
}

impl T {
    fn open(&self, float: i64) -> psm_core::Res<psm_core::rows::Id> {
        self.app.ctx(|c| cash::open_session(c, &parse(json!({ "openingFloat": float }))))
    }
    fn sell(&self, amount: i64, over: Value) -> sales::SaleCreated {
        let input: sales::SaleInput = parse(merge(json!({ "paid": amount, "lines": [{ "productId": self.item, "quantity": 1, "unitPrice": amount }] }), over));
        self.app.ok(|c| sales::create_sale(c, &input, Default::default()))
    }
    fn flexy(&self, amount: i64) -> services::SellResult {
        self.app.ok(|c| services::sell_service(c, &parse(json!({ "serviceId": self.flexy, "amount": amount }))))
    }
    fn expense(&self, amount: i64, over: Value) -> expenses::Expense {
        let category = self.app.ok(expenses::list_categories)[0].id.clone();
        let input: expenses::ExpenseInput = parse(merge(json!({ "buyer": "Samira", "categoryId": category, "date": "2026-10-01", "amount": amount }), over));
        self.app.ok(|c| expenses::create_expense(c, &input))
    }
    fn session(&self) -> String {
        self.app.ok(cash::open_session_id).unwrap()
    }
    fn expected(&self) -> i64 {
        let s = self.session();
        self.app.ok(|c| cash::expected_cash(c, &s))
    }
    fn close(&self, counted: i64, note: &str) -> psm_core::Res<cash::CloseResult> {
        self.app.ctx(|c| cash::close_session(c, &parse(json!({ "counted": counted, "note": note }))))
    }
    fn manual(&self, v: Value) -> psm_core::Res<()> {
        self.app.ctx(|c| cash::add_manual(c, &parse(v)))
    }
    fn types(&self, sql: &str) -> Vec<String> {
        #[derive(Deserialize)]
        struct R {
            r#type: String,
        }
        self.app.rows::<R>(sql).into_iter().map(|r| r.r#type).collect()
    }
}

#[test]
fn float_plus_cash_sale_plus_flexy_minus_expense() {
    let t = setup();
    t.open(1_000_000).unwrap();
    t.sell(3_000_000, json!({}));
    t.flexy(100_000);
    t.expense(200_000, json!({}));
    assert_eq!(t.expected(), 3_900_000);
    let cur = t.app.ok(cash::current).unwrap();
    assert_eq!((cur.expected, cur.total_in, cur.total_out), (3_900_000, 3_100_000, 200_000));
}

#[test]
fn baridimob_and_ccp_sales_do_not_change_the_expected_cash() {
    let t = setup();
    t.open(1_000_000).unwrap();
    t.sell(3_000_000, json!({ "paymentMethod": "BARIDIMOB" }));
    t.sell(500_000, json!({ "paymentMethod": "CCP" }));
    assert_eq!(t.expected(), 1_000_000);
}

#[test]
fn counts_the_money_of_every_earlier_phase() {
    let t = setup();
    t.open(0).unwrap();
    let customer = t.app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid" })))).id;
    t.sell(1_000_000, json!({ "customerId": customer }));
    t.app.ok(|c| customers::receive_payment(c, &parse(json!({ "customerId": customer, "amount": 100_000, "date": now() }))));
    let supplier = t.app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Gros" })))).id;
    let input: purchases::PurchaseInput =
        parse(json!({ "supplierId": supplier, "date": now(), "paid": 200_000, "itemLines": [{ "productId": t.item, "quantity": 4, "unitCost": 100_000 }] }));
    t.app.ok(|c| purchases::create_purchase(c, &input));
    t.app.ok(|c| suppliers::add_payment(c, &parse(json!({ "supplierId": supplier, "amount": 50_000, "date": now() }))));
    t.expense(30_000, json!({}));
    assert_eq!(t.types("SELECT type FROM cash_movements ORDER BY rowid"), vec!["SALE", "CUSTOMER_PAYMENT", "PURCHASE", "SUPPLIER_PAYMENT", "EXPENSE"]);
    assert_eq!(t.expected(), 1_000_000 + 100_000 - 200_000 - 50_000 - 30_000);
}

#[test]
fn deleting_an_expense_or_a_service_sale_puts_the_cash_back() {
    let t = setup();
    t.open(0).unwrap();
    let e = t.expense(200_000, json!({}));
    let f = t.flexy(100_000);
    assert_eq!(t.expected(), 100_000 - 200_000);
    t.app.ok(|c| expenses::delete_expense(c, &e.id));
    t.app.ok(|c| services::delete_service_sale(c, &f.id));
    assert_eq!(t.expected(), 0);
    assert_eq!(
        t.types("SELECT type FROM cash_movements WHERE type IN ('EXPENSE_CANCEL','SERVICE_VOID') ORDER BY rowid"),
        vec!["EXPENSE_CANCEL", "SERVICE_VOID"]
    );
}

#[test]
fn an_expense_not_paid_from_the_drawer_writes_no_cash_movement() {
    let t = setup();
    t.open(0).unwrap();
    t.expense(200_000, json!({ "fromCash": false }));
    assert_eq!(t.expected(), 0);
}

#[test]
fn sessions_need_an_open_day_and_offer_the_last_count() {
    let t = setup();
    assert_eq!(code(t.app.ctx(cash::require_open_session)), "no_cash_session");
    let s = t.app.ok(cash::state);
    assert_eq!((s.open, s.session_id, s.last_counted), (false, None, 0));
    t.open(500_000).unwrap();
    assert_eq!(code(t.open(1)), "session_already_open");
    assert!(t.app.ok(cash::state).open);
    t.close(480_000, "short").unwrap();
    assert_eq!(code(t.app.ctx(cash::require_open_session)), "no_cash_session");
    let s = t.app.ok(cash::state);
    assert_eq!((s.open, s.last_counted), (false, 480_000));
    assert_eq!(code(t.close(0, "")), "no_cash_session");
}

#[test]
fn adopts_movements_made_while_no_day_is_open() {
    let t = setup();
    t.expense(100_000, json!({})); // before the first session exists
    t.open(1_000_000).unwrap();
    assert_eq!(t.expected(), 900_000);
    t.close(900_000, "").unwrap();
    t.expense(50_000, json!({})); // drawer closed
    t.open(900_000).unwrap();
    assert_eq!(t.expected(), 850_000);
    assert_eq!(t.app.val::<i64>("SELECT count(*) FROM cash_movements WHERE session_id IS NULL"), 0);
    // The first day is not changed by the later one.
    let first = t.app.ok(cash::list_sessions).into_iter().find(|s| s.closed_at.is_some()).unwrap();
    assert_eq!((first.expected, first.difference), (900_000, Some(0)));
}

#[test]
fn keeps_manual_movements_with_their_reason() {
    let t = setup();
    t.open(1_000_000).unwrap();
    t.manual(json!({ "direction": "OUT", "amount": 300_000, "reason": "BANK_DEPOSIT", "note": "BEA" })).unwrap();
    t.manual(json!({ "direction": "IN", "amount": 50_000, "reason": "CHANGE_ADDED" })).unwrap();
    assert_eq!(t.expected(), 750_000);
    #[derive(Deserialize, Debug, PartialEq)]
    struct R {
        r#type: String,
        ref_id: String,
        note: String,
    }
    let rows: Vec<R> = t.app.rows("SELECT type, ref_id, note FROM cash_movements ORDER BY rowid");
    assert_eq!(
        rows,
        vec![
            R { r#type: "MANUAL_OUT".into(), ref_id: "BANK_DEPOSIT".into(), note: "BEA".into() },
            R { r#type: "MANUAL_IN".into(), ref_id: "CHANGE_ADDED".into(), note: "".into() },
        ]
    );
    t.close(0, "").unwrap();
    assert_eq!(code(t.manual(json!({ "direction": "IN", "amount": 1, "reason": "OTHER" }))), "no_cash_session");
}

#[test]
fn closing_records_expected_counted_and_the_difference() {
    let t = setup();
    t.open(1_000_000).unwrap();
    t.sell(2_000_000, json!({}));
    let r = t.close(2_950_000, "missing 500").unwrap();
    assert_eq!((r.expected, r.counted, r.difference), (3_000_000, 2_950_000, -50_000));
    let s = &t.app.ok(cash::list_sessions)[0];
    assert_eq!(
        (s.opening_float, s.expected, s.counted_amount, s.difference, s.note.as_str()),
        (1_000_000, 3_000_000, Some(2_950_000), Some(-50_000), "missing 500")
    );
}

#[test]
fn services_apply_the_margin_rule_and_keep_it_on_the_sale() {
    let t = setup();
    t.open(0).unwrap();
    let s = t.flexy(100_000); // 3%
    assert_eq!((s.margin, s.cost), (3_000, 97_000));
    t.app.ok(|c| {
        services::update_service(
            c,
            &parse(json!({ "id": t.flexy, "name": "Flexy Mobilis", "marginType": "FIXED", "marginValue": 2_500, "defaultPrice": 0, "active": true })),
        )
    });
    let s = t.flexy(100_000);
    assert_eq!((s.margin, s.cost), (2_500, 97_500));
    assert_eq!(services::margin_for("FIXED", 9_999, 1_000), 1_000); // never more than the amount
    let from = psm_core::util::ms_to_iso(psm_core::util::now_ms() - 1000);
    let to = psm_core::util::ms_to_iso(psm_core::util::now_ms() + 1000);
    let list = t.app.ok(|c| services::list_service_sales(c, &from, &to));
    let mut margins: Vec<i64> = list.rows.iter().map(|r| r.margin).collect();
    margins.sort();
    assert_eq!(margins, vec![2_500, 3_000]);
    assert_eq!((list.total_amount, list.total_margin), (200_000, 5_500));
}

#[test]
fn another_service_has_an_optional_cost_and_a_phone_number() {
    let t = setup();
    t.open(0).unwrap();
    let sim = t.app.ok(|c| services::create_service(c, &parse(json!({ "name": "SIM activation", "defaultPrice": 50_000 }))));
    let a = t.app.ok(|c| services::sell_service(c, &parse(json!({ "serviceId": sim.id, "amount": 50_000 }))));
    assert_eq!((a.cost, a.margin), (0, 50_000));
    let b = t.app.ok(|c| services::sell_service(c, &parse(json!({ "serviceId": sim.id, "amount": 50_000, "cost": 20_000, "phoneNumber": "0550123456" }))));
    assert_eq!((b.cost, b.margin), (20_000, 30_000));
    let phones: Vec<Option<String>> = t.app.ok(|c| {
        let mut s = c.db.prepare("SELECT phone_number FROM service_sales ORDER BY rowid")?;
        let v = s.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    });
    assert_eq!(phones, vec![None, Some("0550123456".to_owned())]);
    t.app.ok(|c| {
        services::update_service(
            c,
            &parse(json!({ "id": sim.id, "name": "SIM activation", "marginType": "PERCENT", "marginValue": 0, "defaultPrice": 0, "active": false })),
        )
    });
    assert_eq!(code(t.app.ctx(|c| services::sell_service(c, &parse(json!({ "serviceId": sim.id, "amount": 1 }))))), "not_found");
    assert!(!t.app.ok(|c| services::list_services(c, true)).iter().any(|s| s.name == "SIM activation"));
}

#[test]
fn creates_the_three_flexy_operators_once() {
    let t = setup();
    t.app.ok(services::ensure_default_services);
    let mut names: Vec<String> = t.app.ok(|c| services::list_services(c, false)).into_iter().filter(|s| s.kind == "FLEXY").map(|s| s.name).collect();
    names.sort();
    assert_eq!(names, vec!["Flexy Djezzy", "Flexy Mobilis", "Flexy Ooredoo"]);
}

#[test]
fn the_z_report_matches_the_day() {
    let t = setup();
    t.open(1_000_000).unwrap();
    let customer = t.app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid" })))).id;
    t.sell(3_000_000, json!({}));
    t.sell(1_000_000, json!({ "paymentMethod": "BARIDIMOB" }));
    t.sell(500_000, json!({ "customerId": customer, "paid": 200_000 }));
    t.flexy(100_000);
    t.expense(200_000, json!({}));
    t.manual(json!({ "direction": "OUT", "amount": 100_000, "reason": "OWNER_WITHDRAWAL" })).unwrap();
    let session = t.session();
    let open = t.app.ok(|c| cash::z_report(c, &session));
    assert_eq!((open.sales_count, open.sales_total, open.expenses, open.counted), (3, 4_500_000, 200_000, None));
    assert_eq!((open.services.count, open.services.amount, open.services.margin), (1, 100_000, 3_000));
    assert_eq!(open.expected, 1_000_000 + 3_000_000 + 200_000 + 100_000 - 200_000 - 100_000);
    let m = &open.sales_by_method;
    assert_eq!((m[0].method.as_str(), m[0].count, m[0].total), ("BARIDIMOB", 1, 1_000_000));
    assert_eq!((m[1].method.as_str(), m[1].count, m[1].total, m[1].paid), ("CASH", 2, 3_500_000, 3_200_000));
    t.close(3_990_000, "").unwrap();
    let report = t.app.ok(|c| cash::z_report(c, &session));
    assert_eq!((report.expected, report.counted, report.difference), (4_000_000, Some(3_990_000), Some(-10_000)));
    let manual = report.movements.iter().find(|m| m.r#type == "MANUAL_OUT").unwrap();
    assert_eq!((manual.direction.as_str(), manual.amount), ("OUT", 100_000));
    assert_eq!(report.returns.count, 0);
}

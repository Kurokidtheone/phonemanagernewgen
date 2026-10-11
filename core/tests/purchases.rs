mod common;
use common::*;
use psm_core::services::{catalog, purchases, stock, suppliers};
use serde::Deserialize;
use serde_json::{json, Value};

const DATE: &str = "2026-10-01T10:00:00.000Z";

struct T {
    app: App,
    supplier: String,
    item: String,
    samsung: String,
}

fn setup() -> T {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let supplier = app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Tech Import", "phone": "0550123456" })))).id;
    let category = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    let item = app.ok(|c| stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": category, "salePrice": 100_000 })))).id;
    T { app, supplier, item, samsung }
}

impl T {
    fn purchase(&self, over: Value) -> purchases::PurchaseInput {
        parse(merge(json!({ "supplierId": self.supplier, "date": DATE }), over))
    }
    fn item_line(&self, quantity: i64, unit_cost: i64) -> Value {
        json!({ "productId": self.item, "quantity": quantity, "unitCost": unit_cost })
    }
    fn phone_line(&self, n: u32, over: Value) -> Value {
        merge(
            json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 2_000_000, "salePrice": 2_500_000,
                    "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" } }),
            over,
        )
    }
    fn create(&self, over: Value) -> psm_core::Res<psm_core::rows::Id> {
        let input = self.purchase(over);
        self.app.ctx(|c| purchases::create_purchase(c, &input))
    }
    fn product(&self) -> (i64, i64) {
        self.app.ok(|c| Ok(c.db.prepare("SELECT quantity, avg_cost FROM products WHERE id = ?1")?.query_row([&self.item], |r| Ok((r.get(0)?, r.get(1)?)))?))
    }
    fn count(&self, from: &str) -> i64 {
        self.app.val(&format!("SELECT count(*) FROM {from}"))
    }
    fn totals(&self, id: &str) -> suppliers::Totals {
        self.app.ok(|c| suppliers::supplier_totals(c, id))
    }
}

#[test]
fn averages_cost_10_at_500_then_10_at_700_gives_600() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(10, 50_000)] })).unwrap();
    assert_eq!(t.product(), (10, 50_000));
    t.create(json!({ "itemLines": [t.item_line(10, 70_000)] })).unwrap();
    assert_eq!(t.product(), (20, 60_000));
}

#[test]
fn writes_a_purchase_movement_for_every_line_and_refuses_unknown_items() {
    let t = setup();
    let id = t.create(json!({ "itemLines": [t.item_line(5, 10_000)], "phoneLines": [t.phone_line(1, json!({})), t.phone_line(2, json!({}))] })).unwrap().id;
    #[derive(Deserialize)]
    struct M {
        quantity: i64,
        ref_id: String,
    }
    let moves: Vec<M> = t.app.rows("SELECT quantity, ref_id FROM stock_movements WHERE type = 'PURCHASE' ORDER BY rowid");
    assert_eq!(moves.iter().map(|m| m.quantity).collect::<Vec<_>>(), vec![5, 1, 1]);
    assert!(moves.iter().all(|m| m.ref_id == id));
    assert_eq!(code(t.create(json!({ "itemLines": [{ "productId": "nope", "quantity": 1, "unitCost": 1 }] }))), "not_found");
}

#[test]
fn receives_units_with_their_cost_and_the_supplier_is_owed_the_rest() {
    let t = setup();
    let id =
        t.create(json!({ "paid": 1_000_000, "phoneLines": [t.phone_line(1, json!({})), t.phone_line(2, json!({})), t.phone_line(3, json!({}))] })).unwrap().id;
    let units = t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" }))));
    assert_eq!(units.len(), 3);
    assert!(units.iter().all(|u| u.cost == Some(2_000_000) && u.sale_price == 2_500_000));
    assert_eq!(t.app.ok(stock::list_models).len(), 1);
    assert_eq!(t.app.val::<i64>("SELECT quantity FROM products WHERE kind = 'PHONE_MODEL'"), 3);
    assert_eq!(t.totals(&t.supplier), suppliers::Totals { purchased: 6_000_000, paid: 1_000_000, balance: 5_000_000 });
    let first = &t.app.ok(|c| stock::get_unit(c, &units[0].id)).timeline[0];
    assert_eq!((first.kind.as_str(), first.party.as_deref()), ("PURCHASE", Some("Tech Import")));
    assert_eq!(t.app.ok(|c| purchases::get_purchase(c, &id)).lines.len(), 3);
}

#[test]
fn a_bad_or_repeated_imei_keeps_the_whole_purchase_out() {
    let t = setup();
    assert_eq!(code(t.create(json!({ "phoneLines": [t.phone_line(1, json!({})), t.phone_line(2, json!({ "imei1": "123" }))] }))), "imei_invalid");
    assert_eq!(code(t.create(json!({ "phoneLines": [t.phone_line(1, json!({})), t.phone_line(1, json!({}))] }))), "imei_duplicate");
    assert_eq!(t.count("purchases"), 0);
    assert_eq!(t.count("phone_units"), 0);
    assert_eq!(t.count("stock_movements"), 0);
    assert_eq!(t.count("products"), 1); // only the item: the model of the failed purchase was not kept
}

#[test]
fn paying_part_raises_the_balance_and_moves_cash_out() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(100, 100_000)], "paid": 4_000_000 })).unwrap();
    assert_eq!(t.totals(&t.supplier).balance, 6_000_000);
    #[derive(Deserialize, Debug, PartialEq)]
    struct C {
        direction: String,
        amount: i64,
        r#type: String,
    }
    let cash: Vec<C> = t.app.rows("SELECT direction, amount, type FROM cash_movements");
    assert_eq!(cash, vec![C { direction: "OUT".into(), amount: 4_000_000, r#type: "PURCHASE".into() }]);
    assert_eq!(t.app.ok(suppliers::list_suppliers)[0].balance, 6_000_000);
}

#[test]
fn payments_lower_the_balance_and_only_cash_touches_the_drawer() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(10, 100_000)], "paid": 0 })).unwrap();
    t.app.ok(|c| suppliers::add_payment(c, &parse(json!({ "supplierId": t.supplier, "amount": 300_000, "date": DATE }))));
    t.app.ok(|c| suppliers::add_payment(c, &parse(json!({ "supplierId": t.supplier, "amount": 200_000, "date": DATE, "method": "BANK" }))));
    assert_eq!(t.totals(&t.supplier).balance, 500_000);
    assert_eq!(t.count("cash_movements"), 1);
    assert_eq!(t.app.ok(|c| suppliers::get_supplier(c, &t.supplier)).payments.len(), 2);
}

#[test]
fn refuses_paying_more_than_the_total_and_an_empty_purchase() {
    let t = setup();
    assert_eq!(code(t.create(json!({ "itemLines": [t.item_line(1, 100)], "paid": 101 }))), "paid_exceeds_total");
    assert_eq!(code(t.create(json!({}))), "purchase_empty");
}

#[test]
fn refuses_to_delete_a_supplier_we_still_owe() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(1, 100)] })).unwrap();
    assert_eq!(code(t.app.ctx(|c| suppliers::delete_supplier(c, &t.supplier))), "supplier_has_balance");
}

fn seller(t: &T) -> String {
    t.app
        .ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Karim", "phone": "0555000000", "kind": "INDIVIDUAL", "idDocumentNumber": "104512367" }))))
        .id
}

#[test]
fn an_individual_purchase_must_be_fully_paid() {
    let t = setup();
    let id = seller(&t);
    let line = t.phone_line(1, json!({}));
    assert_eq!(code(t.create(json!({ "supplierId": id, "phoneLines": [line], "paid": 1_000_000 }))), "individual_must_be_paid");
    assert_eq!(code(t.create(json!({ "supplierId": id, "phoneLines": [line], "paid": 0 }))), "individual_must_be_paid");
    assert!(t.create(json!({ "supplierId": id, "phoneLines": [line], "paid": 2_000_000 })).is_ok());
}

#[test]
fn an_individual_supplier_needs_name_phone_and_id_document() {
    let t = setup();
    assert_eq!(code(t.app.ctx(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Karim", "kind": "INDIVIDUAL" }))))), "seller_details_required");
}

#[test]
fn buys_a_phone_from_a_customer_reusing_the_seller_by_id_number() {
    let t = setup();
    let buy = |n: u32| {
        let input: purchases::BuyBackInput = parse(json!({ "sellerName": "Karim", "sellerPhone": "0555000000", "sellerIdNumber": "104512367", "date": DATE,
                                                           "line": t.phone_line(n, json!({ "condition": "USED", "batteryHealth": 88 })) }));
        t.app.ok(|c| purchases::buy_from_individual(c, &input))
    };
    let first = buy(1);
    let second = buy(2);
    assert_eq!(second.supplier_id, first.supplier_id);
    assert_eq!(t.app.ok(suppliers::list_suppliers).iter().filter(|s| s.kind == "INDIVIDUAL").count(), 1);
    assert_eq!(t.totals(&first.supplier_id).balance, 0);
    assert_eq!(t.app.ok(|c| stock::list_units(c, &parse(json!({ "condition": "USED" })))).len(), 2);
    assert_eq!(t.count("cash_movements WHERE direction = 'OUT'"), 2);
}

#[test]
fn cancelling_is_refused_when_a_unit_was_sold() {
    let t = setup();
    let id = t.create(json!({ "phoneLines": [t.phone_line(1, json!({})), t.phone_line(2, json!({}))], "paid": 1_000_000 })).unwrap().id;
    let sold = t.app.ok(|c| stock::list_units(c, &Default::default()))[0].id.clone();
    t.app.exec("UPDATE phone_units SET status = 'SOLD' WHERE id = ?1", [&sold]);
    assert_eq!(code(t.app.ctx(|c| purchases::cancel_purchase(c, &id))), "purchase_has_sales");
    assert_eq!(t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" })))).len(), 1); // nothing was reversed
    assert!(t.app.ok(|c| purchases::get_purchase(c, &id)).cancelled_at.is_none());
}

#[test]
fn cancelling_is_refused_when_items_were_sold_after_the_purchase() {
    let t = setup();
    let id = t.create(json!({ "itemLines": [t.item_line(5, 10_000)] })).unwrap().id;
    let n = now();
    t.app.exec(
        "INSERT INTO stock_movements (id, product_id, type, quantity, unit_cost, at, created_at, updated_at) VALUES ('s1', ?1, 'SALE', -1, 0, ?2, '9999-01-01T00:00:00.000Z', ?2)",
        [&t.item, &n],
    );
    assert_eq!(code(t.app.ctx(|c| purchases::cancel_purchase(c, &id))), "purchase_has_sales");
}

#[test]
fn cancelling_reverses_stock_average_cost_balance_and_cash() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(10, 50_000)] })).unwrap();
    let second = t.create(json!({ "itemLines": [t.item_line(10, 70_000)], "phoneLines": [t.phone_line(1, json!({}))], "paid": 500_000 })).unwrap().id;
    assert_eq!(t.product(), (20, 60_000));
    t.app.ok(|c| purchases::cancel_purchase(c, &second));
    assert_eq!(t.product(), (10, 50_000));
    assert!(t.app.ok(|c| stock::list_units(c, &Default::default())).is_empty());
    assert_eq!(t.app.val::<i64>("SELECT quantity FROM products WHERE kind = 'PHONE_MODEL'"), 0);
    assert_eq!(t.totals(&t.supplier).balance, 500_000);
    #[derive(Deserialize, Debug, PartialEq)]
    struct C {
        direction: String,
        amount: i64,
    }
    let cash: Vec<C> = t.app.rows("SELECT direction, amount FROM cash_movements ORDER BY rowid");
    assert_eq!(cash, vec![C { direction: "OUT".into(), amount: 500_000 }, C { direction: "IN".into(), amount: 500_000 }]);
    assert_eq!(t.count("stock_movements WHERE reason = 'PURCHASE_CANCELLED'"), 2);
    assert_eq!(code(t.app.ctx(|c| purchases::cancel_purchase(c, &second))), "not_found");
    // The IMEI is free again.
    assert!(t.create(json!({ "phoneLines": [t.phone_line(1, json!({}))] })).is_ok());
}

#[test]
fn lists_filter_by_supplier_and_period_with_what_is_left_to_pay() {
    let t = setup();
    t.create(json!({ "itemLines": [t.item_line(1, 100_000)], "paid": 40_000 })).unwrap();
    t.create(json!({ "date": "2026-08-01T10:00:00.000Z", "itemLines": [t.item_line(1, 100_000)] })).unwrap();
    assert_eq!(t.app.ok(|c| purchases::list_purchases(c, &Default::default())).len(), 2);
    let recent = t.app.ok(|c| purchases::list_purchases(c, &parse(json!({ "from": "2026-09-01T00:00:00.000Z" }))));
    assert_eq!(recent.len(), 1);
    assert_eq!((recent[0].remaining, recent[0].line_count, recent[0].supplier_name.as_str()), (60_000, 1, "Tech Import"));
    assert!(t.app.ok(|c| purchases::list_purchases(c, &parse(json!({ "supplierId": "other" })))).is_empty());
}

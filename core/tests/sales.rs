mod common;
use chrono::Datelike;
use common::*;
use psm_core::services::{auth, balance, catalog, customers, sales, settings, stock};
use psm_core::Res;
use serde::Deserialize;
use serde_json::{json, Value};

struct T {
    app: App,
    samsung: String,
    customer: String,
    item: String,
}

fn setup() -> T {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let customer = app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid", "phone": "0550000000" })))).id;
    let category = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    let item = app
        .ok(|c| {
            stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": category, "salePrice": 100_000, "minPrice": 80_000, "avgCost": 50_000 })))
        })
        .id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": item, "delta": 10, "reason": "COUNT_CORRECTION" }))));
    T { app, samsung, customer, item }
}

fn imei(n: u32) -> String {
    make_imei(&format!("3500000000000{n}"))
}

impl T {
    fn add_phone(&self, n: u32) -> stock::UnitAdded {
        let input: stock::UnitAddInput = parse(json!({ "imei1": imei(n), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "minPrice": 5_500_000,
                                                       "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" } }));
        self.app.ok(|c| stock::add_unit(c, &input))
    }
    fn sell(&self, over: Value) -> Res<sales::SaleCreated> {
        let input: sales::SaleInput = try_parse(merge(json!({ "paid": 0, "lines": [] }), over))?;
        self.app.ctx(|c| sales::create_sale(c, &input, Default::default()))
    }
    fn item_line(&self, quantity: i64, price: i64, over: Value) -> Value {
        merge(json!({ "productId": self.item, "quantity": quantity, "unitPrice": price }), over)
    }
    fn count(&self, from: &str) -> i64 {
        self.app.val(&format!("SELECT count(*) FROM {from}"))
    }
    fn item_qty(&self) -> i64 {
        self.app.ok(|c| stock::get_item(c, &self.item)).quantity
    }
    fn unit(&self, id: &str) -> stock::UnitRow {
        self.app.ok(|c| stock::get_unit(c, id)).unit
    }
    fn sale(&self, id: &str, profit: bool) -> sales::SaleDetail {
        self.app.ok(|c| sales::get_sale(c, id, profit))
    }
    /// stock.updateUnit({ ...unit, imei1, imei2 }) like the unit form sends it.
    fn update_imeis(&self, id: &str, imei1: Option<&str>, imei2: Option<&str>) -> Res<()> {
        let u = self.unit(id);
        let input: stock::UnitUpdateInput =
            parse(json!({ "id": id, "imei1": imei1, "imei2": imei2, "condition": u.condition, "batteryHealth": u.battery_health,
                                                          "grade": u.grade, "cost": u.cost, "salePrice": u.sale_price, "notes": "" }));
        self.app.ctx(|c| stock::update_unit(c, &input))
    }
}

fn unit_line(id: &str, price: i64) -> Value {
    json!({ "unitId": id, "unitPrice": price })
}

#[derive(Deserialize, Debug, PartialEq)]
struct Cash {
    direction: String,
    amount: i64,
}

#[test]
fn sells_a_unit_once() {
    let t = setup();
    let u = t.add_phone(1);
    let first = t.sell(json!({ "paid": 6_000_000, "lines": [unit_line(&u.id, 6_000_000)] })).unwrap();
    assert_eq!(t.unit(&u.id).status, "SOLD");
    #[derive(Deserialize, Debug, PartialEq)]
    struct M {
        quantity: i64,
        ref_id: String,
    }
    let moves: Vec<M> = t.app.rows("SELECT quantity, ref_id FROM stock_movements WHERE type = 'SALE'");
    assert_eq!(moves, vec![M { quantity: -1, ref_id: first.id }]);
    assert_eq!(code(t.sell(json!({ "paid": 6_000_000, "lines": [unit_line(&u.id, 6_000_000)] }))), "unit_not_available");
    assert_eq!(t.count("sales"), 1);
    assert_eq!(t.app.val::<i64>("SELECT quantity FROM products WHERE kind = 'PHONE_MODEL'"), 0);
    let kinds: Vec<String> = t.app.ok(|c| stock::get_unit(c, &u.id)).timeline.into_iter().map(|e| e.kind).collect();
    assert_eq!(kinds, vec!["ADJUSTMENT", "SALE"]);
}

#[test]
fn refuses_the_same_unit_twice_in_one_sale() {
    let t = setup();
    let u = t.add_phone(1);
    assert_eq!(code(t.sell(json!({ "paid": 12_000_000, "lines": [unit_line(&u.id, 6_000_000), unit_line(&u.id, 6_000_000)] }))), "unit_not_available");
    assert_eq!(t.count("sales"), 0);
    assert_eq!(t.unit(&u.id).status, "IN_STOCK");
}

#[test]
fn a_sale_of_50000_paid_30000_raises_the_debt_by_20000() {
    let t = setup();
    let u = t.add_phone(1);
    let s = t.sell(json!({ "customerId": t.customer, "paid": 3_000_000, "lines": [unit_line(&u.id, 5_000_000)] })).unwrap();
    assert_eq!(t.app.ok(balance::customer_balances).get(&t.customer), Some(&2_000_000));
    let d = t.sale(&s.id, true);
    assert_eq!((d.total, d.paid, d.remaining), (5_000_000, 3_000_000, 2_000_000));
}

#[test]
fn needs_a_customer_for_a_debt_and_refuses_paying_too_much() {
    let t = setup();
    let u = t.add_phone(1);
    assert_eq!(code(t.sell(json!({ "paid": 1_000_000, "lines": [unit_line(&u.id, 6_000_000)] }))), "customer_required");
    assert_eq!(code(t.sell(json!({ "customerId": t.customer, "paid": 6_000_001, "lines": [unit_line(&u.id, 6_000_000)] }))), "paid_exceeds_total");
    assert!(t.sell(json!({ "paid": 6_000_000, "lines": [unit_line(&u.id, 6_000_000)], "discount": 7_000_000 })).is_err());
}

#[test]
fn a_trade_in_lowers_the_total_and_enters_stock_at_its_value() {
    let t = setup();
    let u = t.add_phone(1);
    let trade = json!({ "imei1": imei(2), "condition": "USED", "batteryHealth": 85, "value": 1_500_000, "model": { "brandId": t.samsung, "name": "Galaxy A10", "storage": "32GB", "color": "" } });
    let s = t.sell(json!({ "customerId": t.customer, "paid": 4_500_000, "tradeIn": trade, "lines": [unit_line(&u.id, 6_000_000)] })).unwrap();
    let d = t.sale(&s.id, true);
    assert_eq!((d.total, d.trade_in_value, d.remaining), (4_500_000, 1_500_000, 0));
    let used = t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK", "condition": "USED" }))));
    assert_eq!(used.len(), 1);
    assert_eq!((used[0].imei1.clone().unwrap(), used[0].cost, used[0].name.as_str()), (imei(2), Some(1_500_000), "Samsung Galaxy A10"));
    assert_eq!(t.app.val::<i64>("SELECT unit_cost FROM stock_movements WHERE type = 'TRADE_IN' AND quantity = 1"), 1_500_000);
    let trade_in = d.trade_in.unwrap();
    assert_eq!((trade_in.imei1.unwrap(), trade_in.value), (imei(2), 1_500_000));
    // No cash for the trade-in: only the 45,000 paid.
    let cash: Vec<Cash> = t.app.rows("SELECT direction, amount FROM cash_movements");
    assert_eq!(cash, vec![Cash { direction: "IN".into(), amount: 4_500_000 }]);
}

#[test]
fn a_trade_in_without_imei_joins_stock_and_can_get_one_later() {
    let t = setup();
    let u = t.add_phone(1);
    let trade = json!({ "condition": "USED", "value": 1_000_000, "model": { "brandId": t.samsung, "name": "Galaxy A10", "storage": "", "color": "" } });
    let s = t.sell(json!({ "customerId": t.customer, "paid": 5_000_000, "tradeIn": trade, "lines": [unit_line(&u.id, 6_000_000)] })).unwrap();
    let used = |t: &T| t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK", "condition": "USED" }))));
    let traded = used(&t)[0].clone();
    assert_eq!((traded.imei1.clone(), traded.cost), (None, Some(1_000_000)));
    let ti = t.sale(&s.id, true).trade_in.unwrap();
    assert_eq!((ti.imei1, ti.value), (None, 1_000_000));
    let smaller = merge(trade.clone(), json!({ "value": 500_000 }));
    assert!(t.sell(json!({ "customerId": t.customer, "paid": 0, "tradeIn": smaller, "lines": [t.item_line(1, 100_000, json!({}))] })).is_err()); // value exceeds the sale
    let second = t.add_phone(5);
    assert!(t.sell(json!({ "customerId": t.customer, "paid": 5_500_000, "tradeIn": smaller, "lines": [unit_line(&second.id, 6_000_000)] })).is_ok());
    assert_eq!(used(&t).len(), 2);
    // The IMEI can be added later, and then it is checked and kept.
    t.update_imeis(&traded.id, Some(&imei(7)), None).unwrap();
    assert_eq!(t.unit(&traded.id).imei1, Some(imei(7)));
    assert_eq!(code(t.update_imeis(&traded.id, None, None)), "imei_invalid");
    let other = used(&t).into_iter().find(|u| u.id != traded.id).unwrap();
    assert_eq!(code(t.update_imeis(&other.id, Some(&imei(7)), None)), "imei_duplicate");
    assert_eq!(code(t.update_imeis(&other.id, None, Some(&imei(8)))), "imei_invalid");
    // a second IMEI needs a first
}

#[test]
fn imei_rules_apply_to_the_trade_in_and_roll_the_sale_back() {
    let t = setup();
    let u = t.add_phone(1);
    let trade = json!({ "imei1": imei(1), "condition": "USED", "value": 1_000_000, "model": { "brandId": t.samsung, "name": "Galaxy A10", "storage": "", "color": "" } });
    assert_eq!(
        code(t.sell(json!({ "customerId": t.customer, "paid": 5_000_000, "tradeIn": trade, "lines": [unit_line(&u.id, 6_000_000)] }))),
        "imei_duplicate"
    );
    let bad = merge(trade.clone(), json!({ "imei1": "123" }));
    assert_eq!(code(t.sell(json!({ "customerId": t.customer, "paid": 5_000_000, "tradeIn": bad, "lines": [unit_line(&u.id, 6_000_000)] }))), "imei_invalid");
    assert_eq!(t.count("sales"), 0);
    assert_eq!(t.unit(&u.id).status, "IN_STOCK");
    let big = merge(trade, json!({ "imei1": imei(3), "value": 9_000_000 }));
    assert_eq!(code(t.sell(json!({ "customerId": t.customer, "paid": 0, "tradeIn": big, "lines": [unit_line(&u.id, 6_000_000)] }))), "trade_in_exceeds_total");
}

#[test]
fn items_lower_the_quantity_and_more_than_stock_is_refused() {
    let t = setup();
    t.sell(json!({ "paid": 300_000, "lines": [t.item_line(3, 100_000, json!({}))] })).unwrap();
    assert_eq!(t.item_qty(), 7);
    assert_eq!(code(t.sell(json!({ "paid": 800_000, "lines": [t.item_line(8, 100_000, json!({}))] }))), "insufficient_stock");
    assert_eq!(
        code(t.sell(json!({ "paid": 800_000, "lines": [t.item_line(5, 100_000, json!({})), t.item_line(5, 100_000, json!({}))] }))),
        "insufficient_stock"
    );
    assert_eq!(t.item_qty(), 7);
}

#[test]
fn sells_below_zero_only_with_negative_stock_allowed() {
    let t = setup();
    t.app.ok(|c| settings::update_public(c.db, serde_json::from_value(json!({ "allowNegativeStock": true })).unwrap()));
    t.sell(json!({ "paid": 1_200_000, "lines": [t.item_line(12, 100_000, json!({}))] })).unwrap();
    assert_eq!(t.item_qty(), -2);
}

#[test]
fn profit_uses_the_cost_at_sale_time() {
    let t = setup();
    let s = t.sell(json!({ "paid": 200_000, "lines": [t.item_line(2, 100_000, json!({}))] })).unwrap();
    let item = t.app.ok(|c| stock::get_item(c, &t.item));
    let update: stock::ItemUpdateInput = parse(
        json!({ "id": t.item, "name": item.name, "categoryId": item.category_id, "salePrice": item.sale_price, "minPrice": item.min_price, "avgCost": 90_000 }),
    );
    t.app.ok(|c| stock::update_item(c, &update));
    let d = t.sale(&s.id, true);
    assert_eq!((d.lines[0].unit_cost, d.lines[0].profit), (Some(50_000), Some(100_000)));
    assert_eq!(d.profit, Some(100_000));
    // Hidden while Finance is locked.
    let hidden = t.sale(&s.id, false);
    assert_eq!((hidden.profit, hidden.lines[0].unit_cost, hidden.lines[0].profit), (None, None, None));
}

#[test]
fn sale_and_line_discounts_go_into_totals_and_profit() {
    let t = setup();
    let s = t.sell(json!({ "paid": 170_000, "discount": 10_000, "lines": [t.item_line(2, 100_000, json!({ "discount": 20_000 }))] })).unwrap();
    let d = t.sale(&s.id, true);
    assert_eq!((d.subtotal, d.discount, d.total, d.profit), (180_000, 10_000, 170_000, Some(70_000)));
}

#[test]
fn a_price_under_the_minimum_needs_the_manager_password() {
    let t = setup();
    t.app.ok(|c| auth::set_password(c, "1234"));
    let u = t.add_phone(1);
    let low = |extra: Value| t.sell(merge(json!({ "paid": 5_000_000, "lines": [unit_line(&u.id, 5_000_000)] }), extra));
    assert_eq!(code(low(json!({}))), "manager_password_required");
    assert_eq!(code(low(json!({ "managerPassword": "nope" }))), "wrong_password");
    assert_eq!(t.unit(&u.id).status, "IN_STOCK");
    assert!(low(json!({ "managerPassword": "1234" })).is_ok());
}

#[test]
fn the_minimum_is_checked_after_the_line_discount() {
    let t = setup();
    t.app.ok(|c| auth::set_password(c, "1234"));
    assert!(t.sell(json!({ "paid": 160_000, "lines": [t.item_line(2, 100_000, json!({ "discount": 40_000 }))] })).is_ok()); // exactly 80,000 each
    assert_eq!(code(t.sell(json!({ "paid": 150_000, "lines": [t.item_line(2, 100_000, json!({ "discount": 50_000 }))] }))), "manager_password_required");
}

#[test]
fn numbers_receipts_per_year_sequentially() {
    let t = setup();
    let a = t.sell(json!({ "paid": 100_000, "lines": [t.item_line(1, 100_000, json!({}))] })).unwrap();
    let b = t.sell(json!({ "paid": 100_000, "lines": [t.item_line(1, 100_000, json!({}))] })).unwrap();
    let year = chrono::Local::now().year();
    assert_eq!(a.receipt_number, format!("{year}-000001"));
    assert_eq!(b.receipt_number, format!("{year}-000002"));
}

#[test]
fn writes_a_cash_movement_for_cash_only() {
    let t = setup();
    t.sell(json!({ "paid": 100_000, "lines": [t.item_line(1, 100_000, json!({}))] })).unwrap();
    t.sell(json!({ "paid": 100_000, "paymentMethod": "CCP", "lines": [t.item_line(1, 100_000, json!({}))] })).unwrap();
    let cash: Vec<Cash> = t.app.rows("SELECT direction, amount FROM cash_movements");
    assert_eq!(cash, vec![Cash { direction: "IN".into(), amount: 100_000 }]);
    assert_eq!(t.app.val::<String>("SELECT type FROM cash_movements"), "SALE");
}

#[test]
fn computes_the_warranty_end_and_lists_sales_with_filters() {
    let t = setup();
    let s = t.sell(json!({ "customerId": t.customer, "paid": 0, "lines": [t.item_line(1, 100_000, json!({ "warrantyDays": 30 }))] })).unwrap();
    let d = t.sale(&s.id, true);
    let end = psm_core::util::parse_ms(d.lines[0].warranty_end.as_deref().unwrap()).unwrap();
    assert_eq!((end - psm_core::util::parse_ms(&d.date).unwrap()) / 86_400_000, 30);
    t.sell(json!({ "paid": 100_000, "lines": [t.item_line(1, 100_000, json!({}))] })).unwrap();
    let list = |f: Value| t.app.ok(|c| sales::list_sales(c, &parse(f), None, None));
    assert_eq!(list(json!({})).len(), 2);
    let unpaid = list(json!({ "unpaidOnly": true }));
    assert_eq!(unpaid.len(), 1);
    assert_eq!(
        (unpaid[0].id.as_str(), unpaid[0].customer_name.as_deref(), unpaid[0].remaining, unpaid[0].items_summary.as_deref()),
        (s.id.as_str(), Some("Walid"), 100_000, Some("Chargeur"))
    );
    let tomorrow = psm_core::util::ms_to_iso(psm_core::util::now_ms() + 86_400_000);
    assert!(list(json!({ "from": tomorrow })).is_empty());
}

#[test]
fn refuses_an_empty_sale() {
    assert!(try_parse::<sales::SaleInput>(json!({ "paid": 0, "lines": [] })).is_err());
}

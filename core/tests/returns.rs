mod common;
use common::*;
use psm_core::services::{balance, catalog, customers, returns, sales, stock};
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
    let item = app.ok(|c| stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": category, "salePrice": 100_000, "avgCost": 50_000 })))).id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": item, "delta": 10, "reason": "COUNT_CORRECTION" }))));
    T { app, samsung, customer, item }
}

#[derive(Deserialize, Debug, PartialEq)]
struct Cash {
    direction: String,
    amount: i64,
    r#type: String,
}
fn cash_row(d: &str, a: i64, t: &str) -> Cash {
    Cash { direction: d.into(), amount: a, r#type: t.into() }
}

impl T {
    fn phone(&self, n: u32) -> String {
        let input: stock::UnitAddInput =
            parse(json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000,
                                                       "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "" } }));
        self.app.ok(|c| stock::add_unit(c, &input)).id
    }
    fn sell(&self, lines: Value, over: Value) -> sales::SaleCreated {
        let input: sales::SaleInput = parse(merge(json!({ "customerId": self.customer, "paid": 0, "lines": lines }), over));
        self.app.ok(|c| sales::create_sale(c, &input, Default::default()))
    }
    fn item_line(&self, quantity: i64, price: i64) -> Value {
        json!({ "productId": self.item, "quantity": quantity, "unitPrice": price })
    }
    fn line_ids(&self, sale: &str) -> Vec<String> {
        self.app.ok(|c| {
            let mut s = c.db.prepare("SELECT id FROM sale_lines WHERE sale_id = ?1 ORDER BY created_at, rowid")?;
            let ids = s.query_map([sale], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(ids)
        })
    }
    /// (index, quantity, restock)
    fn do_return(&self, sale: &str, lines: &[(usize, i64, bool)], extra: Value) -> Res<returns::ReturnResult> {
        let ids = self.line_ids(sale);
        let lines: Vec<Value> = lines.iter().map(|(i, q, r)| json!({ "saleLineId": ids[*i], "quantity": q, "restock": r })).collect();
        let input: returns::ReturnInput = try_parse(merge(json!({ "saleId": sale, "reason": "Changed mind", "lines": lines }), extra))?;
        self.app.ctx(|c| returns::create_return(c, &input))
    }
    fn cash(&self) -> Vec<Cash> {
        self.app.rows("SELECT direction, amount, type FROM cash_movements ORDER BY rowid")
    }
    fn remaining(&self, sale: &str) -> i64 {
        self.app.ok(|c| sales::get_sale(c, sale, true)).remaining
    }
    fn balance(&self) -> i64 {
        self.app.ok(|c| balance::customer_balance(c, &self.customer))
    }
    fn item_qty(&self) -> i64 {
        self.app.ok(|c| stock::get_item(c, &self.item)).quantity
    }
    fn unit(&self, id: &str) -> stock::UnitRow {
        self.app.ok(|c| stock::get_unit(c, id)).unit
    }
    fn pay(&self, amount: i64, over: Value) -> customers::PaymentResult {
        let input: customers::CustomerPaymentInput = parse(merge(json!({ "customerId": self.customer, "amount": amount, "date": now() }), over));
        self.app.ok(|c| customers::receive_payment(c, &input))
    }
}

fn unit_line(id: &str, price: i64) -> Value {
    json!({ "unitId": id, "unitPrice": price })
}

#[test]
fn returns_a_paid_phone_with_restock() {
    let t = setup();
    let unit = t.phone(1);
    let sale = t.sell(json!([unit_line(&unit, 6_000_000)]), json!({ "paid": 6_000_000 }));
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    assert_eq!((r.value, r.debt_cancelled, r.refund, r.refund_cash, r.status.as_str()), (6_000_000, 0, 6_000_000, 6_000_000, "RETURNED"));
    let u = t.unit(&unit);
    assert_eq!((u.status.as_str(), u.cost), ("IN_STOCK", Some(4_000_000)));
    assert_eq!(t.cash(), vec![cash_row("IN", 6_000_000, "SALE"), cash_row("OUT", 6_000_000, "SALE_RETURN")]);
    assert_eq!(t.app.val::<i64>("SELECT quantity FROM stock_movements WHERE type = 'RETURN'"), 1);
    assert_eq!(t.app.val::<i64>("SELECT quantity FROM products WHERE kind = 'PHONE_MODEL'"), 1);
    let d = t.app.ok(|c| sales::get_sale(c, &sale.id, true));
    assert_eq!((d.status.as_str(), d.remaining), ("RETURNED", 0));
    assert_eq!(t.balance(), 0);
}

#[test]
fn a_phone_sold_on_credit_cancels_the_debt_and_no_cash_moves() {
    let t = setup();
    let unit = t.phone(1);
    let sale = t.sell(json!([unit_line(&unit, 6_000_000)]), json!({}));
    assert_eq!(t.balance(), 6_000_000);
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    assert_eq!((r.debt_cancelled, r.refund, r.refund_cash), (6_000_000, 0, 0));
    assert_eq!(t.balance(), 0);
    assert!(t.cash().is_empty());
}

#[test]
fn cancels_the_debt_first_and_refunds_the_rest() {
    let t = setup();
    let unit = t.phone(1);
    let sale = t.sell(json!([unit_line(&unit, 6_000_000)]), json!({ "paid": 2_000_000 }));
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    assert_eq!((r.value, r.debt_cancelled, r.refund, r.refund_cash), (6_000_000, 4_000_000, 2_000_000, 2_000_000));
    assert_eq!(t.cash().pop().unwrap(), cash_row("OUT", 2_000_000, "SALE_RETURN"));
    assert_eq!(t.balance(), 0);
}

#[test]
fn a_defective_unit_is_marked_returned_with_a_zero_movement() {
    let t = setup();
    let unit = t.phone(1);
    let sale = t.sell(json!([unit_line(&unit, 6_000_000)]), json!({ "paid": 6_000_000 }));
    t.do_return(&sale.id, &[(0, 1, false)], json!({})).unwrap();
    assert_eq!(t.unit(&unit).status, "RETURNED");
    assert!(t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" })))).is_empty());
    assert_eq!(t.app.val::<String>("SELECT quantity || ':' || reason FROM stock_movements WHERE type = 'RETURN'"), "0:DEFECTIVE");
}

#[test]
fn returns_part_of_an_item_line() {
    let t = setup();
    let sale = t.sell(json!([t.item_line(4, 100_000)]), json!({ "paid": 400_000 }));
    assert_eq!(t.item_qty(), 6);
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    assert_eq!((r.value, r.status.as_str()), (100_000, "PARTIALLY_RETURNED"));
    assert_eq!(t.item_qty(), 7);
    assert_eq!(code(t.do_return(&sale.id, &[(0, 4, true)], json!({}))), "return_quantity");
    assert_eq!(t.item_qty(), 7);
    let r = t.do_return(&sale.id, &[(0, 3, false)], json!({})).unwrap();
    assert_eq!((r.value, r.status.as_str()), (300_000, "RETURNED"));
    assert_eq!(t.item_qty(), 7); // the 3 not restocked did not go back
    assert_eq!(code(t.do_return(&sale.id, &[(0, 1, true)], json!({}))), "return_quantity");
}

#[test]
fn spreads_the_sale_discount_and_the_parts_add_up() {
    let t = setup();
    let sale = t.sell(json!([t.item_line(3, 100_000)]), json!({ "discount": 10_000, "paid": 290_000 }));
    let a = t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    assert_eq!(a.value, 96_667);
    let b = t.do_return(&sale.id, &[(0, 2, true)], json!({})).unwrap();
    assert_eq!(a.value + b.value, 290_000);
}

#[test]
fn a_bad_line_rolls_everything_back() {
    let t = setup();
    let sale = t.sell(json!([t.item_line(2, 100_000)]), json!({ "paid": 200_000 }));
    let input: returns::ReturnInput = parse(json!({ "saleId": sale.id, "reason": "x", "lines": [{ "saleLineId": "nope", "quantity": 1, "restock": true }] }));
    assert_eq!(code(t.app.ctx(|c| returns::create_return(c, &input))), "invalid_input");
    let blank = try_parse::<returns::ReturnInput>(
        json!({ "saleId": sale.id, "reason": "   ", "lines": [{ "saleLineId": t.line_ids(&sale.id)[0], "quantity": 1, "restock": true }] }),
    );
    assert!(blank.is_err());
    assert_eq!(t.app.val::<i64>("SELECT count(*) FROM sale_returns"), 0);
}

#[test]
fn returned_goods_go_back_into_the_average_cost_at_their_cost_at_sale() {
    let t = setup();
    let sale = t.sell(json!([t.item_line(2, 100_000)]), json!({ "paid": 200_000 }));
    let item = t.app.ok(|c| stock::get_item(c, &t.item));
    let update: stock::ItemUpdateInput =
        parse(json!({ "id": t.item, "name": item.name, "categoryId": item.category_id, "salePrice": item.sale_price, "avgCost": 90_000 }));
    t.app.ok(|c| stock::update_item(c, &update));
    t.do_return(&sale.id, &[(0, 2, true)], json!({})).unwrap();
    // (8 x 90,000 + 2 x 50,000) / 10 = 82,000
    let item = t.app.ok(|c| stock::get_item(c, &t.item));
    assert_eq!((item.quantity, item.avg_cost), (10, Some(82_000)));
}

#[test]
fn returns_reduce_the_profit_of_the_period() {
    let t = setup();
    let from = psm_core::util::ms_to_iso(psm_core::util::now_ms() - 1000);
    let to = || psm_core::util::ms_to_iso(psm_core::util::now_ms() + 1000);
    let sale = t.sell(json!([t.item_line(2, 100_000)]), json!({ "paid": 200_000 }));
    let profit = |t: &T| t.app.ok(|c| sales::period_profit(c, &from, &to()));
    assert_eq!(profit(&t), 100_000);
    t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap(); // restocked: gives back 50,000 of profit
    assert_eq!(profit(&t), 50_000);
    t.do_return(&sale.id, &[(0, 1, false)], json!({})).unwrap(); // lost goods: gives back the whole value
    assert_eq!(profit(&t), -50_000);
    assert_eq!(t.app.ok(|c| sales::get_sale(c, &sale.id, true)).profit, Some(-50_000));
}

#[test]
fn lists_returns_and_finds_sales_by_receipt_or_imei() {
    let t = setup();
    let unit = t.phone(1);
    let sale = t.sell(json!([unit_line(&unit, 6_000_000)]), json!({ "paid": 6_000_000 }));
    let find = |q: &str| t.app.ok(|c| returns::find_sales(c, q)).into_iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(find(&sale.receipt_number), vec![sale.id.clone()]);
    assert_eq!(find(&sale.receipt_number[sale.receipt_number.len() - 3..]).len(), 1);
    assert_eq!(find(&make_imei("35000000000001")), vec![sale.id.clone()]);
    assert!(find("nothing").is_empty());
    t.do_return(&sale.id, &[(0, 1, true)], json!({})).unwrap();
    let list = t.app.ok(returns::list_returns);
    assert_eq!(list.len(), 1);
    assert_eq!(
        (list[0].receipt_number.as_str(), list[0].customer_name.as_deref(), list[0].returned_value, list[0].reason.as_str()),
        (sale.receipt_number.as_str(), Some("Walid"), 6_000_000, "Changed mind")
    );
}

#[test]
fn an_exchange_pays_only_the_difference() {
    let t = setup();
    let old = t.phone(1);
    let model = t.app.ok(stock::list_models)[0].id.clone();
    let input: stock::UnitAddInput =
        parse(json!({ "imei1": make_imei("35000000000002"), "condition": "NEW", "cost": 5_000_000, "salePrice": 7_000_000, "productId": model }));
    let new_unit = t.app.ok(|c| stock::add_unit(c, &input)).id;
    let sale = t.sell(json!([unit_line(&old, 6_000_000)]), json!({ "paid": 6_000_000 }));
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({ "exchange": { "paid": 1_000_000, "lines": [unit_line(&new_unit, 7_000_000)] } })).unwrap();
    assert_eq!((r.value, r.refund, r.refund_cash), (6_000_000, 6_000_000, 0));
    let x = r.exchange.unwrap();
    let fresh = t.app.ok(|c| sales::get_sale(c, &x.id, true));
    assert_eq!((fresh.total, fresh.paid, fresh.remaining, fresh.customer_id.as_deref()), (7_000_000, 7_000_000, 0, Some(t.customer.as_str())));
    assert_eq!(t.unit(&old).status, "IN_STOCK");
    assert_eq!(t.unit(&new_unit).status, "SOLD");
    // Only the 10,000 difference went through the till.
    assert_eq!(t.cash(), vec![cash_row("IN", 6_000_000, "SALE"), cash_row("IN", 1_000_000, "SALE")]);
    let linked: String = t.app.val("SELECT r.exchange_sale_id || '|' || s.exchange_return_id FROM sale_returns r JOIN sales s ON s.exchange_return_id = r.id");
    assert_eq!(linked, format!("{}|{}", x.id, r.id));
    assert_eq!(t.balance(), 0);
}

#[test]
fn an_exchange_for_something_cheaper_pays_out_the_difference() {
    let t = setup();
    let old = t.phone(1);
    let sale = t.sell(json!([unit_line(&old, 6_000_000)]), json!({ "paid": 6_000_000 }));
    let r = t.do_return(&sale.id, &[(0, 1, true)], json!({ "exchange": { "paid": 0, "lines": [t.item_line(1, 100_000)] } })).unwrap();
    assert_eq!((r.refund, r.refund_cash), (6_000_000, 5_900_000));
    assert_eq!(t.cash().pop().unwrap(), cash_row("OUT", 5_900_000, "SALE_RETURN"));
}

#[test]
fn a_failed_exchange_rolls_the_return_back() {
    let t = setup();
    let old = t.phone(1);
    let sale = t.sell(json!([unit_line(&old, 6_000_000)]), json!({ "paid": 6_000_000 }));
    let r =
        t.do_return(&sale.id, &[(0, 1, true)], json!({ "exchange": { "paid": 0, "lines": [{ "productId": t.item, "quantity": 99, "unitPrice": 100_000 }] } }));
    assert_eq!(code(r), "insufficient_stock");
    assert_eq!(t.unit(&old).status, "SOLD");
    assert_eq!(t.app.val::<i64>("SELECT count(*) FROM sale_returns"), 0);
}

#[test]
fn a_payment_settles_the_oldest_sales_first() {
    let t = setup();
    let first = t.sell(json!([t.item_line(2, 1_000_000)]), json!({}));
    let second = t.sell(json!([t.item_line(1, 1_000_000)]), json!({}));
    assert_eq!(t.balance(), 3_000_000);
    let r = t.pay(2_500_000, json!({}));
    assert_eq!((r.before, r.after, r.credit), (3_000_000, 500_000, 0));
    assert_eq!(t.remaining(&first.id), 0);
    assert_eq!(t.remaining(&second.id), 500_000);
    assert_eq!(t.balance(), 500_000);
    assert_eq!(t.cash(), vec![cash_row("IN", 2_500_000, "CUSTOMER_PAYMENT")]);
    let p = t.app.ok(|c| customers::get_payment(c, &r.group_id));
    assert_eq!((p.amount, p.balance_before, p.balance_after, p.customer_name.as_str()), (2_500_000, Some(3_000_000), Some(500_000), "Walid"));
    let page = t.app.ok(|c| customers::get_customer(c, &t.customer));
    assert_eq!(page.payments.len(), 1); // one payment, two rows
    assert_eq!(page.payments[0].amount, 2_500_000);
}

#[test]
fn an_overpayment_stays_as_credit_and_ccp_does_not_touch_the_drawer() {
    let t = setup();
    t.sell(json!([t.item_line(1, 1_000_000)]), json!({}));
    let r = t.pay(1_500_000, json!({ "method": "CCP" }));
    assert_eq!(r.credit, 500_000);
    assert_eq!(t.balance(), -500_000);
    assert!(t.cash().is_empty());
}

#[test]
fn the_debt_equals_the_sum_of_the_remaining_amounts() {
    let t = setup();
    t.sell(json!([t.item_line(3, 100_000)]), json!({ "paid": 100_000 }));
    let with_return = t.sell(json!([t.item_line(2, 100_000)]), json!({ "paid": 50_000 }));
    t.sell(json!([t.item_line(1, 100_000)]), json!({ "paid": 100_000 }));
    t.do_return(&with_return.id, &[(0, 1, true)], json!({})).unwrap();
    t.pay(40_000, json!({}));
    let page = t.app.ok(|c| customers::get_customer(c, &t.customer));
    let sum: i64 = page.sales.iter().map(|s| s.remaining).sum();
    assert_eq!(sum, page.stats.balance);
    assert_eq!(page.stats.balance, t.balance());
    assert_eq!(page.stats.total_paid, page.stats.total_bought - page.stats.balance);
}

#[test]
fn counts_a_delivered_unpaid_repair_and_settles_it_after_the_sales() {
    let t = setup();
    t.sell(json!([t.item_line(1, 100_000)]), json!({}));
    let at = now();
    t.app.exec(
        "INSERT INTO repairs (id, ticket_number, customer_id, estimated_price, final_price, deposit, status, received_at, delivered_at, qr_token, created_at, updated_at) VALUES ('r1', 'R-1', ?1, 300000, 400000, 100000, 'DELIVERED', ?2, ?2, 'tok', ?2, ?2)",
        [&t.customer, &at],
    );
    // The deposit is a payment tied to the repair, like the intake of a real ticket.
    t.app.exec(
        "INSERT INTO customer_payments (id, customer_id, amount, date, repair_id, created_at, updated_at) VALUES ('dep1', ?1, 100000, ?2, 'r1', ?2, ?2)",
        [&t.customer, &at],
    );
    t.app.exec("INSERT INTO repairs (id, ticket_number, customer_id, estimated_price, deposit, status, received_at, qr_token, created_at, updated_at) VALUES ('r2', 'R-2', ?1, 900000, 0, 'DIAGNOSING', ?2, 'tok2', ?2, ?2)", [&t.customer, &at]);
    assert_eq!(t.balance(), 100_000 + 300_000); // sale + (400,000 - deposit); the open repair is not owed yet
    t.pay(350_000, json!({}));
    assert_eq!(t.balance(), 50_000);
    assert_eq!(t.app.ok(|c| customers::get_customer(c, &t.customer)).repairs.len(), 2);
}

#[test]
fn lists_customers_with_totals_debt_last_visit_and_overdue() {
    let t = setup();
    let sale = t.sell(json!([t.item_line(1, 100_000)]), json!({ "paid": 30_000 }));
    let overview = |t: &T| t.app.ok(|c| customers::customer_overview(c, &Default::default())).into_iter().find(|c| c.id == t.customer).unwrap();
    let o = overview(&t);
    assert_eq!((o.total_bought, o.balance, o.overdue), (100_000, 70_000, false));
    assert!(o.last_visit.is_some());
    let filtered = |f: Value| t.app.ok(|c| customers::customer_overview(c, &parse(f))).len();
    assert_eq!(filtered(json!({ "inDebt": true })), 1);
    assert_eq!(filtered(json!({ "overdue": true })), 0);
    t.app.exec("UPDATE sales SET date = ?1 WHERE id = ?2", [psm_core::util::ms_to_iso(psm_core::util::now_ms() - 40 * 86_400_000), sale.id]);
    assert!(overview(&t).overdue);
    assert_eq!(filtered(json!({ "overdue": true })), 1);
}

#[test]
fn shows_owned_phones_with_warranty_and_refuses_deleting_a_debtor() {
    let t = setup();
    let unit = t.phone(1);
    t.sell(json!([{ "unitId": unit, "unitPrice": 6_000_000, "warrantyDays": 30 }]), json!({ "paid": 6_000_000 }));
    let phones = t.app.ok(|c| customers::get_customer(c, &t.customer)).phones;
    assert_eq!(phones.len(), 1);
    assert_eq!((phones[0].imei1.clone().unwrap(), phones[0].warranty.as_str()), (make_imei("35000000000001"), "ACTIVE"));
    t.sell(json!([t.item_line(1, 100_000)]), json!({}));
    assert_eq!(code(t.app.ctx(|c| customers::delete_customer(c, &t.customer))), "customer_has_balance");
    t.pay(100_000, json!({}));
    t.app.ok(|c| customers::delete_customer(c, &t.customer));
    assert!(t.app.ok(customers::list_customers).is_empty());
}

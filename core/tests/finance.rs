mod common;
use common::*;
use psm_core::services::{catalog, customers, employees, expenses, finance, repairs, returns, sales, services, stock};
use psm_core::util::{ms_to_iso, now_ms};
use serde_json::{json, Value};

const DAY: i64 = 86_400_000;

struct T {
    app: App,
    samsung: String,
    part: String,
    flexy: String,
    customer: String,
}

fn setup() -> T {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let customer = app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid" })))).id;
    let cat = app.ok(|c| catalog::create_category(c, "Pièces", "PART")).id;
    let part = app
        .ok(|c| {
            stock::create_item(
                c,
                &parse(json!({ "name": "Écran", "categoryId": cat, "salePrice": 900_000, "avgCost": 300_000, "lowStockThreshold": 2, "isRepairPart": true })),
            )
        })
        .id;
    app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": part, "delta": 10, "reason": "COUNT_CORRECTION" }))));
    app.ok(services::ensure_default_services);
    let flexy = app.ok(|c| services::list_services(c, false)).into_iter().find(|s| s.name == "Flexy Mobilis").unwrap().id;
    app.ok(|c| expenses::ensure_default_categories(c, &["Supplies"]));
    T { app, samsung, part, flexy, customer }
}

fn period() -> finance::Period {
    finance::Period { from: ms_to_iso(now_ms() - 6 * 3_600_000), to: ms_to_iso(now_ms() + 6 * 3_600_000) }
}

fn today() -> String {
    finance::local_day(&psm_core::util::now())
}

impl T {
    fn phone(&self, n: u32) -> String {
        let input: stock::UnitAddInput =
            parse(json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 5_000_000, "salePrice": 6_000_000,
                                                       "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "" } }));
        self.app.ok(|c| stock::add_unit(c, &input)).id
    }
    fn sale(&self, v: Value) -> sales::SaleCreated {
        let input: sales::SaleInput = parse(v);
        self.app.ok(|c| sales::create_sale(c, &input, Default::default()))
    }
    fn sell_phone(&self, n: u32, over: Value) -> sales::SaleCreated {
        let id = self.phone(n);
        self.sale(merge(json!({ "paid": 6_000_000, "lines": [{ "unitId": id, "unitPrice": 6_000_000 }] }), over))
    }
    fn repair(&self, over: Value, part: bool) -> String {
        let r = self.app.ok(|c| repairs::create_repair(c, &parse(merge(json!({ "customerId": self.customer, "fault": "Écran" }), over))));
        if part {
            self.app.ok(|c| repairs::add_part(c, &parse(json!({ "repairId": r.id, "productId": self.part, "quantity": 1 }))));
        }
        r.id
    }
    fn deliver(&self, id: &str) {
        self.app.ok(|c| repairs::deliver(c, &parse(json!({ "id": id, "finalPrice": 800_000, "paid": 800_000 }))));
    }
    /// Phone 60,000 (cost 50,000), repair 8,000 (parts 3,000), flexy margin 500, expense 2,000, no salary.
    fn scenario(&self) {
        self.sell_phone(1, json!({}));
        let r = self.repair(json!({}), true);
        self.deliver(&r);
        self.app.ok(|c| services::sell_service(c, &parse(json!({ "serviceId": self.flexy, "amount": 1_666_667 })))); // 3% = 50,000
        let cat = self.app.ok(expenses::list_categories)[0].id.clone();
        self.app.ok(|c| expenses::create_expense(c, &parse(json!({ "buyer": "Samira", "categoryId": cat, "date": today(), "amount": 200_000 }))));
    }
    fn summary(&self, p: &finance::Period) -> finance::Summary {
        self.app.ok(|c| finance::summary(c, p))
    }
    fn return_line(&self, sale: &str, reason: &str) {
        let line: String = self.app.ok(|c| psm_core::db::DbExt::val(c.db, "SELECT id FROM sale_lines WHERE sale_id = ?1", [sale]));
        let input: returns::ReturnInput = parse(json!({ "saleId": sale, "reason": reason, "lines": [{ "saleLineId": line, "quantity": 1, "restock": true }] }));
        self.app.ok(|c| returns::create_return(c, &input));
    }
    fn report(&self, kind: &str, extra: Value) -> finance::Report {
        let p = period();
        let input: finance::ReportInput = parse(merge(json!({ "kind": kind, "from": p.from, "to": p.to, "slowDays": 60 }), extra));
        self.app.ok(|c| finance::report(c, &input))
    }
    fn adjust(&self, delta: i64, reason: &str) {
        self.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": self.part, "delta": delta, "reason": reason }))));
    }
    fn move_sale(&self, id: &str, days_ago: i64) {
        self.app.exec("UPDATE sales SET date = ?1 WHERE id = ?2", [ms_to_iso(now_ms() - days_ago * DAY), id.to_owned()]);
    }
}

#[test]
fn net_profit_of_the_fixed_scenario_is_13500() {
    let t = setup();
    t.scenario();
    let s = t.summary(&period());
    assert_eq!(
        (s.sales_revenue, s.sales_profit, s.repair_revenue, s.repair_profit, s.service_margin, s.expenses, s.salaries, s.net_profit),
        (6_000_000, 1_000_000, 800_000, 500_000, 50_000, 200_000, 0, 1_350_000)
    );
}

#[test]
fn paid_salaries_come_off_the_net_profit() {
    let t = setup();
    t.scenario();
    let e = t.app.ok(|c| employees::create_employee(c, &parse(json!({ "name": "Yacine" })))).id;
    t.app.ok(|c| employees::pay_salary(c, &parse(json!({ "employeeId": e, "amount": 400_000, "date": now() }))));
    let s = t.summary(&period());
    assert_eq!((s.salaries, s.net_profit), (400_000, 950_000));
}

#[test]
fn a_return_in_the_period_reduces_sales_profit_and_revenue() {
    let t = setup();
    let sale = t.sell_phone(1, json!({}));
    assert_eq!(t.summary(&period()).sales_profit, 1_000_000);
    t.return_line(&sale.id, "Changed mind");
    let s = t.summary(&period());
    assert_eq!((s.sales_profit, s.sales_revenue), (0, 0));
}

#[test]
fn leaves_out_what_happened_outside_the_period() {
    let t = setup();
    let sale = t.sell_phone(1, json!({}));
    t.move_sale(&sale.id, 10);
    let s = t.summary(&period());
    assert_eq!((s.sales_revenue, s.sales_profit), (0, 0));
    let wide = finance::Period { from: ms_to_iso(now_ms() - 20 * DAY), to: period().to };
    assert_eq!(t.summary(&wide).sales_profit, 1_000_000);
}

#[test]
fn reports_current_debts_and_stock_values() {
    let t = setup();
    t.phone(1);
    t.sale(json!({ "customerId": t.customer, "paid": 100_000, "lines": [{ "productId": t.part, "quantity": 1, "unitPrice": 900_000 }] }));
    let s = t.summary(&period());
    assert_eq!(s.customer_debts, 800_000);
    assert_eq!(s.stock_value_cost, 5_000_000 + 9 * 300_000);
    assert_eq!(s.stock_value_sale, 6_000_000 + 9 * 900_000);
    assert_eq!(s.supplier_debts, 0);
}

#[test]
fn series_and_detail_rows_add_up_to_the_kpis() {
    let t = setup();
    t.scenario();
    let p = finance::Period { from: ms_to_iso(now_ms() - 3 * DAY), to: ms_to_iso(now_ms() + 3_600_000) };
    let s = serde_json::to_value(t.summary(&p)).unwrap();
    for metric in finance::METRICS {
        let series = t.app.ok(|c| finance::daily_series(c, metric, &p));
        assert!(series.len() >= 4, "{metric}");
        assert_eq!(series.iter().map(|d| d.value).sum::<i64>(), s[metric].as_i64().unwrap(), "{metric}");
        if *metric != "netProfit" {
            let rows = t.app.ok(|c| finance::detail_rows(c, metric, &p));
            assert_eq!(rows.iter().map(|r| r.value).sum::<i64>(), s[metric].as_i64().unwrap(), "{metric} rows");
        }
    }
    // The period can reach into tomorrow, so look up today's day rather than the last one.
    let series = t.app.ok(|c| finance::daily_series(c, "netProfit", &p));
    assert_eq!(series.iter().find(|d| d.day == today()).unwrap().value, 1_350_000);
}

#[test]
fn detail_rows_link_to_their_records_and_returns_are_negative() {
    let t = setup();
    let sale = t.sell_phone(5, json!({}));
    t.return_line(&sale.id, "x");
    let rows = t.app.ok(|c| finance::detail_rows(c, "salesProfit", &period()));
    let mut kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    kinds.sort();
    assert_eq!(kinds, vec!["RETURN", "SALE"]);
    let s = rows.iter().find(|r| r.kind == "SALE").unwrap();
    assert_eq!((s.value, s.link.clone().unwrap()), (1_000_000, format!("/sell/sales/{}", sale.id)));
    assert_eq!(rows.iter().find(|r| r.kind == "RETURN").unwrap().value, -1_000_000);
    t.scenario();
    let repair = &t.app.ok(|c| finance::detail_rows(c, "repairProfit", &period()))[0];
    assert_eq!((repair.kind.as_str(), repair.value), ("REPAIR", 500_000));
    assert!(repair.link.as_deref().unwrap().starts_with("/repairs/"));
    let expense = &t.app.ok(|c| finance::detail_rows(c, "expenses", &period()))[0];
    assert_eq!((expense.kind.as_str(), expense.value, expense.detail.as_str()), ("EXPENSE", 200_000, "Supplies"));
    let days = t.app.ok(|c| finance::detail_rows(c, "netProfit", &period()));
    let parts = days.into_iter().find(|r| r.date == today()).unwrap().parts.unwrap();
    assert_eq!((parts["salesProfit"], parts["expenses"]), (1_000_000, 200_000));
}

#[test]
fn ranks_the_best_selling_models_and_accessories() {
    let t = setup();
    t.sell_phone(1, json!({}));
    t.sell_phone(2, json!({}));
    t.sale(json!({ "paid": 1_800_000, "lines": [{ "productId": t.part, "quantity": 2, "unitPrice": 900_000 }] }));
    assert_eq!(t.report("bestModels", json!({})).rows, vec![vec![json!("Samsung Galaxy A15 128GB"), json!(2), json!(12_000_000), json!(2_000_000)]]);
    assert_eq!(t.report("bestAccessories", json!({})).rows, vec![vec![json!("Écran"), json!(2), json!(1_800_000), json!(1_200_000)]]);
}

#[test]
fn shows_profit_by_brand_and_by_employee() {
    let t = setup();
    let e = t.app.ok(|c| employees::create_employee(c, &parse(json!({ "name": "Yacine" })))).id;
    t.sell_phone(1, json!({ "employeeId": e }));
    let r = t.repair(json!({ "employeeId": e }), true);
    t.deliver(&r);
    assert_eq!(t.report("profitByBrand", json!({})).rows, vec![vec![json!("Samsung"), json!(1), json!(6_000_000), json!(1_000_000)]]);
    assert_eq!(
        t.report("profitByEmployee", json!({})).rows,
        vec![vec![json!("Yacine"), json!(1), json!(1_000_000), json!(1), json!(500_000), json!(1_500_000)]]
    );
}

#[test]
fn lists_slow_phones_low_stock_and_debt_ageing() {
    let t = setup();
    let id = t.phone(1);
    t.app.exec("UPDATE stock_movements SET at = ?1 WHERE unit_id = ?2", [ms_to_iso(now_ms() - 90 * DAY), id]);
    t.phone(2);
    assert_eq!(
        t.report("slowStock", json!({})).rows,
        vec![vec![json!("Samsung Galaxy A15 128GB"), json!(make_imei("35000000000001")), json!("NEW"), json!(90), json!(5_000_000), json!(6_000_000)]]
    );
    assert!(t.report("slowStock", json!({ "slowDays": 100 })).rows.is_empty());
    t.adjust(-9, "DAMAGED");
    assert_eq!(t.report("lowStock", json!({})).rows, vec![vec![json!("Écran"), json!("Pièces"), json!(1), json!(2)]]);
    let old = t.sale(json!({ "customerId": t.customer, "paid": 0, "lines": [{ "productId": t.part, "quantity": 1, "unitPrice": 100_000 }] }));
    t.move_sale(&old.id, 45);
    t.adjust(5, "COUNT_CORRECTION");
    t.sale(json!({ "customerId": t.customer, "paid": 0, "lines": [{ "productId": t.part, "quantity": 1, "unitPrice": 50_000 }] }));
    let late = t.sale(json!({ "customerId": t.customer, "paid": 0, "lines": [{ "productId": t.part, "quantity": 1, "unitPrice": 30_000 }] }));
    t.move_sale(&late.id, 100);
    assert_eq!(t.report("debtsAgeing", json!({})).rows, vec![vec![json!("Walid"), json!(50_000), json!(100_000), json!(30_000), json!(180_000)]]);
}

#[test]
fn overview_summarises_today_and_hides_profit_when_locked() {
    let t = setup();
    t.scenario();
    let r = t.repair(json!({ "dueAt": ms_to_iso(now_ms() - DAY) }), false);
    t.app.ok(|c| repairs::set_status(c, &parse(json!({ "id": r, "status": "READY" }))));
    t.adjust(-8, "LOST");
    let o = t.app.ok(|c| finance::overview(c, true));
    assert_eq!((o.today.sales_count, o.today.sales_total, o.today.profit, o.today.expected_cash), (1, 6_000_000, Some(1_000_000), None));
    let a = &o.attention;
    assert_eq!((a.repairs_ready, a.repairs_overdue, a.low_stock, a.debts_overdue, a.supplier_balances), (1, 1, 1, 0, 0));
    assert_eq!(o.week.len(), 7);
    let last = o.week.last().unwrap();
    assert_eq!((last.day.clone(), last.value), (today(), 6_000_000));
    assert!(o.week[..6].iter().all(|d| d.value == 0));
    let hidden = t.app.ok(|c| finance::overview(c, false));
    assert_eq!(hidden.today.profit, None);
    assert!(!serde_json::to_string(&hidden).unwrap().contains("1000000")); // no profit figure anywhere in the locked view
}

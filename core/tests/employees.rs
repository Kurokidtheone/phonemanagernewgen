mod common;
use common::*;
use psm_core::services::{cash, catalog, customers, employees, repairs, sales, stock};
use psm_core::util::{ms_to_iso, now_ms};
use serde::Deserialize;
use serde_json::{json, Value};

struct T {
    app: App,
    employee: String,
    at: String,
}

fn setup() -> T {
    let app = fresh();
    let employee = app.ok(|c| employees::create_employee(c, &parse(json!({ "name": "Yacine", "role": "SELLER", "monthlySalary": 3_500_000 })))).id;
    T { app, employee, at: now() }
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
    fn pay(&self, amount: i64, over: Value) -> psm_core::Res<employees::SalaryResult> {
        let input: employees::SalaryPaymentInput =
            parse(merge(json!({ "employeeId": self.employee, "amount": amount, "date": self.at, "note": "October salary" }), over));
        self.app.ctx(|c| employees::pay_salary(c, &input))
    }
    fn advance(&self, amount: i64, over: Value) -> psm_core::Res<employees::AdvanceResult> {
        let input: employees::AdvanceInput = parse(merge(json!({ "employeeId": self.employee, "kind": "GIVE", "amount": amount, "date": self.at }), over));
        self.app.ctx(|c| employees::add_advance(c, &input))
    }
    fn balance(&self) -> i64 {
        self.app.ok(|c| employees::advance_balance(c, &self.employee))
    }
    fn cash(&self) -> Vec<Cash> {
        self.app.rows("SELECT direction, amount, type FROM cash_movements ORDER BY rowid")
    }
    fn update(&self, v: Value) {
        let input: employees::EmployeeUpdateInput = parse(merge(v, json!({ "id": self.employee })));
        self.app.ok(|c| employees::update_employee(c, &input));
    }
}

#[test]
fn an_advance_deducted_from_the_salary() {
    let t = setup();
    t.app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 10_000_000 }))));
    t.advance(500_000, json!({})).unwrap();
    assert_eq!(t.balance(), 500_000);
    let r = t.pay(3_500_000, json!({ "deduct": 500_000 })).unwrap();
    assert_eq!((r.net, r.advance_after), (3_000_000, 0));
    assert_eq!(t.balance(), 0);
    assert_eq!(t.cash(), vec![cash_row("OUT", 500_000, "EMPLOYEE_ADVANCE"), cash_row("OUT", 3_000_000, "SALARY")]);
    let session = t.app.ok(cash::open_session_id).unwrap();
    assert_eq!(t.app.ok(|c| cash::expected_cash(c, &session)), 10_000_000 - 3_500_000);
    let page = t.app.ok(|c| employees::get_employee(c, &t.employee));
    assert_eq!(page.stats, employees::EmployeeStats { advance_balance: 0, total_paid_this_year: 3_500_000, salaries_this_year: 3_500_000 });
    assert_eq!((page.salaries[0].amount, page.salaries[0].deducted, page.salaries[0].note.as_str()), (3_500_000, 500_000, "October salary"));
    assert_eq!(page.advances.len(), 1); // the deduction is shown with the salary
    assert_eq!((page.advances[0].r#type.as_str(), page.advances[0].amount), ("ADVANCE", 500_000));
}

#[test]
fn refuses_deducting_more_than_the_advance_or_the_salary() {
    let t = setup();
    t.advance(500_000, json!({})).unwrap();
    assert_eq!(code(t.pay(3_500_000, json!({ "deduct": 600_000 }))), "deduct_too_large");
    assert_eq!(code(t.pay(300_000, json!({ "deduct": 400_000 }))), "deduct_too_large");
    assert_eq!(t.balance(), 500_000);
    assert_eq!(t.app.val::<i64>("SELECT count(*) FROM employee_ledger WHERE type = 'SALARY'"), 0);
    // A partial deduction leaves the rest outstanding.
    assert_eq!(t.pay(3_500_000, json!({ "deduct": 200_000 })).unwrap().advance_after, 300_000);
}

#[test]
fn only_cash_payments_move_the_drawer() {
    let t = setup();
    t.pay(3_500_000, json!({ "method": "CCP" })).unwrap();
    t.advance(100_000, json!({ "method": "BARIDIMOB" })).unwrap();
    assert!(t.cash().is_empty());
}

#[test]
fn an_advance_is_taken_back_in_cash_never_more_than_owed() {
    let t = setup();
    t.advance(500_000, json!({})).unwrap();
    t.advance(200_000, json!({ "kind": "REPAY" })).unwrap();
    assert_eq!(t.balance(), 300_000);
    assert_eq!(t.cash().pop().unwrap(), cash_row("IN", 200_000, "ADVANCE_REPAYMENT"));
    assert_eq!(code(t.advance(300_001, json!({ "kind": "REPAY" }))), "repay_too_large");
    let types: Vec<String> = t.app.ok(|c| employees::get_employee(c, &t.employee)).advances.into_iter().map(|a| a.r#type).collect();
    assert!(types.contains(&"ADVANCE".to_owned()) && types.contains(&"ADVANCE_REPAYMENT".to_owned()));
}

#[test]
fn lists_employees_with_their_advance_and_refuses_deleting_one_who_owes() {
    let t = setup();
    t.advance(500_000, json!({})).unwrap();
    let list = t.app.ok(employees::list_employees_overview);
    assert_eq!((list[0].name.as_str(), list[0].role.as_str(), list[0].monthly_salary, list[0].advance_balance), ("Yacine", "SELLER", 3_500_000, 500_000));
    assert_eq!(code(t.app.ctx(|c| employees::delete_employee(c, &t.employee))), "employee_has_advance");
    t.advance(500_000, json!({ "kind": "REPAY" })).unwrap();
    t.app.ok(|c| employees::delete_employee(c, &t.employee));
    assert!(t.app.ok(employees::list_employees_overview).is_empty());
    assert!(t.app.ok(customers::list_employees).is_empty()); // the pickers only offer active employees
}

#[test]
fn keeps_roles_to_the_known_list_and_updates_details() {
    let t = setup();
    assert!(try_parse::<employees::EmployeeInput>(json!({ "name": "X", "role": "BOSS" })).is_err());
    t.update(json!({ "name": "Yacine B.", "role": "CASHIER", "monthlySalary": 4_000_000, "commissionSalesBp": 500 }));
    let e = &t.app.ok(employees::list_employees_overview)[0];
    assert_eq!((e.name.as_str(), e.role.as_str(), e.commission_sales_bp), ("Yacine B.", "CASHIER", 500));
}

#[test]
fn activity_totals_with_profit_and_commission() {
    let t = setup();
    t.update(json!({ "name": "Yacine", "commissionSalesBp": 1000, "commissionRepairsBp": 2000 }));
    let customer = t.app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid" })))).id;
    let category = t.app.ok(|c| catalog::create_category(c, "Pièces", "PART")).id;
    let part = t
        .app
        .ok(|c| {
            stock::create_item(c, &parse(json!({ "name": "Écran", "categoryId": category, "salePrice": 900_000, "avgCost": 300_000, "isRepairPart": true })))
        })
        .id;
    t.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": part, "delta": 10, "reason": "COUNT_CORRECTION" }))));
    let sell = |price: i64, over: Value| {
        let input: sales::SaleInput = parse(merge(json!({ "paid": price, "lines": [{ "productId": part, "quantity": 1, "unitPrice": price }] }), over));
        t.app.ok(|c| sales::create_sale(c, &input, Default::default()))
    };
    sell(350_000, json!({ "employeeId": t.employee }));
    sell(330_000, json!({ "employeeId": t.employee }));
    sell(900_000, json!({}));
    let r = t.app.ok(|c| repairs::create_repair(c, &parse(json!({ "customerId": customer, "fault": "Écran", "employeeId": t.employee }))));
    t.app.ok(|c| repairs::add_part(c, &parse(json!({ "repairId": r.id, "productId": part, "quantity": 1 }))));
    t.app.ok(|c| repairs::deliver(c, &parse(json!({ "id": r.id, "finalPrice": 800_000, "paid": 800_000 }))));
    let from = ms_to_iso(now_ms() - 3_600_000);
    let to = ms_to_iso(now_ms() + 3_600_000);
    let a = t.app.ok(|c| employees::activity(c, &t.employee, &from, &to, true));
    let x = &a.totals;
    assert_eq!(
        (x.sales_count, x.sales_total, x.repairs_count, x.repairs_total, x.sales_profit, x.repairs_profit),
        (2, 680_000, 1, 800_000, Some(80_000), Some(500_000))
    );
    assert_eq!(x.commission, Some(8_000 + 100_000)); // 10% of 80,000 + 20% of 500,000
    assert_eq!(a.sales.len(), 2);
    assert_eq!((a.repairs[0].price, a.repairs[0].profit), (800_000, Some(500_000)));
    let hidden = t.app.ok(|c| employees::activity(c, &t.employee, &from, &to, false));
    let h = &hidden.totals;
    assert_eq!((h.sales_count, h.sales_total, h.sales_profit, h.repairs_profit, h.commission), (2, 680_000, None, None, None));
    assert_eq!(hidden.sales[0].profit, None);
    let later = t.app.ok(|c| employees::activity(c, &t.employee, &ms_to_iso(now_ms() + 86_400_000), &ms_to_iso(now_ms() + 2 * 86_400_000), true));
    assert_eq!(later.totals.sales_count, 0);
}

#[test]
fn never_pays_commission_on_a_loss() {
    let t = setup();
    let category = t.app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    let item = t.app.ok(|c| stock::create_item(c, &parse(json!({ "name": "Chargeur", "categoryId": category, "salePrice": 100_000, "avgCost": 150_000 })))).id;
    t.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": item, "delta": 5, "reason": "COUNT_CORRECTION" }))));
    t.update(json!({ "name": "Yacine", "commissionSalesBp": 1000 }));
    let input: sales::SaleInput =
        parse(json!({ "employeeId": t.employee, "paid": 100_000, "lines": [{ "productId": item, "quantity": 1, "unitPrice": 100_000 }] }));
    t.app.ok(|c| sales::create_sale(c, &input, Default::default()));
    let a = t.app.ok(|c| employees::activity(c, &t.employee, &ms_to_iso(now_ms() - 1000), &ms_to_iso(now_ms() + 1000), true));
    assert_eq!((a.totals.sales_profit, a.totals.commission), (Some(-50_000), Some(0)));
}

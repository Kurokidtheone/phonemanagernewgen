// Employees: salary payments, advances and what they did (sales, repairs).
//
// The ledger (employee_ledger) holds three kinds of rows:
//   SALARY             a salary payment (gross), for any month or bonus, with a note
//   ADVANCE            money given in advance
//   ADVANCE_REPAYMENT  advance paid back: taken out of a salary (method DEDUCTED, no cash) or handed back (cash IN)
// Advance balance = sum(ADVANCE) - sum(ADVANCE_REPAYMENT). Cash paid out of the drawer is written as a cash
// movement in the same transaction: net salary and advances OUT, cash repayments IN.
use super::cash::cash;
use super::repairs::get_repair;
use super::sales::{get_sale, SALE_METHODS};
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{Employee, EmployeeLedger};
use crate::util::{iso, js_round, now, uuid};
use crate::valid::{self, Validate};
use chrono::{Datelike, Local, TimeZone};
use rusqlite::params;
use std::collections::HashMap;

pub fn advance_balances(ctx: &Ctx) -> Res<HashMap<String, i64>> {
    let mut stmt = ctx.db.prepare_cached(
        "SELECT employee_id, SUM(CASE type WHEN 'ADVANCE' THEN amount WHEN 'ADVANCE_REPAYMENT' THEN -amount ELSE 0 END) FROM employee_ledger GROUP BY employee_id",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn advance_balance(ctx: &Ctx, id: &str) -> Res<i64> {
    Ok(advance_balances(ctx)?.get(id).copied().unwrap_or(0))
}

fn load(ctx: &Ctx, id: &str) -> Res<Employee> {
    match ctx.db.get("SELECT * FROM employees WHERE id = ?1 AND deleted_at IS NULL", [id])? {
        Some(e) => Ok(e),
        None => bail!("not_found"),
    }
}

row! {
    pub struct EmployeeOverview {
        pub id: String,
        pub name: String,
        pub role: String,
        pub phone: String,
        pub monthly_salary: i64,
        pub commission_sales_bp: i64,
        pub commission_repairs_bp: i64,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub advance_balance: i64,
    }
}

pub fn list_employees_overview(ctx: &Ctx) -> Res<Vec<EmployeeOverview>> {
    let balances = advance_balances(ctx)?;
    let rows: Vec<Employee> = ctx.db.all("SELECT * FROM employees WHERE deleted_at IS NULL ORDER BY name", [])?;
    Ok(rows
        .into_iter()
        .map(|e| EmployeeOverview {
            advance_balance: balances.get(&e.id).copied().unwrap_or(0),
            id: e.id,
            name: e.name,
            role: e.role,
            phone: e.phone,
            monthly_salary: e.monthly_salary,
            commission_sales_bp: e.commission_sales_bp,
            commission_repairs_bp: e.commission_repairs_bp,
            deleted_at: e.deleted_at,
            created_at: e.created_at,
            updated_at: e.updated_at,
        })
        .collect())
}

input! {
    pub struct EmployeeInput {
        pub name: String,
        #[serde(default = "seller")]
        pub role: String,
        #[serde(default)]
        pub phone: String,
        #[serde(default)]
        pub monthly_salary: i64,
        /// Hundredths of a percent: 1000 = 10%. Informative only.
        #[serde(default)]
        pub commission_sales_bp: i64,
        #[serde(default)]
        pub commission_repairs_bp: i64,
    }
}
fn seller() -> String {
    "SELLER".into()
}
impl Validate for EmployeeInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 120, "name")?;
        valid::one_of(&self.role, &["SELLER", "TECHNICIAN", "CASHIER", "OTHER"], "role")?;
        valid::text(&mut self.phone, 0, 40, "phone")?;
        valid::centimes(self.monthly_salary, "monthlySalary")?;
        valid::range(self.commission_sales_bp, 0, 10_000, "commissionSalesBp")?;
        valid::range(self.commission_repairs_bp, 0, 10_000, "commissionRepairsBp")
    }
}

input! {
    pub struct EmployeeUpdateInput {
        pub id: String,
        #[serde(flatten)]
        pub fields: EmployeeInput,
    }
}
impl Validate for EmployeeUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        self.fields.validate()
    }
}

pub fn create_employee(ctx: &Ctx, i: &EmployeeInput) -> Res<Employee> {
    let t = now();
    let e = Employee {
        id: uuid(),
        name: i.name.clone(),
        role: i.role.clone(),
        phone: i.phone.clone(),
        monthly_salary: i.monthly_salary,
        commission_sales_bp: i.commission_sales_bp,
        commission_repairs_bp: i.commission_repairs_bp,
        deleted_at: None,
        created_at: t.clone(),
        updated_at: t,
    };
    ctx.db.exec(
        "INSERT INTO employees (id, name, role, phone, monthly_salary, commission_sales_bp, commission_repairs_bp, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![e.id, e.name, e.role, e.phone, e.monthly_salary, e.commission_sales_bp, e.commission_repairs_bp, e.created_at, e.updated_at],
    )?;
    Ok(e)
}

pub fn update_employee(ctx: &Ctx, input: &EmployeeUpdateInput) -> Res<()> {
    load(ctx, &input.id)?;
    let f = &input.fields;
    ctx.db.exec(
        "UPDATE employees SET name = ?1, role = ?2, phone = ?3, monthly_salary = ?4, commission_sales_bp = ?5, commission_repairs_bp = ?6, updated_at = ?7 WHERE id = ?8",
        params![f.name, f.role, f.phone, f.monthly_salary, f.commission_sales_bp, f.commission_repairs_bp, now(), input.id],
    )?;
    Ok(())
}

/// Soft delete (the employee stays on past sales and repairs), refused while an advance is outstanding.
pub fn delete_employee(ctx: &Ctx, id: &str) -> Res<()> {
    load(ctx, id)?;
    if advance_balance(ctx, id)? > 0 {
        bail!("employee_has_advance");
    }
    let t = now();
    ctx.db.exec("UPDATE employees SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", params![t, id])?;
    Ok(())
}

/// January 1st of this year, local midnight, as an ISO instant.
fn year_start() -> String {
    let y = Local::now().year();
    iso(Local.with_ymd_and_hms(y, 1, 1, 0, 0, 0).earliest().unwrap().with_timezone(&chrono::Utc))
}

row! { pub struct EmployeeStats { pub advance_balance: i64, pub total_paid_this_year: i64, pub salaries_this_year: i64 } }
row! { pub struct SalaryRow { pub id: String, pub date: Option<String>, pub amount: i64, pub note: String, pub method: String, pub deducted: i64 } }
row! {
    pub struct AdvanceRow {
        pub id: String,
        pub date: Option<String>,
        #[ts(type = "'SALARY' | 'ADVANCE' | 'ADVANCE_REPAYMENT'")]
        pub r#type: String,
        pub amount: i64,
        pub note: String,
        pub method: String,
    }
}
row! { pub struct DeductionRow { pub id: String, pub date: Option<String>, pub amount: i64 } }
row! {
    pub struct EmployeeDetail {
        pub employee: Employee,
        pub stats: EmployeeStats,
        pub salaries: Vec<SalaryRow>,
        pub advances: Vec<AdvanceRow>,
        pub deductions: Vec<DeductionRow>,
    }
}

pub fn get_employee(ctx: &Ctx, id: &str) -> Res<EmployeeDetail> {
    let employee = load(ctx, id)?;
    let mut ledger: Vec<EmployeeLedger> = ctx.db.all("SELECT * FROM employee_ledger WHERE employee_id = ?1 ORDER BY rowid", [id])?;
    ledger.sort_by(|a, b| b.date.as_deref().unwrap_or("").cmp(a.date.as_deref().unwrap_or("")));
    let start = year_start();
    let sum = |kind: &str| ledger.iter().filter(|l| l.date.as_deref().unwrap_or("") >= start.as_str() && l.r#type == kind).map(|l| l.amount).sum::<i64>();
    // What reached the employee this year, net: salaries and advances given, less advances taken back.
    let total_paid_this_year = sum("SALARY") + sum("ADVANCE") - sum("ADVANCE_REPAYMENT");
    let mut deducted: HashMap<String, i64> = HashMap::new();
    for l in &ledger {
        if l.r#type == "ADVANCE_REPAYMENT" && l.method == "DEDUCTED" {
            if let Some(g) = &l.group_id {
                deducted.insert(g.clone(), l.amount);
            }
        }
    }
    Ok(EmployeeDetail {
        stats: EmployeeStats { advance_balance: advance_balance(ctx, id)?, total_paid_this_year, salaries_this_year: sum("SALARY") },
        salaries: ledger
            .iter()
            .filter(|l| l.r#type == "SALARY")
            .map(|l| SalaryRow {
                id: l.id.clone(),
                date: l.date.clone(),
                amount: l.amount,
                note: l.note.clone(),
                method: l.method.clone(),
                deducted: l.group_id.as_ref().and_then(|g| deducted.get(g)).copied().unwrap_or(0),
            })
            .collect(),
        advances: ledger
            .iter()
            .filter(|l| l.r#type != "SALARY" && l.method != "DEDUCTED")
            .map(|l| AdvanceRow {
                id: l.id.clone(),
                date: l.date.clone(),
                r#type: l.r#type.clone(),
                amount: l.amount,
                note: l.note.clone(),
                method: l.method.clone(),
            })
            .collect(),
        deductions: ledger
            .iter()
            .filter(|l| l.method == "DEDUCTED")
            .map(|l| DeductionRow { id: l.id.clone(), date: l.date.clone(), amount: l.amount })
            .collect(),
        employee,
    })
}

#[allow(clippy::too_many_arguments)]
fn ledger_row(ctx: &Ctx, employee_id: &str, kind: &str, amount: i64, note: &str, method: &str, date: &str, group_id: Option<&str>) -> Res<String> {
    let id = uuid();
    let t = now();
    ctx.db.exec(
        "INSERT INTO employee_ledger (id, employee_id, type, amount, note, date, method, group_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![id, employee_id, kind, amount, note, date, method, group_id, t],
    )?;
    Ok(id)
}

input! {
    pub struct SalaryPaymentInput {
        pub employee_id: String,
        pub amount: i64,
        /// Part of an outstanding advance taken out of this payment.
        #[serde(default)]
        pub deduct: i64,
        #[serde(default)]
        pub note: String,
        #[serde(default = "super::sales::cash_method")]
        pub method: String,
        pub date: String,
    }
}
impl Validate for SalaryPaymentInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.employee_id, "employeeId")?;
        valid::pos_centimes(self.amount, "amount")?;
        valid::centimes(self.deduct, "deduct")?;
        valid::text(&mut self.note, 0, 200, "note")?;
        valid::one_of(&self.method, SALE_METHODS, "method")?;
        valid::datetime(&self.date, "date")
    }
}

row! { pub struct SalaryResult { pub id: String, pub net: i64, pub advance_after: i64 } }

/// Pay a salary. The advance to deduct stays in the books as a repayment; only the net leaves the drawer.
pub fn pay_salary(ctx: &Ctx, i: &SalaryPaymentInput) -> Res<SalaryResult> {
    ctx.tx(|| {
        let e = load(ctx, &i.employee_id)?;
        let outstanding = advance_balance(ctx, &e.id)?;
        if i.deduct > outstanding.min(i.amount) {
            bail!("deduct_too_large");
        }
        let group = uuid();
        let salary_id = ledger_row(ctx, &e.id, "SALARY", i.amount, &i.note, &i.method, &i.date, Some(&group))?;
        if i.deduct > 0 {
            ledger_row(ctx, &e.id, "ADVANCE_REPAYMENT", i.deduct, &i.note, "DEDUCTED", &i.date, Some(&group))?;
        }
        let net = i.amount - i.deduct;
        if i.method == "CASH" {
            cash(ctx, "OUT", net, "SALARY", "employee_ledger", &salary_id, &e.name, Some(&i.date))?;
        }
        Ok(SalaryResult { id: salary_id, net, advance_after: outstanding - i.deduct })
    })
}

input! {
    pub struct AdvanceInput {
        pub employee_id: String,
        pub kind: String,
        pub amount: i64,
        #[serde(default)]
        pub note: String,
        #[serde(default = "super::sales::cash_method")]
        pub method: String,
        pub date: String,
    }
}
impl Validate for AdvanceInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.employee_id, "employeeId")?;
        valid::one_of(&self.kind, &["GIVE", "REPAY"], "kind")?;
        valid::pos_centimes(self.amount, "amount")?;
        valid::text(&mut self.note, 0, 200, "note")?;
        valid::one_of(&self.method, SALE_METHODS, "method")?;
        valid::datetime(&self.date, "date")
    }
}

row! { pub struct AdvanceResult { pub id: String, pub advance_after: i64 } }

/// Give an advance (cash OUT), or take one back in cash (cash IN).
pub fn add_advance(ctx: &Ctx, i: &AdvanceInput) -> Res<AdvanceResult> {
    ctx.tx(|| {
        let e = load(ctx, &i.employee_id)?;
        let outstanding = advance_balance(ctx, &e.id)?;
        let give = i.kind == "GIVE";
        if !give && i.amount > outstanding {
            bail!("repay_too_large");
        }
        let id = ledger_row(ctx, &e.id, if give { "ADVANCE" } else { "ADVANCE_REPAYMENT" }, i.amount, &i.note, &i.method, &i.date, None)?;
        if i.method == "CASH" {
            cash(
                ctx,
                if give { "OUT" } else { "IN" },
                i.amount,
                if give { "EMPLOYEE_ADVANCE" } else { "ADVANCE_REPAYMENT" },
                "employee_ledger",
                &id,
                &e.name,
                Some(&i.date),
            )?;
        }
        Ok(AdvanceResult { id, advance_after: outstanding + if give { i.amount } else { -i.amount } })
    })
}

input! { pub struct EmployeeActivityInput { pub id: String, pub from: String, pub to: String } }
impl Validate for EmployeeActivityInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")
    }
}

row! {
    pub struct ActivitySale {
        pub id: String,
        pub receipt_number: String,
        pub date: String,
        pub total: i64,
        pub status: String,
        #[serde(default)]
        pub profit: Option<i64>,
    }
}
row! {
    pub struct ActivityRepair {
        pub id: String,
        pub ticket: String,
        pub brand: String,
        pub model: String,
        pub closed_at: String,
        pub price: i64,
        #[serde(default)]
        pub profit: Option<i64>,
    }
}
row! {
    pub struct ActivityTotals {
        pub sales_count: i64,
        pub sales_total: i64,
        pub repairs_count: i64,
        pub repairs_total: i64,
        pub sales_profit: Option<i64>,
        pub repairs_profit: Option<i64>,
        pub commission: Option<i64>,
    }
}
row! { pub struct Rates { pub sales: i64, pub repairs: i64 } }
row! {
    pub struct EmployeeActivity {
        pub sales: Vec<ActivitySale>,
        pub repairs: Vec<ActivityRepair>,
        pub totals: ActivityTotals,
        pub rates: Rates,
    }
}

/// What an employee did in a period (ISO instants): sales as the seller, repairs delivered as the technician.
/// Profit and commission only when `with_profit`. Commission = percent of sales profit + percent of repair profit.
pub fn activity(ctx: &Ctx, employee_id: &str, from: &str, to: &str, with_profit: bool) -> Res<EmployeeActivity> {
    let e = load(ctx, employee_id)?;
    let mut sales: Vec<ActivitySale> = ctx.db.all(
        "SELECT s.id, s.receipt_number, s.date, s.total - COALESCE((SELECT SUM(r.returned_value) FROM sale_returns r WHERE r.sale_id = s.id), 0) AS total, s.status
         FROM sales s WHERE s.employee_id = ?1 AND s.date >= ?2 AND s.date <= ?3 ORDER BY s.date DESC",
        params![employee_id, from, to],
    )?;
    if with_profit {
        for s in &mut sales {
            s.profit = get_sale(ctx, &s.id, true)?.profit;
        }
    }
    let mut repairs: Vec<ActivityRepair> = ctx.db.all(
        "SELECT id, ticket_number AS ticket, brand, model, closed_at, COALESCE(final_price, 0) AS price
         FROM repairs WHERE employee_id = ?1 AND status = 'DELIVERED' AND closed_at >= ?2 AND closed_at <= ?3 ORDER BY closed_at DESC",
        params![employee_id, from, to],
    )?;
    if with_profit {
        for r in &mut repairs {
            r.profit = get_repair(ctx, &r.id, true)?.profit;
        }
    }
    let sales_profit = with_profit.then(|| sales.iter().map(|s| s.profit.unwrap_or(0)).sum::<i64>());
    let repairs_profit = with_profit.then(|| repairs.iter().map(|r| r.profit.unwrap_or(0)).sum::<i64>());
    let commission = match (sales_profit, repairs_profit) {
        (Some(sp), Some(rp)) => {
            Some(js_round((sp.max(0) * e.commission_sales_bp) as f64 / 10_000.0) + js_round((rp.max(0) * e.commission_repairs_bp) as f64 / 10_000.0))
        }
        _ => None,
    };
    Ok(EmployeeActivity {
        totals: ActivityTotals {
            sales_count: sales.len() as i64,
            sales_total: sales.iter().map(|s| s.total).sum(),
            repairs_count: repairs.len() as i64,
            repairs_total: repairs.iter().map(|r| r.price).sum(),
            sales_profit,
            repairs_profit,
            commission,
        },
        sales,
        repairs,
        rates: Rates { sales: e.commission_sales_bp, repairs: e.commission_repairs_bp },
    })
}

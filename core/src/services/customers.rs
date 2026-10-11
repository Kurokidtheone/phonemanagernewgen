// Customers, what they owe (balance.rs), and the payments they make against it.
use super::balance::{customer_balance, customer_balances, open_items, OpenItem};
use super::cash::cash;
use super::sales::{list_sales, SaleFilter, SaleRow, SALE_METHODS};
use super::settings::get_public;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{Customer, Employee};
use crate::util::{ms_to_iso, now, parse_ms, uuid, DAY_MS};
use crate::valid::{self, Validate};
use rusqlite::params;
use std::collections::HashMap;

row! {
    pub struct CustomerWithBalance {
        pub id: String,
        pub name: String,
        pub phone: String,
        pub whatsapp: String,
        pub address: String,
        pub notes: String,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub balance: i64,
    }
}

fn with_balance(c: Customer, balance: i64) -> CustomerWithBalance {
    CustomerWithBalance {
        id: c.id,
        name: c.name,
        phone: c.phone,
        whatsapp: c.whatsapp,
        address: c.address,
        notes: c.notes,
        deleted_at: c.deleted_at,
        created_at: c.created_at,
        updated_at: c.updated_at,
        balance,
    }
}

/// The till's light list: who, and how much they owe.
pub fn list_customers(ctx: &Ctx) -> Res<Vec<CustomerWithBalance>> {
    let balances = customer_balances(ctx)?;
    let rows: Vec<Customer> = ctx.db.all("SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY name", [])?;
    Ok(rows
        .into_iter()
        .map(|c| {
            let b = balances.get(&c.id).copied().unwrap_or(0);
            with_balance(c, b)
        })
        .collect())
}

input! {
    pub struct CustomerInput {
        pub name: String,
        #[serde(default)]
        pub phone: String,
        #[serde(default)]
        pub whatsapp: String,
        #[serde(default)]
        pub address: String,
        #[serde(default)]
        pub notes: String,
    }
}
impl Validate for CustomerInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 120, "name")?;
        valid::text(&mut self.phone, 0, 40, "phone")?;
        valid::text(&mut self.whatsapp, 0, 40, "whatsapp")?;
        valid::text(&mut self.address, 0, 200, "address")?;
        valid::text(&mut self.notes, 0, 500, "notes")
    }
}

input! {
    pub struct CustomerUpdateInput {
        pub id: String,
        #[serde(flatten)]
        pub fields: CustomerInput,
    }
}
impl Validate for CustomerUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        self.fields.validate()
    }
}

pub fn create_customer(ctx: &Ctx, i: &CustomerInput) -> Res<CustomerWithBalance> {
    let t = now();
    let c = Customer {
        id: uuid(),
        name: i.name.clone(),
        phone: i.phone.clone(),
        whatsapp: i.whatsapp.clone(),
        address: i.address.clone(),
        notes: i.notes.clone(),
        deleted_at: None,
        created_at: t.clone(),
        updated_at: t,
    };
    ctx.db.exec(
        "INSERT INTO customers (id, name, phone, whatsapp, address, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![c.id, c.name, c.phone, c.whatsapp, c.address, c.notes, c.created_at, c.updated_at],
    )?;
    Ok(with_balance(c, 0))
}

pub fn list_employees(ctx: &Ctx) -> Res<Vec<Employee>> {
    ctx.db.all("SELECT * FROM employees WHERE deleted_at IS NULL ORDER BY name", [])
}

pub fn update_customer(ctx: &Ctx, input: &CustomerUpdateInput) -> Res<()> {
    let f = &input.fields;
    let n = ctx.db.exec(
        "UPDATE customers SET name = ?1, phone = ?2, whatsapp = ?3, address = ?4, notes = ?5, updated_at = ?6 WHERE id = ?7 AND deleted_at IS NULL",
        params![f.name, f.phone, f.whatsapp, f.address, f.notes, now(), input.id],
    )?;
    if n == 0 {
        bail!("not_found");
    }
    Ok(())
}

/// Soft delete. A customer who still owes money stays, so the debt is not lost.
pub fn delete_customer(ctx: &Ctx, id: &str) -> Res<()> {
    if customer_balance(ctx, id)? > 0 {
        bail!("customer_has_balance");
    }
    let t = now();
    if ctx.db.exec("UPDATE customers SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![t, id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

/// Money bought (sales net of returns, delivered repairs) per customer, and their last visit.
fn activity(ctx: &Ctx) -> Res<HashMap<String, (i64, Option<String>)>> {
    let mut stmt = ctx.db.prepare_cached(
        "SELECT c.id,
           COALESCE((SELECT SUM(s.total - COALESCE((SELECT SUM(r.returned_value) FROM sale_returns r WHERE r.sale_id = s.id), 0)) FROM sales s WHERE s.customer_id = c.id), 0)
           + COALESCE((SELECT SUM(COALESCE(rp.final_price, rp.estimated_price)) FROM repairs rp WHERE rp.customer_id = c.id AND rp.status = 'DELIVERED'), 0) AS bought,
           (SELECT MAX(d) FROM (SELECT date AS d FROM sales WHERE customer_id = c.id UNION ALL SELECT received_at FROM repairs WHERE customer_id = c.id)) AS last_visit
         FROM customers c",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

input! {
    #[derive(Default)]
    pub struct CustomerFilter { pub in_debt: Option<bool>, pub overdue: Option<bool> }
}
impl Validate for CustomerFilter {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}

row! {
    pub struct CustomerOverviewRow {
        pub id: String,
        pub name: String,
        pub phone: String,
        pub whatsapp: String,
        pub total_bought: i64,
        pub balance: i64,
        pub last_visit: Option<String>,
        pub oldest_unpaid: Option<String>,
        pub overdue: bool,
    }
}

/// The People > Customers list: totals, debt, last visit, and whether the debt is overdue.
pub fn customer_overview(ctx: &Ctx, filter: &CustomerFilter) -> Res<Vec<CustomerOverviewRow>> {
    let balances = customer_balances(ctx)?;
    let stats = activity(ctx)?;
    let mut oldest: HashMap<String, String> = HashMap::new();
    for item in open_items(ctx, None)? {
        oldest.entry(item.customer_id).or_insert(item.date);
    }
    let limit = ctx.now_ms() - get_public(ctx.db)?.debt_due_days * DAY_MS;
    let rows: Vec<Customer> = ctx.db.all("SELECT * FROM customers WHERE deleted_at IS NULL ORDER BY name", [])?;
    Ok(rows
        .into_iter()
        .map(|c| {
            let since = oldest.get(&c.id).cloned();
            let balance = balances.get(&c.id).copied().unwrap_or(0);
            let (bought, last) = stats.get(&c.id).cloned().unwrap_or((0, None));
            CustomerOverviewRow {
                overdue: balance > 0 && since.as_deref().and_then(parse_ms).is_some_and(|t| t < limit),
                id: c.id,
                name: c.name,
                phone: c.phone,
                whatsapp: c.whatsapp,
                total_bought: bought,
                balance,
                last_visit: last,
                oldest_unpaid: since,
            }
        })
        .filter(|c| (filter.in_debt != Some(true) || c.balance > 0) && (filter.overdue != Some(true) || c.overdue))
        .collect())
}

row! { pub struct CustomerStats { pub total_bought: i64, pub total_paid: i64, pub balance: i64 } }
row! {
    pub struct CustomerRepair {
        pub id: String,
        pub ticket: String,
        pub brand: String,
        pub model: String,
        pub fault: String,
        pub status: String,
        pub received_at: String,
        pub price: i64,
        pub deposit: i64,
    }
}
row! {
    pub struct CustomerPaymentGroup {
        pub id: String,
        pub date: String,
        pub amount: i64,
        pub method: String,
        pub note: String,
        pub balance_before: Option<i64>,
        pub balance_after: Option<i64>,
    }
}
row! {
    pub struct CustomerPhone {
        pub unit_id: String,
        pub imei1: Option<String>,
        pub name: String,
        pub storage: String,
        pub sale_id: String,
        pub receipt: String,
        pub date: String,
        pub warranty_days: i64,
        #[serde(default)]
        pub warranty_end: Option<String>,
        #[ts(type = "'NONE' | 'ACTIVE' | 'EXPIRED'")]
        #[serde(default)]
        pub warranty: String,
    }
}
row! {
    pub struct CustomerDetail {
        pub customer: Customer,
        pub stats: CustomerStats,
        pub sales: Vec<SaleRow>,
        pub repairs: Vec<CustomerRepair>,
        pub payments: Vec<CustomerPaymentGroup>,
        pub phones: Vec<CustomerPhone>,
        pub open_items: Vec<OpenItem>,
    }
}

pub fn get_customer(ctx: &Ctx, id: &str) -> Res<CustomerDetail> {
    let Some(customer) = ctx.db.get::<Customer>("SELECT * FROM customers WHERE id = ?1 AND deleted_at IS NULL", [id])? else { bail!("not_found") };
    let balance = customer_balance(ctx, id)?;
    let bought = activity(ctx)?.get(id).map(|a| a.0).unwrap_or(0);
    let repairs = ctx.db.all(
        "SELECT id, ticket_number AS ticket, brand, model, fault, status, received_at, COALESCE(final_price, estimated_price) AS price, deposit
         FROM repairs WHERE customer_id = ?1 ORDER BY received_at DESC",
        [id],
    )?;
    let payments = ctx.db.all(
        "SELECT COALESCE(group_id, id) AS id, MIN(date) AS date, SUM(amount) AS amount, method, note, balance_before, balance_after
         FROM customer_payments WHERE customer_id = ?1 GROUP BY COALESCE(group_id, id) ORDER BY MIN(date) DESC",
        [id],
    )?;
    // Phones bought here and still with the customer, with the state of their warranty.
    let mut phones: Vec<CustomerPhone> = ctx.db.all(
        "SELECT u.id AS unit_id, u.imei1, p.name, p.storage, s.id AS sale_id, s.receipt_number AS receipt, s.date, l.warranty_days
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN phone_units u ON u.id = l.unit_id JOIN products p ON p.id = l.product_id
         WHERE s.customer_id = ?1 AND l.returned_quantity = 0 AND u.status = 'SOLD' ORDER BY s.date DESC",
        [id],
    )?;
    let t = ctx.now_ms();
    for p in &mut phones {
        let end = (p.warranty_days > 0).then(|| parse_ms(&p.date).unwrap_or(0) + p.warranty_days * DAY_MS);
        p.warranty_end = end.map(ms_to_iso);
        p.warranty = match end {
            None => "NONE",
            Some(e) if e >= t => "ACTIVE",
            Some(_) => "EXPIRED",
        }
        .into();
    }
    Ok(CustomerDetail {
        customer,
        stats: CustomerStats { total_bought: bought, total_paid: bought - balance, balance },
        sales: list_sales(ctx, &SaleFilter { customer_id: Some(id.to_owned()), ..Default::default() }, None, None)?,
        repairs,
        payments,
        phones,
        open_items: open_items(ctx, Some(id))?,
    })
}

input! {
    pub struct CustomerPaymentInput {
        pub customer_id: String,
        pub amount: i64,
        pub date: String,
        #[serde(default = "super::sales::cash_method")]
        pub method: String,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for CustomerPaymentInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.customer_id, "customerId")?;
        valid::pos_centimes(self.amount, "amount")?;
        valid::datetime(&self.date, "date")?;
        valid::one_of(&self.method, SALE_METHODS, "method")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

row! { pub struct Applied { pub label: String, pub amount: i64 } }
row! {
    pub struct PaymentResult {
        pub group_id: String,
        pub before: i64,
        pub after: i64,
        pub applied: Vec<Applied>,
        pub credit: i64,
    }
}

/// A payment from a customer. It settles the oldest unpaid sales and closed repairs first, one customer_payments
/// row per item (tied together by group_id); anything left over stays as credit. Cash goes into the drawer.
pub fn receive_payment(ctx: &Ctx, input: &CustomerPaymentInput) -> Res<PaymentResult> {
    ctx.tx(|| {
        let Some(customer) = ctx.db.get::<Customer>("SELECT * FROM customers WHERE id = ?1 AND deleted_at IS NULL", [&input.customer_id])? else { bail!("not_found") };
        let before = customer_balance(ctx, &customer.id)?;
        let after = before - input.amount;
        let group_id = uuid();
        let mut rows: Vec<(Option<String>, Option<String>, i64, String)> = Vec::new();
        let mut left = input.amount;
        for item in open_items(ctx, Some(&customer.id))? {
            if left <= 0 {
                break;
            }
            let part = left.min(item.remaining);
            let (s, r) = if item.kind == "SALE" { (Some(item.id), None) } else { (None, Some(item.id)) };
            rows.push((s, r, part, item.label));
            left -= part;
        }
        if left > 0 {
            rows.push((None, None, left, String::new())); // credit
        }
        for (sale_id, repair_id, amount, _) in &rows {
            let t = now();
            ctx.db.exec(
                "INSERT INTO customer_payments (id, customer_id, amount, date, method, note, sale_id, repair_id, group_id, balance_before, balance_after, employee_id, via, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
                params![uuid(), customer.id, amount, input.date, input.method, input.note, sale_id, repair_id, group_id, before, after, ctx.actor(), ctx.via(), t],
            )?;
        }
        if input.method == "CASH" {
            cash(ctx, "IN", input.amount, "CUSTOMER_PAYMENT", "customer_payments", &group_id, &customer.name, Some(&input.date))?;
        }
        Ok(PaymentResult {
            group_id,
            before,
            after,
            applied: rows.into_iter().filter(|r| !r.3.is_empty()).map(|r| Applied { label: r.3, amount: r.2 }).collect(),
            credit: left,
        })
    })
}

row! {
    pub struct PaymentReceipt {
        pub customer_id: String,
        pub customer_name: String,
        pub customer_phone: String,
        pub date: String,
        pub method: String,
        pub note: String,
        pub balance_before: Option<i64>,
        pub balance_after: Option<i64>,
        pub amount: i64,
    }
}

/// One payment (all its rows) for the receipt.
pub fn get_payment(ctx: &Ctx, group_id: &str) -> Res<PaymentReceipt> {
    match ctx.db.get(
        "SELECT p.customer_id, c.name AS customer_name, c.phone AS customer_phone, p.date, p.method, p.note, p.balance_before, p.balance_after, SUM(p.amount) AS amount
         FROM customer_payments p JOIN customers c ON c.id = p.customer_id
         WHERE COALESCE(p.group_id, p.id) = ?1 GROUP BY COALESCE(p.group_id, p.id)",
        [group_id],
    )? {
        Some(r) => Ok(r),
        None => bail!("not_found"),
    }
}

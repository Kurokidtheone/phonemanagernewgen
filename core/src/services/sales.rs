// Sales. create_sale is one transaction: lines, stock, stock movements, trade-in, cash.
use super::auth::confirm_manager;
use super::balance::SALE_REMAINING;
use super::cash::cash;
use super::settings::get_public;
use super::stock::{check_imeis, find_or_create_model, insert_unit, recompute_model, write_movement, ModelInput, Movement, CONDITIONS};
use crate::core::Ctx;
use crate::db::{Args, DbExt};
use crate::error::{app, app_with, bail, Res};
use crate::rows::{CustomerPayment, PhoneUnit, Product, SaleReturn};
use crate::util::{ms_to_iso, now, parse_ms, uuid, DAY_MS};
use crate::valid::{self, Validate};
use chrono::Datelike;
use rusqlite::params;
use std::collections::HashMap;

pub const SALE_METHODS: &[&str] = &["CASH", "CCP", "BARIDIMOB", "OTHER"];

/// Next receipt number of the (local) year: 2026-000001.
fn next_receipt_number(ctx: &Ctx) -> Res<String> {
    let year = chrono::Local::now().year();
    let n: Option<i64> = ctx.db.val("SELECT max(CAST(substr(receipt_number, 6) AS INTEGER)) FROM sales WHERE receipt_number LIKE ?1", [format!("{year}-%")])?;
    Ok(format!("{year}-{:06}", n.unwrap_or(0) + 1))
}

input! {
    pub struct SaleLineInput {
        pub unit_id: Option<String>,
        pub product_id: Option<String>,
        #[serde(default = "one")]
        pub quantity: i64,
        pub unit_price: i64,
        #[serde(default)]
        pub discount: i64,
        #[serde(default)]
        pub warranty_days: i64,
    }
}
fn one() -> i64 {
    1
}
impl Validate for SaleLineInput {
    fn validate(&mut self) -> Res<()> {
        valid::opt_id(&self.unit_id, "unitId")?;
        valid::opt_id(&self.product_id, "productId")?;
        valid::range(self.quantity, 1, 100_000, "quantity")?;
        valid::centimes(self.unit_price, "unitPrice")?;
        valid::centimes(self.discount, "discount")?;
        valid::range(self.warranty_days, 0, 3650, "warrantyDays")?;
        valid::check(self.unit_id.is_some() != self.product_id.is_some(), "line_target")
    }
}

input! {
    pub struct TradeInInput {
        pub imei1: Option<String>,
        pub imei2: Option<String>,
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub value: i64,
        pub product_id: Option<String>,
        pub model: Option<ModelInput>,
    }
}
impl Validate for TradeInInput {
    fn validate(&mut self) -> Res<()> {
        valid::opt_text(&mut self.imei1, 40, "imei1")?;
        valid::opt_text(&mut self.imei2, 40, "imei2")?;
        valid::one_of(&self.condition, CONDITIONS, "condition")?;
        if let Some(b) = self.battery_health {
            valid::range(b, 0, 100, "batteryHealth")?;
        }
        valid::opt_text(&mut self.grade, 10, "grade")?;
        valid::pos_centimes(self.value, "value")?;
        valid::opt_id(&self.product_id, "productId")?;
        if let Some(m) = &mut self.model {
            m.validate()?;
        }
        valid::check(self.product_id.is_some() != self.model.is_some(), "model_required")
    }
}

input! {
    pub struct SaleInput {
        pub customer_id: Option<String>,
        pub employee_id: Option<String>,
        #[serde(default)]
        pub discount: i64,
        pub paid: i64,
        #[serde(default = "cash_method")]
        pub payment_method: String,
        pub lines: Vec<SaleLineInput>,
        pub trade_in: Option<TradeInInput>,
        /// Sent by a phone: a repeated id returns the first sale instead of selling again.
        pub request_id: Option<String>,
        /// Needed only when a line is priced below its minimum.
        pub manager_password: Option<String>,
    }
}
pub fn cash_method() -> String {
    "CASH".into()
}
impl Validate for SaleInput {
    fn validate(&mut self) -> Res<()> {
        valid::empty_to_none(&mut self.customer_id);
        valid::empty_to_none(&mut self.employee_id);
        valid::centimes(self.discount, "discount")?;
        valid::centimes(self.paid, "paid")?;
        valid::one_of(&self.payment_method, SALE_METHODS, "paymentMethod")?;
        valid::max_items(&self.lines, 1, 200, "lines")?;
        for l in &mut self.lines {
            l.validate()?;
        }
        if let Some(t) = &mut self.trade_in {
            t.validate()?;
        }
        valid::opt_trimmed(&mut self.request_id, 8, 64, "requestId")?;
        if let Some(p) = &self.manager_password {
            valid::len(p, 0, 100, "managerPassword")?;
        }
        Ok(())
    }
}

struct Prepared {
    product_id: String,
    unit_id: Option<String>,
    quantity: i64,
    unit_price: i64,
    discount: i64,
    warranty_days: i64,
    cost: i64,
    below_minimum: bool,
}

row! { pub struct SaleCreated { pub id: String, pub receipt_number: String, pub credit_used: i64 } }

#[derive(Default)]
pub struct SaleOptions {
    pub exchange_return_id: Option<String>,
    pub return_credit: i64,
}

/// `opts` is for exchanges: the sale is linked to its return, and `return_credit` (the value being returned)
/// pays for it first. Only what is paid on top goes through the till.
pub fn create_sale(ctx: &Ctx, input: &SaleInput, opts: SaleOptions) -> Res<SaleCreated> {
    ctx.tx(|| {
        // A phone that did not get the answer sends the same request id again: nothing is sold twice.
        if let Some(r) = &input.request_id {
            let earlier = ctx.db.prepare_cached("SELECT id, receipt_number FROM sales WHERE request_id = ?1")?.query_row([r], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)));
            if let Ok((id, receipt_number)) = earlier {
                return Ok(SaleCreated { id, receipt_number, credit_used: 0 });
            }
        }
        let settings = get_public(ctx.db)?;
        let date = crate::util::event_now();

        // 1. Check and price every line before anything is written.
        let mut prepared: Vec<Prepared> = Vec::new();
        let mut wanted: HashMap<String, i64> = HashMap::new();
        let mut seen_units: Vec<String> = Vec::new();
        for l in &input.lines {
            let (mut p, min_price) = if let Some(unit_id) = &l.unit_id {
                if l.quantity != 1 || seen_units.contains(unit_id) {
                    bail!("unit_not_available");
                }
                seen_units.push(unit_id.clone());
                let Some(unit) = ctx.db.get::<PhoneUnit>("SELECT * FROM phone_units WHERE id = ?1 AND deleted_at IS NULL", [unit_id])? else { bail!("not_found") };
                if unit.status != "IN_STOCK" {
                    bail!("unit_not_available");
                }
                let min: i64 = ctx.db.val("SELECT min_price FROM products WHERE id = ?1", [&unit.product_id])?;
                (
                    Prepared { product_id: unit.product_id, unit_id: Some(unit.id), quantity: 1, unit_price: l.unit_price, discount: l.discount, warranty_days: l.warranty_days, cost: unit.cost, below_minimum: false },
                    min,
                )
            } else {
                let pid = l.product_id.as_deref().unwrap_or("");
                let Some(item) = ctx.db.get::<Product>("SELECT * FROM products WHERE id = ?1 AND kind = 'ITEM' AND deleted_at IS NULL", [pid])? else { bail!("not_found") };
                let total = wanted.get(&item.id).copied().unwrap_or(0) + l.quantity;
                wanted.insert(item.id.clone(), total);
                if total > item.quantity && !settings.allow_negative_stock && !crate::util::sync_mode().allow_negative {
                    return Err(app_with("insufficient_stock", [("name", item.name.clone().into()), ("available", item.quantity.into())]));
                }
                (
                    Prepared { product_id: item.id, unit_id: None, quantity: l.quantity, unit_price: l.unit_price, discount: l.discount, warranty_days: l.warranty_days, cost: item.avg_cost, below_minimum: false },
                    item.min_price,
                )
            };
            let total = p.unit_price * p.quantity - p.discount;
            if total < 0 {
                bail!("invalid_input");
            }
            p.below_minimum = min_price > 0 && total < min_price * p.quantity;
            prepared.push(p);
        }

        // 2. Totals and who owes what.
        let subtotal: i64 = prepared.iter().map(|p| p.unit_price * p.quantity - p.discount).sum();
        if input.discount > subtotal {
            bail!("invalid_input");
        }
        let trade_in_value = input.trade_in.as_ref().map(|t| t.value).unwrap_or(0);
        let total = subtotal - input.discount - trade_in_value;
        if total < 0 {
            bail!("trade_in_exceeds_total");
        }
        let credit = opts.return_credit.min(total);
        if input.paid + credit > total {
            bail!("paid_exceeds_total");
        }
        let remaining = total - input.paid - credit;
        if (remaining > 0 || input.trade_in.is_some()) && input.customer_id.is_none() {
            bail!("customer_required");
        }
        if let Some(c) = &input.customer_id {
            if !ctx.db.exists("SELECT 1 FROM customers WHERE id = ?1 AND deleted_at IS NULL", [c])? {
                bail!("not_found");
            }
        }
        if let Some(e) = &input.employee_id {
            if !ctx.db.exists("SELECT 1 FROM employees WHERE id = ?1 AND deleted_at IS NULL", [e])? {
                bail!("not_found");
            }
        }
        if prepared.iter().any(|p| p.below_minimum) {
            confirm_manager(ctx, input.manager_password.as_deref())?;
        }

        // 3. Write.
        let sale_id = uuid();
        let receipt_number = next_receipt_number(ctx)?;
        let t = now();
        ctx.db.exec(
            "INSERT INTO sales (id, receipt_number, customer_id, employee_id, date, subtotal, discount, total, paid, trade_in_value, exchange_return_id,
                                request_id, device_id, via, payment_method, status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'COMPLETED', ?16, ?16)",
            params![
                sale_id,
                receipt_number,
                input.customer_id,
                input.employee_id,
                date,
                subtotal,
                input.discount,
                total,
                input.paid + credit,
                trade_in_value,
                opts.exchange_return_id,
                input.request_id,
                ctx.device(),
                ctx.via(),
                input.payment_method,
                t
            ],
        )?;

        let mut models: Vec<String> = Vec::new();
        for p in &prepared {
            let t = now();
            ctx.db.exec(
                "INSERT INTO sale_lines (id, sale_id, product_id, unit_id, quantity, unit_price, discount, unit_cost_at_sale, warranty_days, returned_quantity, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)",
                params![uuid(), sale_id, p.product_id, p.unit_id, p.quantity, p.unit_price, p.discount, p.cost, p.warranty_days, t],
            )?;
            if let Some(u) = &p.unit_id {
                ctx.db.exec("UPDATE phone_units SET status = 'SOLD', updated_at = ?1 WHERE id = ?2", params![now(), u])?;
                if !models.contains(&p.product_id) {
                    models.push(p.product_id.clone());
                }
            } else {
                ctx.db.exec("UPDATE products SET quantity = quantity - ?1, updated_at = ?2 WHERE id = ?3", params![p.quantity, now(), p.product_id])?;
            }
            write_movement(
                ctx,
                Movement { product_id: &p.product_id, unit_id: p.unit_id.as_deref(), kind: "SALE", quantity: -p.quantity, unit_cost: p.cost, reason: "", ref_table: Some("sales"), ref_id: Some(&sale_id), at: Some(&date) },
            )?;
        }

        if let Some(ti) = &input.trade_in {
            check_imeis(ctx, ti.imei1.as_deref(), ti.imei2.as_deref(), None)?;
            let product_id = match &ti.product_id {
                Some(pid) => {
                    if !ctx.db.exists("SELECT 1 FROM products WHERE id = ?1 AND kind = 'PHONE_MODEL' AND deleted_at IS NULL", [pid])? {
                        bail!("not_found");
                    }
                    pid.clone()
                }
                None => find_or_create_model(ctx, ti.model.as_ref().unwrap(), ti.value, 0, ti.value)?,
            };
            // The sale price is a starting point: change it from the unit page.
            let unit_id = insert_unit(ctx, &product_id, ti.imei1.as_deref(), ti.imei2.as_deref(), &ti.condition, ti.battery_health, ti.grade.as_deref(), ti.value, ti.value, "IN_STOCK", "", None)?;
            write_movement(ctx, Movement { product_id: &product_id, unit_id: Some(&unit_id), kind: "TRADE_IN", quantity: 1, unit_cost: ti.value, reason: "", ref_table: Some("sales"), ref_id: Some(&sale_id), at: Some(&date) })?;
            if !models.contains(&product_id) {
                models.push(product_id);
            }
        }
        for m in &models {
            recompute_model(ctx, m)?;
        }

        // Only cash passes through the drawer; CCP and BaridiMob go to the bank side.
        if input.payment_method == "CASH" {
            cash(ctx, "IN", input.paid, "SALE", "sales", &sale_id, &receipt_number, Some(&date))?;
        }
        Ok(SaleCreated { id: sale_id, receipt_number, credit_used: credit })
    })
}

input! { pub struct PeriodInput { pub from: String, pub to: String } }
impl Validate for PeriodInput {
    fn validate(&mut self) -> Res<()> {
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")
    }
}

/// What the calling phone sold in a period (its own sales only), newest first.
pub fn list_by_device(ctx: &Ctx, from: &str, to: &str) -> Res<Vec<SaleRow>> {
    let Some(device) = ctx.device() else { return Ok(vec![]) };
    let mut stmt = ctx.db.prepare_cached("SELECT id FROM sales WHERE device_id = ?1 AND date >= ?2 AND date <= ?3")?;
    let ids: Vec<String> = stmt.query_map(params![device, from, to], |r| r.get(0))?.collect::<Result<_, _>>()?;
    if ids.is_empty() {
        return Ok(vec![]);
    }
    list_sales(ctx, &SaleFilter::default(), Some(&ids), None)
}

/// The most recent sales a list loads. Narrow the period (or search by receipt in Returns) to reach older ones.
pub const SALES_LIST_LIMIT: i64 = 5_000;

input! {
    #[derive(Default)]
    pub struct SaleFilter {
        pub customer_id: Option<String>,
        pub from: Option<String>,
        pub to: Option<String>,
        pub employee_id: Option<String>,
        pub unpaid_only: Option<bool>,
    }
}
impl Validate for SaleFilter {
    fn validate(&mut self) -> Res<()> {
        valid::opt_datetime(&self.from, "from")?;
        valid::opt_datetime(&self.to, "to")
    }
}

row! {
    pub struct SaleRow {
        pub id: String,
        pub receipt_number: String,
        pub date: String,
        pub total: i64,
        pub paid: i64,
        #[ts(type = "'COMPLETED' | 'PARTIALLY_RETURNED' | 'RETURNED'")]
        pub status: String,
        pub customer_id: Option<String>,
        pub customer_name: Option<String>,
        pub employee_id: Option<String>,
        pub employee_name: Option<String>,
        pub remaining: i64,
        pub items_summary: Option<String>,
        pub imeis: Option<String>,
    }
}

pub fn list_sales(ctx: &Ctx, filter: &SaleFilter, ids: Option<&[String]>, limit: Option<i64>) -> Res<Vec<SaleRow>> {
    let mut conds: Vec<String> = Vec::new();
    let mut args = Args::new();
    let mut add = |clause: &str, v: &Option<String>| {
        if let Some(v) = v.as_ref().filter(|v| !v.is_empty()) {
            conds.push(clause.to_owned());
            args.push(v.clone());
        }
    };
    add("s.customer_id = ?", &filter.customer_id);
    add("s.date >= ?", &filter.from);
    add("s.date <= ?", &filter.to);
    add("s.employee_id = ?", &filter.employee_id);
    if filter.unpaid_only == Some(true) {
        conds.push(format!("{SALE_REMAINING} > 0"));
    }
    if let Some(ids) = ids {
        let marks = if ids.is_empty() { "''".to_owned() } else { vec!["?"; ids.len()].join(",") };
        conds.push(format!("s.id IN ({marks})"));
        for id in ids {
            args.push(id.clone());
        }
    }
    let sql = format!(
        "SELECT s.id, s.receipt_number, s.date, s.total, s.paid, s.status, s.customer_id, c.name AS customer_name, s.employee_id, e.name AS employee_name,
                {SALE_REMAINING} AS remaining,
                (SELECT group_concat(pr.name || CASE WHEN l.quantity > 1 THEN ' x' || l.quantity ELSE '' END, ', ')
                   FROM sale_lines l JOIN products pr ON pr.id = l.product_id WHERE l.sale_id = s.id) AS items_summary,
                (SELECT group_concat(u.imei1 || COALESCE(' ' || u.imei2, ''), ' ')
                   FROM sale_lines l JOIN phone_units u ON u.id = l.unit_id WHERE l.sale_id = s.id) AS imeis
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN employees e ON e.id = s.employee_id
         {} ORDER BY s.date DESC LIMIT {}",
        if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) },
        limit.unwrap_or(SALES_LIST_LIMIT)
    );
    ctx.db.all(&sql, args.params())
}

row! {
    pub struct SaleLineDetail {
        pub id: String,
        pub product_id: String,
        pub name: String,
        pub storage: String,
        pub color: String,
        pub unit_id: Option<String>,
        pub imei1: Option<String>,
        pub quantity: i64,
        pub unit_price: i64,
        pub discount: i64,
        pub warranty_days: i64,
        pub returned_quantity: i64,
        pub line_total: i64,
        pub warranty_end: Option<String>,
        pub unit_cost: Option<i64>,
        pub profit: Option<i64>,
    }
}

row! { pub struct SalePaymentRow { pub id: String, pub date: String, pub amount: i64, pub method: String, pub note: String } }
row! {
    pub struct SaleReturnSummary {
        pub id: String,
        pub date: String,
        pub returned_value: i64,
        pub refund_amount: i64,
        pub debt_cancelled: i64,
        pub reason: String,
        pub exchange_sale_id: Option<String>,
    }
}
row! { pub struct TradeInRow { pub unit_id: String, pub imei1: Option<String>, pub name: String, pub value: i64 } }

row! {
    pub struct SaleDetail {
        pub id: String,
        pub receipt_number: String,
        pub date: String,
        pub subtotal: i64,
        pub discount: i64,
        pub total: i64,
        pub paid: i64,
        pub trade_in_value: i64,
        pub payment_method: String,
        #[ts(type = "'COMPLETED' | 'PARTIALLY_RETURNED' | 'RETURNED'")]
        pub status: String,
        pub customer_id: Option<String>,
        pub customer_name: Option<String>,
        pub customer_phone: Option<String>,
        pub customer_whatsapp: Option<String>,
        pub employee_name: Option<String>,
        pub remaining: i64,
        pub returned_value: i64,
        pub returns: Vec<SaleReturnSummary>,
        pub lines: Vec<SaleLineDetail>,
        pub payments: Vec<SalePaymentRow>,
        pub trade_in: Option<TradeInRow>,
        pub profit: Option<i64>,
    }
}

#[derive(serde::Deserialize)]
struct SaleHead {
    id: String,
    receipt_number: String,
    date: String,
    subtotal: i64,
    discount: i64,
    total: i64,
    paid: i64,
    trade_in_value: i64,
    payment_method: String,
    status: String,
    customer_id: Option<String>,
    customer_name: Option<String>,
    customer_phone: Option<String>,
    customer_whatsapp: Option<String>,
    employee_name: Option<String>,
}

#[derive(serde::Deserialize)]
struct LineHead {
    id: String,
    product_id: String,
    name: String,
    storage: String,
    color: String,
    unit_id: Option<String>,
    imei1: Option<String>,
    quantity: i64,
    unit_price: i64,
    discount: i64,
    unit_cost_at_sale: i64,
    warranty_days: i64,
    returned_quantity: i64,
}

/// One sale with its lines. `with_profit` is false while the Finance section is locked: costs are left out.
pub fn get_sale(ctx: &Ctx, id: &str, with_profit: bool) -> Res<SaleDetail> {
    let Some(sale) = ctx.db.get::<SaleHead>(
        "SELECT s.id, s.receipt_number, s.date, s.subtotal, s.discount, s.total, s.paid, s.trade_in_value, s.payment_method, s.status, s.customer_id,
                c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp, e.name AS employee_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN employees e ON e.id = s.employee_id WHERE s.id = ?1",
        [id],
    )?
    else {
        bail!("not_found")
    };

    // What returns took back from each line: its value, and the quantity that went back on the shelf.
    let mut taken: HashMap<String, (i64, i64)> = HashMap::new();
    let mut stmt = ctx.db.prepare_cached(
        "SELECT l.sale_line_id, SUM(l.value), SUM(CASE WHEN l.restock = 1 THEN l.quantity ELSE 0 END)
         FROM sale_return_lines l JOIN sale_returns r ON r.id = l.return_id WHERE r.sale_id = ?1 GROUP BY l.sale_line_id",
    )?;
    for r in stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))? {
        let (lid, value, restocked) = r?;
        taken.insert(lid, (value, restocked));
    }

    let heads: Vec<LineHead> = ctx.db.all(
        "SELECT l.id, l.product_id, p.name, p.storage, p.color, l.unit_id, u.imei1, l.quantity, l.unit_price, l.discount, l.unit_cost_at_sale, l.warranty_days, l.returned_quantity
         FROM sale_lines l JOIN products p ON p.id = l.product_id LEFT JOIN phone_units u ON u.id = l.unit_id WHERE l.sale_id = ?1 ORDER BY l.created_at",
        [id],
    )?;
    let sale_ms = parse_ms(&sale.date).unwrap_or(0);
    let lines: Vec<SaleLineDetail> = heads
        .into_iter()
        .map(|l| {
            let line_total = l.unit_price * l.quantity - l.discount;
            let (value, restocked) = taken.get(&l.id).copied().unwrap_or((0, 0));
            SaleLineDetail {
                warranty_end: if l.warranty_days > 0 { Some(ms_to_iso(sale_ms + l.warranty_days * DAY_MS)) } else { None },
                // Profit always uses the cost stored on the line, never the product's current average cost.
                // Returns take their value back, and give the cost back only for what was restocked.
                unit_cost: with_profit.then_some(l.unit_cost_at_sale),
                profit: with_profit.then(|| line_total - l.unit_cost_at_sale * l.quantity - (value - l.unit_cost_at_sale * restocked)),
                id: l.id,
                product_id: l.product_id,
                name: l.name,
                storage: l.storage,
                color: l.color,
                unit_id: l.unit_id,
                imei1: l.imei1,
                quantity: l.quantity,
                unit_price: l.unit_price,
                discount: l.discount,
                warranty_days: l.warranty_days,
                returned_quantity: l.returned_quantity,
                line_total,
            }
        })
        .collect();

    let later: Vec<CustomerPayment> = ctx.db.all("SELECT * FROM customer_payments WHERE sale_id = ?1", [id])?;
    let mut payments = Vec::new();
    if sale.paid > 0 {
        payments.push(SalePaymentRow {
            id: "at-sale".into(),
            date: sale.date.clone(),
            amount: sale.paid,
            method: sale.payment_method.clone(),
            note: String::new(),
        });
    }
    payments.extend(later.into_iter().map(|p| SalePaymentRow { id: p.id, date: p.date, amount: p.amount, method: p.method, note: p.note }));
    let trade_in: Option<TradeInRow> = ctx.db.get(
        "SELECT u.id AS unit_id, u.imei1, p.name, m.unit_cost AS value
         FROM stock_movements m JOIN phone_units u ON u.id = m.unit_id JOIN products p ON p.id = m.product_id
         WHERE m.type = 'TRADE_IN' AND m.ref_table = 'sales' AND m.ref_id = ?1",
        [id],
    )?;
    let returns: Vec<SaleReturn> = ctx.db.all("SELECT * FROM sale_returns WHERE sale_id = ?1 ORDER BY date", [id])?;
    let received: i64 = payments.iter().map(|p| p.amount).sum();
    let returned_value: i64 = returns.iter().map(|r| r.returned_value).sum();
    let refunded: i64 = returns.iter().map(|r| r.refund_amount).sum();
    let profit = with_profit.then(|| lines.iter().map(|l| l.profit.unwrap_or(0)).sum::<i64>() - sale.discount);
    Ok(SaleDetail {
        // Same rule as balance.rs SALE_REMAINING.
        remaining: sale.total - returned_value - (received - refunded),
        returned_value,
        returns: returns
            .into_iter()
            .map(|r| SaleReturnSummary {
                id: r.id,
                date: r.date,
                returned_value: r.returned_value,
                refund_amount: r.refund_amount,
                debt_cancelled: r.debt_cancelled,
                reason: r.reason,
                exchange_sale_id: r.exchange_sale_id,
            })
            .collect(),
        lines,
        payments,
        trade_in,
        profit,
        id: sale.id,
        receipt_number: sale.receipt_number,
        date: sale.date,
        subtotal: sale.subtotal,
        discount: sale.discount,
        total: sale.total,
        paid: sale.paid,
        trade_in_value: sale.trade_in_value,
        payment_method: sale.payment_method,
        status: sale.status,
        customer_id: sale.customer_id,
        customer_name: sale.customer_name,
        customer_phone: sale.customer_phone,
        customer_whatsapp: sale.customer_whatsapp,
        employee_name: sale.employee_name,
    })
}

/// Profit of a period: the profit of the sales made in it, minus what returns made in it took back
/// (the returned value, giving the cost back only for restocked goods). Dates are ISO instants.
pub fn period_profit(ctx: &Ctx, from: &str, to: &str) -> Res<i64> {
    let sold: i64 = ctx.db.val(
        "SELECT COALESCE(SUM(l.unit_price * l.quantity - l.discount - l.unit_cost_at_sale * l.quantity), 0)
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.date >= ?1 AND s.date <= ?2",
        params![from, to],
    )?;
    let discounts: i64 = ctx.db.val("SELECT COALESCE(SUM(discount), 0) FROM sales WHERE date >= ?1 AND date <= ?2", params![from, to])?;
    let returned: i64 = ctx.db.val(
        "SELECT COALESCE(SUM(rl.value - CASE WHEN rl.restock = 1 THEN sl.unit_cost_at_sale * rl.quantity ELSE 0 END), 0)
         FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id JOIN sale_lines sl ON sl.id = rl.sale_line_id
         WHERE r.date >= ?1 AND r.date <= ?2",
        params![from, to],
    )?;
    Ok(sold - discounts - returned)
}

pub fn not_found() -> crate::error::Error {
    app("not_found")
}

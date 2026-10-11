// Returns and exchanges. One transaction: stock, stock movements, the customer's debt on the sale, the cash
// refund, the sale status and (for an exchange) the replacement sale.
use super::balance::SALE_REMAINING;
use super::cash::cash;
use super::purchases::weighted_average;
use super::sales::{create_sale, list_sales, SaleFilter, SaleInput, SaleOptions, SaleRow};
use super::stock::{recompute_model, write_movement, Movement};
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{Product, Sale, SaleLine};
use crate::util::{js_round, now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;

input! { pub struct ReturnLineInput { pub sale_line_id: String, pub quantity: i64, pub restock: bool } }
impl Validate for ReturnLineInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.sale_line_id, "saleLineId")?;
        valid::range(self.quantity, 1, 100_000, "quantity")
    }
}

input! { pub struct ReturnPreviewInput { pub sale_id: String, pub lines: Vec<ReturnLineInput> } }
impl Validate for ReturnPreviewInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.sale_id, "saleId")?;
        valid::max_items(&self.lines, 1, usize::MAX, "lines")?;
        self.lines.iter_mut().try_for_each(|l| l.validate())
    }
}

input! {
    pub struct ReturnInput {
        pub sale_id: String,
        pub reason: String,
        pub lines: Vec<ReturnLineInput>,
        /// An exchange: the replacement sale, created in the same step and paid with the returned value first.
        pub exchange: Option<SaleInput>,
    }
}
impl Validate for ReturnInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.sale_id, "saleId")?;
        valid::text(&mut self.reason, 1, 300, "reason")?;
        valid::max_items(&self.lines, 1, usize::MAX, "lines")?;
        self.lines.iter_mut().try_for_each(|l| l.validate())?;
        if let Some(x) = &mut self.exchange {
            x.validate()?;
        }
        Ok(())
    }
}

pub struct Row {
    pub line: SaleLine,
    pub quantity: i64,
    pub restock: bool,
    pub value: i64,
}

pub struct Preview {
    pub sale: Sale,
    pub rows: Vec<Row>,
    pub everything_back: bool,
    pub value: i64,
    pub debt_cancelled: i64,
    pub refund: i64,
}

row! { pub struct PreviewResult { pub value: i64, pub debt_cancelled: i64, pub refund: i64 } }

/// Works out what a return is worth, without changing anything.
/// A line's value is its price after discounts, spread like the sale's own discount and trade-in (total /
/// subtotal), for the returned quantity. When the last of the sale goes back, the rounding remainder is settled
/// so the returned values add up to exactly the sale total.
pub fn preview_return(ctx: &Ctx, sale_id: &str, requested: &[ReturnLineInput]) -> Res<Preview> {
    let Some(sale) = ctx.db.get::<Sale>("SELECT * FROM sales WHERE id = ?1", [sale_id])? else { bail!("not_found") };
    let lines: Vec<SaleLine> = ctx.db.all("SELECT * FROM sale_lines WHERE sale_id = ?1", [sale_id])?;
    let mut seen: Vec<&str> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    for r in requested {
        let Some(line) = lines.iter().find(|l| l.id == r.sale_line_id) else { bail!("invalid_input") };
        if seen.contains(&line.id.as_str()) {
            bail!("invalid_input");
        }
        seen.push(&line.id);
        if r.quantity > line.quantity - line.returned_quantity || (line.unit_id.is_some() && r.quantity != 1) {
            bail!("return_quantity");
        }
        rows.push(Row { line: line.clone(), quantity: r.quantity, restock: r.restock, value: 0 });
    }

    let ratio = if sale.subtotal > 0 { sale.total as f64 / sale.subtotal as f64 } else { 0.0 };
    let share = |l: &SaleLine, qty: i64| js_round(((l.unit_price * l.quantity - l.discount) as f64 * ratio * qty as f64) / l.quantity as f64);
    for r in &mut rows {
        r.value = share(&r.line, r.line.returned_quantity + r.quantity) - share(&r.line, r.line.returned_quantity);
    }

    let already: i64 = ctx.db.val("SELECT COALESCE(SUM(returned_value), 0) FROM sale_returns WHERE sale_id = ?1", [sale_id])?;
    let everything_back = lines.iter().all(|l| l.returned_quantity + rows.iter().find(|r| r.line.id == l.id).map(|r| r.quantity).unwrap_or(0) == l.quantity);
    if everything_back && !rows.is_empty() {
        let sum: i64 = rows.iter().map(|r| r.value).sum();
        let last = rows.len() - 1;
        rows[last].value += sale.total - already - sum;
    }
    let value: i64 = rows.iter().map(|r| r.value).sum();
    let remaining: i64 = ctx.db.val(&format!("SELECT {SALE_REMAINING} FROM sales s WHERE s.id = ?1"), [sale_id])?;
    let debt_cancelled = value.min(remaining.max(0));
    Ok(Preview { sale, rows, everything_back, value, debt_cancelled, refund: value - debt_cancelled })
}

row! { pub struct ExchangeRef { pub id: String, pub receipt_number: String } }
row! {
    pub struct ReturnResult {
        pub id: String,
        pub value: i64,
        pub debt_cancelled: i64,
        pub refund: i64,
        pub refund_cash: i64,
        #[ts(type = "'RETURNED' | 'PARTIALLY_RETURNED'")]
        pub status: String,
        pub exchange: Option<ExchangeRef>,
    }
}

pub fn create_return(ctx: &Ctx, input: &ReturnInput) -> Res<ReturnResult> {
    ctx.tx(|| {
        let p = preview_return(ctx, &input.sale_id, &input.lines)?;
        let return_id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO sale_returns (id, sale_id, date, refund_amount, returned_value, debt_cancelled, refund_cash, reason, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4, ?7, ?3, ?3)",
            params![return_id, input.sale_id, t, p.refund, p.value, p.debt_cancelled, input.reason],
        )?;

        let mut touched: Vec<String> = Vec::new();
        for r in &p.rows {
            let l = &r.line;
            let t = now();
            ctx.db.exec(
                "INSERT INTO sale_return_lines (id, return_id, sale_line_id, quantity, restock, value, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![uuid(), return_id, l.id, r.quantity, r.restock, r.value, t],
            )?;
            ctx.db.exec("UPDATE sale_lines SET returned_quantity = ?1, updated_at = ?2 WHERE id = ?3", params![l.returned_quantity + r.quantity, t, l.id])?;
            let mv = |quantity: i64| {
                write_movement(
                    ctx,
                    Movement {
                        product_id: &l.product_id,
                        unit_id: l.unit_id.as_deref(),
                        kind: "RETURN",
                        quantity,
                        unit_cost: l.unit_cost_at_sale,
                        reason: if r.restock { "" } else { "DEFECTIVE" },
                        ref_table: Some("sales"),
                        ref_id: Some(&input.sale_id),
                        at: None,
                    },
                )
            };
            if let Some(unit_id) = &l.unit_id {
                let status: Option<String> = ctx.db.opt_val("SELECT status FROM phone_units WHERE id = ?1", [unit_id])?;
                if status.as_deref() != Some("SOLD") {
                    bail!("unit_not_available");
                }
                // The unit keeps its original cost. Defective ones are not for sale: status RETURNED.
                ctx.db.exec("UPDATE phone_units SET status = ?1, updated_at = ?2 WHERE id = ?3", params![if r.restock { "IN_STOCK" } else { "RETURNED" }, now(), unit_id])?;
                mv(if r.restock { 1 } else { 0 })?;
                if !touched.contains(&l.product_id) {
                    touched.push(l.product_id.clone());
                }
            } else if r.restock {
                let item: Product = ctx.db.get("SELECT * FROM products WHERE id = ?1", [&l.product_id])?.unwrap();
                ctx.db.exec(
                    "UPDATE products SET quantity = ?1, avg_cost = ?2, updated_at = ?3 WHERE id = ?4",
                    params![item.quantity + r.quantity, weighted_average(item.quantity, item.avg_cost, r.quantity, l.unit_cost_at_sale), now(), item.id],
                )?;
                mv(r.quantity)?;
            } else {
                mv(0)?;
            }
        }
        for m in &touched {
            recompute_model(ctx, m)?;
        }

        let status = if p.everything_back { "RETURNED" } else { "PARTIALLY_RETURNED" };
        ctx.db.exec("UPDATE sales SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, now(), input.sale_id])?;

        // Exchange: the refund pays for the replacement sale first; what is left over (or still to pay) is settled normally.
        let mut exchange = None;
        let mut credit = 0;
        if let Some(x) = &input.exchange {
            let mut x = x.clone();
            if x.customer_id.is_none() {
                x.customer_id = p.sale.customer_id.clone();
            }
            let made = create_sale(ctx, &x, SaleOptions { exchange_return_id: Some(return_id.clone()), return_credit: p.refund })?;
            credit = made.credit_used;
            exchange = Some(ExchangeRef { id: made.id, receipt_number: made.receipt_number });
        }
        let cash_out = p.refund - credit;
        ctx.db.exec(
            "UPDATE sale_returns SET refund_cash = ?1, exchange_sale_id = ?2 WHERE id = ?3",
            params![cash_out, exchange.as_ref().map(|e| e.id.clone()), return_id],
        )?;
        cash(ctx, "OUT", cash_out, "SALE_RETURN", "sale_returns", &return_id, &p.sale.receipt_number, None)?;
        Ok(ReturnResult { id: return_id, value: p.value, debt_cancelled: p.debt_cancelled, refund: p.refund, refund_cash: cash_out, status: status.into(), exchange })
    })
}

row! {
    pub struct ReturnRow {
        pub id: String,
        pub date: String,
        pub reason: String,
        pub returned_value: i64,
        pub refund_amount: i64,
        pub debt_cancelled: i64,
        pub refund_cash: i64,
        pub exchange_sale_id: Option<String>,
        pub sale_id: String,
        pub receipt_number: String,
        pub customer_name: Option<String>,
        pub exchange_receipt: Option<String>,
    }
}

pub fn list_returns(ctx: &Ctx) -> Res<Vec<ReturnRow>> {
    ctx.db.all(
        "SELECT r.id, r.date, r.reason, r.returned_value, r.refund_amount, r.debt_cancelled, r.refund_cash, r.exchange_sale_id, s.id AS sale_id,
                s.receipt_number, c.name AS customer_name, x.receipt_number AS exchange_receipt
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN sales x ON x.id = r.exchange_sale_id
         ORDER BY r.date DESC",
        [],
    )
}

/// Sales matching a receipt number (or its tail) or an IMEI, for the Returns screen.
pub fn find_sales(ctx: &Ctx, query: &str) -> Res<Vec<SaleRow>> {
    let q = query.trim();
    let mut stmt = ctx.db.prepare_cached(
        "SELECT DISTINCT s.id FROM sales s LEFT JOIN sale_lines l ON l.sale_id = s.id LEFT JOIN phone_units u ON u.id = l.unit_id
         WHERE s.receipt_number = ?1 OR s.receipt_number LIKE ?2 OR u.imei1 = ?1 OR u.imei2 = ?1",
    )?;
    let ids: Vec<String> = stmt.query_map(params![q, format!("%{q}")], |r| r.get(0))?.collect::<Result<_, _>>()?;
    list_sales(ctx, &SaleFilter::default(), Some(&ids), None)
}

row! {
    pub struct ReturnableLine {
        pub id: String,
        pub name: String,
        pub storage: String,
        pub color: String,
        pub imei1: Option<String>,
        pub unit_id: Option<String>,
        pub quantity: i64,
        pub returned_quantity: i64,
        pub unit_price: i64,
        pub discount: i64,
    }
}

/// Lines of a sale with how much of each can still be returned.
pub fn returnable_lines(ctx: &Ctx, sale_id: &str) -> Res<Vec<ReturnableLine>> {
    ctx.db.all(
        "SELECT l.id, p.name, p.storage, p.color, u.imei1, l.unit_id, l.quantity, l.returned_quantity, l.unit_price, l.discount
         FROM sale_lines l JOIN products p ON p.id = l.product_id LEFT JOIN phone_units u ON u.id = l.unit_id WHERE l.sale_id = ?1",
        [sale_id],
    )
}

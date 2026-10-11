// What customers owe. ONE definition, used by every list and page:
//
//   balance = unpaid sale remainders + unpaid repair remainders - payments not tied to a sale or repair
//
// A sale's remainder is what is still due on it after returns and payments:
//   total - returned_value - (paid at the till + payments applied to it - refunds paid out)
// A repair is owed once it is closed: final price - payments on it (the deposit included).
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::Res;
use serde::Deserialize;
use std::collections::HashMap;

pub const SALE_REMAINING: &str = "(s.total
  - COALESCE((SELECT SUM(r.returned_value) FROM sale_returns r WHERE r.sale_id = s.id), 0)
  - (s.paid
     + COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.sale_id = s.id), 0)
     - COALESCE((SELECT SUM(r.refund_amount) FROM sale_returns r WHERE r.sale_id = s.id), 0)))";

// The deposit is itself a customer_payments row tied to the repair. A cancelled or unrepairable ticket owes only
// its diagnosis fee (final price), if any.
pub const REPAIR_REMAINING: &str = "(CASE
  WHEN r.status = 'DELIVERED' THEN COALESCE(r.final_price, 0) - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.repair_id = r.id), 0)
  WHEN r.status IN ('CANCELLED', 'UNREPAIRABLE') THEN COALESCE(r.final_price, 0) - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.repair_id = r.id), 0)
  ELSE 0 END)";

/// Balance per customer id (deleted customers included).
pub fn customer_balances(ctx: &Ctx) -> Res<HashMap<String, i64>> {
    let sql = format!(
        "SELECT c.id,
           COALESCE((SELECT SUM({SALE_REMAINING}) FROM sales s WHERE s.customer_id = c.id), 0)
           + COALESCE((SELECT SUM({REPAIR_REMAINING}) FROM repairs r WHERE r.customer_id = c.id), 0)
           - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.customer_id = c.id AND p.sale_id IS NULL AND p.repair_id IS NULL), 0) AS balance
         FROM customers c"
    );
    let mut stmt = ctx.db.prepare_cached(&sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn customer_balance(ctx: &Ctx, customer_id: &str) -> Res<i64> {
    Ok(customer_balances(ctx)?.get(customer_id).copied().unwrap_or(0))
}

row! {
    pub struct OpenItem {
        #[ts(type = "'SALE' | 'REPAIR'")]
        #[serde(default)]
        pub kind: String,
        pub id: String,
        /// What orders the settlement: oldest first.
        pub date: String,
        pub label: String,
        pub remaining: i64,
        pub customer_id: String,
    }
}

#[derive(Deserialize)]
struct Raw {
    id: String,
    customer_id: String,
    date: String,
    label: String,
    remaining: i64,
}

/// Sales and closed repairs that still have something to pay, oldest first.
pub fn open_items(ctx: &Ctx, customer_id: Option<&str>) -> Res<Vec<OpenItem>> {
    let sales_sql = format!(
        "SELECT s.id, s.customer_id, s.date, s.receipt_number AS label, {SALE_REMAINING} AS remaining FROM sales s WHERE s.customer_id IS NOT NULL{}",
        if customer_id.is_some() { " AND s.customer_id = ?1" } else { "" }
    );
    let repairs_sql = format!(
        "SELECT r.id, r.customer_id, COALESCE(r.delivered_at, r.received_at) AS date, r.ticket_number AS label, {REPAIR_REMAINING} AS remaining FROM repairs r{}",
        if customer_id.is_some() { " WHERE r.customer_id = ?1" } else { "" }
    );
    let params: Vec<&str> = customer_id.into_iter().collect();
    let sales: Vec<Raw> = ctx.db.all(&sales_sql, rusqlite::params_from_iter(params.iter()))?;
    let repairs: Vec<Raw> = ctx.db.all(&repairs_sql, rusqlite::params_from_iter(params.iter()))?;
    let mut items: Vec<OpenItem> = sales
        .into_iter()
        .map(|r| (r, "SALE"))
        .chain(repairs.into_iter().map(|r| (r, "REPAIR")))
        .filter(|(r, _)| r.remaining > 0)
        .map(|(r, kind)| OpenItem { kind: kind.into(), id: r.id, date: r.date, label: r.label, remaining: r.remaining, customer_id: r.customer_id })
        .collect();
    items.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(items)
}

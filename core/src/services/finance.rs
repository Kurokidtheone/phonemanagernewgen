// Every figure on the Analytics, Reports and Overview screens is aggregated here in SQL.
// Periods are ISO instants; "days" are local days (SQLite's 'localtime'), like the shop's own calendar.
//
//   sales revenue  = sum(subtotal - discount) of the sales made in the period - value returned in the period
//   sales profit   = sales::period_profit: lines - cost at sale - sale discounts - what returns took back
//   repair revenue = final prices of the tickets closed in the period; repair profit = revenue - parts cost
//   service margin = margin of the service sales; expenses = expenses dated in the period
//   salaries paid  = salary payments (gross) of the period
//   net profit     = sales profit + repair profit + service margin - expenses - salaries paid
use super::balance::{customer_balances, open_items};
use super::cash::current as current_cash;
use super::customers::{customer_overview, CustomerFilter};
use super::repairs::repair_profit;
use super::sales::period_profit;
use super::suppliers::list_suppliers;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::Res;
use crate::util::{iso, ms_to_iso, parse_ms, DAY_MS};
use crate::valid::{self, Validate};
use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use rusqlite::{params, Params};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub const METRICS: &[&str] = &["salesRevenue", "salesProfit", "repairRevenue", "repairProfit", "serviceMargin", "expenses", "salaries", "netProfit"];
pub const REPORT_KINDS: &[&str] = &["bestModels", "bestAccessories", "profitByBrand", "profitByEmployee", "slowStock", "lowStock", "debtsAgeing"];

input! { pub struct Period { pub from: String, pub to: String } }
impl Validate for Period {
    fn validate(&mut self) -> Res<()> {
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")
    }
}

input! {
    pub struct SeriesInput {
        pub from: String,
        pub to: String,
        pub metric: String,
    }
}
impl Validate for SeriesInput {
    fn validate(&mut self) -> Res<()> {
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")?;
        valid::one_of(&self.metric, METRICS, "metric")
    }
}

input! {
    pub struct ReportInput {
        pub from: String,
        pub to: String,
        pub kind: String,
        #[serde(default = "sixty")]
        pub slow_days: i64,
    }
}
fn sixty() -> i64 {
    60
}
impl Validate for ReportInput {
    fn validate(&mut self) -> Res<()> {
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")?;
        valid::one_of(&self.kind, REPORT_KINDS, "kind")?;
        valid::range(self.slow_days, 1, 3650, "slowDays")
    }
}

fn local(ms: i64) -> DateTime<Local> {
    Local.from_utc_datetime(&DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().naive_utc())
}

/// The local calendar day of an instant: YYYY-MM-DD.
pub fn local_day(iso_str: &str) -> String {
    local(parse_ms(iso_str).unwrap_or(0)).format("%Y-%m-%d").to_string()
}

fn day_range(p: &Period) -> (String, String) {
    (local_day(&p.from), local_day(&p.to))
}

/// Every local day of the period, to fill the days with nothing in them.
pub fn days_in(p: &Period) -> Vec<String> {
    let start = local(parse_ms(&p.from).unwrap_or(0)).date_naive();
    let end = NaiveDate::parse_from_str(&local_day(&p.to), "%Y-%m-%d").unwrap_or(start);
    let mut out = Vec::new();
    let mut d = start;
    while d <= end && out.len() < 800 {
        out.push(d.format("%Y-%m-%d").to_string());
        d = d.succ_opt().unwrap();
    }
    out
}

fn num(ctx: &Ctx, sql: &str, params: impl Params) -> Res<i64> {
    Ok(ctx.db.val::<Option<i64>>(sql, params)?.unwrap_or(0))
}

const IMPACT: &str = "rl.value - CASE WHEN rl.restock = 1 THEN sl.unit_cost_at_sale * rl.quantity ELSE 0 END";
const CLOSED: &str = "('DELIVERED','CANCELLED','UNREPAIRABLE')";

fn sales_revenue(ctx: &Ctx, p: &Period) -> Res<i64> {
    Ok(num(ctx, "SELECT SUM(subtotal - discount) FROM sales WHERE date >= ?1 AND date <= ?2", params![p.from, p.to])?
        - num(ctx, "SELECT SUM(returned_value) FROM sale_returns WHERE date >= ?1 AND date <= ?2", params![p.from, p.to])?)
}
fn repair_revenue(ctx: &Ctx, p: &Period) -> Res<i64> {
    num(
        ctx,
        &format!("SELECT SUM(COALESCE(final_price, 0)) FROM repairs WHERE status IN {CLOSED} AND closed_at >= ?1 AND closed_at <= ?2"),
        params![p.from, p.to],
    )
}
fn service_margin(ctx: &Ctx, p: &Period) -> Res<i64> {
    num(ctx, "SELECT SUM(margin) FROM service_sales WHERE date >= ?1 AND date <= ?2", params![p.from, p.to])
}
fn expenses_total(ctx: &Ctx, p: &Period) -> Res<i64> {
    let (a, b) = day_range(p);
    num(ctx, "SELECT SUM(amount) FROM expenses WHERE date >= ?1 AND date <= ?2", params![a, b])
}
fn salaries_paid(ctx: &Ctx, p: &Period) -> Res<i64> {
    num(ctx, "SELECT SUM(amount) FROM employee_ledger WHERE type = 'SALARY' AND date >= ?1 AND date <= ?2", params![p.from, p.to])
}

row! {
    pub struct Summary {
        pub sales_revenue: i64,
        pub sales_profit: i64,
        pub repair_revenue: i64,
        pub repair_profit: i64,
        pub service_margin: i64,
        pub expenses: i64,
        pub salaries: i64,
        pub net_profit: i64,
        pub customer_debts: i64,
        pub supplier_debts: i64,
        pub stock_value_cost: i64,
        pub stock_value_sale: i64,
    }
}

/// The KPI cards.
pub fn summary(ctx: &Ctx, p: &Period) -> Res<Summary> {
    let sales = period_profit(ctx, &p.from, &p.to)?;
    let repairs = repair_profit(ctx, &p.from, &p.to)?;
    let services = service_margin(ctx, p)?;
    let expenses = expenses_total(ctx, p)?;
    let salaries = salaries_paid(ctx, p)?;
    Ok(Summary {
        sales_revenue: sales_revenue(ctx, p)?,
        sales_profit: sales,
        repair_revenue: repair_revenue(ctx, p)?,
        repair_profit: repairs,
        service_margin: services,
        expenses,
        salaries,
        net_profit: sales + repairs + services - expenses - salaries,
        customer_debts: customer_balances(ctx)?.values().filter(|b| **b > 0).sum(),
        supplier_debts: list_suppliers(ctx)?.iter().map(|s| s.balance.max(0)).sum(),
        stock_value_cost: num(ctx, "SELECT SUM(cost) FROM phone_units WHERE status = 'IN_STOCK' AND deleted_at IS NULL", [])?
            + num(ctx, "SELECT SUM(quantity * avg_cost) FROM products WHERE kind = 'ITEM' AND deleted_at IS NULL AND quantity > 0", [])?,
        stock_value_sale: num(ctx, "SELECT SUM(sale_price) FROM phone_units WHERE status = 'IN_STOCK' AND deleted_at IS NULL", [])?
            + num(ctx, "SELECT SUM(quantity * sale_price) FROM products WHERE kind = 'ITEM' AND deleted_at IS NULL AND quantity > 0", [])?,
    })
}

// ---------- daily series ----------

type DayMap = HashMap<String, i64>;

fn by_day(ctx: &Ctx, sql: &str, params: impl Params) -> Res<DayMap> {
    let mut stmt = ctx.db.prepare_cached(sql)?;
    let rows = stmt.query_map(params, |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get::<_, Option<i64>>(1)?.unwrap_or(0))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn add(a: DayMap, b: &DayMap, sign: i64) -> DayMap {
    let mut out = a;
    for (k, v) in b {
        *out.entry(k.clone()).or_insert(0) += sign * v;
    }
    out
}

fn daily_map(ctx: &Ctx, metric: &str, p: &Period) -> Res<DayMap> {
    let (a, b) = day_range(p);
    let pp = params![p.from, p.to];
    Ok(match metric {
        "salesRevenue" => add(
            by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(subtotal - discount) FROM sales WHERE date >= ?1 AND date <= ?2 GROUP BY day", pp)?,
            &by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(returned_value) FROM sale_returns WHERE date >= ?1 AND date <= ?2 GROUP BY day", pp)?,
            -1,
        ),
        "salesProfit" => {
            let lines = by_day(
                ctx,
                "SELECT date(s.date, 'localtime') AS day, SUM(l.unit_price * l.quantity - l.discount - l.unit_cost_at_sale * l.quantity)
                 FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.date >= ?1 AND s.date <= ?2 GROUP BY day",
                pp,
            )?;
            let discounts = by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(discount) FROM sales WHERE date >= ?1 AND date <= ?2 GROUP BY day", pp)?;
            let returned = by_day(
                ctx,
                &format!(
                    "SELECT date(r.date, 'localtime') AS day, SUM({IMPACT}) FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id JOIN sale_lines sl ON sl.id = rl.sale_line_id
                     WHERE r.date >= ?1 AND r.date <= ?2 GROUP BY day"
                ),
                pp,
            )?;
            add(add(lines, &discounts, -1), &returned, -1)
        }
        "repairRevenue" => by_day(
            ctx,
            &format!("SELECT date(closed_at, 'localtime') AS day, SUM(COALESCE(final_price, 0)) FROM repairs WHERE status IN {CLOSED} AND closed_at >= ?1 AND closed_at <= ?2 GROUP BY day"),
            pp,
        )?,
        "repairProfit" => by_day(
            ctx,
            &format!(
                "SELECT date(r.closed_at, 'localtime') AS day,
                        SUM(COALESCE(r.final_price, 0) - COALESCE((SELECT SUM(rp.quantity * rp.unit_cost_at_use) FROM repair_parts rp WHERE rp.repair_id = r.id), 0))
                 FROM repairs r WHERE r.status IN {CLOSED} AND r.closed_at >= ?1 AND r.closed_at <= ?2 GROUP BY day"
            ),
            pp,
        )?,
        "serviceMargin" => by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(margin) FROM service_sales WHERE date >= ?1 AND date <= ?2 GROUP BY day", pp)?,
        "expenses" => by_day(ctx, "SELECT date AS day, SUM(amount) FROM expenses WHERE date >= ?1 AND date <= ?2 GROUP BY day", params![a, b])?,
        "salaries" => by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(amount) FROM employee_ledger WHERE type = 'SALARY' AND date >= ?1 AND date <= ?2 GROUP BY day", pp)?,
        _ => DayMap::new(),
    })
}

row! { pub struct DayValue { pub day: String, pub value: i64 } }

pub fn daily_series(ctx: &Ctx, metric: &str, p: &Period) -> Res<Vec<DayValue>> {
    let map = if metric == "netProfit" {
        let gains = add(add(daily_map(ctx, "salesProfit", p)?, &daily_map(ctx, "repairProfit", p)?, 1), &daily_map(ctx, "serviceMargin", p)?, 1);
        let costs = add(daily_map(ctx, "expenses", p)?, &daily_map(ctx, "salaries", p)?, 1);
        add(gains, &costs, -1)
    } else {
        daily_map(ctx, metric, p)?
    };
    Ok(days_in(p).into_iter().map(|day| DayValue { value: map.get(&day).copied().unwrap_or(0), day }).collect())
}

// ---------- detail tables ----------

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize, ts_rs::TS)]
pub struct DetailRow {
    pub id: String,
    #[ts(type = "'SALE' | 'RETURN' | 'REPAIR' | 'SERVICE' | 'EXPENSE' | 'SALARY' | 'DAY'")]
    pub kind: String,
    /// ISO instant, or a local day for DAY and EXPENSE rows.
    pub date: String,
    pub label: String,
    pub detail: String,
    pub value: i64,
    pub link: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parts: Option<BTreeMap<String, i64>>,
}

fn detail(id: String, kind: &str, date: String, label: String, detail: String, value: i64, link: Option<String>) -> DetailRow {
    DetailRow { id, kind: kind.into(), date, label, detail, value, link, parts: None }
}

#[derive(serde::Deserialize)]
struct Raw {
    id: String,
    date: Option<String>,
    a: Option<String>,
    b: Option<String>,
    c: Option<String>,
    d: Option<String>,
    value: i64,
}

/// The rows behind a metric: what adds up to its card.
pub fn detail_rows(ctx: &Ctx, metric: &str, p: &Period) -> Res<Vec<DetailRow>> {
    let (a, b) = day_range(p);
    let q = |sql: &str, args: &[&str]| -> Res<Vec<Raw>> { ctx.db.all(sql, rusqlite::params_from_iter(args.iter())) };
    let s = |v: Option<String>| v.unwrap_or_default();
    let mut rows: Vec<DetailRow> = Vec::new();
    match metric {
        "salesRevenue" | "salesProfit" => {
            let profit = metric == "salesProfit";
            let value = if profit {
                "(SELECT COALESCE(SUM(l.unit_price * l.quantity - l.discount - l.unit_cost_at_sale * l.quantity), 0) FROM sale_lines l WHERE l.sale_id = s.id) - s.discount"
            } else {
                "s.subtotal - s.discount"
            };
            for r in q(
                &format!("SELECT s.id, s.date, s.receipt_number AS a, c.name AS b, NULL AS c, NULL AS d, {value} AS value FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.date >= ?1 AND s.date <= ?2"),
                &[&p.from, &p.to],
            )? {
                rows.push(detail(r.id.clone(), "SALE", s(r.date), s(r.a), s(r.b), r.value, Some(format!("/sell/sales/{}", r.id))));
            }
            let rvalue = if profit {
                format!("(SELECT COALESCE(SUM({IMPACT}), 0) FROM sale_return_lines rl JOIN sale_lines sl ON sl.id = rl.sale_line_id WHERE rl.return_id = r.id)")
            } else {
                "r.returned_value".to_owned()
            };
            for r in q(
                &format!("SELECT r.id, r.date, s.receipt_number AS a, s.id AS b, NULL AS c, NULL AS d, {rvalue} AS value FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE r.date >= ?1 AND r.date <= ?2"),
                &[&p.from, &p.to],
            )? {
                rows.push(detail(r.id, "RETURN", s(r.date), s(r.a), String::new(), -r.value, Some(format!("/sell/sales/{}", s(r.b)))));
            }
        }
        "repairRevenue" | "repairProfit" => {
            let minus = if metric == "repairProfit" { "- COALESCE((SELECT SUM(rp.quantity * rp.unit_cost_at_use) FROM repair_parts rp WHERE rp.repair_id = r.id), 0)" } else { "" };
            for r in q(
                &format!(
                    "SELECT r.id, r.closed_at AS date, r.ticket_number AS a, c.name AS b, r.brand AS c, r.model AS d, COALESCE(r.final_price, 0) {minus} AS value
                     FROM repairs r JOIN customers c ON c.id = r.customer_id WHERE r.status IN {CLOSED} AND r.closed_at >= ?1 AND r.closed_at <= ?2"
                ),
                &[&p.from, &p.to],
            )? {
                let device: Vec<String> = [s(r.c), s(r.d)].into_iter().filter(|x| !x.is_empty()).collect();
                rows.push(detail(r.id.clone(), "REPAIR", s(r.date), s(r.a), format!("{} · {}", s(r.b), device.join(" ")), r.value, Some(format!("/repairs/{}", r.id))));
            }
        }
        "serviceMargin" => {
            for r in q(
                "SELECT s.id, s.date, v.name AS a, s.phone_number AS b, NULL AS c, NULL AS d, s.margin AS value FROM service_sales s JOIN services v ON v.id = s.service_id WHERE s.date >= ?1 AND s.date <= ?2",
                &[&p.from, &p.to],
            )? {
                rows.push(detail(r.id, "SERVICE", s(r.date), s(r.a), s(r.b), r.value, Some("/finance?tab=services".into())));
            }
        }
        "expenses" => {
            for r in q(
                "SELECT e.id, e.date, e.buyer AS a, c.name AS b, NULL AS c, NULL AS d, e.amount AS value FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.date >= ?1 AND e.date <= ?2",
                &[&a, &b],
            )? {
                rows.push(detail(r.id, "EXPENSE", s(r.date), s(r.a), s(r.b), r.value, Some("/finance?tab=expenses".into())));
            }
        }
        "salaries" => {
            for r in q(
                "SELECT l.id, l.date, e.name AS a, e.id AS b, l.note AS c, NULL AS d, l.amount AS value FROM employee_ledger l JOIN employees e ON e.id = l.employee_id WHERE l.type = 'SALARY' AND l.date >= ?1 AND l.date <= ?2",
                &[&p.from, &p.to],
            )? {
                rows.push(detail(r.id, "SALARY", s(r.date), s(r.a), s(r.c), r.value, Some(format!("/people/employees/{}", s(r.b)))));
            }
        }
        _ => {
            // Net profit: one row per day, with what it is made of.
            let mut parts: Vec<(&str, DayMap)> = Vec::new();
            for m in ["salesProfit", "repairProfit", "serviceMargin", "expenses", "salaries"] {
                parts.push((m, daily_map(ctx, m, p)?));
            }
            for d in daily_series(ctx, "netProfit", p)? {
                let mut row = detail(d.day.clone(), "DAY", d.day.clone(), d.day.clone(), String::new(), d.value, None);
                row.parts = Some(parts.iter().map(|(m, map)| (m.to_string(), map.get(&d.day).copied().unwrap_or(0))).collect());
                rows.push(row);
            }
        }
    }
    rows.sort_by(|x, y| y.date.cmp(&x.date));
    Ok(rows)
}

// ---------- reports ----------

/// Ready-made tables. Money is in centimes; each report names its columns so the screen, the print and the Excel
/// export agree. `days` and `age` columns are plain numbers.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize, ts_rs::TS)]
pub struct Report {
    pub columns: Vec<String>,
    pub money: Vec<String>,
    #[ts(type = "(string | number | null)[][]")]
    pub rows: Vec<Vec<Value>>,
}

fn table(ctx: &Ctx, sql: &str, args: &[&str]) -> Res<Vec<Vec<Value>>> {
    let mut stmt = ctx.db.prepare_cached(sql)?;
    let n = stmt.column_count();
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter()), |r| {
        (0..n)
            .map(|i| {
                Ok(match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(v) => json!(v),
                    rusqlite::types::ValueRef::Real(v) => json!(v),
                    rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    rusqlite::types::ValueRef::Blob(_) => Value::Null,
                })
            })
            .collect::<Result<Vec<Value>, rusqlite::Error>>()
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn cols(c: &[&str]) -> Vec<String> {
    c.iter().map(|s| s.to_string()).collect()
}

pub fn report(ctx: &Ctx, r: &ReportInput) -> Res<Report> {
    let line_profit = "l.unit_price * l.quantity - l.discount - l.unit_cost_at_sale * l.quantity";
    let (f, t) = (r.from.as_str(), r.to.as_str());
    Ok(match r.kind.as_str() {
        "bestModels" | "bestAccessories" => {
            let phones = r.kind == "bestModels";
            let rows = table(
                ctx,
                &format!(
                    "SELECT p.name || CASE WHEN p.storage <> '' THEN ' ' || p.storage ELSE '' END AS name, SUM(l.quantity - l.returned_quantity) AS qty,
                            SUM(l.unit_price * l.quantity - l.discount) AS revenue, SUM({line_profit}) AS profit
                     FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
                     WHERE s.date >= ?1 AND s.date <= ?2 AND l.unit_id IS {} GROUP BY p.id ORDER BY qty DESC, revenue DESC LIMIT 100",
                    if phones { "NOT NULL" } else { "NULL" }
                ),
                &[f, t],
            )?;
            Report { columns: cols(&["name", "qty", "revenue", "profit"]), money: cols(&["revenue", "profit"]), rows }
        }
        "profitByBrand" => {
            let rows = table(
                ctx,
                &format!(
                    "SELECT b.name AS brand, SUM(l.quantity) AS qty, SUM(l.unit_price * l.quantity - l.discount) AS revenue, SUM({line_profit}) AS profit
                     FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id LEFT JOIN brands b ON b.id = p.brand_id
                     WHERE s.date >= ?1 AND s.date <= ?2 GROUP BY b.id ORDER BY profit DESC"
                ),
                &[f, t],
            )?;
            Report { columns: cols(&["brand", "qty", "revenue", "profit"]), money: cols(&["revenue", "profit"]), rows }
        }
        "profitByEmployee" => {
            let mut rows = table(
                ctx,
                &format!(
                    "SELECT e.name,
                       (SELECT COUNT(*) FROM sales s WHERE s.employee_id = e.id AND s.date >= ?1 AND s.date <= ?2) AS sales,
                       COALESCE((SELECT SUM({line_profit}) FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE s.employee_id = e.id AND s.date >= ?1 AND s.date <= ?2), 0)
                         - COALESCE((SELECT SUM(s.discount) FROM sales s WHERE s.employee_id = e.id AND s.date >= ?1 AND s.date <= ?2), 0) AS sales_profit,
                       (SELECT COUNT(*) FROM repairs r WHERE r.employee_id = e.id AND r.status = 'DELIVERED' AND r.closed_at >= ?1 AND r.closed_at <= ?2) AS repairs,
                       COALESCE((SELECT SUM(COALESCE(r.final_price, 0) - COALESCE((SELECT SUM(rp.quantity * rp.unit_cost_at_use) FROM repair_parts rp WHERE rp.repair_id = r.id), 0))
                                 FROM repairs r WHERE r.employee_id = e.id AND r.status = 'DELIVERED' AND r.closed_at >= ?1 AND r.closed_at <= ?2), 0) AS repair_profit
                     FROM employees e WHERE e.deleted_at IS NULL ORDER BY e.name"
                ),
                &[f, t],
            )?;
            for row in &mut rows {
                let total = row[2].as_i64().unwrap_or(0) + row[4].as_i64().unwrap_or(0);
                row.push(json!(total));
            }
            Report {
                columns: cols(&["name", "sales", "salesProfit", "repairs", "repairProfit", "total"]),
                money: cols(&["salesProfit", "repairProfit", "total"]),
                rows,
            }
        }
        "slowStock" => {
            let rows = table(
                ctx,
                "SELECT name, imei, condition, days, cost, price FROM (
                   SELECT p.name || CASE WHEN p.storage <> '' THEN ' ' || p.storage ELSE '' END AS name, u.imei1 AS imei, u.condition, u.cost, u.sale_price AS price,
                          CAST(julianday('now') - julianday(COALESCE((SELECT MIN(m.at) FROM stock_movements m WHERE m.unit_id = u.id), u.created_at)) AS INTEGER) AS days
                   FROM phone_units u JOIN products p ON p.id = u.product_id
                   WHERE u.status = 'IN_STOCK' AND u.deleted_at IS NULL ORDER BY days DESC
                 ) WHERE days > ?1",
                &[&r.slow_days.to_string()],
            )?;
            Report { columns: cols(&["name", "imei", "condition", "days", "cost", "price"]), money: cols(&["cost", "price"]), rows }
        }
        "lowStock" => {
            let rows = table(
                ctx,
                "SELECT p.name, c.name AS category, p.quantity, p.low_stock_threshold AS threshold FROM products p JOIN categories c ON c.id = p.category_id
                 WHERE p.kind = 'ITEM' AND p.deleted_at IS NULL AND p.quantity <= p.low_stock_threshold ORDER BY p.quantity, p.name",
                &[],
            )?;
            Report { columns: cols(&["name", "category", "quantity", "threshold"]), money: vec![], rows }
        }
        _ => {
            // debtsAgeing
            let mut names: HashMap<String, String> = HashMap::new();
            let mut stmt = ctx.db.prepare_cached("SELECT id, name FROM customers")?;
            for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
                let (id, name) = row?;
                names.insert(id, name);
            }
            let mut per: Vec<(String, [i64; 3])> = Vec::new();
            let now = ctx.now_ms();
            for item in open_items(ctx, None)? {
                let age = (now - parse_ms(&item.date).unwrap_or(now)) as f64 / DAY_MS as f64;
                let bucket = if age <= 30.0 {
                    0
                } else if age <= 60.0 {
                    1
                } else {
                    2
                };
                match per.iter_mut().find(|(id, _)| *id == item.customer_id) {
                    Some((_, b)) => b[bucket] += item.remaining,
                    None => {
                        let mut b = [0; 3];
                        b[bucket] = item.remaining;
                        per.push((item.customer_id, b));
                    }
                }
            }
            let mut rows: Vec<Vec<Value>> = per
                .into_iter()
                .map(|(id, b)| vec![json!(names.get(&id).cloned().unwrap_or_default()), json!(b[0]), json!(b[1]), json!(b[2]), json!(b[0] + b[1] + b[2])])
                .collect();
            rows.sort_by(|x, y| y[4].as_i64().cmp(&x[4].as_i64()));
            Report { columns: cols(&["name", "bucket1", "bucket2", "bucket3", "total"]), money: cols(&["bucket1", "bucket2", "bucket3", "total"]), rows }
        }
    })
}

// ---------- overview ----------

row! { pub struct OverviewToday { pub sales_total: i64, pub sales_count: i64, pub profit: Option<i64>, pub expected_cash: Option<i64> } }
row! {
    pub struct OverviewAttention {
        pub repairs_ready: i64,
        pub repairs_overdue: i64,
        pub low_stock: i64,
        pub debts_overdue: i64,
        pub debts_overdue_amount: i64,
        pub supplier_balances: i64,
        pub supplier_owed: i64,
    }
}
row! { pub struct Overview { pub today: OverviewToday, pub attention: OverviewAttention, pub week: Vec<DayValue> } }

/// The Overview page. Profit is left out unless `with_profit` (the Finance section is open).
pub fn overview(ctx: &Ctx, with_profit: bool) -> Res<Overview> {
    let today_local = Local::now().date_naive();
    let start = Local.from_local_datetime(&today_local.and_hms_opt(0, 0, 0).unwrap()).earliest().unwrap().with_timezone(&Utc);
    let start_ms = start.timestamp_millis();
    let today = Period { from: iso(start), to: ms_to_iso(start_ms + DAY_MS - 1) };
    let (count, total): (i64, i64) = ctx
        .db
        .prepare_cached("SELECT COUNT(*), COALESCE(SUM(total), 0) FROM sales WHERE date >= ?1 AND date <= ?2")?
        .query_row(params![today.from, today.to], |r| Ok((r.get(0)?, r.get(1)?)))?;
    let cash = current_cash(ctx)?;
    let low_stock = num(ctx, "SELECT COUNT(*) FROM products WHERE kind = 'ITEM' AND deleted_at IS NULL AND quantity <= low_stock_threshold", [])?;
    let customers = customer_overview(ctx, &CustomerFilter::default())?;
    let suppliers: Vec<_> = list_suppliers(ctx)?.into_iter().filter(|s| s.balance > 0).collect();
    let week = Period { from: ms_to_iso(start_ms - 6 * DAY_MS), to: today.to.clone() };
    let per_day =
        by_day(ctx, "SELECT date(date, 'localtime') AS day, SUM(total) FROM sales WHERE date >= ?1 AND date <= ?2 GROUP BY day", params![week.from, week.to])?;
    Ok(Overview {
        today: OverviewToday {
            sales_total: total,
            sales_count: count,
            profit: if with_profit { Some(period_profit(ctx, &today.from, &today.to)?) } else { None },
            expected_cash: cash.map(|c| c.expected),
        },
        attention: OverviewAttention {
            repairs_ready: num(ctx, "SELECT COUNT(*) FROM repairs WHERE status = 'READY'", [])?,
            repairs_overdue: num(
                ctx,
                "SELECT COUNT(*) FROM repairs WHERE status IN ('RECEIVED','DIAGNOSING','WAITING_PARTS','READY') AND due_at IS NOT NULL AND due_at < ?1",
                [crate::util::now()],
            )?,
            low_stock,
            debts_overdue: customers.iter().filter(|c| c.overdue).count() as i64,
            debts_overdue_amount: customers.iter().filter(|c| c.overdue).map(|c| c.balance).sum(),
            supplier_balances: suppliers.len() as i64,
            supplier_owed: suppliers.iter().map(|s| s.balance).sum(),
        },
        week: days_in(&week).into_iter().map(|day| DayValue { value: per_day.get(&day).copied().unwrap_or(0), day }).collect(),
    })
}

row! { pub struct SeriesResult { pub days: Vec<DayValue>, pub rows: Vec<DetailRow> } }

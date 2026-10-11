// Stock counts: walk the shelf with a phone, compare with the system, then (owner) apply.
// Scanning writes only count lines. Applying writes one ADJUSTMENT movement per accessory difference and nothing
// else; phones are never changed automatically: each missing unit is decided one by one (write off or keep).
use super::stock::{write_movement, write_off_unit, Movement};
use super::visibility::costs_visible;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{StockCount, StockCountLine};
use crate::util::{now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;
use serde::Deserialize;
use std::collections::HashMap;

fn get_count(ctx: &Ctx, id: &str) -> Res<StockCount> {
    match ctx.db.get("SELECT * FROM stock_counts WHERE id = ?1", [id])? {
        Some(c) => Ok(c),
        None => bail!("not_found"),
    }
}

fn open_count(ctx: &Ctx, id: &str) -> Res<StockCount> {
    let c = get_count(ctx, id)?;
    if c.status != "OPEN" {
        bail!("count_closed");
    }
    Ok(c)
}

#[derive(Deserialize, Clone)]
struct UnitRow {
    id: String,
    imei1: Option<String>,
    cost: i64,
    sale_price: i64,
    status: String,
    category_id: String,
    name: String,
    storage: String,
    color: String,
}

const UNIT_SQL: &str = "SELECT u.id, u.imei1, u.cost, u.sale_price, u.status, u.product_id, p.category_id, p.name, p.storage, p.color
                        FROM phone_units u JOIN products p ON p.id = u.product_id WHERE u.deleted_at IS NULL";

fn unit_by_id(ctx: &Ctx, id: &str) -> Res<Option<UnitRow>> {
    ctx.db.get(&format!("{UNIT_SQL} AND u.id = ?1"), [id])
}

fn unit_in_scope(c: &StockCount, category_id: &str) -> bool {
    c.scope == "PHONES" || (c.scope == "CATEGORY" && c.category_id.as_deref() == Some(category_id))
}
fn item_in_scope(c: &StockCount, category_id: &str) -> bool {
    c.scope == "ITEMS" || (c.scope == "CATEGORY" && c.category_id.as_deref() == Some(category_id))
}

input! { pub struct CountStartInput { pub scope: String, pub category_id: Option<String> } }
impl Validate for CountStartInput {
    fn validate(&mut self) -> Res<()> {
        valid::one_of(&self.scope, &["PHONES", "ITEMS", "CATEGORY"], "scope")?;
        valid::opt_id(&self.category_id, "categoryId")?;
        valid::check((self.scope == "CATEGORY") == self.category_id.is_some(), "category_required")
    }
}

row! { pub struct CountStarted { pub id: String, pub joined: bool } }

/// Starts a count, or joins the open one for the same scope: two phones can count together.
pub fn start_count(ctx: &Ctx, input: &CountStartInput) -> Res<CountStarted> {
    ctx.tx(|| {
        let category_id = if input.scope == "CATEGORY" { input.category_id.clone() } else { None };
        if let Some(c) = &category_id {
            if !ctx.db.exists("SELECT 1 FROM categories WHERE id = ?1", [c])? {
                bail!("not_found");
            }
        }
        if let Some(id) = ctx.db.opt_val::<String>(
            "SELECT id FROM stock_counts WHERE status = 'OPEN' AND scope = ?1 AND COALESCE(category_id, '') = ?2",
            params![input.scope, category_id.clone().unwrap_or_default()],
        )? {
            return Ok(CountStarted { id, joined: true });
        }
        let id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO stock_counts (id, started_by_device, scope, category_id, status, started_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'OPEN', ?5, ?5, ?5)",
            params![id, ctx.device(), input.scope, category_id, t],
        )?;
        Ok(CountStarted { id, joined: false })
    })
}

row! {
    pub struct ScanUnitView {
        pub id: String,
        pub name: String,
        pub storage: String,
        pub color: String,
        pub imei: Option<String>,
        pub status: String,
    }
}
row! {
    pub struct ScanOutcome {
        #[ts(type = "'counted' | 'already' | 'unexpected'")]
        pub status: String,
        #[ts(type = "'unknown' | 'not_in_stock' | 'out_of_scope' | null")]
        pub reason: Option<String>,
        pub unit: Option<ScanUnitView>,
    }
}

input! { pub struct CountScanInput { pub count_id: String, pub code: String } }
impl Validate for CountScanInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.count_id, "countId")?;
        valid::text(&mut self.code, 1, 40, "code")
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_line(
    ctx: &Ctx,
    count_id: &str,
    unit_id: Option<&str>,
    product_id: Option<&str>,
    code: Option<&str>,
    counted: i64,
    flag: Option<&str>,
    device: Option<&str>,
) -> Res<()> {
    let t = now();
    ctx.db.exec(
        "INSERT INTO stock_count_lines (id, count_id, unit_id, product_id, code, counted_quantity, flag, device_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![uuid(), count_id, unit_id, product_id, code, counted, flag, device, t],
    )?;
    Ok(())
}

/// One phone seen on the shelf. Sending the same scan twice is harmless.
pub fn scan_unit(ctx: &Ctx, count_id: &str, code: &str) -> Res<ScanOutcome> {
    ctx.tx(|| {
        let count = open_count(ctx, count_id)?;
        let unit: Option<UnitRow> = ctx.db.get(&format!("{UNIT_SQL} AND (u.imei1 = ?1 OR u.imei2 = ?1)"), [code])?;
        let Some(unit) = unit else {
            let had = ctx.db.exists("SELECT 1 FROM stock_count_lines WHERE count_id = ?1 AND code = ?2", params![count_id, code])?;
            if !had {
                insert_line(ctx, count_id, None, None, Some(code), 1, Some("unknown"), ctx.device())?;
            }
            return Ok(ScanOutcome { status: if had { "already" } else { "unexpected" }.into(), reason: Some("unknown".into()), unit: None });
        };
        let flag = if unit.status != "IN_STOCK" {
            Some("not_in_stock")
        } else if !unit_in_scope(&count, &unit.category_id) {
            Some("out_of_scope")
        } else {
            None
        };
        let view = ScanUnitView { id: unit.id.clone(), name: unit.name, storage: unit.storage, color: unit.color, imei: unit.imei1, status: unit.status };
        if ctx.db.exists("SELECT 1 FROM stock_count_lines WHERE count_id = ?1 AND unit_id = ?2", params![count_id, unit.id])? {
            return Ok(ScanOutcome { status: "already".into(), reason: flag.map(Into::into), unit: Some(view) });
        }
        insert_line(ctx, count_id, Some(&unit.id), None, None, 1, flag, ctx.device())?;
        Ok(ScanOutcome { status: if flag.is_some() { "unexpected" } else { "counted" }.into(), reason: flag.map(Into::into), unit: Some(view) })
    })
}

input! { pub struct CountItemInput { pub count_id: String, pub product_id: String, pub quantity: i64 } }
impl Validate for CountItemInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.count_id, "countId")?;
        valid::id(&self.product_id, "productId")?;
        valid::range(self.quantity, 0, 1_000_000, "quantity")
    }
}

/// An accessory counted by quantity. Counting it again replaces the number.
pub fn count_item(ctx: &Ctx, count_id: &str, product_id: &str, quantity: i64) -> Res<()> {
    ctx.tx(|| {
        let count = open_count(ctx, count_id)?;
        let Some(category_id) =
            ctx.db.opt_val::<String>("SELECT category_id FROM products WHERE id = ?1 AND kind = 'ITEM' AND deleted_at IS NULL", [product_id])?
        else {
            bail!("not_found")
        };
        if !item_in_scope(&count, &category_id) {
            bail!("count_out_of_scope");
        }
        match ctx.db.opt_val::<String>("SELECT id FROM stock_count_lines WHERE count_id = ?1 AND product_id = ?2", params![count_id, product_id])? {
            Some(id) => {
                ctx.db.exec(
                    "UPDATE stock_count_lines SET counted_quantity = ?1, device_id = ?2, updated_at = ?3 WHERE id = ?4",
                    params![quantity, ctx.device(), now(), id],
                )?;
            }
            None => insert_line(ctx, count_id, None, Some(product_id), None, quantity, None, ctx.device())?,
        }
        Ok(())
    })
}

row! {
    pub struct CountUnitView {
        pub id: String,
        pub name: String,
        pub storage: String,
        pub color: String,
        pub imei: Option<String>,
        pub status: String,
        pub cost: Option<i64>,
        pub sale_price: i64,
    }
}

fn unit_view(u: &UnitRow) -> CountUnitView {
    CountUnitView {
        id: u.id.clone(),
        name: u.name.clone(),
        storage: u.storage.clone(),
        color: u.color.clone(),
        imei: u.imei1.clone(),
        status: u.status.clone(),
        cost: Some(u.cost),
        sale_price: u.sale_price,
    }
}

row! {
    pub struct MissingUnit {
        pub id: String,
        pub name: String,
        pub storage: String,
        pub color: String,
        pub imei: Option<String>,
        pub status: String,
        pub cost: Option<i64>,
        pub sale_price: i64,
        #[ts(type = "'WRITE_OFF' | 'KEEP' | null")]
        pub decision: Option<String>,
    }
}
row! {
    pub struct UnexpectedScan {
        pub code: Option<String>,
        #[ts(type = "'unknown' | 'not_in_stock' | 'out_of_scope'")]
        pub reason: String,
        pub unit: Option<CountUnitView>,
    }
}
row! {
    pub struct ItemDifference {
        pub product_id: String,
        pub name: String,
        pub system: i64,
        pub counted: i64,
        pub difference: i64,
        pub difference_cost: Option<i64>,
    }
}
row! {
    pub struct CountResult {
        pub id: String,
        #[ts(type = "'PHONES' | 'ITEMS' | 'CATEGORY'")]
        pub scope: String,
        pub category_id: Option<String>,
        #[ts(type = "'OPEN' | 'CLOSED'")]
        pub status: String,
        pub applied: bool,
        pub started_at: String,
        pub closed_at: Option<String>,
        pub counted: i64,
        pub items_counted: i64,
        pub missing: Vec<MissingUnit>,
        pub unexpected: Vec<UnexpectedScan>,
        pub differences: Vec<ItemDifference>,
        pub missing_cost: Option<i64>,
        pub difference_cost: Option<i64>,
    }
}

fn lines_of(ctx: &Ctx, count_id: &str) -> Res<Vec<StockCountLine>> {
    ctx.db.all("SELECT * FROM stock_count_lines WHERE count_id = ?1 ORDER BY rowid", [count_id])
}

pub fn result(ctx: &Ctx, count_id: &str) -> Res<CountResult> {
    let count = get_count(ctx, count_id)?;
    let lines = lines_of(ctx, count_id)?;
    let by_unit: HashMap<&str, &StockCountLine> = lines.iter().filter_map(|l| l.unit_id.as_deref().map(|u| (u, l))).collect();
    let open = count.status == "OPEN";

    // Missing: in the system as in stock, not scanned. A closed count has them frozen as lines with quantity 0.
    let missing_rows: Vec<(UnitRow, Option<&StockCountLine>)> = if open {
        let expected: Vec<UnitRow> = ctx.db.all(&format!("{UNIT_SQL} AND u.status = 'IN_STOCK'"), [])?;
        expected.into_iter().filter(|u| unit_in_scope(&count, &u.category_id) && !by_unit.contains_key(u.id.as_str())).map(|u| (u, None)).collect()
    } else {
        let mut v = Vec::new();
        for l in lines.iter().filter(|l| l.unit_id.is_some() && l.counted_quantity == 0) {
            if let Some(u) = unit_by_id(ctx, l.unit_id.as_deref().unwrap())? {
                v.push((u, Some(l)));
            }
        }
        v
    };

    let mut unexpected = Vec::new();
    for l in lines.iter().filter(|l| l.counted_quantity == 1 && l.flag.is_some()) {
        let unit = match &l.unit_id {
            Some(u) => unit_by_id(ctx, u)?.map(|u| unit_view(&u)),
            None => None,
        };
        unexpected.push(UnexpectedScan { code: l.code.clone(), reason: l.flag.clone().unwrap_or_default(), unit });
    }

    let counted = lines.iter().filter(|l| l.unit_id.is_some() && l.counted_quantity == 1 && l.flag.is_none()).count() as i64;
    let mut item_rows = Vec::new();
    for l in lines.iter().filter(|l| l.product_id.is_some()) {
        let pid = l.product_id.clone().unwrap();
        let (name, quantity, avg_cost): (String, i64, i64) = ctx
            .db
            .prepare_cached("SELECT name, quantity, avg_cost FROM products WHERE id = ?1")?
            .query_row([&pid], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let system = if open { quantity } else { l.expected_quantity.unwrap_or(quantity) };
        let difference = l.counted_quantity - system;
        item_rows.push(ItemDifference { product_id: pid, name, system, counted: l.counted_quantity, difference, difference_cost: Some(difference * avg_cost) });
    }
    let items_counted = item_rows.len() as i64;
    let differences: Vec<ItemDifference> = item_rows.into_iter().filter(|r| r.difference != 0).collect();

    let visible = costs_visible(ctx)?;
    let missing_cost = visible.then(|| missing_rows.iter().map(|(u, _)| u.cost).sum::<i64>());
    let difference_cost = visible.then(|| differences.iter().map(|d| d.difference_cost.unwrap_or(0)).sum::<i64>());
    let missing = missing_rows
        .iter()
        .map(|(u, line)| MissingUnit {
            id: u.id.clone(),
            name: u.name.clone(),
            storage: u.storage.clone(),
            color: u.color.clone(),
            imei: u.imei1.clone(),
            status: u.status.clone(),
            cost: visible.then_some(u.cost),
            sale_price: u.sale_price,
            decision: line.and_then(|l| l.decision.clone()),
        })
        .collect();
    Ok(CountResult {
        id: count.id,
        scope: count.scope,
        category_id: count.category_id,
        status: count.status,
        applied: count.applied,
        started_at: count.started_at,
        closed_at: count.closed_at,
        counted,
        items_counted,
        missing,
        unexpected,
        differences: differences
            .into_iter()
            .map(|mut d| {
                if !visible {
                    d.difference_cost = None;
                }
                d
            })
            .collect(),
        missing_cost,
        difference_cost,
    })
}

row! {
    pub struct CountSummary {
        pub id: String,
        #[ts(type = "'PHONES' | 'ITEMS' | 'CATEGORY'")]
        pub scope: String,
        pub category_name: Option<String>,
        #[ts(type = "'OPEN' | 'CLOSED'")]
        pub status: String,
        pub applied: bool,
        pub started_at: String,
        pub closed_at: Option<String>,
        pub started_by: Option<String>,
        pub counted: i64,
        pub missing: i64,
        pub unexpected: i64,
        pub differences: i64,
    }
}

fn name_map(ctx: &Ctx, sql: &str) -> Res<HashMap<String, String>> {
    let mut stmt = ctx.db.prepare_cached(sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn list_counts(ctx: &Ctx) -> Res<Vec<CountSummary>> {
    let names = name_map(ctx, "SELECT id, name FROM mobile_devices")?;
    let categories = name_map(ctx, "SELECT id, name FROM categories")?;
    let counts: Vec<StockCount> = ctx.db.all("SELECT * FROM stock_counts ORDER BY started_at DESC LIMIT 100", [])?;
    counts
        .into_iter()
        .map(|c| {
            let r = result(ctx, &c.id)?;
            Ok(CountSummary {
                category_name: c.category_id.as_ref().and_then(|id| categories.get(id).cloned()),
                started_by: c.started_by_device.as_ref().and_then(|id| names.get(id).cloned()),
                counted: r.counted + r.items_counted,
                missing: r.missing.len() as i64,
                unexpected: r.unexpected.len() as i64,
                differences: r.differences.len() as i64,
                id: c.id,
                scope: c.scope,
                status: c.status,
                applied: c.applied,
                started_at: c.started_at,
                closed_at: c.closed_at,
            })
        })
        .collect()
}

/// Closes the count. With apply, each counted accessory whose system quantity differs is set to the counted
/// quantity (an ADJUSTMENT movement each). Phones are never touched: missing ones become lines to decide on.
pub fn close_count(ctx: &Ctx, count_id: &str, apply: bool) -> Res<CountResult> {
    ctx.tx(|| {
        open_count(ctx, count_id)?;
        let before = result(ctx, count_id)?;
        for m in &before.missing {
            insert_line(ctx, count_id, Some(&m.id), None, None, 0, None, None)?;
        }
        for line in lines_of(ctx, count_id)?.iter().filter(|l| l.product_id.is_some()) {
            let pid = line.product_id.as_deref().unwrap();
            let (quantity, avg_cost): (i64, i64) =
                ctx.db.prepare_cached("SELECT quantity, avg_cost FROM products WHERE id = ?1")?.query_row([pid], |r| Ok((r.get(0)?, r.get(1)?)))?;
            ctx.db.exec("UPDATE stock_count_lines SET expected_quantity = ?1, updated_at = ?2 WHERE id = ?3", params![quantity, now(), line.id])?;
            let delta = line.counted_quantity - quantity;
            if apply && delta != 0 {
                ctx.db.exec("UPDATE products SET quantity = ?1, updated_at = ?2 WHERE id = ?3", params![line.counted_quantity, now(), pid])?;
                write_movement(
                    ctx,
                    Movement {
                        product_id: pid,
                        unit_id: None,
                        kind: "ADJUSTMENT",
                        quantity: delta,
                        unit_cost: avg_cost,
                        reason: "COUNT_CORRECTION",
                        ref_table: Some("stock_counts"),
                        ref_id: Some(count_id),
                        at: None,
                    },
                )?;
            }
        }
        let t = now();
        ctx.db.exec("UPDATE stock_counts SET status = 'CLOSED', closed_at = ?1, applied = ?2, updated_at = ?1 WHERE id = ?3", params![t, apply, count_id])?;
        Ok(())
    })?;
    result(ctx, count_id)
}

input! { pub struct CountDecisionInput { pub count_id: String, pub unit_id: String, pub action: String } }
impl Validate for CountDecisionInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.count_id, "countId")?;
        valid::id(&self.unit_id, "unitId")?;
        valid::one_of(&self.action, &["WRITE_OFF", "KEEP"], "action")
    }
}

/// One missing phone: write it off, or keep it in stock.
pub fn decide_unit(ctx: &Ctx, i: &CountDecisionInput) -> Res<CountResult> {
    ctx.tx(|| {
        let count = get_count(ctx, &i.count_id)?;
        if count.status != "CLOSED" {
            bail!("count_open");
        }
        let line = lines_of(ctx, &i.count_id)?.into_iter().find(|l| l.unit_id.as_deref() == Some(i.unit_id.as_str()) && l.counted_quantity == 0);
        let Some(line) = line.filter(|l| l.decision.is_none()) else { bail!("not_found") };
        if i.action == "WRITE_OFF" {
            write_off_unit(ctx, &i.unit_id, "Stock count")?;
        }
        ctx.db.exec("UPDATE stock_count_lines SET decision = ?1, updated_at = ?2 WHERE id = ?3", params![i.action, now(), line.id])?;
        Ok(())
    })?;
    result(ctx, &i.count_id)
}

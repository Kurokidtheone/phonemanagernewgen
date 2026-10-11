// Stock: phone units (tracked per IMEI) and items (accessories and parts, tracked per quantity).
// Every change to a quantity or a unit status is one transaction that also writes a stock_movements row.
use super::catalog::phone_category_id;
use super::codes::{internal_barcode, is_valid_imei};
use super::settings::{get_value, set_value};
use crate::core::Ctx;
use crate::db::{DbExt, Filter};
use crate::error::{app_with, bail, Res};
use crate::rows::{Product, StockMovement};
use crate::util::{js_round, now, parse_ms, uuid, DAY_MS};
use crate::valid::{self, Validate};
use rusqlite::params;
use serde::{Deserialize, Serialize};

// ---------- models ----------

row! {
    pub struct ModelRow {
        pub id: String,
        pub brand_id: Option<String>,
        pub brand_name: Option<String>,
        pub name: String,
        pub model: String,
        pub storage: String,
        pub color: String,
        pub sale_price: i64,
        pub min_price: i64,
        pub avg_cost: Option<i64>,
    }
}

pub fn list_models(ctx: &Ctx) -> Res<Vec<ModelRow>> {
    ctx.db.all(
        "SELECT p.id, p.brand_id, b.name AS brand_name, p.name, p.model, p.storage, p.color, p.sale_price, p.min_price, p.avg_cost
         FROM products p LEFT JOIN brands b ON b.id = p.brand_id
         WHERE p.kind = 'PHONE_MODEL' AND p.deleted_at IS NULL ORDER BY b.name, p.model",
        [],
    )
}

/// Count and average cost of what is in stock for a model. Called after every unit change.
pub fn recompute_model(ctx: &Ctx, product_id: &str) -> Res<()> {
    let (n, avg): (i64, f64) = ctx
        .db
        .prepare_cached("SELECT count(*), coalesce(avg(cost), 0) FROM phone_units WHERE product_id = ?1 AND status = 'IN_STOCK' AND deleted_at IS NULL")?
        .query_row([product_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    if n > 0 {
        ctx.db.exec("UPDATE products SET quantity = ?1, avg_cost = ?2, updated_at = ?3 WHERE id = ?4", params![n, js_round(avg), now(), product_id])?;
    } else {
        ctx.db.exec("UPDATE products SET quantity = ?1, updated_at = ?2 WHERE id = ?3", params![n, now(), product_id])?;
    }
    Ok(())
}

input! {
    pub struct ModelInput {
        pub brand_id: String,
        pub name: String,
        #[serde(default)]
        pub storage: String,
        #[serde(default)]
        pub color: String,
    }
}
impl Validate for ModelInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.brand_id, "brandId")?;
        valid::text(&mut self.name, 1, 100, "name")?;
        valid::text(&mut self.storage, 0, 30, "storage")?;
        valid::text(&mut self.color, 0, 30, "color")
    }
}

pub fn find_or_create_model(ctx: &Ctx, input: &ModelInput, sale_price: i64, min_price: i64, cost: i64) -> Res<String> {
    let Some(brand_name) = ctx.db.opt_val::<String>("SELECT name FROM brands WHERE id = ?1", [&input.brand_id])? else { bail!("not_found") };
    if let Some(id) = ctx.db.opt_val::<String>(
        "SELECT id FROM products WHERE kind = 'PHONE_MODEL' AND brand_id = ?1 AND model = ?2 AND storage = ?3 AND color = ?4 AND deleted_at IS NULL LIMIT 1",
        params![input.brand_id, input.name, input.storage, input.color],
    )? {
        return Ok(id);
    }
    let id = uuid();
    let t = now();
    ctx.db.exec(
        "INSERT INTO products (id, kind, brand_id, category_id, name, model, storage, color, sale_price, min_price, avg_cost, created_at, updated_at)
         VALUES (?1, 'PHONE_MODEL', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)",
        params![
            id,
            input.brand_id,
            phone_category_id(ctx)?,
            format!("{brand_name} {}", input.name),
            input.name,
            input.storage,
            input.color,
            sale_price,
            min_price,
            cost,
            t
        ],
    )?;
    Ok(id)
}

// ---------- phone units ----------

row! { pub struct Duplicate { pub id: String, pub model: String, pub status: String } }
row! { pub struct ImeiStatus { pub valid: bool, pub duplicate: Option<Duplicate> } }

/// What the UI needs to say about a typed or scanned IMEI.
pub fn imei_status(ctx: &Ctx, imei: &str, exclude: Option<&str>) -> Res<ImeiStatus> {
    let valid = is_valid_imei(imei);
    let duplicate = if valid { find_imei(ctx, imei, exclude)?.map(|c| Duplicate { id: c.id, model: c.name, status: c.status }) } else { None };
    Ok(ImeiStatus { valid, duplicate })
}

#[derive(Deserialize)]
struct ImeiClash {
    id: String,
    status: String,
    name: String,
}

fn find_imei(ctx: &Ctx, imei: &str, exclude: Option<&str>) -> Res<Option<ImeiClash>> {
    ctx.db.get(
        "SELECT u.id, u.status, p.name FROM phone_units u JOIN products p ON p.id = u.product_id
         WHERE u.deleted_at IS NULL AND (u.imei1 = ?1 OR u.imei2 = ?1) AND (?2 IS NULL OR u.id <> ?2) LIMIT 1",
        params![imei, exclude],
    )
}

/// Phones that are bought or added to stock must have an IMEI (only a trade-in may come without).
pub fn check_required_imeis(ctx: &Ctx, imei1: &str, imei2: Option<&str>, exclude: Option<&str>) -> Res<()> {
    if imei1.is_empty() {
        bail!("imei_invalid");
    }
    check_imeis(ctx, Some(imei1), imei2, exclude)
}

pub fn check_imeis(ctx: &Ctx, imei1: Option<&str>, imei2: Option<&str>, exclude: Option<&str>) -> Res<()> {
    let Some(imei1) = imei1.filter(|s| !s.is_empty()) else {
        if imei2.is_some_and(|s| !s.is_empty()) {
            bail!("imei_invalid"); // a second IMEI needs a first
        }
        return Ok(()); // a trade-in phone without an IMEI
    };
    for imei in std::iter::once(imei1).chain(imei2.filter(|s| !s.is_empty())) {
        if !is_valid_imei(imei) {
            bail!("imei_invalid");
        }
        if let Some(clash) = find_imei(ctx, imei, exclude)? {
            return Err(app_with("imei_duplicate", [("model", clash.name.into())]));
        }
    }
    if imei2 == Some(imei1) {
        bail!("imei_invalid");
    }
    Ok(())
}

row! {
    pub struct UnitRow {
        pub id: String,
        pub product_id: String,
        pub brand_id: Option<String>,
        pub brand_name: Option<String>,
        pub name: String,
        pub model: String,
        pub storage: String,
        pub color: String,
        pub imei1: Option<String>,
        pub imei2: Option<String>,
        #[ts(type = "'NEW' | 'USED' | 'REFURBISHED'")]
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub cost: Option<i64>,
        pub sale_price: i64,
        pub min_price: i64,
        pub default_warranty_days: i64,
        #[ts(type = "'IN_STOCK' | 'SOLD' | 'IN_REPAIR' | 'RETURNED' | 'WRITTEN_OFF'")]
        pub status: String,
        pub notes: String,
        pub stocked_at: String,
        #[serde(default)]
        pub age_days: i64,
    }
}

input! {
    #[derive(Default)]
    pub struct UnitFilter {
        pub status: Option<String>,
        pub brand_id: Option<String>,
        pub condition: Option<String>,
    }
}
impl Validate for UnitFilter {
    fn validate(&mut self) -> Res<()> {
        valid::opt_one_of(&self.status, &["IN_STOCK", "SOLD", "IN_REPAIR", "RETURNED", "WRITTEN_OFF"], "status")?;
        valid::opt_one_of(&self.condition, &["NEW", "USED", "REFURBISHED"], "condition")
    }
}

fn unit_rows(ctx: &Ctx, unit_id: Option<&str>, filter: &UnitFilter) -> Res<Vec<UnitRow>> {
    let mut f = Filter::new();
    f.add("u.deleted_at IS NULL");
    if let Some(id) = unit_id {
        f.add_with("u.id = ?", id.to_owned());
    }
    if let Some(v) = &filter.status {
        f.add_with("u.status = ?", v.clone());
    }
    if let Some(v) = &filter.condition {
        f.add_with("u.condition = ?", v.clone());
    }
    if let Some(v) = filter.brand_id.as_ref().filter(|v| !v.is_empty()) {
        f.add_with("p.brand_id = ?", v.clone());
    }
    let sql = format!(
        "SELECT u.id, u.product_id, p.brand_id, b.name AS brand_name, p.name, p.model, p.storage, p.color, u.imei1, u.imei2, u.condition,
                u.battery_health, u.grade, u.cost, u.sale_price, p.min_price, p.default_warranty_days, u.status, u.notes,
                coalesce((SELECT min(m.at) FROM stock_movements m WHERE m.unit_id = u.id), u.created_at) AS stocked_at
         FROM phone_units u JOIN products p ON p.id = u.product_id LEFT JOIN brands b ON b.id = p.brand_id{} ORDER BY u.created_at DESC",
        f.sql()
    );
    let mut rows: Vec<UnitRow> = ctx.db.all(&sql, f.args.params())?;
    let t = ctx.now_ms();
    for r in &mut rows {
        r.age_days = parse_ms(&r.stocked_at).map(|s| ((t - s).div_euclid(DAY_MS)).max(0)).unwrap_or(0);
    }
    Ok(rows)
}

pub fn list_units(ctx: &Ctx, filter: &UnitFilter) -> Res<Vec<UnitRow>> {
    unit_rows(ctx, None, filter)
}

row! {
    pub struct TimelineEvent {
        pub at: String,
        pub kind: String,
        pub reason: String,
        pub party: Option<String>,
        pub r#ref: Option<String>,
    }
}

row! {
    pub struct UnitDetail {
        #[serde(flatten)]
        #[ts(flatten)]
        pub unit: UnitRow,
        pub timeline: Vec<TimelineEvent>,
    }
}

pub fn get_unit(ctx: &Ctx, id: &str) -> Res<UnitDetail> {
    let Some(unit) = unit_rows(ctx, Some(id), &UnitFilter::default())?.into_iter().next() else { bail!("not_found") };
    let movements: Vec<StockMovement> = ctx.db.all("SELECT * FROM stock_movements WHERE unit_id = ?1", [id])?;
    let mut events = Vec::new();
    for m in movements {
        events.push(TimelineEvent {
            party: party_of(ctx, &m.r#type, m.ref_table.as_deref(), m.ref_id.as_deref())?,
            at: m.at,
            kind: m.r#type,
            reason: m.reason,
            r#ref: None,
        });
    }
    // A phone brought in for repair does not move stock, so it comes from the repair itself.
    if let Some(imei) = &unit.imei1 {
        let mut stmt = ctx.db.prepare_cached("SELECT received_at, ticket_number FROM repairs WHERE imei = ?1")?;
        for r in stmt.query_map([imei], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (at, ticket) = r?;
            events.push(TimelineEvent { at, kind: "REPAIR".into(), reason: String::new(), party: None, r#ref: Some(ticket) });
        }
    }
    events.sort_by(|a, b| a.at.cmp(&b.at));
    Ok(UnitDetail { unit, timeline: events })
}

/// Who the other side of a movement was: the supplier of a purchase, the customer of a sale.
fn party_of(ctx: &Ctx, kind: &str, ref_table: Option<&str>, ref_id: Option<&str>) -> Res<Option<String>> {
    let Some(ref_id) = ref_id else { return Ok(None) };
    if kind == "PURCHASE" && ref_table == Some("purchases") {
        return ctx.db.opt_val("SELECT s.name FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?1", [ref_id]);
    }
    if (kind == "SALE" || kind == "RETURN") && ref_table == Some("sales") {
        return ctx.db.opt_val("SELECT c.name FROM sales s JOIN customers c ON c.id = s.customer_id WHERE s.id = ?1", [ref_id]);
    }
    Ok(None)
}

pub const CONDITIONS: &[&str] = &["NEW", "USED", "REFURBISHED"];

input! {
    pub struct UnitAddInput {
        pub imei1: String,
        pub imei2: Option<String>,
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub cost: i64,
        pub sale_price: i64,
        #[serde(default)]
        pub notes: String,
        #[serde(default)]
        pub min_price: i64,
        pub product_id: Option<String>,
        pub model: Option<ModelInput>,
    }
}
impl Validate for UnitAddInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.imei1, 0, 40, "imei1")?;
        valid::opt_text(&mut self.imei2, 40, "imei2")?;
        valid::one_of(&self.condition, CONDITIONS, "condition")?;
        if let Some(b) = self.battery_health {
            valid::range(b, 0, 100, "batteryHealth")?;
        }
        valid::opt_text(&mut self.grade, 10, "grade")?;
        valid::centimes(self.cost, "cost")?;
        valid::pos_centimes(self.sale_price, "salePrice")?;
        valid::text(&mut self.notes, 0, 500, "notes")?;
        valid::centimes(self.min_price, "minPrice")?;
        valid::opt_id(&self.product_id, "productId")?;
        if let Some(m) = &mut self.model {
            m.validate()?;
        }
        valid::check(self.product_id.is_some() != self.model.is_some(), "model_required")
    }
}

row! { pub struct UnitAdded { pub id: String, pub product_id: String } }

#[allow(clippy::too_many_arguments)]
pub fn insert_unit(
    ctx: &Ctx,
    product_id: &str,
    imei1: Option<&str>,
    imei2: Option<&str>,
    condition: &str,
    battery_health: Option<i64>,
    grade: Option<&str>,
    cost: i64,
    sale_price: i64,
    status: &str,
    notes: &str,
    source_line: Option<&str>,
) -> Res<String> {
    let id = uuid();
    let t = now();
    let new = condition == "NEW";
    ctx.db.exec(
        "INSERT INTO phone_units (id, product_id, imei1, imei2, condition, battery_health, grade, cost, sale_price, status, notes, source_purchase_line_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            id,
            product_id,
            imei1,
            imei2,
            condition,
            if new { None } else { battery_health },
            if new { None } else { grade },
            cost,
            sale_price,
            status,
            notes,
            source_line,
            t
        ],
    )?;
    Ok(id)
}

pub fn add_unit(ctx: &Ctx, input: &UnitAddInput) -> Res<UnitAdded> {
    ctx.tx(|| {
        check_required_imeis(ctx, &input.imei1, input.imei2.as_deref(), None)?;
        let product_id = if let Some(pid) = &input.product_id {
            match ctx.db.opt_val::<String>("SELECT id FROM products WHERE id = ?1 AND kind = 'PHONE_MODEL' AND deleted_at IS NULL", [pid])? {
                Some(id) => id,
                None => bail!("not_found"),
            }
        } else {
            find_or_create_model(ctx, input.model.as_ref().unwrap(), input.sale_price, input.min_price, input.cost)?
        };
        let id = insert_unit(
            ctx,
            &product_id,
            Some(&input.imei1),
            input.imei2.as_deref(),
            &input.condition,
            input.battery_health,
            input.grade.as_deref(),
            input.cost,
            input.sale_price,
            "IN_STOCK",
            &input.notes,
            None,
        )?;
        write_movement(
            ctx,
            Movement {
                product_id: &product_id,
                unit_id: Some(&id),
                kind: "ADJUSTMENT",
                quantity: 1,
                unit_cost: input.cost,
                reason: "MANUAL_ENTRY",
                ref_table: Some("phone_units"),
                ref_id: Some(&id),
                at: None,
            },
        )?;
        recompute_model(ctx, &product_id)?;
        Ok(UnitAdded { id, product_id })
    })
}

input! {
    pub struct UnitUpdateInput {
        pub id: String,
        pub imei1: Option<String>,
        pub imei2: Option<String>,
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub cost: Option<i64>,
        pub sale_price: i64,
        #[serde(default)]
        pub notes: String,
    }
}
impl Validate for UnitUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::opt_text(&mut self.imei1, 40, "imei1")?;
        valid::opt_text(&mut self.imei2, 40, "imei2")?;
        valid::one_of(&self.condition, CONDITIONS, "condition")?;
        if let Some(b) = self.battery_health {
            valid::range(b, 0, 100, "batteryHealth")?;
        }
        valid::opt_text(&mut self.grade, 10, "grade")?;
        if let Some(c) = self.cost {
            valid::centimes(c, "cost")?;
        }
        valid::pos_centimes(self.sale_price, "salePrice")?;
        valid::text(&mut self.notes, 0, 500, "notes")
    }
}

fn live_unit(ctx: &Ctx, id: &str) -> Res<Option<crate::rows::PhoneUnit>> {
    ctx.db.get("SELECT * FROM phone_units WHERE id = ?1 AND deleted_at IS NULL", [id])
}

pub fn update_unit(ctx: &Ctx, input: &UnitUpdateInput) -> Res<()> {
    ctx.tx(|| {
        let Some(unit) = live_unit(ctx, &input.id)? else { bail!("not_found") };
        // A phone that has an IMEI keeps one: it can be corrected, not removed. One that came without can get it later.
        if input.imei1.is_none() && unit.imei1.is_some() {
            bail!("imei_invalid");
        }
        check_imeis(ctx, input.imei1.as_deref(), input.imei2.as_deref(), Some(&unit.id))?;
        let new = input.condition == "NEW";
        ctx.db.exec(
            "UPDATE phone_units SET imei1 = ?1, imei2 = ?2, condition = ?3, battery_health = ?4, grade = ?5, cost = ?6, sale_price = ?7, notes = ?8, updated_at = ?9 WHERE id = ?10",
            params![
                input.imei1,
                input.imei2,
                input.condition,
                if new { None } else { input.battery_health },
                if new { None } else { input.grade.clone() },
                input.cost.unwrap_or(unit.cost),
                input.sale_price,
                input.notes,
                now(),
                unit.id
            ],
        )?;
        recompute_model(ctx, &unit.product_id)
    })
}

input! { pub struct UnitPriceInput { pub id: String, pub sale_price: i64 } }
impl Validate for UnitPriceInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::pos_centimes(self.sale_price, "salePrice")
    }
}

pub fn set_unit_price(ctx: &Ctx, id: &str, sale_price: i64) -> Res<()> {
    if ctx.db.exec("UPDATE phone_units SET sale_price = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL", params![sale_price, now(), id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

input! { pub struct UnitWriteOffInput { pub id: String, pub reason: String } }
impl Validate for UnitWriteOffInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::text(&mut self.reason, 1, 200, "reason")
    }
}

pub fn write_off_unit(ctx: &Ctx, id: &str, reason: &str) -> Res<()> {
    ctx.tx(|| {
        let Some(unit) = live_unit(ctx, id)? else { bail!("not_found") };
        if unit.status != "IN_STOCK" {
            bail!("unit_not_in_stock");
        }
        ctx.db.exec("UPDATE phone_units SET status = 'WRITTEN_OFF', updated_at = ?1 WHERE id = ?2", params![now(), id])?;
        write_movement(
            ctx,
            Movement {
                product_id: &unit.product_id,
                unit_id: Some(id),
                kind: "WRITE_OFF",
                quantity: -1,
                unit_cost: unit.cost,
                reason,
                ref_table: Some("phone_units"),
                ref_id: Some(id),
                at: None,
            },
        )?;
        recompute_model(ctx, &unit.product_id)
    })
}

pub struct Movement<'a> {
    pub product_id: &'a str,
    pub unit_id: Option<&'a str>,
    pub kind: &'a str,
    pub quantity: i64,
    pub unit_cost: i64,
    pub reason: &'a str,
    pub ref_table: Option<&'a str>,
    pub ref_id: Option<&'a str>,
    pub at: Option<&'a str>,
}

pub fn write_movement(ctx: &Ctx, m: Movement) -> Res<()> {
    let t = now();
    let at = crate::util::event_now();
    ctx.db.exec(
        "INSERT INTO stock_movements (id, product_id, unit_id, type, quantity, unit_cost, reason, ref_table, ref_id, at, employee_id, via, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![uuid(), m.product_id, m.unit_id, m.kind, m.quantity, m.unit_cost, m.reason, m.ref_table, m.ref_id, m.at.map(str::to_owned).unwrap_or(at), ctx.actor(), ctx.via(), t],
    )?;
    Ok(())
}

// ---------- items (accessories and parts) ----------

input! {
    #[derive(Default)]
    pub struct ItemFilter {
        pub category_id: Option<String>,
        pub low_stock_only: Option<bool>,
        pub repair_parts_only: Option<bool>,
    }
}
impl Validate for ItemFilter {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}

row! {
    pub struct ItemRow {
        pub id: String,
        pub name: String,
        pub category_id: String,
        pub category_name: String,
        pub brand_id: Option<String>,
        pub brand_name: Option<String>,
        pub barcode: Option<String>,
        pub quantity: i64,
        pub avg_cost: Option<i64>,
        pub sale_price: i64,
        pub min_price: i64,
        pub low_stock_threshold: i64,
        pub default_warranty_days: i64,
        pub is_repair_part: bool,
        pub is_low: bool,
    }
}

pub fn list_items(ctx: &Ctx, filter: &ItemFilter) -> Res<Vec<ItemRow>> {
    let mut f = Filter::new();
    f.add("p.kind = 'ITEM'").add("p.deleted_at IS NULL");
    if let Some(v) = filter.category_id.as_ref().filter(|v| !v.is_empty()) {
        f.add_with("p.category_id = ?", v.clone());
    }
    if filter.low_stock_only == Some(true) {
        f.add("p.quantity <= p.low_stock_threshold");
    }
    if filter.repair_parts_only == Some(true) {
        f.add("p.is_repair_part = 1");
    }
    let sql = format!(
        "SELECT p.id, p.name, p.category_id, c.name AS category_name, p.brand_id, b.name AS brand_name, p.barcode, p.quantity, p.avg_cost,
                p.sale_price, p.min_price, p.low_stock_threshold, p.default_warranty_days, p.is_repair_part,
                (p.quantity <= p.low_stock_threshold) AS is_low
         FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id{} ORDER BY p.name",
        f.sql()
    );
    ctx.db.all(&sql, f.args.params())
}

pub fn get_item(ctx: &Ctx, id: &str) -> Res<ItemRow> {
    match list_items(ctx, &ItemFilter::default())?.into_iter().find(|i| i.id == id) {
        Some(i) => Ok(i),
        None => bail!("not_found"),
    }
}

input! {
    pub struct ItemInput {
        pub name: String,
        pub category_id: String,
        pub brand_id: Option<String>,
        pub barcode: Option<String>,
        pub sale_price: i64,
        #[serde(default)]
        pub min_price: i64,
        #[serde(default)]
        pub avg_cost: i64,
        #[serde(default)]
        pub low_stock_threshold: i64,
        #[serde(default)]
        pub default_warranty_days: i64,
        #[serde(default)]
        pub is_repair_part: bool,
    }
}
impl Validate for ItemInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 120, "name")?;
        valid::id(&self.category_id, "categoryId")?;
        valid::empty_to_none(&mut self.brand_id);
        valid::opt_text(&mut self.barcode, 40, "barcode")?;
        valid::centimes(self.sale_price, "salePrice")?;
        valid::centimes(self.min_price, "minPrice")?;
        valid::centimes(self.avg_cost, "avgCost")?;
        valid::range(self.low_stock_threshold, 0, 100_000, "lowStockThreshold")?;
        valid::range(self.default_warranty_days, 0, 3650, "defaultWarrantyDays")
    }
}

input! {
    pub struct ItemUpdateInput {
        pub id: String,
        pub name: String,
        pub category_id: String,
        pub brand_id: Option<String>,
        pub barcode: Option<String>,
        pub sale_price: i64,
        #[serde(default)]
        pub min_price: i64,
        pub avg_cost: Option<i64>,
        #[serde(default)]
        pub low_stock_threshold: i64,
        #[serde(default)]
        pub default_warranty_days: i64,
        #[serde(default)]
        pub is_repair_part: bool,
    }
}
impl ItemUpdateInput {
    fn as_input(&self, avg_cost: i64) -> ItemInput {
        ItemInput {
            name: self.name.clone(),
            category_id: self.category_id.clone(),
            brand_id: self.brand_id.clone(),
            barcode: self.barcode.clone(),
            sale_price: self.sale_price,
            min_price: self.min_price,
            avg_cost,
            low_stock_threshold: self.low_stock_threshold,
            default_warranty_days: self.default_warranty_days,
            is_repair_part: self.is_repair_part,
        }
    }
}
impl Validate for ItemUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        let mut base = self.as_input(self.avg_cost.unwrap_or(0));
        base.validate()?;
        self.name = base.name;
        self.brand_id = base.brand_id;
        self.barcode = base.barcode;
        Ok(())
    }
}

fn check_item(ctx: &Ctx, input: &ItemInput, exclude: Option<&str>) -> Res<()> {
    let kind: Option<String> = ctx.db.opt_val("SELECT kind FROM categories WHERE id = ?1", [&input.category_id])?;
    if kind.is_none() || kind.as_deref() == Some("PHONE") {
        bail!("not_found");
    }
    if let Some(b) = &input.brand_id {
        if !ctx.db.exists("SELECT 1 FROM brands WHERE id = ?1", [b])? {
            bail!("not_found");
        }
    }
    if let Some(code) = &input.barcode {
        if ctx.db.exists("SELECT 1 FROM products WHERE barcode = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id <> ?2)", params![code, exclude])? {
            bail!("barcode_duplicate");
        }
    }
    Ok(())
}

pub fn create_item(ctx: &Ctx, input: &ItemInput) -> Res<crate::rows::Id> {
    check_item(ctx, input, None)?;
    let id = uuid();
    insert_item(ctx, &id, input)?;
    Ok(crate::rows::Id { id })
}

pub fn insert_item(ctx: &Ctx, id: &str, i: &ItemInput) -> Res<()> {
    let t = now();
    ctx.db.exec(
        "INSERT INTO products (id, kind, brand_id, category_id, name, barcode, sale_price, min_price, avg_cost, low_stock_threshold, is_repair_part, default_warranty_days, created_at, updated_at)
         VALUES (?1, 'ITEM', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![id, i.brand_id, i.category_id, i.name, i.barcode, i.sale_price, i.min_price, i.avg_cost, i.low_stock_threshold, i.is_repair_part, i.default_warranty_days, t],
    )?;
    Ok(())
}

fn live_item(ctx: &Ctx, id: &str) -> Res<Option<Product>> {
    ctx.db.get("SELECT * FROM products WHERE id = ?1 AND kind = 'ITEM' AND deleted_at IS NULL", [id])
}

pub fn update_item(ctx: &Ctx, input: &ItemUpdateInput) -> Res<()> {
    let Some(item) = live_item(ctx, &input.id)? else { bail!("not_found") };
    let fields = input.as_input(input.avg_cost.unwrap_or(item.avg_cost));
    check_item(ctx, &fields, Some(&input.id))?;
    ctx.db.exec(
        "UPDATE products SET brand_id = ?1, category_id = ?2, name = ?3, barcode = ?4, sale_price = ?5, min_price = ?6, avg_cost = ?7,
                low_stock_threshold = ?8, is_repair_part = ?9, default_warranty_days = ?10, updated_at = ?11 WHERE id = ?12",
        params![
            fields.brand_id,
            fields.category_id,
            fields.name,
            fields.barcode,
            fields.sale_price,
            fields.min_price,
            fields.avg_cost,
            fields.low_stock_threshold,
            fields.is_repair_part,
            fields.default_warranty_days,
            now(),
            input.id
        ],
    )?;
    Ok(())
}

/// Soft delete: the item disappears from lists and frees its barcode, but old sales keep pointing at it.
pub fn delete_item(ctx: &Ctx, id: &str) -> Res<()> {
    let t = now();
    if ctx.db.exec("UPDATE products SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND kind = 'ITEM' AND deleted_at IS NULL", params![t, id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

input! { pub struct ItemAdjustInput { pub id: String, pub delta: i64, pub reason: String } }
impl Validate for ItemAdjustInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::check(self.delta != 0 && self.delta.abs() <= 1_000_000, "delta")?;
        valid::one_of(&self.reason, &["COUNT_CORRECTION", "DAMAGED", "LOST"], "reason")
    }
}

pub fn adjust_item(ctx: &Ctx, input: &ItemAdjustInput) -> Res<()> {
    ctx.tx(|| {
        let Some(item) = live_item(ctx, &input.id)? else { bail!("not_found") };
        let next = item.quantity + input.delta;
        if next < 0 {
            bail!("quantity_negative");
        }
        ctx.db.exec("UPDATE products SET quantity = ?1, updated_at = ?2 WHERE id = ?3", params![next, now(), item.id])?;
        write_movement(
            ctx,
            Movement {
                product_id: &item.id,
                unit_id: None,
                kind: "ADJUSTMENT",
                quantity: input.delta,
                unit_cost: item.avg_cost,
                reason: &input.reason,
                ref_table: Some("products"),
                ref_id: Some(&item.id),
                at: None,
            },
        )
    })
}

// ---------- barcodes and scanning ----------

/// Next free internal EAN-13 (starts with 200). The counter is kept in settings.
pub fn generate_barcode(ctx: &Ctx) -> Res<String> {
    ctx.tx(|| {
        let mut counter: i64 = get_value(ctx.db, "barcode.counter")?.unwrap_or(0);
        loop {
            counter += 1;
            let code = internal_barcode(counter);
            if !ctx.db.exists("SELECT 1 FROM products WHERE barcode = ?1 AND deleted_at IS NULL", [&code])? {
                set_value(ctx.db, "barcode.counter", &counter)?;
                return Ok(code);
            }
        }
    })
}

row! { pub struct SearchResult { pub units: Vec<UnitRow>, pub items: Vec<ItemRow> } }

/// Free text over phones (model, brand, IMEI, color) and items (name, barcode, brand).
pub fn search(ctx: &Ctx, query: &str) -> Res<SearchResult> {
    let q = query.trim().to_lowercase();
    let has = |fields: &[Option<&str>]| fields.iter().any(|f| f.is_some_and(|f| !f.is_empty() && f.to_lowercase().contains(&q)));
    let units = list_units(ctx, &UnitFilter::default())?
        .into_iter()
        .filter(|u| has(&[Some(&u.name), u.brand_name.as_deref(), u.imei1.as_deref(), u.imei2.as_deref(), Some(&u.storage), Some(&u.color)]))
        .take(30)
        .collect();
    let items = list_items(ctx, &ItemFilter::default())?
        .into_iter()
        .filter(|i| has(&[Some(&i.name), i.barcode.as_deref(), i.brand_name.as_deref()]))
        .take(30)
        .collect();
    Ok(SearchResult { units, items })
}

#[derive(Debug, Clone, Serialize, ts_rs::TS)]
pub struct Lookup {
    #[ts(type = "'item' | 'unit'")]
    pub r#type: &'static str,
    pub id: String,
}

/// What a scanned code points to: an item by barcode, or a phone unit by either IMEI.
pub fn lookup(ctx: &Ctx, code: &str) -> Res<Option<Lookup>> {
    if let Some(id) = ctx.db.opt_val::<String>("SELECT id FROM products WHERE barcode = ?1 AND kind = 'ITEM' AND deleted_at IS NULL LIMIT 1", [code])? {
        return Ok(Some(Lookup { r#type: "item", id }));
    }
    Ok(find_imei(ctx, code, None)?.map(|u| Lookup { r#type: "unit", id: u.id }))
}

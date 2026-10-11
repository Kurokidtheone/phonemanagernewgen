// Repairs. Every operation that moves stock or money is one transaction with its movement rows.
//
// Flow: RECEIVED -> DIAGNOSING -> WAITING_PARTS -> READY -> DELIVERED; from any open status a ticket can also be
// CANCELLED or UNREPAIRABLE. Open tickets move between open statuses freely, every change goes to repair_status_log.
// Money: the deposit and every payment are customer_payments tied to the repair, so
// remaining = final_price - payments on the repair, and an unpaid remainder is customer debt (balance.rs).
use super::cash::cash;
use super::codes::is_valid_imei;
use super::files::{remove_file, stored_file_path};
use super::purchases::weighted_average;
use super::sales::SALE_METHODS;
use super::settings::get_public;
use super::stock::{write_movement, Movement};
use crate::core::Ctx;
use crate::db::{Args, DbExt};
use crate::error::{app_with, bail, Res};
use crate::rows::{CustomerPayment, Product, Repair};
use crate::util::{ms_to_iso, now, parse_ms, uuid, DAY_MS};
use crate::valid::{self, Validate};
use base64::Engine;
use chrono::Datelike;
use rand::RngCore;
use rusqlite::params;
use serde::{Deserialize, Serialize};

pub const OPEN_STATUSES: &[&str] = &["RECEIVED", "DIAGNOSING", "WAITING_PARTS", "READY"];
pub const STATUSES: &[&str] = &["RECEIVED", "DIAGNOSING", "WAITING_PARTS", "READY", "DELIVERED", "CANCELLED", "UNREPAIRABLE"];
pub const MAX_REPAIR_PHOTOS: i64 = 6;
const ARRIVAL_FLAGS: &[&str] = &["POWERS_ON", "SCREEN_CRACKED", "BACK_CRACKED", "WATER_DAMAGE", "MISSING_PARTS"];
const ACCESSORY_ITEMS: &[&str] = &["SIM", "MEMORY_CARD", "CASE", "CHARGER"];

fn is_open(status: &str) -> bool {
    OPEN_STATUSES.contains(&status)
}

/// Next ticket number of the (local) year: R-2026-00001.
fn next_ticket_number(ctx: &Ctx) -> Res<String> {
    let prefix = format!("R-{}-", chrono::Local::now().year());
    let n: Option<i64> = ctx.db.val(
        "SELECT max(CAST(substr(ticket_number, ?1) AS INTEGER)) FROM repairs WHERE ticket_number LIKE ?2",
        params![prefix.len() as i64 + 1, format!("{prefix}%")],
    )?;
    Ok(format!("{prefix}{:05}", n.unwrap_or(0) + 1))
}

/// What the intake slip's QR code holds. Recognisable on a scanner: PSM- and 12 URL-safe characters.
fn new_token() -> String {
    let mut b = [0u8; 9];
    rand::thread_rng().fill_bytes(&mut b);
    format!("PSM-{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b))
}

fn load(ctx: &Ctx, id: &str) -> Res<Repair> {
    match ctx.db.get("SELECT * FROM repairs WHERE id = ?1", [id])? {
        Some(r) => Ok(r),
        None => bail!("not_found"),
    }
}

fn paid_on(ctx: &Ctx, repair_id: &str) -> Res<i64> {
    ctx.db.val("SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE repair_id = ?1", [repair_id])
}

fn parts_cost(ctx: &Ctx, repair_id: &str) -> Res<i64> {
    ctx.db.val("SELECT COALESCE(SUM(quantity * unit_cost_at_use), 0) FROM repair_parts WHERE repair_id = ?1", [repair_id])
}

fn log(ctx: &Ctx, repair_id: &str, status: &str, note: &str) -> Res<()> {
    let t = crate::util::event_now();
    ctx.db.exec(
        "INSERT INTO repair_status_log (id, repair_id, status, at, note, employee_id, via, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?4, ?4)",
        params![uuid(), repair_id, status, t, note, ctx.actor(), ctx.via()],
    )?;
    Ok(())
}

/// A photo already stored by the PC (uploaded through /files). At most six per repair.
fn store_photo(ctx: &Ctx, repair_id: &str, file_name: &str) -> Res<()> {
    if !stored_file_path(&ctx.core.paths.files_dir(), file_name).exists() {
        bail!("file_not_found");
    }
    let n: i64 = ctx.db.val("SELECT COUNT(*) FROM repair_photos WHERE repair_id = ?1", [repair_id])?;
    if n >= MAX_REPAIR_PHOTOS {
        return Err(app_with("too_many_photos", [("max", MAX_REPAIR_PHOTOS.into())]));
    }
    let t = now();
    ctx.db.exec(
        "INSERT INTO repair_photos (id, repair_id, file_name, taken_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4, ?4)",
        params![uuid(), repair_id, file_name, t],
    )?;
    Ok(())
}

input! { pub struct RepairPhotoInput { pub repair_id: String, pub file_name: String } }
impl Validate for RepairPhotoInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.repair_id, "repairId")?;
        valid::stored_file(&self.file_name, "fileName")
    }
}

pub fn add_photo(ctx: &Ctx, repair_id: &str, file_name: &str) -> Res<()> {
    ctx.tx(|| {
        load(ctx, repair_id)?;
        store_photo(ctx, repair_id, file_name)
    })
}

pub fn remove_photo(ctx: &Ctx, id: &str) -> Res<()> {
    let Some(name) = ctx.db.opt_val::<String>("SELECT file_name FROM repair_photos WHERE id = ?1", [id])? else { bail!("not_found") };
    ctx.db.exec("DELETE FROM repair_photos WHERE id = ?1", [id])?;
    remove_file(ctx, Some(&name));
    Ok(())
}

fn payment(ctx: &Ctx, repair_id: &str, customer_id: &str, amount: i64, method: &str, note: &str, at: &str) -> Res<String> {
    let id = uuid();
    let t = now();
    ctx.db.exec(
        "INSERT INTO customer_payments (id, customer_id, amount, date, method, note, repair_id, group_id, employee_id, via, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?1, ?8, ?9, ?10, ?10)",
        params![id, customer_id, amount, at, method, note, repair_id, ctx.actor(), ctx.via(), t],
    )?;
    Ok(id)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct Arrival {
    #[serde(default)]
    pub flags: Vec<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
pub struct Accessories {
    #[serde(default)]
    pub items: Vec<String>,
    #[serde(default)]
    pub note: String,
}

fn empty_arrival() -> Arrival {
    Arrival { flags: vec![], note: String::new() }
}
fn empty_accessories() -> Accessories {
    Accessories { items: vec![], note: String::new() }
}

input! {
    pub struct RepairInput {
        pub customer_id: String,
        #[serde(default)]
        pub brand: String,
        #[serde(default)]
        pub model: String,
        pub imei: Option<String>,
        pub fault: String,
        #[serde(default = "empty_arrival")]
        pub arrival: Arrival,
        #[serde(default = "empty_accessories")]
        pub accessories: Accessories,
        #[serde(default)]
        pub unlock_note: String,
        #[serde(default)]
        pub estimated_price: i64,
        #[serde(default)]
        pub deposit: i64,
        #[serde(default = "super::sales::cash_method")]
        pub deposit_method: String,
        pub employee_id: Option<String>,
        pub due_at: Option<String>,
        /// Photos of the device already uploaded to the PC (names returned by POST /files).
        #[serde(default)]
        pub photos: Vec<String>,
    }
}
impl Validate for RepairInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.customer_id, "customerId")?;
        valid::text(&mut self.brand, 0, 60, "brand")?;
        valid::text(&mut self.model, 0, 80, "model")?;
        valid::opt_text(&mut self.imei, 40, "imei")?;
        valid::text(&mut self.fault, 1, 300, "fault")?;
        for f in &self.arrival.flags {
            valid::one_of(f, ARRIVAL_FLAGS, "arrival.flags")?;
        }
        valid::text(&mut self.arrival.note, 0, 300, "arrival.note")?;
        for i in &self.accessories.items {
            valid::one_of(i, ACCESSORY_ITEMS, "accessories.items")?;
        }
        valid::text(&mut self.accessories.note, 0, 200, "accessories.note")?;
        valid::text(&mut self.unlock_note, 0, 200, "unlockNote")?;
        valid::centimes(self.estimated_price, "estimatedPrice")?;
        valid::centimes(self.deposit, "deposit")?;
        valid::one_of(&self.deposit_method, SALE_METHODS, "depositMethod")?;
        valid::empty_to_none(&mut self.employee_id);
        valid::opt_datetime(&self.due_at, "dueAt")?;
        valid::max_items(&self.photos, 0, MAX_REPAIR_PHOTOS as usize, "photos")?;
        self.photos.iter().try_for_each(|p| valid::stored_file(p, "photos"))
    }
}

row! { pub struct RepairCreated { pub id: String, pub ticket_number: String, pub qr_token: String } }

pub fn create_repair(ctx: &Ctx, input: &RepairInput) -> Res<RepairCreated> {
    if let Some(imei) = &input.imei {
        if !is_valid_imei(imei) {
            bail!("imei_invalid");
        }
    }
    ctx.tx(|| {
        if !ctx.db.exists("SELECT 1 FROM customers WHERE id = ?1", [&input.customer_id])? {
            bail!("not_found");
        }
        if let Some(e) = &input.employee_id {
            if !ctx.db.exists("SELECT 1 FROM employees WHERE id = ?1", [e])? {
                bail!("not_found");
            }
        }
        let id = uuid();
        let ticket_number = next_ticket_number(ctx)?;
        let qr_token = new_token();
        let received_at = crate::util::event_now();
        ctx.db.exec(
            "INSERT INTO repairs (id, ticket_number, customer_id, employee_id, brand, model, imei, fault, arrival_state, accessories_left, unlock_note,
                                  estimated_price, final_price, deposit, status, received_at, due_at, warranty_days, qr_token, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, ?13, 'RECEIVED', ?14, ?15, 0, ?16, ?14, ?14)",
            params![
                id,
                ticket_number,
                input.customer_id,
                input.employee_id,
                input.brand,
                input.model,
                input.imei,
                input.fault,
                serde_json::to_string(&input.arrival)?,
                serde_json::to_string(&input.accessories)?,
                input.unlock_note,
                input.estimated_price,
                input.deposit,
                received_at,
                input.due_at,
                qr_token
            ],
        )?;
        log(ctx, &id, "RECEIVED", "")?;
        for f in &input.photos {
            store_photo(ctx, &id, f)?;
        }
        if input.deposit > 0 {
            payment(ctx, &id, &input.customer_id, input.deposit, &input.deposit_method, "DEPOSIT", &received_at)?;
            if input.deposit_method == "CASH" {
                cash(ctx, "IN", input.deposit, "REPAIR_DEPOSIT", "repairs", &id, &ticket_number, Some(&received_at))?;
            }
        }
        Ok(RepairCreated { id, ticket_number, qr_token })
    })
}

input! {
    pub struct RepairUpdateInput {
        pub id: String,
        pub fault: String,
        #[serde(default)]
        pub unlock_note: String,
        pub estimated_price: i64,
        pub employee_id: Option<String>,
        pub due_at: Option<String>,
        #[serde(default)]
        pub notes: String,
    }
}
impl Validate for RepairUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::text(&mut self.fault, 1, 300, "fault")?;
        valid::text(&mut self.unlock_note, 0, 200, "unlockNote")?;
        valid::centimes(self.estimated_price, "estimatedPrice")?;
        valid::empty_to_none(&mut self.employee_id);
        valid::opt_datetime(&self.due_at, "dueAt")?;
        valid::text(&mut self.notes, 0, 2000, "notes")
    }
}

pub fn update_repair(ctx: &Ctx, i: &RepairUpdateInput) -> Res<()> {
    let r = load(ctx, &i.id)?;
    if let Some(e) = &i.employee_id {
        if !ctx.db.exists("SELECT 1 FROM employees WHERE id = ?1", [e])? {
            bail!("not_found");
        }
    }
    // Once closed only the internal notes can still be edited.
    if is_open(&r.status) {
        ctx.db.exec(
            "UPDATE repairs SET fault = ?1, unlock_note = ?2, estimated_price = ?3, employee_id = ?4, due_at = ?5, notes = ?6, updated_at = ?7 WHERE id = ?8",
            params![i.fault, i.unlock_note, i.estimated_price, i.employee_id, i.due_at, i.notes, now(), r.id],
        )?;
    } else {
        ctx.db.exec("UPDATE repairs SET notes = ?1, updated_at = ?2 WHERE id = ?3", params![i.notes, now(), r.id])?;
    }
    Ok(())
}

input! {
    pub struct RepairStatusInput {
        pub id: String,
        pub status: String,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for RepairStatusInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::one_of(&self.status, OPEN_STATUSES, "status")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

pub fn set_status(ctx: &Ctx, i: &RepairStatusInput) -> Res<()> {
    ctx.tx(|| {
        let r = load(ctx, &i.id)?;
        if !is_open(&r.status) {
            bail!("repair_closed");
        }
        if r.status == i.status {
            return Ok(());
        }
        ctx.db.exec("UPDATE repairs SET status = ?1, updated_at = ?2 WHERE id = ?3", params![i.status, now(), r.id])?;
        log(ctx, &r.id, &i.status, &i.note)
    })
}

// ---------- parts ----------

input! { pub struct RepairPartInput { pub repair_id: String, pub product_id: String, pub quantity: i64 } }
impl Validate for RepairPartInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.repair_id, "repairId")?;
        valid::id(&self.product_id, "productId")?;
        valid::range(self.quantity, 1, 10_000, "quantity")
    }
}

/// A part leaves stock at its average cost; the cost is stored on the line so later changes do not alter the profit.
pub fn add_part(ctx: &Ctx, i: &RepairPartInput) -> Res<crate::rows::Id> {
    ctx.tx(|| {
        let r = load(ctx, &i.repair_id)?;
        if !is_open(&r.status) {
            bail!("repair_closed");
        }
        let item = ctx.db.get::<Product>("SELECT * FROM products WHERE id = ?1 AND kind = 'ITEM'", [&i.product_id])?;
        let Some(item) = item.filter(|p| p.deleted_at.is_none()) else { bail!("not_found") };
        if i.quantity > item.quantity && !get_public(ctx.db)?.allow_negative_stock {
            return Err(app_with("insufficient_stock", [("name", item.name.clone().into()), ("available", item.quantity.into())]));
        }
        let id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO repair_parts (id, repair_id, product_id, quantity, unit_cost_at_use, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, r.id, item.id, i.quantity, item.avg_cost, t],
        )?;
        ctx.db.exec("UPDATE products SET quantity = ?1, updated_at = ?2 WHERE id = ?3", params![item.quantity - i.quantity, now(), item.id])?;
        write_movement(
            ctx,
            Movement {
                product_id: &item.id,
                unit_id: None,
                kind: "REPAIR_USE",
                quantity: -i.quantity,
                unit_cost: item.avg_cost,
                reason: "",
                ref_table: Some("repairs"),
                ref_id: Some(&r.id),
                at: None,
            },
        )?;
        Ok(crate::rows::Id { id })
    })
}

#[derive(Deserialize)]
struct PartRow {
    id: String,
    repair_id: String,
    product_id: String,
    quantity: i64,
    unit_cost_at_use: i64,
}

/// Put a part back on the shelf, at the cost it left with.
fn restore_part(ctx: &Ctx, part: &PartRow, reason: &str) -> Res<()> {
    let item: Product = ctx.db.get("SELECT * FROM products WHERE id = ?1", [&part.product_id])?.unwrap();
    ctx.db.exec(
        "UPDATE products SET quantity = ?1, avg_cost = ?2, updated_at = ?3 WHERE id = ?4",
        params![item.quantity + part.quantity, weighted_average(item.quantity, item.avg_cost, part.quantity, part.unit_cost_at_use), now(), item.id],
    )?;
    write_movement(
        ctx,
        Movement {
            product_id: &item.id,
            unit_id: None,
            kind: "REPAIR_USE",
            quantity: part.quantity,
            unit_cost: part.unit_cost_at_use,
            reason,
            ref_table: Some("repairs"),
            ref_id: Some(&part.repair_id),
            at: None,
        },
    )?;
    ctx.db.exec("DELETE FROM repair_parts WHERE id = ?1", [&part.id])?;
    Ok(())
}

const PART_COLUMNS: &str = "SELECT id, repair_id, product_id, quantity, unit_cost_at_use FROM repair_parts";

pub fn remove_part(ctx: &Ctx, part_id: &str) -> Res<()> {
    ctx.tx(|| {
        let Some(part) = ctx.db.get::<PartRow>(&format!("{PART_COLUMNS} WHERE id = ?1"), [part_id])? else { bail!("not_found") };
        if !is_open(&load(ctx, &part.repair_id)?.status) {
            bail!("repair_closed");
        }
        restore_part(ctx, &part, "REMOVED")
    })
}

// ---------- closing ----------

input! {
    pub struct RepairDeliverInput {
        pub id: String,
        pub final_price: i64,
        #[serde(default)]
        pub paid: i64,
        #[serde(default = "super::sales::cash_method")]
        pub method: String,
        #[serde(default)]
        pub warranty_days: i64,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for RepairDeliverInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::centimes(self.final_price, "finalPrice")?;
        valid::centimes(self.paid, "paid")?;
        valid::one_of(&self.method, SALE_METHODS, "method")?;
        valid::range(self.warranty_days, 0, 3650, "warrantyDays")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

row! { pub struct DeliverResult { pub remaining: i64, pub warranty_end: Option<String> } }

/// Deliver the device: a final price is required, what is paid now is recorded, the rest is the customer's debt.
pub fn deliver(ctx: &Ctx, i: &RepairDeliverInput) -> Res<DeliverResult> {
    ctx.tx(|| {
        let r = load(ctx, &i.id)?;
        if !is_open(&r.status) {
            bail!("repair_closed");
        }
        let paid_before = paid_on(ctx, &r.id)?;
        if paid_before + i.paid > i.final_price {
            bail!("paid_exceeds_total");
        }
        let at = now();
        ctx.db.exec(
            "UPDATE repairs SET status = 'DELIVERED', final_price = ?1, warranty_days = ?2, delivered_at = ?3, closed_at = ?3, updated_at = ?3 WHERE id = ?4",
            params![i.final_price, i.warranty_days, at, r.id],
        )?;
        log(ctx, &r.id, "DELIVERED", &i.note)?;
        if i.paid > 0 {
            payment(ctx, &r.id, &r.customer_id, i.paid, &i.method, "", &at)?;
            if i.method == "CASH" {
                cash(ctx, "IN", i.paid, "REPAIR_PAYMENT", "repairs", &r.id, &r.ticket_number, Some(&at))?;
            }
        }
        Ok(DeliverResult {
            remaining: i.final_price - paid_before - i.paid,
            warranty_end: (i.warranty_days > 0).then(|| ms_to_iso(parse_ms(&at).unwrap_or(0) + i.warranty_days * DAY_MS)),
        })
    })
}

input! {
    pub struct RepairCancelInput {
        pub id: String,
        pub status: String,
        /// A diagnosis fee, or 0.
        #[serde(default)]
        pub fee: i64,
        /// true: give the deposit back (less the fee). false: keep it, as the fee.
        pub refund_deposit: bool,
        #[serde(default)]
        pub note: String,
    }
}
impl Validate for RepairCancelInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::one_of(&self.status, &["CANCELLED", "UNREPAIRABLE"], "status")?;
        valid::centimes(self.fee, "fee")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

row! { pub struct CancelResult { pub fee: i64, pub refund: i64, pub remaining: i64 } }

/// CANCELLED or UNREPAIRABLE. Parts go back to stock. The final price is a diagnosis fee (or 0). The deposit is
/// either refunded (less the fee), or kept: then it counts as the fee (the larger of the two).
pub fn cancel(ctx: &Ctx, i: &RepairCancelInput) -> Res<CancelResult> {
    ctx.tx(|| {
        let r = load(ctx, &i.id)?;
        if !is_open(&r.status) {
            bail!("repair_closed");
        }
        let parts: Vec<PartRow> = ctx.db.all(&format!("{PART_COLUMNS} WHERE repair_id = ?1"), [&r.id])?;
        for p in &parts {
            restore_part(ctx, p, "CANCELLED")?;
        }
        let paid = paid_on(ctx, &r.id)?;
        let at = now();
        let mut fee = i.fee;
        let mut refund = 0;
        if i.refund_deposit {
            refund = (paid - fee).max(0);
        } else {
            fee = fee.max(paid);
        }
        if refund > 0 {
            payment(ctx, &r.id, &r.customer_id, -refund, "CASH", "REFUND", &at)?; // a negative payment: the deposit going back out
            cash(ctx, "OUT", refund, "REPAIR_REFUND", "repairs", &r.id, &r.ticket_number, Some(&at))?;
        }
        ctx.db.exec("UPDATE repairs SET status = ?1, final_price = ?2, closed_at = ?3, updated_at = ?3 WHERE id = ?4", params![i.status, fee, at, r.id])?;
        log(ctx, &r.id, &i.status, &i.note)?;
        Ok(CancelResult { fee, refund, remaining: fee - (paid - refund) })
    })
}

// ---------- reading ----------

input! {
    #[derive(Default)]
    pub struct RepairFilter {
        pub status: Option<String>,
        pub employee_id: Option<String>,
        pub from: Option<String>,
        pub to: Option<String>,
        pub overdue: Option<bool>,
        /// The board: every open ticket plus those delivered since this moment.
        pub board_since: Option<String>,
    }
}
impl Validate for RepairFilter {
    fn validate(&mut self) -> Res<()> {
        valid::opt_one_of(&self.status, STATUSES, "status")?;
        valid::opt_datetime(&self.from, "from")?;
        valid::opt_datetime(&self.to, "to")?;
        valid::opt_datetime(&self.board_since, "boardSince")
    }
}

row! {
    pub struct RepairRow {
        pub id: String,
        pub ticket_number: String,
        #[ts(type = "'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE'")]
        pub status: String,
        pub customer_id: String,
        pub customer_name: String,
        pub customer_phone: String,
        pub brand: String,
        pub model: String,
        pub imei: Option<String>,
        pub fault: String,
        pub received_at: String,
        pub due_at: Option<String>,
        pub delivered_at: Option<String>,
        pub estimated_price: i64,
        pub final_price: Option<i64>,
        pub employee_id: Option<String>,
        pub technician_name: Option<String>,
        pub paid: i64,
        #[serde(default)]
        pub overdue: bool,
    }
}

pub fn list_repairs(ctx: &Ctx, filter: &RepairFilter) -> Res<Vec<RepairRow>> {
    let mut conds: Vec<&str> = Vec::new();
    let mut args = Args::new();
    let t = now();
    if let Some(v) = &filter.status {
        conds.push("r.status = ?");
        args.push(v.clone());
    }
    if let Some(v) = filter.employee_id.as_ref().filter(|v| !v.is_empty()) {
        conds.push("r.employee_id = ?");
        args.push(v.clone());
    }
    if let Some(v) = &filter.from {
        conds.push("r.received_at >= ?");
        args.push(v.clone());
    }
    if let Some(v) = &filter.to {
        conds.push("r.received_at <= ?");
        args.push(v.clone());
    }
    if filter.overdue == Some(true) {
        conds.push("r.due_at IS NOT NULL AND r.due_at < ? AND r.status IN ('RECEIVED','DIAGNOSING','WAITING_PARTS','READY')");
        args.push(t.clone());
    }
    if let Some(v) = &filter.board_since {
        conds.push("(r.status IN ('RECEIVED','DIAGNOSING','WAITING_PARTS','READY') OR (r.status = 'DELIVERED' AND r.delivered_at >= ?))");
        args.push(v.clone());
    }
    let sql = format!(
        "SELECT r.id, r.ticket_number, r.status, r.customer_id, c.name AS customer_name, c.phone AS customer_phone, r.brand, r.model, r.imei, r.fault,
                r.received_at, r.due_at, r.delivered_at, r.estimated_price, r.final_price, r.employee_id, e.name AS technician_name,
                COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.repair_id = r.id), 0) AS paid
         FROM repairs r JOIN customers c ON c.id = r.customer_id LEFT JOIN employees e ON e.id = r.employee_id
         {} ORDER BY r.received_at DESC",
        if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) }
    );
    let mut rows: Vec<RepairRow> = ctx.db.all(&sql, args.params())?;
    for r in &mut rows {
        r.overdue = is_open(&r.status) && r.due_at.as_deref().is_some_and(|d| d < t.as_str());
    }
    Ok(rows)
}

row! { pub struct RepairCustomer { pub id: String, pub name: String, pub phone: String, pub whatsapp: String } }
row! { pub struct RepairPartRow { pub id: String, pub product_id: String, pub name: String, pub quantity: i64, pub unit_cost: Option<i64> } }
row! { pub struct RepairPhoto { pub id: String, pub file_name: String, pub taken_at: String } }
row! { pub struct RepairPaymentRow { pub id: String, pub date: String, pub amount: i64, pub method: String, pub note: String } }
row! {
    pub struct RepairHistory {
        #[ts(type = "'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE'")]
        pub status: String,
        pub at: String,
        pub note: String,
    }
}

row! {
    pub struct RepairDetail {
        pub id: String,
        pub ticket_number: String,
        pub customer_id: String,
        pub employee_id: Option<String>,
        pub brand: String,
        pub model: String,
        pub imei: Option<String>,
        pub fault: String,
        pub arrival_state: String,
        pub accessories_left: String,
        pub unlock_note: String,
        pub estimated_price: i64,
        pub final_price: Option<i64>,
        pub deposit: i64,
        #[ts(type = "'RECEIVED' | 'DIAGNOSING' | 'WAITING_PARTS' | 'READY' | 'DELIVERED' | 'CANCELLED' | 'UNREPAIRABLE'")]
        pub status: String,
        pub received_at: String,
        pub due_at: Option<String>,
        pub delivered_at: Option<String>,
        pub warranty_days: i64,
        pub qr_token: String,
        pub notes: String,
        pub closed_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub arrival: Arrival,
        pub accessories: Accessories,
        pub customer: RepairCustomer,
        pub technician_name: Option<String>,
        pub parts: Vec<RepairPartRow>,
        pub photos: Vec<RepairPhoto>,
        pub payments: Vec<RepairPaymentRow>,
        pub history: Vec<RepairHistory>,
        pub paid: i64,
        /// What is still to pay: against the final price once closed, against the estimate while open.
        pub remaining: i64,
        pub closed: bool,
        pub overdue: bool,
        pub warranty_end: Option<String>,
        pub profit: Option<i64>,
    }
}

/// One ticket. Costs and profit are included only when `with_profit` (the Finance section is open).
pub fn get_repair(ctx: &Ctx, id: &str, with_profit: bool) -> Res<RepairDetail> {
    let r = load(ctx, id)?;
    let customer: RepairCustomer = ctx.db.get("SELECT id, name, phone, whatsapp FROM customers WHERE id = ?1", [&r.customer_id])?.unwrap();
    let technician_name: Option<String> = match &r.employee_id {
        Some(e) => ctx.db.opt_val("SELECT name FROM employees WHERE id = ?1", [e])?,
        None => None,
    };
    let mut parts: Vec<RepairPartRow> = ctx.db.all(
        "SELECT rp.id, rp.product_id, p.name, rp.quantity, rp.unit_cost_at_use AS unit_cost FROM repair_parts rp JOIN products p ON p.id = rp.product_id WHERE rp.repair_id = ?1 ORDER BY rp.created_at",
        [id],
    )?;
    if !with_profit {
        for p in &mut parts {
            p.unit_cost = None;
        }
    }
    let payments: Vec<CustomerPayment> = ctx.db.all("SELECT * FROM customer_payments WHERE repair_id = ?1 ORDER BY date", [id])?;
    let history: Vec<RepairHistory> = ctx.db.all("SELECT status, at, note FROM repair_status_log WHERE repair_id = ?1 ORDER BY at", [id])?;
    let photos: Vec<RepairPhoto> = ctx.db.all("SELECT id, file_name, taken_at FROM repair_photos WHERE repair_id = ?1 ORDER BY taken_at, rowid", [id])?;
    let paid: i64 = payments.iter().map(|p| p.amount).sum();
    let closed = !is_open(&r.status);
    let price = if closed { r.final_price.unwrap_or(0) } else { r.estimated_price };
    let cost = parts_cost(ctx, id)?;
    let t = now();
    Ok(RepairDetail {
        arrival: serde_json::from_str(&r.arrival_state).unwrap_or_else(|_| empty_arrival()),
        accessories: serde_json::from_str(&r.accessories_left).unwrap_or_else(|_| empty_accessories()),
        customer,
        technician_name,
        parts,
        photos,
        payments: payments.into_iter().map(|p| RepairPaymentRow { id: p.id, date: p.date, amount: p.amount, method: p.method, note: p.note }).collect(),
        history,
        paid,
        remaining: price - paid,
        closed,
        overdue: !closed && r.due_at.as_deref().is_some_and(|d| d < t.as_str()),
        warranty_end: match (&r.delivered_at, r.status.as_str()) {
            (Some(d), "DELIVERED") if r.warranty_days > 0 => Some(ms_to_iso(parse_ms(d).unwrap_or(0) + r.warranty_days * DAY_MS)),
            _ => None,
        },
        profit: (with_profit && r.status == "DELIVERED").then(|| r.final_price.unwrap_or(0) - cost),
        id: r.id,
        ticket_number: r.ticket_number,
        customer_id: r.customer_id,
        employee_id: r.employee_id,
        brand: r.brand,
        model: r.model,
        imei: r.imei,
        fault: r.fault,
        arrival_state: r.arrival_state,
        accessories_left: r.accessories_left,
        unlock_note: r.unlock_note,
        estimated_price: r.estimated_price,
        final_price: r.final_price,
        deposit: r.deposit,
        status: r.status,
        received_at: r.received_at,
        due_at: r.due_at,
        delivered_at: r.delivered_at,
        warranty_days: r.warranty_days,
        qr_token: r.qr_token,
        notes: r.notes,
        closed_at: r.closed_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}

input! { pub struct RepairTokenInput { pub token: String } }
impl Validate for RepairTokenInput {
    fn validate(&mut self) -> Res<()> {
        valid::check(valid::QR_TOKEN.is_match(&self.token), "token")
    }
}

pub fn find_by_token(ctx: &Ctx, token: &str) -> Res<Option<crate::rows::Id>> {
    Ok(ctx.db.opt_val::<String>("SELECT id FROM repairs WHERE qr_token = ?1", [token])?.map(|id| crate::rows::Id { id }))
}

/// Profit of the repairs closed in a period: final price - parts cost, counted on the closing date.
pub fn repair_profit(ctx: &Ctx, from: &str, to: &str) -> Res<i64> {
    ctx.db.val(
        "SELECT COALESCE(SUM(COALESCE(r.final_price, 0) - COALESCE((SELECT SUM(rp.quantity * rp.unit_cost_at_use) FROM repair_parts rp WHERE rp.repair_id = r.id), 0)), 0)
         FROM repairs r WHERE r.closed_at >= ?1 AND r.closed_at <= ?2",
        params![from, to],
    )
}

row! { pub struct RepairPartOption { pub id: String, pub name: String, pub barcode: Option<String>, pub quantity: i64 } }

/// Spare parts the shop can use: items flagged as repair parts.
pub fn list_repair_parts(ctx: &Ctx) -> Res<Vec<RepairPartOption>> {
    ctx.db.all("SELECT id, name, barcode, quantity FROM products WHERE kind = 'ITEM' AND is_repair_part = 1 AND deleted_at IS NULL ORDER BY name", [])
}

row! { pub struct Suggestions { pub brands: Vec<String>, pub models: Vec<String> } }

/// Brand and model names seen before, to suggest while typing.
pub fn suggestions(ctx: &Ctx) -> Res<Suggestions> {
    let mut stmt = ctx.db.prepare_cached("SELECT name FROM brands UNION SELECT DISTINCT brand FROM repairs WHERE brand <> '' ORDER BY 1")?;
    let brands = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut stmt = ctx.db.prepare_cached(
        "SELECT DISTINCT model FROM (SELECT model FROM products WHERE kind = 'PHONE_MODEL' UNION SELECT model FROM repairs) WHERE model <> '' ORDER BY model",
    )?;
    let models = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(Suggestions { brands, models })
}

// Purchases: stock comes in here. One transaction per purchase (or cancellation) that updates stock, writes a
// stock_movements row per line and a cash_movements row for what is paid.
use super::cash::cash;
use super::files::{import_file, remove_file, stored_file_path, DOCUMENT_TYPES};
use super::stock::{check_required_imeis, find_or_create_model, insert_unit, recompute_model, write_movement, ModelInput, Movement, CONDITIONS};
use super::suppliers::{assert_individual_details, create_supplier, list_suppliers, SupplierInput};
use crate::core::Ctx;
use crate::db::{DbExt, Filter};
use crate::error::{bail, Res};
use crate::rows::{Id, Product, Purchase, Supplier};
use crate::util::{js_round, now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;
use std::collections::HashMap;

/// New average cost when `qty` units arrive at `unit_cost`. Rounded to a centime.
pub fn weighted_average(old_qty: i64, old_avg: i64, qty: i64, unit_cost: i64) -> i64 {
    let base = old_qty.max(0);
    js_round((base * old_avg + qty * unit_cost) as f64 / (base + qty) as f64)
}

input! {
    pub struct ItemLineInput { pub product_id: String, pub quantity: i64, pub unit_cost: i64 }
}
impl Validate for ItemLineInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.product_id, "productId")?;
        valid::range(self.quantity, 1, 1_000_000, "quantity")?;
        valid::centimes(self.unit_cost, "unitCost")
    }
}

input! {
    pub struct PhoneLineInput {
        pub imei1: String,
        pub imei2: Option<String>,
        pub condition: String,
        pub battery_health: Option<i64>,
        pub grade: Option<String>,
        pub cost: i64,
        pub sale_price: i64,
        #[serde(default)]
        pub min_price: i64,
        pub product_id: Option<String>,
        pub model: Option<ModelInput>,
    }
}
impl Validate for PhoneLineInput {
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
        valid::centimes(self.min_price, "minPrice")?;
        valid::opt_id(&self.product_id, "productId")?;
        if let Some(m) = &mut self.model {
            m.validate()?;
        }
        valid::check(self.product_id.is_some() != self.model.is_some(), "model_required")
    }
}

input! {
    pub struct PurchaseInput {
        pub supplier_id: String,
        pub date: String,
        #[serde(default)]
        pub paid: i64,
        #[serde(default)]
        pub note: String,
        #[serde(default)]
        pub invoice_path: Option<String>,
        /// A file already stored by the PC (a photo a phone uploaded through /files).
        pub invoice_file: Option<String>,
        /// Sent by a phone: a repeated id returns the first purchase instead of creating another.
        pub request_id: Option<String>,
        #[serde(default)]
        pub item_lines: Vec<ItemLineInput>,
        #[serde(default)]
        pub phone_lines: Vec<PhoneLineInput>,
    }
}
impl Validate for PurchaseInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.supplier_id, "supplierId")?;
        valid::datetime(&self.date, "date")?;
        valid::centimes(self.paid, "paid")?;
        valid::text(&mut self.note, 0, 500, "note")?;
        if let Some(f) = &self.invoice_file {
            valid::stored_file(f, "invoiceFile")?;
        }
        valid::opt_trimmed(&mut self.request_id, 8, 64, "requestId")?;
        valid::max_items(&self.item_lines, 0, 500, "itemLines")?;
        valid::max_items(&self.phone_lines, 0, 500, "phoneLines")?;
        for l in &mut self.item_lines {
            l.validate()?;
        }
        for l in &mut self.phone_lines {
            l.validate()?;
        }
        Ok(())
    }
}

pub fn create_purchase(ctx: &Ctx, input: &PurchaseInput) -> Res<Id> {
    // A phone that did not get the answer sends the same request id again: it gets the first purchase back.
    if let Some(r) = &input.request_id {
        if let Some(id) = find_by_request(ctx, r)? {
            return Ok(Id { id });
        }
    }
    if let Some(f) = &input.invoice_file {
        if !stored_file_path(&ctx.core.paths.files_dir(), f).exists() {
            bail!("file_not_found");
        }
    }
    let imported = match &input.invoice_path {
        Some(p) if !p.is_empty() => Some(import_file(ctx, p, DOCUMENT_TYPES)?),
        _ => None,
    };
    let invoice_file = imported.clone().or_else(|| input.invoice_file.clone());
    let result = ctx.tx(|| {
        let Some(supplier) = ctx.db.get::<Supplier>("SELECT * FROM suppliers WHERE id = ?1 AND deleted_at IS NULL", [&input.supplier_id])? else { bail!("not_found") };
        if input.item_lines.len() + input.phone_lines.len() == 0 {
            bail!("purchase_empty");
        }
        let total: i64 = input.item_lines.iter().map(|l| l.quantity * l.unit_cost).sum::<i64>() + input.phone_lines.iter().map(|l| l.cost).sum::<i64>();
        if input.paid > total {
            bail!("paid_exceeds_total");
        }
        if supplier.kind == "INDIVIDUAL" {
            assert_individual_details(&supplier.name, &supplier.phone, supplier.id_document_number.as_deref())?;
            if input.paid != total {
                bail!("individual_must_be_paid");
            }
        }
        let purchase_id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO purchases (id, supplier_id, date, total, paid, note, invoice_file, request_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![purchase_id, supplier.id, input.date, total, input.paid, input.note, invoice_file, input.request_id, t],
        )?;
        let line = |product_id: &str, quantity: i64, unit_cost: i64| -> Res<String> {
            let id = uuid();
            let t = now();
            ctx.db.exec(
                "INSERT INTO purchase_lines (id, purchase_id, product_id, unit_id, quantity, unit_cost, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?6)",
                params![id, purchase_id, product_id, quantity, unit_cost, t],
            )?;
            Ok(id)
        };
        let mv = |product_id: &str, unit_id: Option<&str>, quantity: i64, unit_cost: i64| {
            write_movement(ctx, Movement { product_id, unit_id, kind: "PURCHASE", quantity, unit_cost, reason: "", ref_table: Some("purchases"), ref_id: Some(&purchase_id), at: Some(&input.date) })
        };

        for l in &input.item_lines {
            let Some(item) = ctx.db.get::<Product>("SELECT * FROM products WHERE id = ?1 AND kind = 'ITEM' AND deleted_at IS NULL", [&l.product_id])? else { bail!("not_found") };
            ctx.db.exec(
                "UPDATE products SET quantity = ?1, avg_cost = ?2, updated_at = ?3 WHERE id = ?4",
                params![item.quantity + l.quantity, weighted_average(item.quantity, item.avg_cost, l.quantity, l.unit_cost), now(), item.id],
            )?;
            line(&item.id, l.quantity, l.unit_cost)?;
            mv(&item.id, None, l.quantity, l.unit_cost)?;
        }

        let mut touched: Vec<String> = Vec::new();
        for l in &input.phone_lines {
            check_required_imeis(ctx, &l.imei1, l.imei2.as_deref(), None)?; // sees the units added by earlier lines
            let product_id = match &l.product_id {
                Some(pid) => match ctx.db.opt_val::<String>("SELECT id FROM products WHERE id = ?1 AND kind = 'PHONE_MODEL' AND deleted_at IS NULL", [pid])? {
                    Some(id) => id,
                    None => bail!("not_found"),
                },
                None => find_or_create_model(ctx, l.model.as_ref().unwrap(), l.sale_price, l.min_price, l.cost)?,
            };
            let line_id = line(&product_id, 1, l.cost)?;
            let unit_id = insert_unit(ctx, &product_id, Some(&l.imei1), l.imei2.as_deref(), &l.condition, l.battery_health, l.grade.as_deref(), l.cost, l.sale_price, "IN_STOCK", "", Some(&line_id))?;
            ctx.db.exec("UPDATE purchase_lines SET unit_id = ?1 WHERE id = ?2", params![unit_id, line_id])?;
            mv(&product_id, Some(&unit_id), 1, l.cost)?;
            if !touched.contains(&product_id) {
                touched.push(product_id);
            }
        }
        for p in &touched {
            recompute_model(ctx, p)?;
        }
        cash(ctx, "OUT", input.paid, "PURCHASE", "purchases", &purchase_id, &supplier.name, Some(&input.date))?;
        Ok(Id { id: purchase_id })
    });
    if result.is_err() {
        remove_file(ctx, imported.as_deref()); // only a copy made here: a file a phone uploaded stays for its retry
    }
    result
}

fn find_by_request(ctx: &Ctx, request_id: &str) -> Res<Option<String>> {
    ctx.db.opt_val("SELECT id FROM purchases WHERE request_id = ?1", [request_id])
}

input! {
    pub struct BuyBackInput {
        pub seller_name: String,
        pub seller_phone: String,
        pub seller_id_number: String,
        pub date: String,
        pub line: PhoneLineInput,
    }
}
impl Validate for BuyBackInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.seller_name, 1, 120, "sellerName")?;
        valid::text(&mut self.seller_phone, 1, 40, "sellerPhone")?;
        valid::text(&mut self.seller_id_number, 1, 40, "sellerIdNumber")?;
        valid::datetime(&self.date, "date")?;
        self.line.validate()
    }
}

row! { pub struct BuyBackResult { pub id: String, pub supplier_id: String } }

/// Buy one phone from a private seller, finding the seller by ID number or creating them. Paid in full.
pub fn buy_from_individual(ctx: &Ctx, input: &BuyBackInput) -> Res<BuyBackResult> {
    ctx.tx(|| {
        let existing =
            list_suppliers(ctx)?.into_iter().find(|s| s.kind == "INDIVIDUAL" && s.id_document_number.as_deref() == Some(input.seller_id_number.as_str()));
        let supplier_id = match existing {
            Some(s) => s.id,
            None => {
                create_supplier(
                    ctx,
                    &SupplierInput {
                        name: input.seller_name.clone(),
                        phone: input.seller_phone.clone(),
                        address: String::new(),
                        kind: "INDIVIDUAL".into(),
                        id_document_number: Some(input.seller_id_number.clone()),
                        notes: String::new(),
                    },
                )?
                .id
            }
        };
        let Id { id } = create_purchase(
            ctx,
            &PurchaseInput {
                supplier_id: supplier_id.clone(),
                date: input.date.clone(),
                paid: input.line.cost,
                note: String::new(),
                invoice_path: None,
                invoice_file: None,
                request_id: None,
                item_lines: vec![],
                phone_lines: vec![input.line.clone()],
            },
        )?;
        Ok(BuyBackResult { id, supplier_id })
    })
}

input! {
    #[derive(Default)]
    pub struct PurchaseFilter {
        pub supplier_id: Option<String>,
        pub from: Option<String>,
        pub to: Option<String>,
    }
}
impl Validate for PurchaseFilter {
    fn validate(&mut self) -> Res<()> {
        valid::opt_datetime(&self.from, "from")?;
        valid::opt_datetime(&self.to, "to")
    }
}

row! {
    pub struct PurchaseRow {
        pub id: String,
        pub date: String,
        pub supplier_id: String,
        pub supplier_name: String,
        #[ts(type = "'COMPANY' | 'INDIVIDUAL'")]
        pub supplier_kind: String,
        pub total: i64,
        pub paid: i64,
        pub cancelled_at: Option<String>,
        #[serde(default)]
        pub line_count: i64,
        #[serde(default)]
        pub remaining: i64,
    }
}

pub fn list_purchases(ctx: &Ctx, filter: &PurchaseFilter) -> Res<Vec<PurchaseRow>> {
    let mut f = Filter::new();
    if let Some(v) = filter.supplier_id.as_ref().filter(|v| !v.is_empty()) {
        f.add_with("p.supplier_id = ?", v.clone());
    }
    if let Some(v) = &filter.from {
        f.add_with("p.date >= ?", v.clone());
    }
    if let Some(v) = &filter.to {
        f.add_with("p.date <= ?", v.clone());
    }
    let mut counts: HashMap<String, i64> = HashMap::new();
    let mut stmt = ctx.db.prepare_cached("SELECT purchase_id, count(*) FROM purchase_lines GROUP BY purchase_id")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (id, n) = r?;
        counts.insert(id, n);
    }
    let sql = format!(
        "SELECT p.id, p.date, p.supplier_id, s.name AS supplier_name, s.kind AS supplier_kind, p.total, p.paid, p.cancelled_at
         FROM purchases p JOIN suppliers s ON s.id = p.supplier_id{} ORDER BY p.date DESC, p.created_at DESC",
        f.sql()
    );
    let mut rows: Vec<PurchaseRow> = ctx.db.all(&sql, f.args.params())?;
    for r in &mut rows {
        r.line_count = counts.get(&r.id).copied().unwrap_or(0);
        r.remaining = if r.cancelled_at.is_some() { 0 } else { r.total - r.paid };
    }
    Ok(rows)
}

row! {
    pub struct PurchaseLineRow {
        pub id: String,
        pub product_id: String,
        pub product_name: String,
        pub storage: String,
        pub color: String,
        pub unit_id: Option<String>,
        pub imei1: Option<String>,
        #[ts(type = "'NEW' | 'USED' | 'REFURBISHED' | null")]
        pub condition: Option<String>,
        pub quantity: i64,
        pub unit_cost: i64,
    }
}

row! {
    pub struct PurchaseDetail {
        pub id: String,
        pub date: String,
        pub supplier_id: String,
        pub supplier_name: String,
        pub supplier_phone: String,
        #[ts(type = "'COMPANY' | 'INDIVIDUAL'")]
        pub supplier_kind: String,
        pub supplier_id_number: Option<String>,
        pub total: i64,
        pub paid: i64,
        pub note: String,
        pub invoice_file: Option<String>,
        pub cancelled_at: Option<String>,
        #[serde(default)]
        pub remaining: i64,
        #[serde(default)]
        pub lines: Vec<PurchaseLineRow>,
    }
}

pub fn get_purchase(ctx: &Ctx, id: &str) -> Res<PurchaseDetail> {
    let Some(mut p) = ctx.db.get::<PurchaseDetail>(
        "SELECT p.id, p.date, p.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone, s.kind AS supplier_kind, s.id_document_number AS supplier_id_number,
                p.total, p.paid, p.note, p.invoice_file, p.cancelled_at
         FROM purchases p JOIN suppliers s ON s.id = p.supplier_id WHERE p.id = ?1",
        [id],
    )?
    else {
        bail!("not_found")
    };
    p.lines = ctx.db.all(
        "SELECT l.id, l.product_id, pr.name AS product_name, pr.storage, pr.color, l.unit_id, u.imei1, u.condition, l.quantity, l.unit_cost
         FROM purchase_lines l JOIN products pr ON pr.id = l.product_id LEFT JOIN phone_units u ON u.id = l.unit_id WHERE l.purchase_id = ?1",
        [id],
    )?;
    p.remaining = if p.cancelled_at.is_some() { 0 } else { p.total - p.paid };
    Ok(p)
}

#[derive(serde::Deserialize)]
struct LineRow {
    product_id: String,
    unit_id: Option<String>,
    quantity: i64,
    unit_cost: i64,
}

/// Cancel a purchase that has not been sold from: every unit still in stock, and for items no outgoing movement
/// since the purchase. Reverses stock and average cost; cash paid comes back in.
pub fn cancel_purchase(ctx: &Ctx, id: &str) -> Res<()> {
    ctx.tx(|| {
        let purchase = ctx.db.get::<Purchase>("SELECT * FROM purchases WHERE id = ?1", [id])?;
        let Some(purchase) = purchase.filter(|p| p.cancelled_at.is_none()) else { bail!("not_found") };
        let lines: Vec<LineRow> = ctx.db.all("SELECT product_id, unit_id, quantity, unit_cost FROM purchase_lines WHERE purchase_id = ?1", [id])?;

        // Check everything before changing anything.
        for l in &lines {
            if let Some(unit_id) = &l.unit_id {
                let ok = ctx.db.exists("SELECT 1 FROM phone_units WHERE id = ?1 AND deleted_at IS NULL AND status = 'IN_STOCK'", [unit_id])?;
                if !ok {
                    bail!("purchase_has_sales");
                }
            } else {
                let qty: Option<i64> = ctx.db.opt_val("SELECT quantity FROM products WHERE id = ?1", [&l.product_id])?;
                let entered: Option<String> = ctx.db.opt_val(
                    "SELECT created_at FROM stock_movements WHERE type = 'PURCHASE' AND ref_table = 'purchases' AND ref_id = ?1 AND product_id = ?2",
                    params![id, l.product_id],
                )?;
                let out: i64 = ctx.db.val(
                    "SELECT count(*) FROM stock_movements WHERE product_id = ?1 AND type IN ('SALE','REPAIR_USE') AND created_at > ?2",
                    params![l.product_id, entered.unwrap_or_default()],
                )?;
                if qty.is_none_or(|q| q < l.quantity) || out > 0 {
                    bail!("purchase_has_sales");
                }
            }
        }

        let mut touched: Vec<String> = Vec::new();
        for l in &lines {
            if let Some(unit_id) = &l.unit_id {
                let t = now();
                ctx.db.exec("UPDATE phone_units SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2", params![t, unit_id])?;
                if !touched.contains(&l.product_id) {
                    touched.push(l.product_id.clone());
                }
            } else {
                let item: Product = ctx.db.get("SELECT * FROM products WHERE id = ?1", [&l.product_id])?.unwrap();
                let left = item.quantity - l.quantity;
                let avg =
                    if left > 0 { js_round((item.quantity * item.avg_cost - l.quantity * l.unit_cost) as f64 / left as f64).max(0) } else { item.avg_cost };
                ctx.db.exec("UPDATE products SET quantity = ?1, avg_cost = ?2, updated_at = ?3 WHERE id = ?4", params![left, avg, now(), item.id])?;
            }
            write_movement(
                ctx,
                Movement {
                    product_id: &l.product_id,
                    unit_id: l.unit_id.as_deref(),
                    kind: "ADJUSTMENT",
                    quantity: -l.quantity,
                    unit_cost: l.unit_cost,
                    reason: "PURCHASE_CANCELLED",
                    ref_table: Some("purchases"),
                    ref_id: Some(id),
                    at: None,
                },
            )?;
        }
        for p in &touched {
            recompute_model(ctx, p)?;
        }
        let t = now();
        ctx.db.exec("UPDATE purchases SET cancelled_at = ?1, updated_at = ?1 WHERE id = ?2", params![t, id])?;
        cash(ctx, "IN", purchase.paid, "PURCHASE_CANCEL", "purchases", id, "", None)
    })
}

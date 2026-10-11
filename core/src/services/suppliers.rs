// Suppliers and what we owe them.
// balance = sum(purchase totals) - sum(amounts paid on purchases) - sum(supplier payments), purchases not cancelled.
use super::cash::cash;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{Id, Supplier, SupplierPayment};
use crate::util::{now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;
use std::collections::HashMap;

row! { #[derive(Default, Copy)] pub struct Totals { pub purchased: i64, pub paid: i64, pub balance: i64 } }

fn totals_map(ctx: &Ctx) -> Res<HashMap<String, Totals>> {
    let mut map: HashMap<String, Totals> = HashMap::new();
    let mut stmt = ctx
        .db
        .prepare_cached("SELECT supplier_id, COALESCE(SUM(total), 0), COALESCE(SUM(paid), 0) FROM purchases WHERE cancelled_at IS NULL GROUP BY supplier_id")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))? {
        let (id, total, paid) = r?;
        let e = map.entry(id).or_default();
        e.purchased = total;
        e.paid = paid;
    }
    let mut stmt = ctx.db.prepare_cached("SELECT supplier_id, COALESCE(SUM(amount), 0) FROM supplier_payments GROUP BY supplier_id")?;
    for r in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (id, amount) = r?;
        map.entry(id).or_default().paid += amount;
    }
    for t in map.values_mut() {
        t.balance = t.purchased - t.paid;
    }
    Ok(map)
}

pub fn supplier_totals(ctx: &Ctx, id: &str) -> Res<Totals> {
    Ok(totals_map(ctx)?.get(id).copied().unwrap_or_default())
}

row! {
    pub struct SupplierRow {
        pub id: String,
        pub name: String,
        pub phone: String,
        pub address: String,
        #[ts(type = "'COMPANY' | 'INDIVIDUAL'")]
        pub kind: String,
        pub id_document_number: Option<String>,
        pub notes: String,
        pub deleted_at: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        pub purchased: i64,
        pub paid: i64,
        pub balance: i64,
    }
}

pub fn list_suppliers(ctx: &Ctx) -> Res<Vec<SupplierRow>> {
    let totals = totals_map(ctx)?;
    let rows: Vec<Supplier> = ctx.db.all("SELECT * FROM suppliers WHERE deleted_at IS NULL ORDER BY name", [])?;
    Ok(rows
        .into_iter()
        .map(|s| {
            let t = totals.get(&s.id).copied().unwrap_or_default();
            SupplierRow {
                id: s.id,
                name: s.name,
                phone: s.phone,
                address: s.address,
                kind: s.kind,
                id_document_number: s.id_document_number,
                notes: s.notes,
                deleted_at: s.deleted_at,
                created_at: s.created_at,
                updated_at: s.updated_at,
                purchased: t.purchased,
                paid: t.paid,
                balance: t.balance,
            }
        })
        .collect())
}

/// A private seller must be identifiable: name, phone and ID document number.
pub fn assert_individual_details(name: &str, phone: &str, id_number: Option<&str>) -> Res<()> {
    if name.trim().is_empty() || phone.trim().is_empty() || id_number.map(str::trim).unwrap_or("").is_empty() {
        bail!("seller_details_required");
    }
    Ok(())
}

row! {
    pub struct SupplierPurchase {
        pub id: String,
        pub date: String,
        pub total: i64,
        pub paid: i64,
        pub cancelled_at: Option<String>,
        pub line_count: i64,
    }
}

row! {
    pub struct SupplierDetail {
        pub supplier: Supplier,
        pub totals: Totals,
        pub purchases: Vec<SupplierPurchase>,
        pub payments: Vec<SupplierPayment>,
    }
}

pub fn get_supplier(ctx: &Ctx, id: &str) -> Res<SupplierDetail> {
    let Some(supplier) = ctx.db.get::<Supplier>("SELECT * FROM suppliers WHERE id = ?1 AND deleted_at IS NULL", [id])? else { bail!("not_found") };
    let purchases = ctx.db.all(
        "SELECT p.id, p.date, p.total, p.paid, p.cancelled_at, (SELECT count(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count
         FROM purchases p WHERE p.supplier_id = ?1 ORDER BY p.date DESC, p.created_at DESC",
        [id],
    )?;
    let payments = ctx.db.all("SELECT * FROM supplier_payments WHERE supplier_id = ?1 ORDER BY date DESC", [id])?;
    Ok(SupplierDetail { totals: supplier_totals(ctx, id)?, supplier, purchases, payments })
}

input! {
    pub struct SupplierInput {
        pub name: String,
        #[serde(default)]
        pub phone: String,
        #[serde(default)]
        pub address: String,
        #[serde(default = "company")]
        pub kind: String,
        pub id_document_number: Option<String>,
        #[serde(default)]
        pub notes: String,
    }
}
fn company() -> String {
    "COMPANY".into()
}
impl Validate for SupplierInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 120, "name")?;
        valid::text(&mut self.phone, 0, 40, "phone")?;
        valid::text(&mut self.address, 0, 200, "address")?;
        valid::one_of(&self.kind, &["COMPANY", "INDIVIDUAL"], "kind")?;
        valid::opt_text(&mut self.id_document_number, 40, "idDocumentNumber")?;
        valid::text(&mut self.notes, 0, 500, "notes")
    }
}

input! {
    pub struct SupplierUpdateInput {
        pub id: String,
        #[serde(flatten)]
        pub fields: SupplierInput,
    }
}
impl Validate for SupplierUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        self.fields.validate()
    }
}

pub fn create_supplier(ctx: &Ctx, input: &SupplierInput) -> Res<Supplier> {
    if input.kind == "INDIVIDUAL" {
        assert_individual_details(&input.name, &input.phone, input.id_document_number.as_deref())?;
    }
    let t = now();
    let row = Supplier {
        id: uuid(),
        name: input.name.clone(),
        phone: input.phone.clone(),
        address: input.address.clone(),
        kind: input.kind.clone(),
        id_document_number: input.id_document_number.clone(),
        notes: input.notes.clone(),
        deleted_at: None,
        created_at: t.clone(),
        updated_at: t,
    };
    insert_supplier(ctx, &row)?;
    Ok(row)
}

pub fn insert_supplier(ctx: &Ctx, r: &Supplier) -> Res<()> {
    ctx.db.exec(
        "INSERT INTO suppliers (id, name, phone, address, kind, id_document_number, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![r.id, r.name, r.phone, r.address, r.kind, r.id_document_number, r.notes, r.created_at, r.updated_at],
    )?;
    Ok(())
}

pub fn update_supplier(ctx: &Ctx, input: &SupplierUpdateInput) -> Res<()> {
    let f = &input.fields;
    if f.kind == "INDIVIDUAL" {
        assert_individual_details(&f.name, &f.phone, f.id_document_number.as_deref())?;
    }
    let n = ctx.db.exec(
        "UPDATE suppliers SET name = ?1, phone = ?2, address = ?3, kind = ?4, id_document_number = ?5, notes = ?6, updated_at = ?7 WHERE id = ?8 AND deleted_at IS NULL",
        params![f.name, f.phone, f.address, f.kind, f.id_document_number, f.notes, now(), input.id],
    )?;
    if n == 0 {
        bail!("not_found");
    }
    Ok(())
}

/// Soft delete, refused while we still owe the supplier money.
pub fn delete_supplier(ctx: &Ctx, id: &str) -> Res<()> {
    if supplier_totals(ctx, id)?.balance > 0 {
        bail!("supplier_has_balance");
    }
    let t = now();
    if ctx.db.exec("UPDATE suppliers SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![t, id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

input! {
    pub struct SupplierPaymentInput {
        pub supplier_id: String,
        pub amount: i64,
        pub date: String,
        #[serde(default = "cash_method")]
        pub method: String,
        #[serde(default)]
        pub note: String,
    }
}
pub fn cash_method() -> String {
    "CASH".into()
}
impl Validate for SupplierPaymentInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.supplier_id, "supplierId")?;
        valid::pos_centimes(self.amount, "amount")?;
        valid::datetime(&self.date, "date")?;
        valid::one_of(&self.method, &["CASH", "BANK", "OTHER"], "method")?;
        valid::text(&mut self.note, 0, 300, "note")
    }
}

/// A payment to a supplier. Cash payments leave the drawer, so they also write a cash movement.
pub fn add_payment(ctx: &Ctx, input: &SupplierPaymentInput) -> Res<Id> {
    ctx.tx(|| {
        let Some(name) = ctx.db.opt_val::<String>("SELECT name FROM suppliers WHERE id = ?1 AND deleted_at IS NULL", [&input.supplier_id])? else {
            bail!("not_found")
        };
        let id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO supplier_payments (id, supplier_id, amount, date, method, note, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![id, input.supplier_id, input.amount, input.date, input.method, input.note, t],
        )?;
        if input.method == "CASH" {
            cash(ctx, "OUT", input.amount, "SUPPLIER_PAYMENT", "supplier_payments", &id, &name, Some(&input.date))?;
        }
        Ok(Id { id })
    })
}

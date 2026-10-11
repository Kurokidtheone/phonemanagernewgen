// Import accessories (and parts) from an Excel file: name, category, barcode, quantity, cost, price.
// The file is read twice: once for the preview (every row checked, nothing written) and once to import, so what
// is written is never what the screen sent. Amounts are in DA.
use super::stock::{write_movement, Movement};
use super::xlsx::{build_xlsx, read_xlsx, Cell, ReadError};
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{app_with, bail, Res};
use crate::rows::Category;
use crate::util::{js_number_text, now, to_centimes_number, to_centimes_text, uuid};
use crate::valid::{self, Validate};
use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::params;
use std::collections::{HashMap, HashSet};

const HEADERS: [(&str, &[&str]); 6] = [
    ("name", &["name", "nom", "designation", "désignation", "الاسم"]),
    ("category", &["category", "categorie", "catégorie", "الفئة"]),
    ("barcode", &["barcode", "code-barres", "code barres", "code", "الباركود"]),
    ("quantity", &["quantity", "qty", "quantite", "quantité", "qte", "الكمية"]),
    ("cost", &["cost", "cout", "coût", "prix achat", "التكلفة"]),
    ("price", &["price", "prix", "prix vente", "السعر"]),
];
pub const TEMPLATE_HEADERS: [&str; 6] = ["name", "category", "barcode", "quantity", "cost", "price"];

input! { pub struct ImportPathInput { pub path: String } }
impl Validate for ImportPathInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.path, 1, 1024, "path")
    }
}

row! {
    pub struct ImportRow {
        /// The line in the file (the header is line 1).
        pub line: i64,
        pub name: String,
        pub category: String,
        pub new_category: bool,
        pub barcode: Option<String>,
        pub quantity: f64,
        pub cost: i64,
        pub price: i64,
        #[ts(type = "('name_required' | 'category_required' | 'price_invalid' | 'quantity_invalid' | 'cost_invalid' | 'barcode_invalid' | 'barcode_repeated' | 'barcode_exists')[]")]
        pub errors: Vec<String>,
    }
}

row! {
    pub struct ImportPreview {
        pub rows: Vec<ImportRow>,
        pub valid: i64,
        pub invalid: i64,
        pub new_categories: Vec<String>,
    }
}

fn load(path: &str) -> Res<Vec<Vec<Cell>>> {
    if !path.to_lowercase().ends_with(".xlsx") {
        bail!("import_not_xlsx");
    }
    let too_large = || app_with("file_too_large", [("mb", 5.into())]);
    let Ok(meta) = std::fs::metadata(path) else { bail!("import_not_xlsx") };
    if meta.len() > 5 * 1024 * 1024 {
        return Err(too_large());
    }
    let Ok(bytes) = std::fs::read(path) else { bail!("import_not_xlsx") };
    match read_xlsx(&bytes) {
        Ok(rows) => Ok(rows),
        Err(ReadError::TooLarge) => Err(too_large()),
        Err(ReadError::NotXlsx) => bail!("import_not_xlsx"),
    }
}

fn text(v: Option<&Cell>) -> String {
    match v {
        None | Some(Cell::Null) => String::new(),
        Some(Cell::Num(n)) => js_number_text(*n),
        Some(Cell::Text(t)) => t.trim().to_owned(),
    }
}

enum Amount {
    Empty,
    Bad,
    Ok(i64),
}

/// An amount in DA typed as a number or as text like "1 200,50".
fn amount(v: Option<&Cell>) -> Amount {
    let c = match v {
        None | Some(Cell::Null) => return Amount::Empty,
        Some(Cell::Text(t)) if t.is_empty() => return Amount::Empty,
        Some(Cell::Text(t)) => to_centimes_text(t),
        Some(Cell::Num(n)) => to_centimes_number(*n),
    };
    match c {
        Some(c) if c >= 0 => Amount::Ok(c),
        _ => Amount::Bad,
    }
}

static BARCODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,40}$").unwrap());

pub fn preview_items(ctx: &Ctx, path: &str) -> Res<ImportPreview> {
    let sheet = load(path)?;
    let header: Vec<String> = sheet.first().map(|r| r.iter().map(|h| text(Some(h)).to_lowercase()).collect()).unwrap_or_default();
    let column = |key: &str| -> Option<usize> {
        let names = HEADERS.iter().find(|(k, _)| *k == key).unwrap().1;
        header.iter().position(|h| names.contains(&h.as_str()))
    };
    let idx: HashMap<&str, Option<usize>> = TEMPLATE_HEADERS.iter().map(|k| (*k, column(k))).collect();
    // The columns we cannot do without; the others default to empty or zero.
    if idx["name"].is_none() || idx["price"].is_none() {
        bail!("import_bad_header");
    }
    let cats: Vec<Category> = ctx.db.all("SELECT * FROM categories WHERE kind <> 'PHONE'", [])?;
    let known: HashMap<String, String> = cats.into_iter().map(|c| (c.name.to_lowercase(), c.name)).collect();
    let mut stmt = ctx.db.prepare_cached("SELECT barcode FROM products WHERE barcode IS NOT NULL AND deleted_at IS NULL")?;
    let live: HashSet<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut seen: HashSet<String> = HashSet::new();
    let mut rows: Vec<ImportRow> = Vec::new();

    for (i, cells) in sheet.iter().enumerate().skip(1) {
        if cells.iter().all(|c| text(Some(c)).is_empty()) {
            continue; // blank line
        }
        let get = |key: &str| idx[key].and_then(|i| cells.get(i));
        let mut errors: Vec<String> = Vec::new();
        let name = text(get("name"));
        let category_text = text(get("category"));
        let barcode_text = text(get("barcode"));
        let barcode_text = barcode_text.strip_suffix(".0").map(str::to_owned).unwrap_or(barcode_text); // Excel turns 6130000000012 into a number
        let price = amount(get("price"));
        let cost = amount(get("cost"));
        let quantity: f64 = match get("quantity") {
            None | Some(Cell::Null) => 0.0,
            Some(Cell::Text(t)) if t.is_empty() => 0.0,
            Some(c) => {
                let s = text(Some(c)).replacen(',', ".", 1);
                if s.trim().is_empty() {
                    0.0
                } else {
                    s.trim().parse::<f64>().unwrap_or(f64::NAN)
                }
            }
        };
        if name.is_empty() {
            errors.push("name_required".into());
        }
        if category_text.is_empty() {
            errors.push("category_required".into());
        }
        if !matches!(price, Amount::Ok(_)) {
            errors.push("price_invalid".into());
        }
        if matches!(cost, Amount::Bad) {
            errors.push("cost_invalid".into());
        }
        if !(quantity.is_finite() && quantity.fract() == 0.0 && (0.0..=1_000_000.0).contains(&quantity)) {
            errors.push("quantity_invalid".into());
        }
        if !barcode_text.is_empty() {
            if !BARCODE.is_match(&barcode_text) {
                errors.push("barcode_invalid".into());
            } else if seen.contains(&barcode_text) {
                errors.push("barcode_repeated".into());
            } else if live.contains(&barcode_text) {
                errors.push("barcode_exists".into());
            }
            seen.insert(barcode_text.clone());
        }
        let existing = known.get(&category_text.to_lowercase());
        rows.push(ImportRow {
            line: i as i64 + 1,
            name,
            category: existing.cloned().unwrap_or_else(|| category_text.clone()),
            new_category: !category_text.is_empty() && existing.is_none(),
            barcode: (!barcode_text.is_empty()).then_some(barcode_text),
            quantity: if quantity.is_finite() { quantity } else { 0.0 },
            cost: if let Amount::Ok(c) = cost { c } else { 0 },
            price: if let Amount::Ok(p) = price { p } else { 0 },
            errors,
        });
    }
    let invalid = rows.iter().filter(|r| !r.errors.is_empty()).count() as i64;
    let mut new_categories: Vec<String> = Vec::new();
    for r in rows.iter().filter(|r| r.errors.is_empty() && r.new_category) {
        if !new_categories.contains(&r.category) {
            new_categories.push(r.category.clone());
        }
    }
    Ok(ImportPreview { valid: rows.len() as i64 - invalid, invalid, rows, new_categories })
}

row! { pub struct ImportResult { pub imported: i64, pub skipped: i64, pub categories_created: i64 } }

/// Imports every valid row in one transaction. Rows with errors are left out (the preview listed them).
pub fn import_items(ctx: &Ctx, path: &str) -> Res<ImportResult> {
    let preview = preview_items(ctx, path)?;
    ctx.tx(|| {
        let cats: Vec<Category> = ctx.db.all("SELECT * FROM categories WHERE kind <> 'PHONE'", [])?;
        let mut ids: HashMap<String, String> = cats.into_iter().map(|c| (c.name.to_lowercase(), c.id)).collect();
        let (mut created, mut imported) = (0, 0);
        for r in preview.rows.iter().filter(|r| r.errors.is_empty()) {
            let key = r.category.to_lowercase();
            let category_id = match ids.get(&key) {
                Some(id) => id.clone(),
                None => {
                    let id = uuid();
                    let t = now();
                    ctx.db.exec("INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES (?1, ?2, 'ACCESSORY', ?3, ?3)", params![id, r.category, t])?;
                    ids.insert(key, id.clone());
                    created += 1;
                    id
                }
            };
            // A barcode can have appeared since the preview: check again inside the transaction.
            if let Some(b) = &r.barcode {
                if ctx.db.exists("SELECT 1 FROM products WHERE barcode = ?1 AND deleted_at IS NULL", [b])? {
                    continue;
                }
            }
            let id = uuid();
            let t = now();
            let qty = r.quantity as i64;
            ctx.db.exec(
                "INSERT INTO products (id, kind, brand_id, category_id, name, barcode, sale_price, min_price, avg_cost, quantity, low_stock_threshold, is_repair_part, default_warranty_days, created_at, updated_at)
                 VALUES (?1, 'ITEM', NULL, ?2, ?3, ?4, ?5, 0, ?6, ?7, 0, 0, 0, ?8, ?8)",
                params![id, category_id, r.name, r.barcode, r.price, r.cost, qty, t],
            )?;
            // Quantity arrives with its movement, like every other change of stock.
            if qty > 0 {
                write_movement(ctx, Movement { product_id: &id, unit_id: None, kind: "ADJUSTMENT", quantity: qty, unit_cost: r.cost, reason: "IMPORT", ref_table: Some("products"), ref_id: Some(&id), at: None })?;
            }
            imported += 1;
        }
        Ok(ImportResult { imported, skipped: preview.rows.len() as i64 - imported, categories_created: created })
    })
}

/// The template to fill in: the six columns and two example rows.
pub fn template_file() -> Res<Vec<u8>> {
    build_xlsx(
        "Accessories",
        &TEMPLATE_HEADERS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
        &[
            vec![
                Cell::Text("Chargeur rapide 25W Type-C".into()),
                Cell::Text("Chargeurs".into()),
                Cell::Text("6130000000012".into()),
                Cell::Num(20.0),
                Cell::Num(1100.0),
                Cell::Num(1800.0),
            ],
            vec![
                Cell::Text("Coque silicone Galaxy A15".into()),
                Cell::Text("Coques".into()),
                Cell::Text(String::new()),
                Cell::Num(15.0),
                Cell::Num(350.0),
                Cell::Num(600.0),
            ],
        ],
        &[4, 5],
    )
}

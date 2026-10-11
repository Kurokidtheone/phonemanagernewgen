// Sample data for testing by hand: brands, phone models and units, accessories and parts, suppliers, customers,
// employees and Flexy services. Loaded from Settings > System, only into an empty catalogue. Stock arrives through
// four purchases that stay unpaid (supplier debt), so every quantity has its stock_movements row and no cash moves.
use super::codes::{ean13_check_digit, make_imei};
use super::{counts, employees, repairs, sales, services};
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, invalid, Res};
use crate::rows::{PhoneUnit, Product};
use crate::util::{js_round, ms_to_iso, now, uuid, DAY_MS};
use crate::valid::Validate;
use rusqlite::params;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::collections::HashMap;

/// mulberry32, the same sequence as the Electron app's seed.
struct Rng(i32);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5u32 as i32);
        let s = self.0;
        let mut t = (s ^ ((s as u32) >> 15) as i32).wrapping_mul(1 | s);
        t = (t.wrapping_add((t ^ ((t as u32) >> 7) as i32).wrapping_mul(61 | t))) ^ t;
        ((t ^ ((t as u32) >> 14) as i32) as u32) as f64 / 4294967296.0
    }
    fn pick<'a, T>(&mut self, list: &'a [T]) -> &'a T {
        &list[(self.next() * list.len() as f64).floor() as usize]
    }
}

fn dzd(amount: f64) -> i64 {
    js_round(amount) * 100
}
fn round100(amount: f64) -> f64 {
    js_round(amount / 100.0) as f64 * 100.0
}
fn round50(amount: f64) -> f64 {
    js_round(amount / 50.0) as f64 * 50.0
}
fn ean13(body12: &str) -> String {
    format!("{body12}{}", ean13_check_digit(body12))
}

/// Like Zod's schema.parse: defaults, trimming and checks.
fn parse<T: DeserializeOwned + Validate>(v: Value) -> Res<T> {
    let mut t: T = serde_json::from_value(v).map_err(|e| invalid(e.to_string()))?;
    t.validate()?;
    Ok(t)
}

const BRANDS: &[&str] = &["Samsung", "Apple", "Xiaomi", "Oppo", "Realme", "Infinix", "Tecno", "Condor"];
const MODELS: &[(&str, &str, &str, f64)] = &[
    ("Samsung", "Galaxy A05", "64GB", 17500.0),
    ("Samsung", "Galaxy A15", "128GB", 28500.0),
    ("Samsung", "Galaxy A25", "128GB", 41000.0),
    ("Samsung", "Galaxy A35", "256GB", 62000.0),
    ("Samsung", "Galaxy S24", "256GB", 165000.0),
    ("Apple", "iPhone 13", "128GB", 105000.0),
    ("Apple", "iPhone 14", "128GB", 128000.0),
    ("Apple", "iPhone 15", "128GB", 158000.0),
    ("Apple", "iPhone 15 Pro", "256GB", 225000.0),
    ("Xiaomi", "Redmi A3", "64GB", 16500.0),
    ("Xiaomi", "Redmi 13C", "128GB", 24500.0),
    ("Xiaomi", "Redmi Note 13", "256GB", 43000.0),
    ("Xiaomi", "Poco X6", "256GB", 58000.0),
    ("Oppo", "A18", "128GB", 25500.0),
    ("Oppo", "A38", "128GB", 31500.0),
    ("Oppo", "Reno 11", "256GB", 78000.0),
    ("Realme", "C53", "128GB", 23500.0),
    ("Realme", "C55", "256GB", 31000.0),
    ("Realme", "12 Pro", "256GB", 69000.0),
    ("Infinix", "Smart 8", "64GB", 16000.0),
    ("Infinix", "Hot 40i", "128GB", 22500.0),
    ("Infinix", "Note 40", "256GB", 39500.0),
    ("Tecno", "Spark 20", "128GB", 23000.0),
    ("Tecno", "Camon 30", "256GB", 48000.0),
    ("Condor", "Allure M3 Plus", "64GB", 14500.0),
];
const COLORS: &[&str] = &["Noir", "Bleu", "Blanc", "Vert", "Gris"];
const ACCESSORIES: &[(&str, &str, f64)] = &[
    ("Chargeurs", "Chargeur rapide 25W Type-C", 1800.0),
    ("Chargeurs", "Chargeur 20W iPhone", 2500.0),
    ("Chargeurs", "Chargeur voiture 2 USB", 900.0),
    ("Chargeurs", "Chargeur sans fil 15W", 2800.0),
    ("Câbles", "Câble USB-C 1m", 500.0),
    ("Câbles", "Câble Lightning 1m", 900.0),
    ("Câbles", "Câble Micro-USB 1m", 350.0),
    ("Câbles", "Câble USB-C vers USB-C 2m", 1100.0),
    ("Coques", "Coque silicone Galaxy A15", 600.0),
    ("Coques", "Coque silicone iPhone 13", 800.0),
    ("Coques", "Coque transparente iPhone 15", 900.0),
    ("Coques", "Coque Redmi Note 13", 600.0),
    ("Coques", "Coque Oppo A18", 600.0),
    ("Coques", "Coque Realme C55", 600.0),
    ("Coques", "Pochette universelle", 700.0),
    ("Protections écran", "Verre trempé Galaxy A15", 400.0),
    ("Protections écran", "Verre trempé iPhone 13", 600.0),
    ("Protections écran", "Verre trempé iPhone 15", 700.0),
    ("Protections écran", "Verre trempé Redmi Note 13", 400.0),
    ("Protections écran", "Verre trempé Oppo A18", 400.0),
    ("Protections écran", "Verre trempé Infinix Hot 40i", 400.0),
    ("Audio", "Écouteurs filaires jack 3.5", 600.0),
    ("Audio", "Écouteurs USB-C", 1200.0),
    ("Audio", "Écouteurs Bluetooth TWS", 3500.0),
    ("Audio", "Casque Bluetooth", 4500.0),
    ("Audio", "Haut-parleur Bluetooth", 3800.0),
    ("Énergie", "Power bank 10000mAh", 3200.0),
    ("Énergie", "Power bank 20000mAh", 5200.0),
    ("Divers", "Support voiture", 1200.0),
    ("Divers", "Carte mémoire 64GB", 1800.0),
    ("Divers", "Carte mémoire 128GB", 2900.0),
    ("Divers", "Clé USB 32GB", 1100.0),
    ("Divers", "Selfie stick", 1000.0),
    ("Divers", "Adaptateur OTG", 350.0),
    ("Divers", "Support téléphone bureau", 800.0),
    ("Divers", "Montre connectée", 6500.0),
    ("Divers", "Lampe anneau", 2200.0),
];
const PARTS: &[(&str, f64)] = &[
    ("Écran Galaxy A15", 9500.0),
    ("Écran Galaxy A25", 13500.0),
    ("Écran iPhone 13", 28000.0),
    ("Écran iPhone 11", 14000.0),
    ("Écran Redmi 13C", 6500.0),
    ("Écran Redmi Note 13", 11000.0),
    ("Écran Oppo A18", 6800.0),
    ("Écran Realme C53", 6500.0),
    ("Écran Infinix Hot 40i", 6000.0),
    ("Écran Tecno Spark 20", 6200.0),
    ("Batterie Galaxy A15", 2800.0),
    ("Batterie iPhone 13", 5500.0),
    ("Batterie iPhone 11", 4200.0),
    ("Batterie Redmi Note 13", 3000.0),
    ("Batterie Oppo A18", 2800.0),
    ("Batterie Infinix Hot 40i", 2600.0),
    ("Connecteur de charge Type-C", 900.0),
    ("Connecteur de charge Lightning", 1500.0),
    ("Connecteur de charge Micro-USB", 600.0),
    ("Haut-parleur sonnerie universel", 500.0),
    ("Vitre arrière iPhone 13", 4500.0),
    ("Caméra arrière Galaxy A15", 3200.0),
    ("Nappe bouton power", 700.0),
];
const SUPPLIERS: &[(&str, &str, &str, Option<&str>)] = &[
    ("Tech Import Alger", "0550 12 34 56", "COMPANY", None),
    ("Mobile Distribution Oran", "0661 22 33 44", "COMPANY", None),
    ("Gros Télécom Sétif", "0770 55 66 77", "COMPANY", None),
    ("Karim Benali", "0555 98 76 54", "INDIVIDUAL", Some("104512367")),
];
const FIRST: &[&str] = &[
    "Mohamed", "Ahmed", "Yacine", "Karim", "Sofiane", "Amine", "Walid", "Riad", "Nabil", "Bilal", "Samir", "Hichem", "Fatima", "Amel", "Samira", "Nadia",
    "Lynda", "Meriem", "Sarah", "Imane",
];
const LAST: &[&str] = &["Benali", "Bouzid", "Haddad", "Messaoudi", "Cherif", "Brahimi", "Khelifi", "Mansouri", "Belkacem", "Saidi", "Ferhat", "Zerrouki"];

struct SeedPurchase {
    id: String,
    supplier_id: String,
    date: String,
    total: i64,
}

pub fn seed_sample_data(ctx: &Ctx) -> Res<()> {
    // The popular brands may already be there: the demo data needs an empty catalogue of products.
    if ctx.db.exists("SELECT 1 FROM products LIMIT 1", [])? {
        bail!("seed_not_empty");
    }
    let mut rand = Rng(2026);
    let now_ms = ctx.now_ms();
    let days_ago = |n: i64| ms_to_iso(now_ms - n * DAY_MS);
    ctx.tx(|| {
        let t = now();
        let mut stmt = ctx.db.prepare_cached("SELECT name, id FROM brands")?;
        let existing: HashMap<String, String> = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?.to_lowercase(), r.get::<_, String>(1)?)))?.collect::<Result<_, _>>()?;
        let mut brand_ids: HashMap<&str, String> = HashMap::new();
        for name in BRANDS {
            let id = match existing.get(&name.to_lowercase()) {
                Some(id) => id.clone(),
                None => {
                    let id = uuid();
                    ctx.db.exec("INSERT INTO brands (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", params![id, name, t])?;
                    id
                }
            };
            brand_ids.insert(name, id);
        }

        let mut categories: Vec<(String, String, &str)> = vec![(uuid(), "Smartphones".into(), "PHONE")];
        for (c, _, _) in ACCESSORIES {
            if !categories.iter().any(|x| x.1 == *c) {
                categories.push((uuid(), c.to_string(), "ACCESSORY"));
            }
        }
        categories.push((uuid(), "Pièces détachées".into(), "PART"));
        for (id, name, kind) in &categories {
            ctx.db.exec("INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)", params![id, name, kind, t])?;
        }
        let category = |name: &str| categories.iter().find(|c| c.1 == name).unwrap().0.clone();

        let supplier_ids: Vec<String> = SUPPLIERS.iter().map(|_| uuid()).collect();
        for (i, (name, phone, kind, doc)) in SUPPLIERS.iter().enumerate() {
            ctx.db.exec(
                "INSERT INTO suppliers (id, name, phone, address, kind, id_document_number, notes, created_at, updated_at) VALUES (?1, ?2, ?3, 'Algérie', ?4, ?5, '', ?6, ?6)",
                params![supplier_ids[i], name, phone, kind, doc, t],
            )?;
        }
        // One purchase per supplier; every line below is added to it.
        let mut purchases: Vec<SeedPurchase> =
            supplier_ids.iter().enumerate().map(|(i, s)| SeedPurchase { id: uuid(), supplier_id: s.clone(), date: days_ago(30 - i as i64 * 6), total: 0 }).collect();
        // (id, purchase, product, unit, quantity, unit cost)
        let mut lines: Vec<(String, String, String, Option<String>, i64, i64)> = Vec::new();
        let mut moves: Vec<(String, Option<String>, i64, i64, String, String)> = Vec::new();
        let mut add_line = |n: usize, product_id: &str, quantity: i64, unit_cost: i64, unit_id: Option<String>, purchases: &mut Vec<SeedPurchase>| -> String {
            let len = purchases.len();
            let p = &mut purchases[n % len];
            let id = uuid();
            lines.push((id.clone(), p.id.clone(), product_id.to_owned(), unit_id.clone(), quantity, unit_cost));
            moves.push((product_id.to_owned(), unit_id, quantity, unit_cost, p.id.clone(), p.date.clone()));
            p.total += quantity * unit_cost;
            id
        };

        // Phone models and their units.
        struct M {
            id: String,
            brand: &'static str,
            name: &'static str,
            storage: &'static str,
            price: i64,
            cost: i64,
            color: &'static str,
        }
        let models: Vec<M> = MODELS
            .iter()
            .enumerate()
            .map(|(i, (brand, name, storage, price))| M { id: uuid(), brand, name, storage, price: dzd(*price), cost: dzd(round100(price * 0.86)), color: COLORS[i % COLORS.len()] })
            .collect();
        let mut units: Vec<PhoneUnit> = Vec::new();
        for i in 0..40usize {
            let m = &models[i % models.len()];
            let condition = if m.brand == "Condor" || i % 3 != 0 { if i % 7 == 0 { "REFURBISHED" } else { "NEW" } } else { "USED" };
            let used = condition != "NEW";
            let factor = match condition {
                "USED" => 0.7,
                "REFURBISHED" => 0.8,
                _ => 1.0,
            };
            let cost = dzd(round100((m.cost as f64 / 100.0) * factor));
            let tail = format!("{:08}", 100000 + i * 7919);
            let imei1 = make_imei(&format!("35{:02}{:02}{}", i % 100, 10 + (i % models.len()), &tail[tail.len() - 8..]));
            let unit_id = uuid();
            let battery = if used { Some(78 + (rand.next() * 18.0).floor() as i64) } else { None };
            let grade = if used { Some(rand.pick(&["A", "B", "C"]).to_string()) } else { None };
            let price_factor = match condition {
                "USED" => 0.82,
                "REFURBISHED" => 0.9,
                _ => 1.0,
            };
            let line_id = add_line(i, &m.id, 1, cost, Some(unit_id.clone()), &mut purchases);
            units.push(PhoneUnit {
                id: unit_id,
                product_id: m.id.clone(),
                imei2: if i % 2 == 0 { Some(make_imei(&format!("36{}", &imei1[2..14]))) } else { None },
                imei1: Some(imei1),
                condition: condition.into(),
                battery_health: battery,
                grade,
                cost,
                sale_price: dzd(round100((m.price as f64 / 100.0) * price_factor)),
                status: "IN_STOCK".into(),
                notes: String::new(),
                source_purchase_line_id: Some(line_id),
                deleted_at: None,
                created_at: now(),
                updated_at: now(),
            });
        }
        let mut unit_counts: HashMap<String, (i64, i64)> = HashMap::new();
        for u in &units {
            let e = unit_counts.entry(u.product_id.clone()).or_insert((0, 0));
            e.0 += 1;
            e.1 += u.cost;
        }
        for m in &models {
            let c = unit_counts.get(&m.id);
            ctx.db.exec(
                "INSERT INTO products (id, kind, brand_id, category_id, name, model, storage, color, barcode, sale_price, min_price, avg_cost, quantity, low_stock_threshold, default_warranty_days, created_at, updated_at)
                 VALUES (?1, 'PHONE_MODEL', ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?13)",
                params![
                    m.id,
                    brand_ids[m.brand],
                    category("Smartphones"),
                    format!("{} {}", m.brand, m.name),
                    m.name,
                    m.storage,
                    m.color,
                    m.price,
                    dzd(round100((m.price as f64 / 100.0) * 0.93)),
                    c.map(|c| js_round(c.1 as f64 / c.0 as f64)).unwrap_or(m.cost),
                    c.map(|c| c.0).unwrap_or(0),
                    if m.brand == "Apple" { 365 } else { 180 },
                    now()
                ],
            )?;
        }

        // Accessories and parts, 60 in all, each with an EAN-13 barcode.
        let items: Vec<(&str, &str, f64, bool)> = ACCESSORIES.iter().map(|(c, n, p)| (*c, *n, *p, false)).chain(PARTS.iter().map(|(n, p)| ("Pièces détachées", *n, *p, true))).collect();
        let mut item_ids: Vec<String> = Vec::new();
        for (i, (cat, name, price, part)) in items.iter().enumerate() {
            let id = uuid();
            let cost = dzd(round50(price * if *part { 0.7 } else { 0.62 }));
            let quantity = 4 + (rand.next() * 37.0).floor() as i64;
            ctx.db.exec(
                "INSERT INTO products (id, kind, brand_id, category_id, name, barcode, sale_price, min_price, avg_cost, quantity, low_stock_threshold, is_repair_part, default_warranty_days, created_at, updated_at)
                 VALUES (?1, 'ITEM', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 5, ?9, ?10, ?11, ?11)",
                params![id, category(cat), name, ean13(&format!("613{:09}", 100000 + i)), dzd(*price), dzd(round50(price * 0.9)), cost, quantity, part, if *part { 30 } else { 0 }, now()],
            )?;
            add_line(i, &id, quantity, cost, None, &mut purchases);
            item_ids.push(id);
        }

        for (i, p) in purchases.iter().enumerate() {
            ctx.db.exec(
                "INSERT INTO purchases (id, supplier_id, date, total, paid, note, invoice_file, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, NULL, ?6, ?6)",
                params![p.id, p.supplier_id, p.date, p.total, format!("Seed {}", i + 1), now()],
            )?;
        }
        // Lines first without the unit link: units reference lines and lines reference units.
        for (id, purchase, product, _, qty, cost) in &lines {
            ctx.db.exec(
                "INSERT INTO purchase_lines (id, purchase_id, product_id, unit_id, quantity, unit_cost, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?6)",
                params![id, purchase, product, qty, cost, now()],
            )?;
        }
        for u in &units {
            ctx.db.exec(
                "INSERT INTO phone_units (id, product_id, imei1, imei2, condition, battery_health, grade, cost, sale_price, status, notes, source_purchase_line_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'IN_STOCK', '', ?10, ?11, ?11)",
                params![u.id, u.product_id, u.imei1, u.imei2, u.condition, u.battery_health, u.grade, u.cost, u.sale_price, u.source_purchase_line_id, u.created_at],
            )?;
        }
        for (id, _, _, unit, _, _) in lines.iter().filter(|l| l.3.is_some()) {
            ctx.db.exec("UPDATE purchase_lines SET unit_id = ?1 WHERE id = ?2", params![unit, id])?;
        }
        for (product, unit, qty, cost, purchase, at) in &moves {
            ctx.db.exec(
                "INSERT INTO stock_movements (id, product_id, unit_id, type, quantity, unit_cost, reason, ref_table, ref_id, at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'PURCHASE', ?4, ?5, '', 'purchases', ?6, ?7, ?8, ?8)",
                params![uuid(), product, unit, qty, cost, purchase, at, now()],
            )?;
        }

        for i in 0..30usize {
            let phone = format!("0{}{:08}", rand.pick(&["5", "6", "7"]), (rand.next() * 1e8).floor() as i64);
            ctx.db.exec(
                "INSERT INTO customers (id, name, phone, whatsapp, address, notes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '', '', ?5, ?5)",
                params![uuid(), format!("{} {}", FIRST[i % FIRST.len()], LAST[(i * 5) % LAST.len()]), phone, if i % 3 == 0 { phone.clone() } else { String::new() }, now()],
            )?;
        }
        for (name, role, phone, salary, sales_bp, repairs_bp) in [
            ("Yacine Boudiaf", "SELLER", "0550 00 00 01", 45000.0, 500, 0),
            ("Amel Rahmani", "CASHIER", "0660 00 00 02", 42000.0, 0, 0),
            ("Mourad Lakhal", "TECHNICIAN", "0770 00 00 03", 60000.0, 0, 1000),
        ] {
            ctx.db.exec(
                "INSERT INTO employees (id, name, role, phone, monthly_salary, commission_sales_bp, commission_repairs_bp, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![uuid(), name, role, phone, dzd(salary), sales_bp, repairs_bp, now()],
            )?;
        }

        services::ensure_default_services(ctx)?; // Flexy Mobilis, Djezzy and Ooredoo, with a 3% margin

        // Repairs and a few sales go through the services, so every rule (stock, cash, debt) applies.
        let mut stmt = ctx.db.prepare_cached("SELECT id FROM customers ORDER BY name")?;
        let people: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let mut stmt = ctx.db.prepare_cached("SELECT id FROM employees ORDER BY rowid")?;
        let staff: Vec<String> = stmt.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let spare: Vec<Product> = ctx.db.all("SELECT * FROM products WHERE is_repair_part = 1 ORDER BY rowid", [])?;
        let in_days = |n: i64| ms_to_iso(now_ms + n * DAY_MS);
        #[allow(clippy::type_complexity)]
        let tickets: [(&str, &str, &str, f64, f64, i64, Option<&str>); 6] = [
            ("Samsung", "Galaxy A15", "Écran cassé", 8000.0, 2000.0, 3, None),
            ("Apple", "iPhone 13", "Batterie qui se vide vite", 6500.0, 0.0, 2, Some("DIAGNOSING")),
            ("Xiaomi", "Redmi Note 13", "Ne charge plus", 3500.0, 1000.0, 5, Some("WAITING_PARTS")),
            ("Oppo", "A18", "Le tactile ne répond plus", 7000.0, 2500.0, 1, Some("READY")),
            ("Infinix", "Hot 40i", "Tombé dans l'eau", 5000.0, 1000.0, -2, None), // overdue
            ("Realme", "C53", "Haut-parleur muet", 2500.0, 500.0, 0, Some("DELIVERED")),
        ];
        for (i, (brand, model, fault, estimate, deposit, due, state)) in tickets.iter().enumerate() {
            let mut flags = vec!["POWERS_ON"];
            if i == 0 {
                flags.push("SCREEN_CRACKED");
            }
            let made = repairs::create_repair(
                ctx,
                &parse(json!({
                    "customerId": people[i],
                    "brand": brand,
                    "model": model,
                    "fault": fault,
                    "arrival": { "flags": flags, "note": "" },
                    "accessories": { "items": if i % 2 == 0 { vec!["SIM", "CASE"] } else { vec![] }, "note": "" },
                    "estimatedPrice": dzd(*estimate),
                    "deposit": dzd(*deposit),
                    "employeeId": staff.get(2),
                    "dueAt": in_days(*due),
                }))?,
            )?;
            if let Some(s) = state.filter(|s| *s != "DELIVERED") {
                repairs::set_status(ctx, &parse(json!({ "id": made.id, "status": s }))?)?;
            }
            if i < 4 {
                if let Some(p) = spare.get(i) {
                    repairs::add_part(ctx, &parse(json!({ "repairId": made.id, "productId": p.id, "quantity": 1 }))?)?;
                }
            }
            if *state == Some("DELIVERED") {
                repairs::add_part(ctx, &parse(json!({ "repairId": made.id, "productId": spare[4].id, "quantity": 1 }))?)?;
                // Delivered with 1,000 DA left to pay, so the customer page shows a repair debt.
                repairs::deliver(ctx, &parse(json!({ "id": made.id, "finalPrice": dzd(*estimate), "paid": dzd(estimate - deposit - 1000.0), "warrantyDays": 30 }))?)?;
            }
        }

        // Two sales on credit (one old enough to be overdue) and one paid in full.
        let unit: PhoneUnit = ctx.db.get("SELECT * FROM phone_units WHERE status = 'IN_STOCK' ORDER BY rowid LIMIT 1", [])?.unwrap();
        let sell = |customer: &str, lines: Value, paid: f64, ago: i64| -> Res<()> {
            let made = sales::create_sale(ctx, &parse(json!({ "customerId": customer, "employeeId": staff.first(), "paid": dzd(paid), "lines": lines }))?, Default::default())?;
            if ago > 0 {
                ctx.db.exec("UPDATE sales SET date = ?1 WHERE id = ?2", params![ms_to_iso(now_ms - ago * DAY_MS), made.id])?;
            }
            Ok(())
        };
        sell(&people[6], json!([{ "unitId": unit.id, "unitPrice": unit.sale_price, "warrantyDays": 180 }]), unit.sale_price as f64 / 100.0, 0)?;
        let part_or_item = spare.get(5).map(|p| p.id.clone()).unwrap_or_else(|| item_ids[0].clone());
        sell(&people[7], json!([{ "productId": part_or_item, "quantity": 2, "unitPrice": dzd(1500.0) }]), 1000.0, 45)?;
        sell(&people[8], json!([{ "productId": item_ids[1], "quantity": 1, "unitPrice": dzd(900.0) }]), 0.0, 3)?;

        // An advance to the seller, and last month's salary with part of it deducted.
        if let Some(seller) = staff.first() {
            let when = now();
            employees::add_advance(ctx, &parse(json!({ "employeeId": seller, "kind": "GIVE", "amount": dzd(5000.0), "note": "Avance", "date": when }))?)?;
            employees::add_advance(ctx, &parse(json!({ "employeeId": seller, "kind": "GIVE", "amount": dzd(3000.0), "note": "Avance", "date": when }))?)?;
            employees::pay_salary(ctx, &parse(json!({ "employeeId": seller, "amount": dzd(45000.0), "deduct": dzd(5000.0), "note": "Salaire", "date": ms_to_iso(now_ms - 30 * DAY_MS) }))?)?;
        }

        // Flexy and one other service. Their cash waits, with the rest, for the first day opened in the drawer.
        let flexy: Vec<_> = services::list_services(ctx, false)?.into_iter().filter(|s| s.kind == "FLEXY").collect();
        let sim = services::create_service(ctx, &parse(json!({ "name": "Activation SIM", "defaultPrice": dzd(500.0) }))?)?;
        for (i, da) in [500.0, 1000.0, 2000.0].iter().enumerate() {
            services::sell_service(ctx, &parse(json!({ "serviceId": flexy[i % flexy.len()].id, "amount": dzd(*da), "phoneNumber": format!("055{}", 1000000 + i) }))?)?;
        }
        services::sell_service(ctx, &parse(json!({ "serviceId": sim.id, "amount": dzd(500.0), "cost": dzd(100.0) }))?)?;

        // Two finished stock counts, not applied: accessories with two more than the system says, and phones with one not found.
        let item_count = counts::start_count(ctx, &parse(json!({ "scope": "ITEMS" }))?)?;
        let qty: i64 = ctx.db.val("SELECT quantity FROM products WHERE id = ?1", [&item_ids[0]])?;
        counts::count_item(ctx, &item_count.id, &item_ids[0], qty + 2)?;
        counts::close_count(ctx, &item_count.id, false)?;
        let phone_count = counts::start_count(ctx, &parse(json!({ "scope": "PHONES" }))?)?;
        let shelf: Vec<PhoneUnit> = ctx.db.all("SELECT * FROM phone_units WHERE status = 'IN_STOCK' ORDER BY rowid", [])?;
        for u in shelf.iter().skip(1) {
            if let Some(imei) = &u.imei1 {
                counts::scan_unit(ctx, &phone_count.id, imei)?;
            }
        }
        counts::close_count(ctx, &phone_count.id, false)?;
        Ok(())
    })
}

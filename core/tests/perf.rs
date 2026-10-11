// Performance check: 5,000 phone units, 2,000 items, 20,000 sales.
// Run on demand:  npm run perf   (ignored in normal runs: it takes a few seconds to build the data; use --release)
// Budgets: every list under 200 ms (query + JSON, what crosses to the window), the New sale search under 50 ms.
mod common;
use common::*;
use psm_core::util::uuid;
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Instant;

const DAY: i64 = 86_400_000;

fn iso(ms: i64) -> String {
    psm_core::util::ms_to_iso(ms)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn build(app: &App) {
    app.ok(|c| {
        c.tx(|| {
            let db = c.db;
            let at = iso(now_ms());
            let (brand, phone_cat, item_cat) = (uuid(), uuid(), uuid());
            db.execute("INSERT INTO brands VALUES (?,?,?,?)", params![brand, "Samsung", at, at])?;
            db.execute("INSERT INTO categories VALUES (?,?,?,?,?)", params![phone_cat, "Smartphones", "PHONE", at, at])?;
            db.execute("INSERT INTO categories VALUES (?,?,?,?,?)", params![item_cat, "Accessoires", "ACCESSORY", at, at])?;
            let mut product = db.prepare(
                "INSERT INTO products (id, kind, brand_id, category_id, name, model, storage, color, barcode, sale_price, min_price, avg_cost, quantity, low_stock_threshold, is_repair_part, default_warranty_days, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, '128GB', 'Noir', ?, ?, 0, ?, ?, 5, ?, 0, ?, ?)",
            )?;
            let mut models = Vec::new();
            for i in 0..100 {
                let id = uuid();
                product.execute(params![id, "PHONE_MODEL", brand, phone_cat, format!("Samsung Galaxy M{i}"), format!("Galaxy M{i}"), None::<String>, 5_000_000, 4_000_000, 0, 0, at, at])?;
                models.push(id);
            }
            let mut items = Vec::new();
            for i in 0..2000i64 {
                let id = uuid();
                let barcode = (6_130_000_000_000i64 + i).to_string();
                product.execute(params![id, "ITEM", None::<String>, item_cat, format!("Accessoire {i} chargeur câble coque"), "", barcode, 180_000, 110_000, 1_000_000, (i % 40 == 0) as i64, at, at])?;
                items.push(id);
            }
            let mut unit = db.prepare("INSERT INTO phone_units (id, product_id, imei1, condition, cost, sale_price, status, notes, created_at, updated_at) VALUES (?, ?, ?, ?, 4000000, 5000000, ?, '', ?, ?)")?;
            let mut movement = db.prepare("INSERT INTO stock_movements (id, product_id, unit_id, type, quantity, unit_cost, reason, at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 4000000, '', ?, ?, ?)")?;
            let mut sold = Vec::new();
            for i in 0..5000i64 {
                let id = uuid();
                let m = &models[(i % 100) as usize];
                let in_stock = i < 4000;
                let imei = make_imei(&(35_000_000_000_000i64 + i).to_string());
                unit.execute(params![id, m, imei, if i % 3 == 0 { "USED" } else { "NEW" }, if in_stock { "IN_STOCK" } else { "SOLD" }, at, at])?;
                movement.execute(params![uuid(), m, id, "PURCHASE", 1, iso(now_ms() - (i % 120) * DAY), at, at])?;
                if !in_stock {
                    sold.push((id, m.clone()));
                }
            }
            let mut customers = Vec::new();
            let mut customer = db.prepare("INSERT INTO customers (id, name, phone, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")?;
            for i in 0..2000 {
                let id = uuid();
                customer.execute(params![id, format!("Client {i}"), format!("0550{}", 100000 + i), at, at])?;
                customers.push(id);
            }
            let mut sale = db.prepare(
                "INSERT INTO sales (id, receipt_number, customer_id, date, subtotal, discount, total, paid, trade_in_value, status, created_at, updated_at, payment_method)
                 VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 'COMPLETED', ?, ?, 'CASH')",
            )?;
            let mut line = db.prepare("INSERT INTO sale_lines (id, sale_id, product_id, unit_id, quantity, unit_price, discount, unit_cost_at_sale, warranty_days, returned_quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?)")?;
            for i in 0..20_000i64 {
                let id = uuid();
                let date = iso(now_ms() - (i % 365) * DAY - (i % 24) * 3_600_000);
                let phone = sold.get(i as usize);
                let total = if phone.is_some() { 5_000_000 } else { 360_000 };
                // One in ten sales is on credit, so debts, ageing and the customer list have real work to do.
                let paid = if i % 10 == 0 { total / 2 } else { total };
                let who = if i % 3 == 0 { Some(&customers[(i % 2000) as usize]) } else { None };
                sale.execute(params![id, format!("2026-{:06}", i + 1), who, date, total, total, paid, at, at])?;
                match phone {
                    Some((u, p)) => line.execute(params![uuid(), id, p, u, 1, 5_000_000, 4_000_000, at, at])?,
                    None => line.execute(params![uuid(), id, items[(i % 2000) as usize], None::<String>, 2, 180_000, 110_000, at, at])?,
                };
            }
            Ok(())
        })
    });
}

/// The median of 5 runs after a warm-up, in ms: the API call with its JSON answer.
fn time(mut f: impl FnMut() -> usize) -> f64 {
    f();
    let mut runs: Vec<f64> = (0..5)
        .map(|_| {
            let t = Instant::now();
            std::hint::black_box(f());
            t.elapsed().as_secs_f64() * 1000.0
        })
        .collect();
    runs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    runs[2]
}

#[test]
#[ignore = "on demand: npm run perf"]
fn performance_with_5000_phones_2000_items_and_20000_sales() {
    let app = fresh();
    let t = Instant::now();
    build(&app);
    // Real services on top of the bulk data, for the screens that need session and repair rows.
    assert!(app.call("cash.open", json!({ "openingFloat": 1_000_000 })).is_ok());
    assert!(app.call("suppliers.create", json!({ "name": "Gros" })).is_ok());
    assert!(app.call("employee.create", json!({ "name": "Yacine", "monthlySalary": 4_500_000 })).is_ok());
    println!("data built in {} ms", t.elapsed().as_millis());

    let data = |channel: &str, payload: Value| app.call(channel, payload).data().cloned().unwrap_or_else(|| panic!("{channel} failed"));
    let customer = data("customers.list", Value::Null)[5]["id"].clone();
    let sale = data("sales.list", json!({}))[100]["id"].clone();
    let unit = data("units.list", json!({ "status": "IN_STOCK" }))[0]["id"].clone();
    let (month_start, until) = (iso(now_ms() - 30 * DAY), iso(now_ms() + DAY));
    let period = json!({ "from": month_start, "to": until });
    let with = |extra: Value| merge(period.clone(), extra);

    let lists: Vec<(&str, &str, Value)> = vec![
        ("phones in stock (4,000 rows)", "units.list", json!({ "status": "IN_STOCK" })),
        ("all phones (5,000 rows)", "units.list", json!({})),
        ("items (2,000 rows)", "items.list", json!({})),
        ("phone models", "models.list", Value::Null),
        ("sales history, all (20,000 rows)", "sales.list", json!({})),
        ("sales history, last 30 days", "sales.list", period.clone()),
        ("sales history, unpaid only", "sales.list", json!({ "unpaidOnly": true })),
        ("customers (till list)", "customers.list", Value::Null),
        ("customers overview", "customer.list", json!({})),
        ("customers in debt", "customer.list", json!({ "inDebt": true })),
        ("one customer page", "customer.get", json!({ "id": customer })),
        ("one sale", "sales.get", json!({ "id": sale })),
        ("one phone (timeline)", "units.get", json!({ "id": unit })),
        ("purchases", "purchases.list", json!({})),
        ("suppliers", "suppliers.list", Value::Null),
        ("repairs", "repairs.list", json!({})),
        ("employees", "employee.list", Value::Null),
        ("returns", "returns.list", Value::Null),
        ("cash sessions", "cash.sessions", Value::Null),
        ("Overview", "overview.get", Value::Null),
        ("Analytics, this month: cards", "finance.summary", period.clone()),
        ("Analytics, this month: net profit chart + rows", "finance.series", with(json!({ "metric": "netProfit" }))),
        ("Report: best-selling models", "finance.report", with(json!({ "kind": "bestModels", "slowDays": 60 }))),
        ("Report: slow stock", "finance.report", with(json!({ "kind": "slowStock", "slowDays": 60 }))),
        ("Report: debts ageing", "finance.report", with(json!({ "kind": "debtsAgeing", "slowDays": 60 }))),
    ];
    let mut results = Vec::new();
    let mut slow = Vec::new();
    for (name, channel, payload) in lists {
        let ms = time(|| {
            let r = app.call(channel, payload.clone());
            assert!(r.is_ok(), "{channel}: {:?}", r.error_code());
            serde_json::to_string(&r).unwrap().len()
        });
        if ms >= 200.0 {
            slow.push(name);
        }
        results.push((name.to_owned(), ms));
    }

    // The New sale search filters the lists it already holds on every keystroke.
    let units = data("units.list", json!({ "status": "IN_STOCK" }));
    let items = data("items.list", json!({}));
    let text = |v: &Value, keys: &[&str]| keys.iter().map(|k| v[*k].as_str().unwrap_or_default()).collect::<Vec<_>>().join(" ").to_lowercase();
    let search = |q: &str| {
        let phones =
            units.as_array().unwrap().iter().filter(|u| text(u, &["name", "model", "storage", "color", "imei1", "imei2"]).contains(q)).take(30).count();
        let accessories = items.as_array().unwrap().iter().filter(|i| text(i, &["name", "barcode"]).contains(q)).take(30).count();
        phones + accessories
    };
    let hit = time(|| search("m7"));
    let miss = time(|| search("zzz"));
    results.push(("New sale search (typed text)".into(), hit));
    results.push(("New sale search (no match)".into(), miss));

    for (name, ms) in &results {
        println!("{ms:>8.1} ms  {name}");
    }
    assert!(slow.is_empty(), "over 200 ms: {slow:?}");
    assert!(hit < 50.0 && miss < 50.0, "New sale search over 50 ms");
}

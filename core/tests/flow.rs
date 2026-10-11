// The whole shop day, end to end: buy stock from a supplier, sell with a trade-in on credit, take a customer payment,
// do a repair with a part, sell flexy, add an expense, close the day, check the net profit, back up and restore.
mod common;
use common::*;
use psm_core::services::{backup, balance, cash, catalog, customers, expenses, finance, purchases, repairs, sales, services, stock, suppliers};
use psm_core::util::{ms_to_iso, now_ms};
use serde::Deserialize;
use serde_json::json;

fn hour() -> finance::Period {
    finance::Period { from: ms_to_iso(now_ms() - 3_600_000), to: ms_to_iso(now_ms() + 3_600_000) }
}

#[test]
fn every_figure_stays_consistent_from_the_first_purchase_to_the_restored_backup() {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    let part_cat = app.ok(|c| catalog::create_category(c, "Pièces", "PART")).id;
    let part = app
        .ok(|c| {
            stock::create_item(
                c,
                &parse(json!({ "name": "Écran A15", "categoryId": part_cat, "salePrice": 900_000, "lowStockThreshold": 1, "isRepairPart": true })),
            )
        })
        .id;
    app.ok(services::ensure_default_services);
    app.ok(|c| expenses::ensure_default_categories(c, &["Supplies"]));
    let today = finance::local_day(&now());

    // Open the day with 10,000 DA in the drawer.
    let day = app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 1_000_000 }))));

    // 1. Buy 2 phones (50,000 each) and 10 screens (1,000 each). Pay 40,000 now.
    let supplier = app.ok(|c| suppliers::create_supplier(c, &parse(json!({ "name": "Tech Import", "phone": "0550123456" })))).id;
    let model = json!({ "brandId": samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" });
    let line =
        |n: u32| json!({ "imei1": make_imei(&format!("3500000000000{n}")), "condition": "NEW", "cost": 5_000_000, "salePrice": 6_000_000, "model": model });
    let input: purchases::PurchaseInput = parse(
        json!({ "supplierId": supplier, "date": now(), "paid": 4_000_000, "itemLines": [{ "productId": part, "quantity": 10, "unitCost": 100_000 }], "phoneLines": [line(1), line(2)] }),
    );
    app.ok(|c| purchases::create_purchase(c, &input));
    assert_eq!(app.ok(|c| suppliers::supplier_totals(c, &supplier)), suppliers::Totals { purchased: 11_000_000, paid: 4_000_000, balance: 7_000_000 });
    let in_stock = || app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" }))));
    assert_eq!(in_stock().len(), 2);

    // 2. Sell a phone at 60,000 with a 15,000 trade-in, on credit: 20,000 paid, 25,000 owed.
    let walid = app.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid", "phone": "0550000001" })))).id;
    let unit = in_stock()[0].id.clone();
    let input: sales::SaleInput = parse(json!({
        "customerId": walid, "paid": 2_000_000, "lines": [{ "unitId": unit, "unitPrice": 6_000_000, "warrantyDays": 365 }],
        "tradeIn": { "imei1": make_imei("35000000000009"), "condition": "USED", "batteryHealth": 82, "value": 1_500_000, "model": { "brandId": samsung, "name": "Galaxy A10", "storage": "32GB", "color": "" } },
    }));
    let sale = app.ok(|c| sales::create_sale(c, &input, Default::default()));
    let d = app.ok(|c| sales::get_sale(c, &sale.id, true));
    assert_eq!((d.total, d.paid, d.remaining, d.profit), (4_500_000, 2_000_000, 2_500_000, Some(1_000_000)));
    let owed = || app.ok(|c| balance::customer_balance(c, &walid));
    assert_eq!(owed(), 2_500_000);
    let used = app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK", "condition": "USED" }))));
    assert_eq!(used[0].cost, Some(1_500_000)); // the trade-in joined the stock

    // 3. The customer pays what he owes.
    app.ok(|c| customers::receive_payment(c, &parse(json!({ "customerId": walid, "amount": 2_500_000, "date": now() }))));
    assert_eq!(owed(), 0);

    // 4. A repair with a part, delivered at 8,000 and paid.
    let ticket = app.ok(|c| {
        repairs::create_repair(c, &parse(json!({ "customerId": walid, "brand": "Samsung", "model": "A15", "fault": "Écran cassé", "estimatedPrice": 800_000 })))
    });
    app.ok(|c| repairs::add_part(c, &parse(json!({ "repairId": ticket.id, "productId": part, "quantity": 1 }))));
    app.ok(|c| repairs::deliver(c, &parse(json!({ "id": ticket.id, "finalPrice": 800_000, "paid": 800_000, "warrantyDays": 30 }))));
    let r = app.ok(|c| repairs::get_repair(c, &ticket.id, true));
    assert_eq!((r.status.as_str(), r.profit, r.remaining), ("DELIVERED", Some(700_000), 0));
    assert_eq!(app.ok(|c| stock::get_item(c, &part)).quantity, 9);

    // 5. A flexy sale and an expense.
    let flexy = app.ok(|c| services::list_services(c, false)).into_iter().find(|s| s.name == "Flexy Mobilis").unwrap();
    app.ok(|c| services::sell_service(c, &parse(json!({ "serviceId": flexy.id, "amount": 1_666_667 }))));
    let cat = app.ok(expenses::list_categories)[0].id.clone();
    app.ok(|c| expenses::create_expense(c, &parse(json!({ "buyer": "Samira", "categoryId": cat, "date": today, "amount": 200_000 }))));

    // 6. Close the day.
    let expected = 1_000_000 - 4_000_000 + 2_000_000 + 2_500_000 + 800_000 + 1_666_667 - 200_000;
    assert_eq!(app.ok(|c| cash::expected_cash(c, &day.id)), expected);
    let closed = app.ok(|c| cash::close_session(c, &parse(json!({ "counted": expected - 100, "note": "short by 1 DA" }))));
    assert_eq!((closed.expected, closed.difference), (expected, -100));
    let z = app.ok(|c| cash::z_report(c, &day.id));
    assert_eq!((z.sales_count, z.sales_total, z.services.count, z.services.margin), (1, 4_500_000, 1, 50_000));
    assert_eq!((z.repairs.delivered, z.repairs.payments, z.debt_payments, z.expenses), (1, 800_000, 2_500_000, 200_000));
    assert_eq!((z.expected, z.counted, z.difference), (expected, Some(expected - 100), Some(-100)));

    // 7. Net profit: sales 10,000 + repair 7,000 + flexy 500 - expense 2,000.
    let s = app.ok(|c| finance::summary(c, &hour()));
    assert_eq!(
        (s.sales_profit, s.repair_profit, s.service_margin, s.expenses, s.net_profit, s.customer_debts, s.supplier_debts),
        (1_000_000, 700_000, 50_000, 200_000, 1_550_000, 0, 7_000_000)
    );

    // 8. Backup, change things, restore: the data comes back as it was.
    let zip = app.dir.path().join("day.zip");
    backup::create_backup(&app.core, &zip).unwrap();
    app.ok(|c| expenses::create_expense(c, &parse(json!({ "buyer": "After backup", "categoryId": cat, "date": today, "amount": 999_900 }))));
    app.ok(|c| cash::open_session(c, &parse(json!({ "openingFloat": 0 }))));
    assert_eq!(app.ok(|c| finance::summary(c, &hour())).expenses, 1_199_900);
    backup::restore_backup(&app.core, &zip).unwrap();
    let s = app.ok(|c| finance::summary(c, &hour()));
    assert_eq!((s.expenses, s.net_profit), (200_000, 1_550_000));
    assert!(app.ok(cash::open_session_id).is_none());
    assert_eq!(app.ok(|c| cash::z_report(c, &day.id)).difference, Some(-100));
    assert_eq!(owed(), 0);
    // The stock still adds up: every product quantity equals its movements.
    #[derive(Deserialize)]
    struct M {
        quantity: i64,
        moved: i64,
    }
    for r in app.rows::<M>("SELECT p.quantity, COALESCE((SELECT SUM(quantity) FROM stock_movements m WHERE m.product_id = p.id), 0) AS moved FROM products p") {
        assert_eq!(r.moved, r.quantity);
    }
}

#[test]
fn opens_a_database_written_by_the_electron_app() {
    // A database at schema 9 (before the trade-in migration edited phone_units) is brought to the latest schema.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("store.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        for step in &psm_core::migrations::MIGRATIONS[..9] {
            if let psm_core::migrations::Migration::Sql(sql) = step {
                conn.execute_batch(sql).unwrap();
            }
        }
        conn.pragma_update(None, "user_version", 9).unwrap();
        conn.execute_batch("INSERT INTO settings (key, value) VALUES ('public', '{\"storeName\":\"Old shop\",\"language\":\"fr\"}')").unwrap();
    }
    let paths = psm_core::Paths::new(dir.path(), None, None).unwrap();
    let core = psm_core::Core::new(paths, "1.0.0", std::sync::Arc::new(psm_core::NullHost)).unwrap();
    let s = core.desktop(|c| psm_core::services::settings::get_public(c.db)).unwrap();
    assert_eq!((s.store_name.as_str(), s.language.as_str(), s.theme.as_str()), ("Old shop", "fr", "system"));
    let version: i64 = core.desktop(|c| psm_core::db::DbExt::val(c.db, "PRAGMA user_version", [])).unwrap();
    assert_eq!(version, psm_core::migrations::SCHEMA_VERSION as i64);
    let sql: String = core.desktop(|c| psm_core::db::DbExt::val(c.db, "SELECT sql FROM sqlite_master WHERE name = 'phone_units'", [])).unwrap();
    assert!(sql.contains("imei1 TEXT CHECK (imei1 IS NULL OR length(imei1) = 15)"));
}

// Manager password, cost visibility, expenses, backup and the schema itself.
mod common;
use common::*;
use psm_core::services::{auth, backup, catalog, codes::is_valid_imei, customers, expenses, files, seed, settings, visibility};
use serde::Deserialize;
use serde_json::json;

fn set(app: &App, v: serde_json::Value) {
    app.ok(|c| settings::update_public(c.db, serde_json::from_value(v).unwrap()));
}

#[test]
fn locks_protected_sections_until_the_password_is_given() {
    let app = fresh();
    assert!(!app.ok(|c| auth::is_locked(c, "finance")));
    app.ok(|c| auth::set_password(c, "secret1"));
    app.ok(|c| auth::set_protected_sections(c, &["finance".into(), "overview".into()]));
    assert_eq!(app.ok(auth::protected_sections), vec!["finance"]); // overview can never be protected
    app.ok(auth::lock);
    assert!(app.ok(|c| auth::is_locked(c, "finance")));
    assert!(!app.ok(|c| auth::is_locked(c, "people")));
    assert_eq!(code(app.ctx(|c| auth::unlock(c, "wrong"))), "wrong_password");
    app.ok(|c| auth::unlock(c, "secret1"));
    assert!(!app.ok(|c| auth::is_locked(c, "finance")));
}

#[test]
fn a_locked_section_refuses_its_channels_from_the_window() {
    let app = fresh();
    app.ok(|c| auth::set_password(c, "secret1"));
    app.ok(|c| auth::set_protected_sections(c, &["stock".into(), "finance".into()]));
    app.ok(auth::lock);
    assert_eq!(app.call("brands.list", serde_json::Value::Null).error_code(), Some("locked"));
    // Shared pickers stay open while one of their sections is open.
    assert!(app.call("customers.list", serde_json::Value::Null).is_ok());
    assert!(app.call("overview.get", serde_json::Value::Null).is_ok());
    assert_eq!(app.call("brands.create", json!({ "name": "" })).error_code(), Some("locked"));
    app.ok(|c| auth::unlock(c, "secret1"));
    assert_eq!(app.call("brands.create", json!({ "name": "" })).error_code(), Some("invalid_input"));
}

#[test]
fn resets_with_the_recovery_code_and_issues_a_new_one() {
    let app = fresh();
    let code1 = app.ok(|c| auth::set_password(c, "secret1")).recovery_code;
    app.ok(auth::lock);
    assert_eq!(code(app.ctx(|c| auth::reset_with_recovery(c, "AAAA-AAAA-AAAA-AAAA", "next123"))), "wrong_recovery_code");
    let again = app.ok(|c| auth::reset_with_recovery(c, &code1.to_lowercase(), "next123")).recovery_code;
    assert_ne!(again, code1);
    app.ok(auth::lock);
    app.ok(|c| auth::unlock(c, "next123"));
    assert_eq!(code(app.ctx(|c| auth::reset_with_recovery(c, &code1, "x12345"))), "wrong_recovery_code");
}

#[test]
fn delays_after_five_wrong_attempts() {
    let app = fresh();
    app.ok(|c| auth::set_password(c, "secret1"));
    app.ok(auth::lock);
    for _ in 0..5 {
        assert_eq!(code(app.ctx(|c| auth::unlock(c, "nope"))), "wrong_password");
    }
    assert_eq!(code(app.ctx(|c| auth::unlock(c, "secret1"))), "too_many_attempts");
}

#[test]
fn refuses_to_protect_sections_before_a_password_exists() {
    let app = fresh();
    assert_eq!(code(app.ctx(|c| auth::set_protected_sections(c, &["finance".into()]))), "password_required_first");
}

#[test]
fn shows_costs_without_a_password_or_when_finance_is_not_protected() {
    let app = fresh();
    assert!(app.ok(visibility::costs_visible));
    app.ok(|c| auth::set_password(c, "1234"));
    app.ok(|c| auth::set_protected_sections(c, &["sell".into()]));
    app.ok(auth::lock);
    assert!(app.ok(visibility::costs_visible));
}

#[test]
fn strips_costs_while_finance_is_locked_and_gives_them_back_once_unlocked() {
    let app = fresh();
    app.ok(|c| auth::set_password(c, "1234"));
    app.ok(|c| auth::set_protected_sections(c, &["finance".into()]));
    app.ok(auth::lock);
    assert!(!app.ok(visibility::costs_visible));
    let cat = app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id;
    app.ok(auth::lock);
    let created = app.call("items.create", json!({ "name": "Chargeur", "categoryId": cat, "salePrice": 100, "avgCost": 110_000 }));
    assert!(created.is_ok());
    let list = app.call("items.list", json!({}));
    assert_eq!(list.data().unwrap()[0]["avgCost"], serde_json::Value::Null);
    app.ok(|c| auth::unlock(c, "1234"));
    assert!(app.ok(visibility::costs_visible));
    assert_eq!(app.call("items.list", json!({})).data().unwrap()[0]["avgCost"], json!(110_000));
}

#[test]
fn hiding_is_on_by_default_and_can_be_switched_off() {
    let app = fresh();
    app.ok(|c| auth::set_password(c, "1234"));
    app.ok(|c| auth::set_protected_sections(c, &["finance".into()]));
    app.ok(auth::lock);
    set(&app, json!({ "hideCostWhenLocked": false }));
    assert!(app.ok(visibility::costs_visible));
    set(&app, json!({ "hideCostWhenLocked": true }));
    assert!(!app.ok(visibility::costs_visible));
}

#[test]
fn settings_ignore_the_logo_and_unknown_keys_and_refuse_bad_values() {
    let app = fresh();
    let r = app.call("settings.update", json!({ "storeName": "Boutique", "logoFile": "x.png", "nope": 1 }));
    assert_eq!(r.data().unwrap()["storeName"], json!("Boutique"));
    assert_eq!(r.data().unwrap()["logoFile"], serde_json::Value::Null);
    assert_eq!(app.call("settings.update", json!({ "language": "de" })).error_code(), Some("invalid_input"));
    assert_eq!(app.call("settings.update", json!({ "slipCopies": 9 })).error_code(), Some("invalid_input"));
    assert_eq!(app.call("settings.get", serde_json::Value::Null).data().unwrap()["storeName"], json!("Boutique"));
}

fn expense(app: &App, over: serde_json::Value) -> expenses::Expense {
    let cat = app.ok(expenses::list_categories)[0].id.clone();
    let input: expenses::ExpenseInput = parse(merge(json!({ "buyer": "سميرة", "categoryId": cat, "date": "2026-10-01", "amount": 450_000 }), over));
    app.ok(|c| expenses::create_expense(c, &input))
}

#[test]
fn expenses_are_created_filtered_and_totalled() {
    let app = fresh();
    app.ok(|c| expenses::ensure_default_categories(c, &["Supplies", "Rent"]));
    app.ok(|c| expenses::ensure_default_categories(c, &["Ignored"])); // only seeds an empty table
    assert_eq!(app.ok(expenses::list_categories).len(), 2);
    expense(&app, json!({}));
    expense(&app, json!({ "date": "2026-09-10", "amount": 100_000, "buyer": "رضا" }));
    assert_eq!(app.ok(|c| expenses::list_expenses(c, &Default::default())).len(), 2);
    assert_eq!(app.ok(|c| expenses::total_expenses(c, &parse(json!({ "from": "2026-10-01", "to": "2026-10-31" })))), 450_000);
    assert_eq!(app.ok(|c| expenses::list_expenses(c, &parse(json!({ "search": "رضا" })))).len(), 1);
}

#[test]
fn expense_input_is_checked() {
    assert!(try_parse::<expenses::ExpenseInput>(json!({ "buyer": "", "categoryId": "x", "date": "2026-10-01", "amount": 5 })).is_err());
    assert!(try_parse::<expenses::ExpenseInput>(json!({ "buyer": "a", "categoryId": "x", "date": "01/10/2026", "amount": 5 })).is_err());
    assert!(try_parse::<expenses::ExpenseInput>(json!({ "buyer": "a", "categoryId": "x", "date": "2026-10-01", "amount": -5 })).is_err());
}

#[test]
fn backup_restores_the_database_and_the_uploaded_files() {
    let app = fresh();
    app.ok(|c| expenses::ensure_default_categories(c, &["Supplies"]));
    let receipt = app.dir.path().join("receipt.png");
    std::fs::write(&receipt, "fake image").unwrap();
    let kept = expense(&app, json!({ "receiptPath": receipt.display().to_string() }));
    let zip = app.dir.path().join("backup.zip");
    backup::create_backup(&app.core, &zip).unwrap();
    app.ok(|c| expenses::delete_expense(c, &kept.id));
    expense(&app, json!({ "buyer": "after backup" }));
    let files_dir = app.core.paths.files_dir();
    assert!(!files::stored_file_path(&files_dir, kept.receipt_file.as_deref().unwrap()).exists());
    backup::restore_backup(&app.core, &zip).unwrap();
    let rows = app.ok(|c| expenses::list_expenses(c, &Default::default()));
    assert_eq!(rows.iter().map(|r| r.buyer.as_str()).collect::<Vec<_>>(), vec!["سميرة"]);
    assert!(files::stored_file_path(&files_dir, rows[0].receipt_file.as_deref().unwrap()).exists());
    // A safety copy of the data before the restore is kept.
    assert!(std::fs::read_dir(app.core.paths.backups_dir()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("before-restore-")));
}

#[test]
fn refuses_a_zip_that_is_not_a_backup_of_this_product() {
    let app = fresh();
    let not_backup = app.dir.path().join("x.zip");
    std::fs::write(&not_backup, "nope").unwrap();
    assert_eq!(code(backup::restore_backup(&app.core, &not_backup)), "backup_invalid");
}

#[test]
fn keeps_one_automatic_backup_a_day() {
    let app = fresh();
    backup::auto_backup(&app.core).unwrap();
    backup::auto_backup(&app.core).unwrap();
    let autos =
        std::fs::read_dir(app.core.paths.backups_dir()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("auto-")).count();
    assert_eq!(autos, 1);
}

#[test]
fn every_table_except_settings_has_id_and_timestamps() {
    let app = fresh();
    #[derive(Deserialize)]
    struct N {
        name: String,
    }
    let tables: Vec<N> = app.rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    assert!(tables.len() > 25);
    // The sync feed and its bookkeeping (phase 17) are keyed by their own columns, not by an id.
    for t in tables.iter().filter(|t| !["settings", "changes", "sync_state", "applied_ops", "sync_id_map"].contains(&t.name.as_str())) {
        let cols: Vec<N> = app.rows(&format!("SELECT name FROM pragma_table_info('{}')", t.name));
        let cols: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        for c in ["id", "created_at", "updated_at"] {
            assert!(cols.contains(&c), "{} lacks {c}", t.name);
        }
    }
    assert_eq!(app.val::<i64>("PRAGMA user_version"), psm_core::migrations::SCHEMA_VERSION as i64);
}

fn count(app: &App, table: &str, cond: &str) -> i64 {
    app.val(&format!("SELECT count(*) FROM {table} WHERE {cond}"))
}

#[test]
fn imei_stays_unique_among_units_that_are_not_deleted() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    let clone = "INSERT INTO phone_units (id, product_id, imei1, condition, created_at, updated_at) SELECT 'dup', product_id, imei1, condition, created_at, updated_at FROM phone_units WHERE id = (SELECT id FROM phone_units ORDER BY rowid LIMIT 1)";
    assert!(format!("{:?}", app.ctx(|c| Ok(c.db.execute(clone, [])?)).unwrap_err()).contains("UNIQUE"));
    app.exec("UPDATE phone_units SET deleted_at = ?1 WHERE id = (SELECT id FROM phone_units ORDER BY rowid LIMIT 1)", [now()]);
    assert!(app.ctx(|c| Ok(c.db.execute(clone, [])?)).is_ok());
}

#[test]
fn seed_loads_the_expected_catalogue_people_and_services() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    assert_eq!(count(&app, "brands", "1"), 8);
    assert_eq!(count(&app, "products", "kind = 'PHONE_MODEL'"), 25);
    assert_eq!(count(&app, "phone_units", "1"), 40);
    assert_eq!(count(&app, "products", "kind = 'ITEM' AND barcode IS NOT NULL"), 60);
    assert_eq!(count(&app, "suppliers", "1"), 4);
    assert_eq!(count(&app, "customers", "1"), 30);
    assert_eq!(count(&app, "employees", "1"), 3);
    assert_eq!(count(&app, "services", "kind = 'FLEXY'"), 3);
    assert!(count(&app, "phone_units", "condition = 'NEW'") > 0);
    assert!(count(&app, "phone_units", "condition <> 'NEW'") > 0);
}

#[test]
fn seed_uses_valid_distinct_imeis() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    #[derive(Deserialize)]
    struct U {
        imei1: Option<String>,
        imei2: Option<String>,
    }
    let units: Vec<U> = app.rows("SELECT imei1, imei2 FROM phone_units");
    for u in &units {
        assert!(is_valid_imei(u.imei1.as_deref().unwrap_or("")));
        if let Some(i) = &u.imei2 {
            assert!(is_valid_imei(i));
        }
    }
    let distinct: std::collections::HashSet<_> = units.iter().map(|u| u.imei1.clone()).collect();
    assert_eq!(distinct.len(), 40);
}

#[derive(Deserialize)]
struct Moved {
    quantity: i64,
    moved: i64,
}
const MOVED: &str = "SELECT p.quantity, COALESCE((SELECT SUM(quantity) FROM stock_movements m WHERE m.product_id = p.id), 0) AS moved FROM products p";

#[test]
fn seed_records_a_stock_movement_for_every_quantity() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    let rows: Vec<Moved> = app.rows(MOVED);
    assert_eq!(rows.len(), 85);
    for r in rows {
        assert_eq!(r.moved, r.quantity);
    }
    assert_eq!(count(&app, "purchases", "total > 0"), 4);
}

#[test]
fn seed_adds_repairs_and_sales_that_follow_the_rules() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    assert_eq!(count(&app, "repairs", "1"), 6);
    assert_eq!(count(&app, "repairs", "status = 'DELIVERED'"), 1);
    assert!(count(&app, "repair_parts", "1") > 0);
    assert_eq!(count(&app, "sales", "1"), 3);
    assert_eq!(count(&app, "service_sales", "1"), 4);
    assert!(count(&app, "employee_ledger", "1") >= 4);
    assert_eq!(count(&app, "employees", "role IN ('SELLER','CASHIER','TECHNICIAN')"), 3);
    assert!(count(&app, "cash_movements", "session_id IS NULL") > 0); // adopted by the first day opened
    assert!(count(&app, "repair_status_log", "1") > 6);
    for r in app.rows::<Moved>(MOVED) {
        assert_eq!(r.moved, r.quantity);
    }
    assert!(!app.ok(|c| customers::customer_overview(c, &parse(json!({ "overdue": true })))).is_empty());
    assert!(app.ok(|c| customers::customer_overview(c, &parse(json!({ "inDebt": true })))).len() >= 3);
}

#[test]
fn seed_loads_on_top_of_existing_brands_without_duplicating_them() {
    let app = fresh();
    app.ok(|c| catalog::create_brand(c, "Samsung"));
    app.ok(catalog::add_popular_brands);
    app.ok(seed::seed_sample_data);
    assert_eq!(count(&app, "products", "kind = 'PHONE_MODEL'"), 25);
    assert_eq!(count(&app, "brands", "name = 'Samsung' COLLATE NOCASE"), 1);
}

#[test]
fn seed_refuses_to_load_twice() {
    let app = fresh();
    app.ok(seed::seed_sample_data);
    assert_eq!(code(app.ctx(seed::seed_sample_data)), "seed_not_empty");
}

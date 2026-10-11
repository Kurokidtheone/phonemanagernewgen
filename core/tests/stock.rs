mod common;
use common::*;
use psm_core::services::codes::is_valid_ean13;
use psm_core::services::{catalog, stock};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize, Debug, PartialEq)]
struct Move {
    r#type: String,
    quantity: i64,
    reason: String,
}

fn moves(app: &App) -> Vec<Move> {
    app.rows("SELECT type, quantity, reason FROM stock_movements ORDER BY created_at, rowid")
}

fn mv(t: &str, q: i64, r: &str) -> Move {
    Move { r#type: t.into(), quantity: q, reason: r.into() }
}

struct T {
    app: App,
    samsung: String,
    a: String,
    b: String,
}

fn setup() -> T {
    let app = fresh();
    let samsung = app.ok(|c| catalog::create_brand(c, "Samsung")).id;
    T { app, samsung, a: make_imei("35000000000001"), b: make_imei("35000000000002") }
}

impl T {
    fn unit_json(&self, over: Value) -> Value {
        merge(
            json!({ "imei1": self.a, "condition": "NEW", "cost": 2_000_000, "salePrice": 2_500_000,
                    "model": { "brandId": self.samsung, "name": "Galaxy A15", "storage": "128GB", "color": "Noir" } }),
            over,
        )
    }
    fn unit(&self, over: Value) -> stock::UnitAddInput {
        parse(self.unit_json(over))
    }
    fn qty_cost(&self, product: &str) -> (i64, i64) {
        self.app.ok(|c| Ok(c.db.prepare("SELECT quantity, avg_cost FROM products WHERE id = ?1")?.query_row([product], |r| Ok((r.get(0)?, r.get(1)?)))?))
    }
}

#[test]
fn adds_a_unit_creates_the_model_and_writes_an_adjustment() {
    let t = setup();
    let added = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    assert_eq!(moves(&t.app), vec![mv("ADJUSTMENT", 1, "MANUAL_ENTRY")]);
    let rows = t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" }))));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, added.id);
    assert_eq!(rows[0].imei1.as_deref(), Some(t.a.as_str()));
    assert_eq!(rows[0].name, "Samsung Galaxy A15");
    assert_eq!(rows[0].storage, "128GB");
    assert_eq!(rows[0].age_days, 0);
    let models = t.app.ok(stock::list_models);
    assert_eq!(models.iter().find(|m| m.id == added.product_id).unwrap().sale_price, 2_500_000);
    assert_eq!(t.qty_cost(&added.product_id), (1, 2_000_000));
}

#[test]
fn reuses_the_model_and_tracks_the_average_cost() {
    let t = setup();
    let first = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    t.app.ok(|c| stock::add_unit(c, &t.unit(json!({ "imei1": t.b, "cost": 3_000_000, "productId": first.product_id, "model": null }))));
    assert_eq!(t.app.ok(stock::list_models).len(), 1);
    assert_eq!(t.qty_cost(&first.product_id), (2, 2_500_000));
}

#[test]
fn refuses_a_wrong_check_digit_without_touching_stock() {
    let t = setup();
    let last = t.a[14..].parse::<u32>().unwrap();
    let bad = format!("{}{}", &t.a[..14], (last + 1) % 10);
    assert_eq!(code(t.app.ctx(|c| stock::add_unit(c, &t.unit(json!({ "imei1": bad }))))), "imei_invalid");
    assert_eq!(code(t.app.ctx(|c| stock::add_unit(c, &t.unit(json!({ "imei1": "12345" }))))), "imei_invalid");
    assert!(moves(&t.app).is_empty());
    assert!(t.app.ok(stock::list_models).is_empty()); // the model was not created either
}

#[test]
fn refuses_the_same_imei_twice_also_as_imei2_until_the_unit_is_deleted() {
    let t = setup();
    t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    let product = t.app.ok(stock::list_models)[0].id.clone();
    let again = t.unit(json!({ "model": null, "productId": product }));
    assert_eq!(code(t.app.ctx(|c| stock::add_unit(c, &again))), "imei_duplicate");
    let swapped = t.unit(json!({ "model": null, "productId": product, "imei1": t.b, "imei2": t.a }));
    assert_eq!(code(t.app.ctx(|c| stock::add_unit(c, &swapped))), "imei_duplicate");
    let status = t.app.ok(|c| stock::imei_status(c, &t.a, None));
    assert!(status.valid);
    assert_eq!(status.duplicate.unwrap().model, "Samsung Galaxy A15");
    t.app.exec("UPDATE phone_units SET deleted_at = ?1", [now()]);
    assert!(t.app.ok(|c| stock::imei_status(c, &t.a, None)).duplicate.is_none());
    assert!(t.app.ctx(|c| stock::add_unit(c, &again)).is_ok());
}

#[test]
fn writes_off_an_in_stock_unit_with_a_reason_once() {
    let t = setup();
    let u = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    t.app.ok(|c| stock::write_off_unit(c, &u.id, "Water damage"));
    assert_eq!(moves(&t.app).pop().unwrap(), mv("WRITE_OFF", -1, "Water damage"));
    assert_eq!(t.qty_cost(&u.product_id).0, 0);
    assert!(t.app.ok(|c| stock::list_units(c, &parse(json!({ "status": "IN_STOCK" })))).is_empty());
    assert_eq!(code(t.app.ctx(|c| stock::write_off_unit(c, &u.id, "again"))), "unit_not_in_stock");
    let detail = t.app.ok(|c| stock::get_unit(c, &u.id));
    assert_eq!(detail.unit.status, "WRITTEN_OFF");
    assert_eq!(detail.timeline.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["ADJUSTMENT", "WRITE_OFF"]);
}

#[test]
fn edits_fields_and_price_keeping_imei_rules() {
    let t = setup();
    let u = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    let product = t.app.ok(stock::list_models)[0].id.clone();
    t.app.ok(|c| stock::add_unit(c, &t.unit(json!({ "imei1": t.b, "productId": product, "model": null }))));
    let current = t.app.ok(|c| stock::get_unit(c, &u.id)).unit;
    let edit: stock::UnitUpdateInput = parse(json!({
        "id": u.id, "imei1": t.b, "imei2": null, "condition": current.condition, "batteryHealth": current.battery_health,
        "grade": current.grade, "cost": 2_000_000, "salePrice": current.sale_price, "notes": "",
    }));
    assert_eq!(code(t.app.ctx(|c| stock::update_unit(c, &edit))), "imei_duplicate");
    t.app.ok(|c| stock::set_unit_price(c, &u.id, 2_700_000));
    assert_eq!(t.app.ok(|c| stock::get_unit(c, &u.id)).unit.sale_price, 2_700_000);
}

#[test]
fn shows_the_repair_of_a_phone_in_its_timeline() {
    let t = setup();
    let u = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    let n = now();
    t.app.exec("INSERT INTO customers (id, name, created_at, updated_at) VALUES ('c1', 'X', ?1, ?1)", [&n]);
    t.app.exec("INSERT INTO repairs (id, ticket_number, customer_id, imei, received_at, qr_token, created_at, updated_at) VALUES ('r1', 'R-1', 'c1', ?1, ?2, 'tok', ?2, ?2)", [&t.a, &n]);
    assert!(t.app.ok(|c| stock::get_unit(c, &u.id)).timeline.iter().any(|e| e.kind == "REPAIR"));
}

fn category(app: &App) -> String {
    app.ok(|c| catalog::create_category(c, "Chargeurs", "ACCESSORY")).id
}

fn item(category: &str, over: Value) -> stock::ItemInput {
    parse(merge(json!({ "name": "Chargeur 25W", "categoryId": category, "salePrice": 180_000, "lowStockThreshold": 5 }), over))
}

#[test]
fn items_are_created_listed_with_the_low_stock_flag_and_filtered() {
    let t = setup();
    let cat = category(&t.app);
    let id = t.app.ok(|c| stock::create_item(c, &item(&cat, json!({ "barcode": "6130000000012" })))).id;
    let all = |f: Value| t.app.ok(|c| stock::list_items(c, &parse(f))).len();
    assert_eq!(all(json!({})), 1);
    assert_eq!(all(json!({ "lowStockOnly": true })), 1); // 0 <= 5
    t.app.ok(|c| stock::adjust_item(c, &parse(json!({ "id": id, "delta": 6, "reason": "COUNT_CORRECTION" }))));
    assert_eq!(all(json!({ "lowStockOnly": true })), 0);
    assert_eq!(all(json!({ "repairPartsOnly": true })), 0);
    let got = t.app.ok(|c| stock::get_item(c, &id));
    assert_eq!((got.quantity, got.is_low), (6, false));
}

#[test]
fn adjusts_the_quantity_with_a_movement_and_never_below_zero() {
    let t = setup();
    let cat = category(&t.app);
    let id = t.app.ok(|c| stock::create_item(c, &item(&cat, json!({})))).id;
    let adjust = |delta: i64, reason: &str| t.app.ctx(|c| stock::adjust_item(c, &parse(json!({ "id": id, "delta": delta, "reason": reason }))));
    adjust(10, "COUNT_CORRECTION").unwrap();
    adjust(-3, "DAMAGED").unwrap();
    assert_eq!(moves(&t.app), vec![mv("ADJUSTMENT", 10, "COUNT_CORRECTION"), mv("ADJUSTMENT", -3, "DAMAGED")]);
    assert_eq!(code(adjust(-8, "LOST")), "quantity_negative");
    assert_eq!(t.app.ok(|c| stock::get_item(c, &id)).quantity, 7);
    assert_eq!(moves(&t.app).len(), 2);
}

#[test]
fn barcodes_are_unique_among_live_items_and_scans_find_items_and_units() {
    let t = setup();
    let cat = category(&t.app);
    let input = item(&cat, json!({ "barcode": "6130000000012" }));
    let id = t.app.ok(|c| stock::create_item(c, &input)).id;
    assert_eq!(code(t.app.ctx(|c| stock::create_item(c, &input))), "barcode_duplicate");
    let found = t.app.ok(|c| stock::lookup(c, "6130000000012")).unwrap();
    assert_eq!((found.r#type, found.id.as_str()), ("item", id.as_str()));
    let phone = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({}))));
    let found = t.app.ok(|c| stock::lookup(c, &t.a)).unwrap();
    assert_eq!((found.r#type, found.id), ("unit", phone.id));
    assert!(t.app.ok(|c| stock::lookup(c, "0000000000000")).is_none());
    t.app.ok(|c| stock::delete_item(c, &id));
    assert!(t.app.ok(|c| stock::list_items(c, &Default::default())).is_empty());
    assert!(t.app.ok(|c| stock::lookup(c, "6130000000012")).is_none());
    assert!(t.app.ctx(|c| stock::create_item(c, &input)).is_ok());
}

#[test]
fn refuses_a_phone_category_for_an_item() {
    let t = setup();
    let phone = t.app.ok(|c| catalog::create_category(c, "Phones", "PHONE")).id;
    assert_eq!(code(t.app.ctx(|c| stock::create_item(c, &item(&phone, json!({}))))), "not_found");
}

#[test]
fn generates_distinct_internal_ean13_codes() {
    let t = setup();
    let a = t.app.ok(stock::generate_barcode);
    let b = t.app.ok(stock::generate_barcode);
    assert_ne!(a, b);
    for code in [a, b] {
        assert!(code.starts_with("200"));
        assert!(is_valid_ean13(&code));
    }
}

#[test]
fn brands_and_categories_in_use_cannot_go_and_names_are_unique() {
    let t = setup();
    assert_eq!(code(t.app.ctx(|c| catalog::create_brand(c, "samsung"))), "name_taken");
    t.app.ok(|c| stock::add_unit(c, &t.unit(json!({ "model": { "brandId": t.samsung, "name": "S24", "storage": "", "color": "" } }))));
    assert_eq!(code(t.app.ctx(|c| catalog::delete_brand(c, &t.samsung))), "in_use");
    let free = t.app.ok(|c| catalog::create_brand(c, "Nokia")).id;
    t.app.ok(|c| catalog::delete_brand(c, &free));
    assert_eq!(t.app.ok(catalog::list_brands).iter().map(|b| b.name.clone()).collect::<Vec<_>>(), vec!["Samsung"]);
    let cat = t.app.ok(|c| catalog::create_category(c, "Cases", "ACCESSORY")).id;
    t.app.ok(|c| catalog::rename_category(c, &cat, "Coques"));
    t.app.ok(|c| catalog::delete_category(c, &cat));
    assert!(!t.app.ok(catalog::list_categories).iter().any(|c| c.id == cat));
}

#[test]
fn popular_brands_are_added_once_ignoring_case() {
    let t = setup();
    t.app.ok(|c| catalog::create_brand(c, "APPLE"));
    t.app.ok(|c| catalog::create_brand(c, "My brand"));
    let added = t.app.ok(catalog::add_popular_brands);
    assert!(added > 50);
    let names: Vec<String> = t.app.ok(catalog::list_brands).into_iter().map(|b| b.name).collect();
    for n in ["Huawei", "Condor", "IRIS", "Stream System", "My brand", "APPLE"] {
        assert!(names.iter().any(|x| x == n), "{n}");
    }
    assert_eq!(names.iter().filter(|n| n.to_lowercase() == "apple").count(), 1);
    assert_eq!(names.iter().filter(|n| n.to_lowercase() == "samsung").count(), 1);
    assert_eq!(t.app.ok(catalog::add_popular_brands), 0);
}

#[test]
fn imei1_may_be_null_for_trade_ins_but_real_imeis_are_checked() {
    let t = setup();
    let product = t.app.ok(|c| stock::add_unit(c, &t.unit(json!({})))).product_id;
    let insert = |id: &str, imei: Option<&str>| {
        t.app.ctx(|c| {
            c.db.execute(
                "INSERT INTO phone_units (id, product_id, imei1, condition, created_at, updated_at) VALUES (?1, ?2, ?3, 'USED', 'x', 'x')",
                rusqlite::params![id, product, imei],
            )?;
            Ok(())
        })
    };
    assert!(insert("a", None).is_ok());
    assert!(insert("b", None).is_ok()); // NULLs never clash
    assert!(format!("{:?}", insert("c", Some("123")).unwrap_err()).contains("CHECK"));
    assert!(format!("{:?}", insert("d", Some(&t.a)).unwrap_err()).contains("UNIQUE"));
    // Phones added to stock normally still need one.
    let empty = json!({ "imei1": "", "condition": "NEW", "cost": 1, "salePrice": 1, "productId": product });
    let input: stock::UnitAddInput = parse(empty);
    assert_eq!(code(t.app.ctx(|c| stock::add_unit(c, &input))), "imei_invalid");
}

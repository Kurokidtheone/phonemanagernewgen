// Phase 18: the shop and phone editions, the Android device id, and a backup that moves from the phone to a PC.
mod common;
use common::*;
use ed25519_dalek::pkcs8::{spki::der::pem::LineEnding, EncodePublicKey};
use ed25519_dalek::{Signer, SigningKey};
use psm_core::services::license::{self, base32_encode, group_text, Edition};
use psm_core::services::{backup, catalog, customers, sales, seed, stock};
use serde_json::json;

fn signer() -> SigningKey {
    SigningKey::generate(&mut rand::rngs::OsRng)
}

fn key_for(app: &App, signer: &SigningKey, edition: &str) -> String {
    let device = app.ok(|c| Ok(license::device_id(c)));
    let bytes = serde_json::to_vec(&json!({ "p": "PSM", "d": device, "n": "Boutique", "e": edition, "i": "2026-10-10" })).unwrap();
    let mut raw = signer.sign(&bytes).to_bytes().to_vec();
    raw.extend_from_slice(&bytes);
    group_text(&base32_encode(&raw), 5)
}

fn trusting(app: &App, signer: &SigningKey, accepts: Edition) {
    app.core.license.write().unwrap().public_key_pem = signer.verifying_key().to_public_key_pem(LineEnding::LF).unwrap();
    app.core.set_edition(accepts);
}

#[test]
fn a_phone_key_is_refused_by_the_desktop_and_accepted_by_the_stand_alone_app_and_the_reverse() {
    let s = signer();
    let desktop = fresh();
    trusting(&desktop, &s, Edition::Shop);
    let standalone = fresh();
    trusting(&standalone, &s, Edition::Phone);
    // The same machine id on both, so only the edition can make a difference.
    desktop.core.set_machine_id("same-machine");
    standalone.core.set_machine_id("same-machine");

    let phone_key = key_for(&desktop, &s, "phone");
    let shop_key = key_for(&desktop, &s, "shop");
    assert_eq!(code(desktop.ctx(|c| license::activate(c, &phone_key))), "license_wrong_edition");
    assert_eq!(desktop.ok(license::status).state, "trial");
    desktop.ok(|c| license::activate(c, &shop_key));
    assert_eq!(desktop.ok(license::status).state, "licensed");
    assert_eq!(desktop.ok(license::edition), Some(Edition::Shop));

    assert_eq!(code(standalone.ctx(|c| license::activate(c, &shop_key))), "license_wrong_edition");
    assert_eq!(standalone.ok(license::status).state, "trial");
    standalone.ok(|c| license::activate(c, &phone_key));
    assert_eq!(standalone.ok(license::edition), Some(Edition::Phone));
}

#[test]
fn an_old_lifetime_key_counts_as_shop() {
    let s = signer();
    let desktop = fresh();
    trusting(&desktop, &s, Edition::Shop);
    let old = key_for(&desktop, &s, "lifetime");
    desktop.ok(|c| license::activate(c, &old));
    assert_eq!(desktop.ok(license::edition), Some(Edition::Shop));
    let old_with_phones = key_for(&desktop, &s, "lifetime+mobile3");
    desktop.ok(|c| license::activate(c, &old_with_phones));
    assert_eq!(desktop.ok(license::edition), Some(Edition::Shop));

    let standalone = fresh();
    trusting(&standalone, &s, Edition::Phone);
    standalone.core.set_machine_id("other-machine");
    let for_standalone = key_for(&standalone, &s, "lifetime");
    assert_eq!(code(standalone.ctx(|c| license::activate(c, &for_standalone))), "license_wrong_edition");
}

#[test]
fn the_android_device_id_has_the_documented_form_and_follows_the_android_id() {
    let app = fresh();
    app.core.set_machine_id("9774D56D682E549C"); // an ANDROID_ID: 16 hex characters, upper case from some phones
    let id = app.ok(|c| Ok(license::device_id(c)));
    assert_eq!(id.len(), 19);
    let groups: Vec<&str> = id.split('-').collect();
    assert_eq!(groups.len(), 4);
    assert!(groups.iter().all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase())), "{id}");
    // The same function as the desktop: sha256("nldl:" + lower-case id), first 16 hex characters.
    let again = fresh();
    again.core.set_machine_id("9774d56d682e549c");
    assert_eq!(again.ok(|c| Ok(license::device_id(c))), id);
    again.core.set_machine_id("0000000000000001");
    assert_ne!(again.ok(|c| Ok(license::device_id(c))), id, "a different Android id gives a different device id");
}

#[test]
fn the_phone_edition_cannot_pair_phones_and_the_shop_edition_stops_at_three() {
    assert_eq!(license::mobile_allowance(Some("phone")), license::MobileAccess { allowed: false, limit: None });
    assert_eq!(license::mobile_allowance(Some("shop")), license::MobileAccess { allowed: true, limit: Some(3) });
}

fn count(app: &App, table: &str) -> i64 {
    app.val(&format!("SELECT count(*) FROM {table}"))
}

#[test]
fn a_backup_made_on_the_stand_alone_phone_restores_in_a_desktop_core_with_the_same_rows_and_totals() {
    let phone = fresh();
    phone.core.set_edition(Edition::Phone);
    phone.core.set_machine_id("9774d56d682e549c");
    phone.ok(seed::seed_sample_data);
    let brand = phone.ok(|c| catalog::create_brand(c, "Nokia")).id;
    let customer = phone.ok(|c| customers::create_customer(c, &parse(json!({ "name": "Walid", "phone": "0550000000" })))).id;
    let unit = phone.ok(|c| {
        stock::add_unit(
            c,
            &parse(json!({ "imei1": make_imei("35000000000001"), "condition": "NEW", "cost": 4_000_000, "salePrice": 6_000_000, "minPrice": 5_000_000,
                                                              "model": { "brandId": brand, "name": "3310", "storage": "", "color": "Gris" } })),
        )
    });
    phone.ok(|c| psm_core::services::cash::open_session(c, &parse(json!({ "openingFloat": 100_000 }))));
    phone.ok(|c| {
        sales::create_sale(
            c,
            &parse(json!({ "customerId": customer, "paid": 1_000_000, "lines": [{ "unitId": unit.id, "unitPrice": 6_000_000 }] })),
            Default::default(),
        )
    });

    let tables = ["sales", "sale_lines", "products", "phone_units", "customers", "cash_movements", "stock_movements", "expenses", "repairs"];
    let before: Vec<i64> = tables.iter().map(|t| count(&phone, t)).collect();
    let totals_before: (i64, i64, i64) = (
        phone.val("SELECT COALESCE(sum(total), 0) FROM sales"),
        phone.val("SELECT COALESCE(sum(amount), 0) FROM cash_movements"),
        phone.val("SELECT COALESCE(sum(quantity), 0) FROM products"),
    );
    let zip = phone.dir.path().join("export.zip");
    backup::create_backup(&phone.core, &zip).unwrap();

    let desktop = fresh();
    desktop.core.set_edition(Edition::Shop);
    backup::restore_backup(&desktop.core, &zip).unwrap();
    let after: Vec<i64> = tables.iter().map(|t| count(&desktop, t)).collect();
    assert_eq!(before, after, "row counts per table");
    assert!(before[0] >= 1 && before[2] > 1);
    let totals_after: (i64, i64, i64) = (
        desktop.val("SELECT COALESCE(sum(total), 0) FROM sales"),
        desktop.val("SELECT COALESCE(sum(amount), 0) FROM cash_movements"),
        desktop.val("SELECT COALESCE(sum(quantity), 0) FROM products"),
    );
    assert_eq!(totals_before, totals_after);
}

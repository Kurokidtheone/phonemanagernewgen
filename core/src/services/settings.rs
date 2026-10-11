// Key/value settings. Private keys ("auth.*", "license.*", "window.*") never leave the core.
use crate::db::DbExt;
use crate::error::{invalid, Res};
use crate::valid;
use rusqlite::{params, Connection};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn get_value<T: DeserializeOwned>(db: &Connection, key: &str) -> Res<Option<T>> {
    let raw: Option<String> = db.opt_val("SELECT value FROM settings WHERE key = ?1", [key])?;
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn set_value<T: Serialize + ?Sized>(db: &Connection, key: &str, value: &T) -> Res<()> {
    let json = serde_json::to_string(value)?;
    db.exec("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, json])?;
    Ok(())
}

pub fn delete_value(db: &Connection, key: &str) -> Res<()> {
    db.exec("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

/// Settings the window may read at any time: identity, language, theme, printing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(rename_all = "camelCase")]
pub struct PublicSettings {
    pub store_name: String,
    pub owner_name: String,
    pub phone: String,
    pub address: String,
    pub logo_file: Option<String>,
    #[ts(type = "'ar' | 'fr' | 'en'")]
    pub language: String,
    #[ts(type = "'light' | 'dark' | 'system'")]
    pub theme: String,
    #[ts(type = "'80mm' | 'A5'")]
    pub receipt_size: String,
    pub receipt_footer: String,
    pub receipt_printer: String,
    #[ts(type = "'40x25' | '50x30'")]
    pub label_size: String,
    pub allow_negative_stock: bool,
    pub auto_print_receipt: bool,
    pub debt_due_days: i64,
    pub repair_terms: String,
    pub ask_seller: bool,
    pub slip_copies: i64,
    pub warranty_new_days: i64,
    pub warranty_used_days: i64,
    pub warranty_accessory_days: i64,
    pub hide_cost_when_locked: bool,
    pub setup_done: bool,
}

impl Default for PublicSettings {
    fn default() -> Self {
        Self {
            store_name: String::new(),
            owner_name: String::new(),
            phone: String::new(),
            address: String::new(),
            logo_file: None,
            language: "ar".into(),
            theme: "system".into(),
            receipt_size: "80mm".into(),
            receipt_footer: String::new(),
            receipt_printer: String::new(),
            label_size: "40x25".into(),
            allow_negative_stock: false,
            auto_print_receipt: true,
            debt_due_days: 30,
            repair_terms: String::new(),
            ask_seller: false,
            slip_copies: 2,
            warranty_new_days: 365,
            warranty_used_days: 30,
            warranty_accessory_days: 0,
            hide_cost_when_locked: true,
            setup_done: false,
        }
    }
}

impl PublicSettings {
    pub fn validate(&self) -> Res<()> {
        valid::len(&self.store_name, 0, 120, "storeName")?;
        valid::len(&self.owner_name, 0, 120, "ownerName")?;
        valid::len(&self.phone, 0, 40, "phone")?;
        valid::len(&self.address, 0, 200, "address")?;
        valid::one_of(&self.language, &["ar", "fr", "en"], "language")?;
        valid::one_of(&self.theme, &["light", "dark", "system"], "theme")?;
        valid::one_of(&self.receipt_size, &["80mm", "A5"], "receiptSize")?;
        valid::len(&self.receipt_footer, 0, 400, "receiptFooter")?;
        valid::len(&self.receipt_printer, 0, 200, "receiptPrinter")?;
        valid::one_of(&self.label_size, &["40x25", "50x30"], "labelSize")?;
        valid::range(self.debt_due_days, 0, 3650, "debtDueDays")?;
        valid::len(&self.repair_terms, 0, 400, "repairTerms")?;
        valid::range(self.slip_copies, 1, 3, "slipCopies")?;
        valid::range(self.warranty_new_days, 0, 3650, "warrantyNewDays")?;
        valid::range(self.warranty_used_days, 0, 3650, "warrantyUsedDays")?;
        valid::range(self.warranty_accessory_days, 0, 3650, "warrantyAccessoryDays")?;
        Ok(())
    }
}

const PUBLIC_KEY: &str = "public";

pub fn get_public(db: &Connection) -> Res<PublicSettings> {
    let stored: Option<Value> = get_value(db, PUBLIC_KEY)?;
    let mut merged = serde_json::to_value(PublicSettings::default())?;
    if let (Some(Value::Object(stored)), Value::Object(base)) = (stored, &mut merged) {
        for (k, v) in stored {
            if base.contains_key(&k) {
                base.insert(k, v);
            }
        }
    }
    let settings: PublicSettings = serde_json::from_value(merged)?;
    settings.validate()?;
    Ok(settings)
}

/// Applies a partial update (keys the settings do not have are ignored). Invalid values are refused.
pub fn update_public(db: &Connection, patch: serde_json::Map<String, Value>) -> Res<PublicSettings> {
    let mut current = serde_json::to_value(get_public(db)?)?;
    if let Value::Object(base) = &mut current {
        for (k, v) in patch {
            if base.contains_key(&k) {
                base.insert(k, v);
            }
        }
    }
    let next: PublicSettings = serde_json::from_value(current).map_err(|e| invalid(e.to_string()))?;
    next.validate()?;
    set_value(db, PUBLIC_KEY, &next)?;
    Ok(next)
}

pub fn set_logo(db: &Connection, logo: Option<String>) -> Res<PublicSettings> {
    let mut s = get_public(db)?;
    s.logo_file = logo;
    set_value(db, PUBLIC_KEY, &s)?;
    Ok(s)
}

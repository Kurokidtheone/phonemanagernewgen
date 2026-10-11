// Offline sync for the phone (phase 17).
//
//   sync.pull { cursor }  -> what changed on the PC since the phone's cursor, through views that hide costs and profit
//                            from every role but OWNER, plus each customer's debt.
//   sync.push { ops }     -> the operations the phone made while it could not reach the PC, applied one by one through
//                            the SAME service functions as the live channels. Every op has an id; an id that was already
//                            applied returns its stored result and does nothing else, so a retry is always safe.
//
// Conflicts are exactly these: a sale of a phone that is no longer in stock (nothing of the sale is applied and the op
// waits in sync_conflicts), and a new phone whose IMEI exists. Everything else that cannot be applied is rejected.
use crate::caller::{Caller, DeviceCaller, Via};
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Error, Res};
use crate::mobile::allowlist::is_allowed;
use crate::services::{cash, customers, repairs, sales, settings, stock};
use crate::util::{now, uuid, with_event_at, with_sync_mode, SyncMode};
use crate::valid::{self, Validate};
use rusqlite::params;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// Changes older than this are dropped, unless they are the newest change of their row.
pub const KEEP_DAYS: i64 = 30;
pub const PULL_LIMIT: i64 = 2000;
pub const DEFAULT_MAX_STALE_DAYS: i64 = 7;
pub const DEFAULT_MAX_OUTBOX: i64 = 500;

// ---------- the change feed ----------

/// (table, columns a phone may see, columns an OWNER may see). `None` means every column.
const TABLES: &[(&str, &str, Option<&str>)] = &[
    (
        "products",
        "id, kind, brand_id, category_id, name, model, storage, color, barcode, sale_price, min_price, quantity, low_stock_threshold, is_repair_part, default_warranty_days, deleted_at, created_at, updated_at",
        None,
    ),
    (
        "phone_units",
        "id, product_id, imei1, imei2, condition, battery_health, grade, sale_price, status, notes, deleted_at, created_at, updated_at",
        None,
    ),
    ("brands", "*", None),
    ("categories", "*", None),
    ("customers", "*", None),
    ("repairs", "*", None),
    ("repair_status_log", "*", None),
    ("services", "id, name, kind, default_price, active, created_at, updated_at", None),
    ("employees", "id, name, role, deleted_at, created_at, updated_at", Some("id, name, role, deleted_at, created_at, updated_at")),
];

/// The SQL of the migration that adds the feed: tables, triggers on every synced table, the views and the first backfill.
pub fn feed_sql() -> String {
    let mut sql = String::from(
        "
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('UPSERT','DELETE')),
  at TEXT NOT NULL
);
CREATE INDEX changes_row ON changes(table_name, row_id, seq);
CREATE INDEX changes_at ON changes(at);
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE applied_ops (
  op_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied','conflict','rejected')),
  result_json TEXT NOT NULL,
  made_at TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE sync_id_map (
  device_id TEXT NOT NULL,
  temp_id TEXT NOT NULL,
  real_id TEXT NOT NULL,
  PRIMARY KEY (device_id, temp_id)
);
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  op_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  resolution TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX sync_conflicts_status ON sync_conflicts(status);
ALTER TABLE sales ADD COLUMN applied_at TEXT;
ALTER TABLE sales ADD COLUMN temp_receipt TEXT;
ALTER TABLE sales ADD COLUMN sync_flag TEXT;
CREATE INDEX sales_temp_receipt ON sales(temp_receipt);
ALTER TABLE cash_movements ADD COLUMN held_by_device TEXT;
",
    );
    let stamp = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
    let mut tables: Vec<(&str, &str, &str)> = TABLES.iter().map(|(t, _, _)| (*t, "id", "")).collect();
    tables.push(("settings", "key", " WHEN NEW.key = 'public'"));
    for (t, pk, when) in &tables {
        let old_when = when.replace("NEW.", "OLD.");
        sql += &format!(
            "CREATE TRIGGER sync_{t}_ins AFTER INSERT ON {t}{when} BEGIN INSERT INTO changes (table_name, row_id, op, at) VALUES ('{t}', NEW.{pk}, 'UPSERT', {stamp}); END;
CREATE TRIGGER sync_{t}_upd AFTER UPDATE ON {t}{when} BEGIN INSERT INTO changes (table_name, row_id, op, at) VALUES ('{t}', NEW.{pk}, 'UPSERT', {stamp}); END;
CREATE TRIGGER sync_{t}_del AFTER DELETE ON {t}{old_when} BEGIN INSERT INTO changes (table_name, row_id, op, at) VALUES ('{t}', OLD.{pk}, 'DELETE', {stamp}); END;
INSERT INTO changes (table_name, row_id, op, at) SELECT '{t}', {pk}, 'UPSERT', {stamp} FROM {t}{backfill};
",
            backfill = if *t == "settings" { " WHERE key = 'public'" } else { "" }
        );
    }
    // One view per table that exposes only what a phone may see, and one for OWNER phones.
    for (t, cols, owner) in TABLES {
        sql += &format!("CREATE VIEW sync_{t} AS SELECT {cols} FROM {t};\n");
        sql += &format!("CREATE VIEW sync_owner_{t} AS SELECT {} FROM {t};\n", owner.unwrap_or("*"));
    }
    sql += "CREATE VIEW sync_settings AS SELECT key AS id, value FROM settings WHERE key = 'public';\n";
    sql += "CREATE VIEW sync_owner_settings AS SELECT key AS id, value FROM settings WHERE key = 'public';\n";
    sql
}

fn synced_table(name: &str) -> bool {
    name == "settings" || TABLES.iter().any(|(t, _, _)| *t == name)
}

fn camel(s: &str) -> String {
    let mut out = String::new();
    let mut up = false;
    for c in s.chars() {
        if c == '_' {
            up = true;
        } else if up {
            out.extend(c.to_uppercase());
            up = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// One row of a view as a JSON object with camelCase keys.
fn view_row(ctx: &Ctx, view: &str, id: &str) -> Res<Option<Value>> {
    let mut stmt = ctx.db.prepare_cached(&format!("SELECT * FROM {view} WHERE id = ?1"))?;
    let names: Vec<String> = stmt.column_names().iter().map(|n| camel(n)).collect();
    let mut rows = stmt.query([id])?;
    let Some(row) = rows.next()? else { return Ok(None) };
    let mut map = Map::new();
    for (i, name) in names.iter().enumerate() {
        let v = match row.get_ref(i)? {
            rusqlite::types::ValueRef::Null | rusqlite::types::ValueRef::Blob(_) => Value::Null,
            rusqlite::types::ValueRef::Integer(n) => json!(n),
            rusqlite::types::ValueRef::Real(f) => json!(f),
            rusqlite::types::ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        };
        map.insert(name.clone(), v);
    }
    Ok(Some(Value::Object(map)))
}

fn state_get(ctx: &Ctx, key: &str) -> Res<Option<String>> {
    ctx.db.opt_val("SELECT value FROM sync_state WHERE key = ?1", [key])
}

/// Drops changes older than 30 days that a newer change of the same row makes useless. A DELETE older than that is
/// dropped too, and the highest dropped number is remembered: a phone whose cursor is below it must start over.
pub fn prune_changes(ctx: &Ctx) -> Res<()> {
    let cutoff = crate::util::iso(chrono::Utc::now() - chrono::Duration::days(KEEP_DAYS));
    ctx.db.exec(
        "DELETE FROM changes WHERE at < ?1 AND op = 'UPSERT' AND EXISTS (SELECT 1 FROM changes n WHERE n.table_name = changes.table_name AND n.row_id = changes.row_id AND n.seq > changes.seq)",
        [&cutoff],
    )?;
    let old_deletes: Option<i64> = ctx.db.val("SELECT max(seq) FROM changes WHERE at < ?1 AND op = 'DELETE'", [&cutoff])?;
    if let Some(top) = old_deletes {
        ctx.db.exec("DELETE FROM changes WHERE at < ?1 AND op = 'DELETE'", [&cutoff])?;
        let current: i64 = state_get(ctx, "pruned_up_to")?.and_then(|v| v.parse().ok()).unwrap_or(0);
        if top > current {
            ctx.db.exec(
                "INSERT INTO sync_state (key, value) VALUES ('pruned_up_to', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [top.to_string()],
            )?;
        }
    }
    Ok(())
}

input! { pub struct PullInput { #[serde(default)] pub cursor: i64 } }
impl Validate for PullInput {
    fn validate(&mut self) -> Res<()> {
        valid::check(self.cursor >= 0, "invalid_input")
    }
}

row! { pub struct DebtRow { pub customer_id: String, pub balance: i64 } }
row! {
    pub struct SyncLimits {
        pub max_stale_days: i64,
        pub max_outbox: i64,
        pub server_time: String,
    }
}
row! {
    pub struct PullResult {
        pub cursor: i64,
        /// The phone's cursor is older than what the PC kept: drop the local copy and pull from 0.
        pub reset: bool,
        /// More changes wait: pull again with the new cursor.
        pub more: bool,
        /// Rows to insert or replace, by table.
        #[ts(type = "Record<string, Array<Record<string, unknown>>>")]
        pub tables: Value,
        /// Ids to remove, by table.
        #[ts(type = "Record<string, string[]>")]
        pub deletes: Value,
        pub debts: Vec<DebtRow>,
        pub limits: SyncLimits,
    }
}

fn limits(ctx: &Ctx) -> Res<SyncLimits> {
    Ok(SyncLimits {
        max_stale_days: settings::get_value::<i64>(ctx.db, "sync.maxStaleDays")?.unwrap_or(DEFAULT_MAX_STALE_DAYS),
        max_outbox: settings::get_value::<i64>(ctx.db, "sync.maxOutbox")?.unwrap_or(DEFAULT_MAX_OUTBOX),
        server_time: now(),
    })
}

fn is_owner(ctx: &Ctx) -> bool {
    match &ctx.caller {
        Caller::Desktop => true,
        Caller::Device(d) => d.role.as_deref() == Some("OWNER"),
    }
}

pub fn pull(ctx: &Ctx, input: &PullInput) -> Res<PullResult> {
    prune_changes(ctx)?;
    let head: i64 = ctx.db.val::<Option<i64>>("SELECT max(seq) FROM changes", [])?.unwrap_or(0);
    let pruned: i64 = state_get(ctx, "pruned_up_to")?.and_then(|v| v.parse().ok()).unwrap_or(0);
    let debts = || -> Res<Vec<DebtRow>> {
        let mut out: Vec<DebtRow> = crate::services::balance::customer_balances(ctx)?
            .into_iter()
            .filter(|(_, b)| *b > 0)
            .map(|(customer_id, balance)| DebtRow { customer_id, balance })
            .collect();
        out.sort_by(|a, b| a.customer_id.cmp(&b.customer_id));
        Ok(out)
    };
    // Too old (some deletions were forgotten), or ahead of the PC (a restored backup): start over.
    if input.cursor > 0 && (input.cursor < pruned || input.cursor > head) {
        return Ok(PullResult { cursor: 0, reset: true, more: false, tables: json!({}), deletes: json!({}), debts: Vec::new(), limits: limits(ctx)? });
    }

    // The newest change of each row after the cursor, oldest first.
    let page: Vec<(i64, String, String, String)> = {
        let mut stmt = ctx.db.prepare_cached(
            "SELECT seq, table_name, row_id, op FROM changes c
              WHERE seq > ?1 AND seq = (SELECT max(seq) FROM changes n WHERE n.table_name = c.table_name AND n.row_id = c.row_id)
              ORDER BY seq LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![input.cursor, PULL_LIMIT + 1], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let more = page.len() as i64 > PULL_LIMIT;
    let owner = is_owner(ctx);
    let mut tables: Map<String, Value> = Map::new();
    let mut deletes: Map<String, Value> = Map::new();
    let mut last = input.cursor;
    for (seq, table, row_id, op) in page.iter().take(PULL_LIMIT as usize) {
        last = *seq;
        if !synced_table(table) {
            continue;
        }
        if op == "DELETE" {
            deletes.entry(table.clone()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(json!(row_id));
        } else if let Some(row) = view_row(ctx, &format!("{}_{table}", if owner { "sync_owner" } else { "sync" }), row_id)? {
            tables.entry(table.clone()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(row);
        }
    }
    let cursor = if more { last } else { head.max(input.cursor) };
    Ok(PullResult { cursor, reset: false, more, tables: Value::Object(tables), deletes: Value::Object(deletes), debts: debts()?, limits: limits(ctx)? })
}

// ---------- push ----------

input! {
    pub struct OpInput {
        pub op_id: String,
        #[serde(rename = "type")]
        pub kind: String,
        pub made_at: String,
        pub payload: Value,
    }
}
input! { pub struct PushInput { pub ops: Vec<OpInput> } }
impl Validate for PushInput {
    fn validate(&mut self) -> Res<()> {
        valid::max_items(&self.ops, 0, 100, "ops")?;
        for op in &self.ops {
            valid::id(&op.op_id, "opId")?;
            valid::datetime(&op.made_at, "madeAt")?;
            valid::len(&op.kind, 1, 40, "type")?;
        }
        Ok(())
    }
}

row! {
    pub struct OpResult {
        pub op_id: String,
        #[ts(type = "'applied' | 'conflict' | 'rejected'")]
        pub status: String,
        /// For conflict and rejected: why, as a code.
        pub reason: Option<String>,
        /// For applied: the final ids and numbers.
        #[ts(type = "Record<string, unknown>")]
        pub result: Value,
    }
}
row! { pub struct PushResult { pub results: Vec<OpResult> } }

const CONFLICTS: &[&str] = &["imei_already_sold", "imei_exists"];

/// Operation type -> the live channel it stands for (its role check).
fn channel_of(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "sale" => "sales.create",
        "stock_add_unit" => "units.add",
        "stock_add_item" => "items.create",
        "price_change" => "units.setPrice",
        "customer_create" => "customers.create",
        "customer_payment" => "customer.receivePayment",
        "repair_create" => "repairs.create",
        "repair_status" => "repairs.setStatus",
        _ => return None,
    })
}

/// Every string in the payload that is a temporary id made earlier becomes the real id.
fn remap(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(real) = map.get(s.as_str()) {
                *s = real.clone();
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| remap(x, map)),
        Value::Object(o) => o.values_mut().for_each(|x| remap(x, map)),
        _ => {}
    }
}

fn parse<T: serde::de::DeserializeOwned + Validate>(v: &Value) -> Res<T> {
    let mut t: T = serde_json::from_value(v.clone()).map_err(|e| crate::error::invalid(e.to_string()))?;
    t.validate()?;
    Ok(t)
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

struct Applied {
    result: Value,
    /// temp id -> real id, remembered for later ops.
    ids: Vec<(String, String)>,
}

fn sale_op(ctx: &Ctx, op: &OpInput, p: &Value, device: &DeviceCaller) -> Res<Applied> {
    // A phone that is no longer in stock: the whole sale is not applied.
    let mut negative = false;
    let mut wanted: HashMap<String, i64> = HashMap::new();
    for line in p.get("lines").and_then(Value::as_array).into_iter().flatten() {
        if let Some(unit) = str_of(line, "unitId") {
            let status: Option<String> = ctx.db.opt_val("SELECT status FROM phone_units WHERE id = ?1 AND deleted_at IS NULL", [unit])?;
            if status.as_deref() != Some("IN_STOCK") {
                bail!("imei_already_sold");
            }
        } else if let Some(item) = str_of(line, "productId") {
            *wanted.entry(item.to_owned()).or_insert(0) += line.get("quantity").and_then(Value::as_i64).unwrap_or(1);
        }
    }
    for (item, qty) in &wanted {
        let have: Option<i64> = ctx.db.opt_val("SELECT quantity FROM products WHERE id = ?1 AND kind = 'ITEM'", [item])?;
        if have.is_some_and(|h| *qty > h) {
            negative = true;
        }
    }
    let mut payload = p.clone();
    // The phone cannot choose who sold: its own employee replaces what it wrote.
    if let Some(o) = payload.as_object_mut() {
        match &device.employee_id {
            Some(e) => {
                o.insert("employeeId".into(), json!(e));
            }
            None if device.role.as_deref() != Some("OWNER") => {
                o.remove("employeeId");
            }
            None => {}
        }
        o.remove("managerPassword");
        o.remove("requestId");
    }
    let input: sales::SaleInput = parse(&payload)?;
    let created = with_event_at(&op.made_at, || {
        with_sync_mode(SyncMode { allow_negative: true, hold_cash: true }, || {
            sales::create_sale(ctx, &input, sales::SaleOptions::default()).map_err(|e| {
                if e.code() == "unit_not_available" {
                    crate::error::app("imei_already_sold")
                } else {
                    e
                }
            })
        })
    })?;
    let temp_receipt = str_of(p, "tempReceipt").map(str::to_owned);
    let flag = negative.then_some("negative_stock");
    ctx.db.exec("UPDATE sales SET applied_at = ?1, temp_receipt = ?2, sync_flag = ?3 WHERE id = ?4", params![now(), temp_receipt, flag, created.id])?;
    let mut ids = Vec::new();
    if let Some(t) = str_of(p, "tempId") {
        ids.push((t.to_owned(), created.id.clone()));
    }
    Ok(Applied { result: json!({ "saleId": created.id, "receiptNumber": created.receipt_number, "flag": flag }), ids })
}

fn apply_kind(ctx: &Ctx, op: &OpInput, p: &Value, device: &DeviceCaller) -> Res<Applied> {
    let temp = str_of(p, "tempId").map(str::to_owned);
    let with_temp = |real: &str, extra: Value| Applied { result: extra, ids: temp.iter().map(|t| (t.clone(), real.to_owned())).collect() };
    match op.kind.as_str() {
        "sale" => sale_op(ctx, op, p, device),
        "stock_add_unit" => {
            let input: stock::UnitAddInput = parse(p)?;
            if let Some(dup) = stock::imei_status(ctx, &input.imei1, None)?.duplicate {
                let _ = dup;
                bail!("imei_exists");
            }
            if let Some(i2) = &input.imei2 {
                if stock::imei_status(ctx, i2, None)?.duplicate.is_some() {
                    bail!("imei_exists");
                }
            }
            let added = with_event_at(&op.made_at, || stock::add_unit(ctx, &input))?;
            let mut applied = with_temp(&added.id, json!({ "unitId": added.id, "productId": added.product_id }));
            // The phone may have made a model of its own for this phone: its temporary id maps to the real model.
            if let Some(t) = str_of(p, "tempProductId") {
                applied.ids.push((t.to_owned(), added.product_id.clone()));
            }
            Ok(applied)
        }
        "stock_add_item" => {
            let input: stock::ItemInput = parse(p)?;
            let created = stock::create_item(ctx, &input)?;
            Ok(with_temp(&created.id, json!({ "itemId": created.id })))
        }
        "price_change" => {
            let target = str_of(p, "target").unwrap_or("");
            let id = str_of(p, "id").unwrap_or("");
            let price = p.get("salePrice").and_then(Value::as_i64).unwrap_or(-1);
            valid::id(id, "id")?;
            valid::pos_centimes(price, "salePrice")?;
            let (table, old): (&str, Option<i64>) = match target {
                "unit" => ("phone_units", ctx.db.opt_val("SELECT sale_price FROM phone_units WHERE id = ?1 AND deleted_at IS NULL", [id])?),
                "item" => ("products", ctx.db.opt_val("SELECT sale_price FROM products WHERE id = ?1 AND kind = 'ITEM' AND deleted_at IS NULL", [id])?),
                _ => bail!("invalid_input"),
            };
            let Some(old) = old else { bail!("not_found") };
            // The last price to arrive wins; the old and the new are kept in the result.
            ctx.db.exec(&format!("UPDATE {table} SET sale_price = ?1, updated_at = ?2 WHERE id = ?3"), params![price, now(), id])?;
            Ok(Applied { result: json!({ "target": target, "id": id, "old": old, "new": price }), ids: Vec::new() })
        }
        "customer_create" => {
            let input: customers::CustomerInput = parse(p)?;
            // The same phone number is the same customer: reuse it, and later ops that name the temporary id are mapped to it.
            if !input.phone.is_empty() {
                let existing: Option<String> =
                    ctx.db.opt_val("SELECT id FROM customers WHERE phone = ?1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [&input.phone])?;
                if let Some(id) = existing {
                    return Ok(with_temp(&id, json!({ "customerId": id, "reused": true })));
                }
            }
            let c = customers::create_customer(ctx, &input)?;
            Ok(with_temp(&c.id, json!({ "customerId": c.id, "reused": false })))
        }
        "customer_payment" => {
            let mut payload = p.clone();
            if let Some(o) = payload.as_object_mut() {
                o.insert("date".into(), json!(op.made_at));
            }
            let input: customers::CustomerPaymentInput = parse(&payload)?;
            let r = with_sync_mode(SyncMode { allow_negative: false, hold_cash: true }, || customers::receive_payment(ctx, &input))?;
            Ok(Applied { result: json!({ "groupId": r.group_id, "before": r.before, "after": r.after }), ids: Vec::new() })
        }
        "repair_create" => {
            let input: repairs::RepairInput = parse(p)?;
            let r = with_sync_mode(SyncMode { allow_negative: false, hold_cash: true }, || with_event_at(&op.made_at, || repairs::create_repair(ctx, &input)))?;
            Ok(with_temp(&r.id, json!({ "repairId": r.id, "ticketNumber": r.ticket_number })))
        }
        "repair_status" => {
            let input: repairs::RepairStatusInput = parse(p)?;
            with_event_at(&op.made_at, || repairs::set_status(ctx, &input))?;
            Ok(Applied { result: json!({ "repairId": input.id, "status": input.status }), ids: Vec::new() })
        }
        _ => bail!("unknown_op"),
    }
}

fn stored_result(status: &str, reason: Option<&str>, result: &Value) -> String {
    json!({ "status": status, "reason": reason, "result": result }).to_string()
}

/// Applies one op, or returns what happened to it the first time. Only a bug (an internal error) is an Err.
fn apply_op(ctx: &Ctx, device: &DeviceCaller, op: &OpInput, map: &mut HashMap<String, String>) -> Res<OpResult> {
    if let Ok((status, json)) = ctx
        .db
        .prepare_cached("SELECT status, result_json FROM applied_ops WHERE op_id = ?1")?
        .query_row([&op.op_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
    {
        let v: Value = serde_json::from_str(&json)?;
        return Ok(OpResult { op_id: op.op_id.clone(), status, reason: v["reason"].as_str().map(str::to_owned), result: v["result"].clone() });
    }
    let record = |status: &str, reason: Option<&str>, result: &Value| -> Res<()> {
        ctx.db.exec(
            "INSERT INTO applied_ops (op_id, device_id, type, status, result_json, made_at, applied_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![op.op_id, device.device_id, op.kind, status, stored_result(status, reason, result), op.made_at, now()],
        )?;
        Ok(())
    };

    let rejected = |code: &str| -> Res<OpResult> {
        record("rejected", Some(code), &Value::Null)?;
        Ok(OpResult { op_id: op.op_id.clone(), status: "rejected".into(), reason: Some(code.to_owned()), result: Value::Null })
    };
    let Some(channel) = channel_of(&op.kind) else { return rejected("unknown_op") };
    if !is_allowed(channel, device.role.as_deref()) {
        return rejected("forbidden");
    }
    let mut payload = op.payload.clone();
    remap(&mut payload, map);

    // The service work and the applied_ops row are one transaction.
    let outcome = ctx.tx(|| {
        let applied = apply_kind(ctx, op, &payload, device)?;
        for (temp, real) in &applied.ids {
            ctx.db.exec("INSERT OR REPLACE INTO sync_id_map (device_id, temp_id, real_id) VALUES (?1, ?2, ?3)", params![device.device_id, temp, real])?;
        }
        record("applied", None, &applied.result)?;
        Ok(applied)
    });
    match outcome {
        Ok(applied) => {
            for (t, r) in applied.ids {
                map.insert(t, r);
            }
            Ok(OpResult { op_id: op.op_id.clone(), status: "applied".into(), reason: None, result: applied.result })
        }
        Err(Error::Internal(e)) => Err(Error::Internal(e)),
        Err(e) => {
            let code = e.code().to_owned();
            if CONFLICTS.contains(&code.as_str()) {
                let t = now();
                ctx.db.exec(
                    "INSERT INTO sync_conflicts (id, device_id, op_id, op_json, reason, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'OPEN', ?6, ?6)",
                    params![uuid(), device.device_id, op.op_id, serde_json::to_string(&json!({ "type": op.kind, "madeAt": op.made_at, "payload": payload }))?, code, t],
                )?;
                record("conflict", Some(&code), &Value::Null)?;
                Ok(OpResult { op_id: op.op_id.clone(), status: "conflict".into(), reason: Some(code), result: Value::Null })
            } else {
                rejected(&code)
            }
        }
    }
}

pub fn push(ctx: &Ctx, input: &PushInput) -> Res<PushResult> {
    let Caller::Device(device) = &ctx.caller else { bail!("forbidden") };
    let mut map: HashMap<String, String> = ctx
        .db
        .prepare_cached("SELECT temp_id, real_id FROM sync_id_map WHERE device_id = ?1")?
        .query_map([&device.device_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut results = Vec::with_capacity(input.ops.len());
    for op in &input.ops {
        results.push(apply_op(ctx, device, op, &mut map)?);
    }
    Ok(PushResult { results })
}

// ---------- needs review ----------

row! {
    pub struct ConflictRow {
        pub id: String,
        pub device_id: String,
        pub device_name: Option<String>,
        pub op_id: String,
        pub reason: String,
        pub status: String,
        pub resolution: Option<String>,
        pub resolved_at: Option<String>,
        pub created_at: String,
        /// What the phone tried to do.
        #[ts(type = "Record<string, unknown>")]
        pub op: Value,
        /// What the PC has now for the unit or the IMEI in question.
        #[ts(type = "Record<string, unknown>")]
        pub pc_has: Value,
    }
}

fn describe_pc_side(ctx: &Ctx, reason: &str, op: &Value) -> Res<Value> {
    let imei_of_unit = |unit_id: &str| -> Res<Option<(String, String, String)>> {
        Ok(ctx
            .db
            .prepare_cached("SELECT u.imei1, u.status, p.name FROM phone_units u JOIN products p ON p.id = u.product_id WHERE u.id = ?1")?
            .query_row([unit_id], |r| Ok((r.get::<_, Option<String>>(0)?.unwrap_or_default(), r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            .ok())
    };
    if reason == "imei_already_sold" {
        for line in op["payload"]["lines"].as_array().into_iter().flatten() {
            if let Some(unit) = line["unitId"].as_str() {
                if let Some((imei, status, model)) = imei_of_unit(unit)? {
                    if status != "IN_STOCK" {
                        let sale: Option<(String, String)> = ctx
                            .db
                            .prepare_cached("SELECT s.receipt_number, s.date FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE l.unit_id = ?1 ORDER BY s.date DESC LIMIT 1")?
                            .query_row([unit], |r| Ok((r.get(0)?, r.get(1)?)))
                            .ok();
                        return Ok(
                            json!({ "unitId": unit, "imei": imei, "model": model, "status": status, "receiptNumber": sale.as_ref().map(|s| &s.0), "soldAt": sale.as_ref().map(|s| &s.1) }),
                        );
                    }
                }
            }
        }
    }
    if reason == "imei_exists" {
        let imei = op["payload"]["imei1"].as_str().unwrap_or("");
        let found: Option<(String, String, String)> = ctx
            .db
            .prepare_cached("SELECT u.id, u.status, p.name FROM phone_units u JOIN products p ON p.id = u.product_id WHERE (u.imei1 = ?1 OR u.imei2 = ?1) AND u.deleted_at IS NULL")?
            .query_row([imei], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .ok();
        if let Some((id, status, model)) = found {
            return Ok(json!({ "unitId": id, "imei": imei, "model": model, "status": status }));
        }
    }
    Ok(json!({}))
}

pub fn list_conflicts(ctx: &Ctx, open_only: bool) -> Res<Vec<ConflictRow>> {
    #[derive(serde::Deserialize)]
    struct Raw {
        id: String,
        device_id: String,
        device_name: Option<String>,
        op_id: String,
        op_json: String,
        reason: String,
        status: String,
        resolution: Option<String>,
        resolved_at: Option<String>,
        created_at: String,
    }
    let sql = format!(
        "SELECT c.id, c.device_id, d.name AS device_name, c.op_id, c.op_json, c.reason, c.status, c.resolution, c.resolved_at, c.created_at
           FROM sync_conflicts c LEFT JOIN mobile_devices d ON d.id = c.device_id {} ORDER BY c.created_at",
        if open_only { "WHERE c.status = 'OPEN'" } else { "" }
    );
    let raws: Vec<Raw> = ctx.db.all(&sql, [])?;
    raws.into_iter()
        .map(|r| {
            let op: Value = serde_json::from_str(&r.op_json)?;
            let pc_has = describe_pc_side(ctx, &r.reason, &op)?;
            Ok(ConflictRow {
                id: r.id,
                device_id: r.device_id,
                device_name: r.device_name,
                op_id: r.op_id,
                reason: r.reason,
                status: r.status,
                resolution: r.resolution,
                resolved_at: r.resolved_at,
                created_at: r.created_at,
                op,
                pc_has,
            })
        })
        .collect()
}

pub fn open_conflict_count(ctx: &Ctx) -> Res<i64> {
    ctx.db.val("SELECT count(*) FROM sync_conflicts WHERE status = 'OPEN'", [])
}

input! {
    pub struct ResolveInput {
        pub id: String,
        /// "discard", or "apply" with another unit the manager picked.
        pub action: String,
        pub unit_id: Option<String>,
    }
}
impl Validate for ResolveInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::one_of(&self.action, &["discard", "apply"], "action")?;
        valid::opt_id(&self.unit_id, "unitId")?;
        valid::check(self.action == "discard" || self.unit_id.is_some(), "invalid_input")
    }
}

fn finish(ctx: &Ctx, id: &str, op_id: &str, resolution: &str, result: &Value) -> Res<()> {
    let t = now();
    ctx.db.exec(
        "UPDATE sync_conflicts SET status = 'RESOLVED', resolution = ?1, resolved_at = ?2, resolved_by = 'manager', updated_at = ?2 WHERE id = ?3",
        params![resolution, t, id],
    )?;
    // A phone that asks again about this op learns what the manager decided.
    ctx.db.exec(
        "UPDATE applied_ops SET result_json = json_set(result_json, '$.result', json(?1)) WHERE op_id = ?2",
        params![serde_json::to_string(&json!({ "resolution": resolution, "detail": result }))?, op_id],
    )?;
    Ok(())
}

row! {
    pub struct ResolveResult {
        pub resolution: String,
        #[ts(type = "Record<string, unknown> | null")]
        pub sale: Option<Value>,
    }
}

/// The manager's decision on a conflict. "apply" runs the phone's sale again with the picked unit in place of the one
/// that was gone; the sale keeps the time the phone made it.
pub fn resolve_conflict(ctx: &Ctx, input: &ResolveInput) -> Res<ResolveResult> {
    ctx.tx(|| {
        #[derive(serde::Deserialize)]
        struct Raw {
            device_id: String,
            op_id: String,
            op_json: String,
            reason: String,
            status: String,
        }
        let Some(row) = ctx.db.get::<Raw>("SELECT device_id, op_id, op_json, reason, status FROM sync_conflicts WHERE id = ?1", [&input.id])? else {
            bail!("not_found")
        };
        if row.status != "OPEN" {
            bail!("already_resolved");
        }
        if input.action == "discard" {
            finish(ctx, &input.id, &row.op_id, "discarded", &Value::Null)?;
            return Ok(ResolveResult { resolution: "discarded".into(), sale: None });
        }
        if row.reason != "imei_already_sold" {
            bail!("invalid_input");
        }
        let op: Value = serde_json::from_str(&row.op_json)?;
        let unit = input.unit_id.clone().unwrap();
        let mut payload = op["payload"].clone();
        let gone = payload["lines"].as_array().into_iter().flatten().find_map(|l| {
            let u = l["unitId"].as_str()?;
            let status: Option<String> = ctx.db.opt_val("SELECT status FROM phone_units WHERE id = ?1", [u]).ok().flatten();
            (status.as_deref() != Some("IN_STOCK")).then(|| u.to_owned())
        });
        let Some(gone) = gone else { bail!("invalid_input") };
        if let Some(lines) = payload["lines"].as_array_mut() {
            for l in lines {
                if l["unitId"].as_str() == Some(gone.as_str()) {
                    l["unitId"] = json!(unit);
                }
            }
        }
        let device = device_caller(ctx, &row.device_id)?;
        let made_at = op["madeAt"].as_str().unwrap_or("").to_owned();
        let again = OpInput { op_id: row.op_id.clone(), kind: "sale".into(), made_at, payload: payload.clone() };
        let applied = ctx.with_caller(Caller::Device(device.clone()), |c| sale_op(c, &again, &payload, &device))?;
        finish(ctx, &input.id, &row.op_id, "applied_with_other_unit", &applied.result)?;
        Ok(ResolveResult { resolution: "applied_with_other_unit".into(), sale: Some(applied.result) })
    })
}

fn device_caller(ctx: &Ctx, id: &str) -> Res<DeviceCaller> {
    let Some(d) = crate::mobile::devices::find_by_id(ctx, id)? else { bail!("not_found") };
    Ok(DeviceCaller { device_id: d.id, role: d.role, employee_id: d.employee_id, via: Via::Lan })
}

// ---------- phone cash to hand over ----------

row! {
    pub struct HeldCash {
        pub device_id: String,
        pub device_name: Option<String>,
        pub amount: i64,
        pub count: i64,
    }
}

/// Cash that phones took and have not yet handed over, per phone.
pub fn held_cash(ctx: &Ctx) -> Res<Vec<HeldCash>> {
    ctx.db.all(
        "SELECT m.held_by_device AS device_id, d.name AS device_name,
                COALESCE(SUM(CASE WHEN m.direction = 'IN' THEN m.amount ELSE -m.amount END), 0) AS amount, COUNT(*) AS count
           FROM cash_movements m LEFT JOIN mobile_devices d ON d.id = m.held_by_device
          WHERE m.held_by_device IS NOT NULL GROUP BY m.held_by_device ORDER BY d.name",
        [],
    )
}

input! { pub struct ConfirmCashInput { pub device_id: String } }
impl Validate for ConfirmCashInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.device_id, "deviceId")
    }
}

/// "Confirm received": the phone's cash moves into the open session.
pub fn confirm_held_cash(ctx: &Ctx, input: &ConfirmCashInput) -> Res<i64> {
    ctx.tx(|| {
        let session = cash::require_open_session(ctx)?;
        let held = held_cash(ctx)?.into_iter().find(|h| h.device_id == input.device_id).map(|h| h.amount).unwrap_or(0);
        ctx.db.exec(
            "UPDATE cash_movements SET session_id = ?1, held_by_device = NULL, updated_at = ?2 WHERE held_by_device = ?3",
            params![session, now(), input.device_id],
        )?;
        Ok(held)
    })
}

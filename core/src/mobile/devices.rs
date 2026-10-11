// Paired phones. Only the SHA-256 of a token is stored; the token itself is shown to the phone once, at pairing.
use crate::caller::Via;
use crate::core::{Core, Ctx};
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::MobileDevice;
use crate::util::{ms_to_iso, now, now_ms, uuid};
use crate::valid::{self, Validate};
use base64::Engine;
use rand::RngCore;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const LAST_SEEN_EVERY_MS: i64 = 60_000;

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

row! {
    pub struct Device {
        pub id: String,
        pub name: String,
        #[ts(type = "'OWNER' | 'SELLER' | 'TECHNICIAN' | 'STOCK' | null")]
        pub role: Option<String>,
        pub employee_id: Option<String>,
        pub last_seen_at: Option<String>,
        pub revoked_at: Option<String>,
        pub created_at: String,
        /// How the phone last reached the PC: the shop Wi-Fi or the mailbox (outside the shop).
        #[ts(type = "'lan' | 'remote' | null")]
        pub last_seen_via: Option<String>,
    }
}

fn public_device(d: &MobileDevice) -> Device {
    Device {
        id: d.id.clone(),
        name: d.name.clone(),
        role: d.role.clone(),
        employee_id: d.employee_id.clone(),
        last_seen_at: d.last_seen_at.clone(),
        revoked_at: d.revoked_at.clone(),
        created_at: d.created_at.clone(),
        last_seen_via: d.last_seen_via.clone().filter(|v| v == "lan" || v == "remote"),
    }
}

row! { pub struct RemoteKeys { pub mailbox: String, pub key: String } }

pub struct Created {
    pub token: String,
    pub device: Device,
    pub remote: RemoteKeys,
}

/// Creates the device with no role yet: it can call nothing until the owner saves the device form. It also gets its
/// own mailbox name and encryption key for outside access, returned here once for the pairing answer.
pub fn create_device(ctx: &Ctx, name: &str) -> Res<Created> {
    let remote = RemoteKeys { mailbox: wire::new_mailbox(), key: wire::key_to_string(&wire::new_key()) };
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw);
    let trimmed = name.trim();
    let t = now();
    let row = MobileDevice {
        id: uuid(),
        name: if trimmed.is_empty() { "Phone".into() } else { trimmed.to_owned() },
        role: None,
        employee_id: None,
        token_hash: hash_token(&token),
        remote_allowed: false,
        mailbox: Some(remote.mailbox.clone()),
        wire_key: Some(remote.key.clone()),
        last_seen_via: None,
        last_seen_at: None,
        revoked_at: None,
        created_at: t.clone(),
        updated_at: t,
    };
    ctx.db.exec(
        "INSERT INTO mobile_devices (id, name, role, employee_id, token_hash, remote_allowed, mailbox, wire_key, created_at, updated_at) VALUES (?1, ?2, NULL, NULL, ?3, 0, ?4, ?5, ?6, ?6)",
        params![row.id, row.name, row.token_hash, row.mailbox, row.wire_key, row.created_at],
    )?;
    Ok(Created { token, device: public_device(&row), remote })
}

pub fn find_by_token(ctx: &Ctx, token: &str) -> Res<Option<MobileDevice>> {
    ctx.db.get("SELECT * FROM mobile_devices WHERE token_hash = ?1", [hash_token(token)])
}

pub fn find_by_id(ctx: &Ctx, id: &str) -> Res<Option<MobileDevice>> {
    ctx.db.get("SELECT * FROM mobile_devices WHERE id = ?1", [id])
}

/// Paired phones that are not revoked: what the license limit counts.
pub fn active_device_count(ctx: &Ctx) -> Res<i64> {
    ctx.db.val("SELECT count(*) FROM mobile_devices WHERE revoked_at IS NULL", [])
}

pub fn get_device(ctx: &Ctx, id: &str) -> Res<Device> {
    match find_by_id(ctx, id)? {
        Some(d) => Ok(public_device(&d)),
        None => bail!("not_found"),
    }
}

row! {
    pub struct DeviceRow {
        #[serde(flatten)]
        #[ts(flatten)]
        pub device: Device,
        pub employee_name: Option<String>,
    }
}

pub fn list_devices(ctx: &Ctx) -> Res<Vec<DeviceRow>> {
    let mut stmt = ctx.db.prepare_cached("SELECT id, name FROM employees")?;
    let names: HashMap<String, String> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let rows: Vec<MobileDevice> = ctx.db.all("SELECT * FROM mobile_devices ORDER BY created_at DESC", [])?;
    Ok(rows.iter().map(|d| DeviceRow { device: public_device(d), employee_name: d.employee_id.as_ref().and_then(|e| names.get(e).cloned()) }).collect())
}

input! {
    pub struct DeviceUpdateInput {
        pub id: String,
        pub name: String,
        pub role: String,
        pub employee_id: Option<String>,
    }
}
impl Validate for DeviceUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::text(&mut self.name, 1, 60, "name")?;
        valid::one_of(&self.role, &["OWNER", "SELLER", "TECHNICIAN", "STOCK"], "role")?;
        valid::empty_to_none(&mut self.employee_id);
        Ok(())
    }
}

pub fn update_device(ctx: &Ctx, i: &DeviceUpdateInput) -> Res<Device> {
    get_device(ctx, &i.id)?;
    if let Some(e) = &i.employee_id {
        if !ctx.db.exists("SELECT 1 FROM employees WHERE id = ?1", [e])? {
            bail!("not_found");
        }
    }
    ctx.db.exec(
        "UPDATE mobile_devices SET name = ?1, role = ?2, employee_id = ?3, updated_at = ?4 WHERE id = ?5",
        params![i.name, i.role, i.employee_id, now(), i.id],
    )?;
    get_device(ctx, &i.id)
}

/// Takes effect on the very next request: every call looks the device up again. Forgets the mailbox and its key.
pub fn revoke_device(ctx: &Ctx, id: &str) -> Res<()> {
    let d = get_device(ctx, id)?;
    if d.revoked_at.is_some() {
        return Ok(());
    }
    let t = now();
    ctx.db.exec("UPDATE mobile_devices SET revoked_at = ?1, mailbox = NULL, wire_key = NULL, updated_at = ?1 WHERE id = ?2", params![t, id])?;
    Ok(())
}

pub struct RemoteDevice {
    pub id: String,
    pub mailbox: String,
    pub key: String,
}

/// The phones that can be reached through a mailbox: paired, not revoked.
pub fn remote_devices(ctx: &Ctx) -> Res<Vec<RemoteDevice>> {
    let rows: Vec<MobileDevice> =
        ctx.db.all("SELECT * FROM mobile_devices WHERE revoked_at IS NULL AND mailbox IS NOT NULL AND wire_key IS NOT NULL ORDER BY rowid", [])?;
    Ok(rows.into_iter().map(|d| RemoteDevice { id: d.id, mailbox: d.mailbox.unwrap(), key: d.wire_key.unwrap() }).collect())
}

/// last_seen_at is written at most once a minute per device, but a change of route (shop <-> outside) is written at once.
pub fn touch(core: &Core, ctx: &Ctx, id: &str, via: Via) -> Res<()> {
    let at = now_ms();
    {
        let mut last = core.mobile.last_seen.lock().unwrap();
        if let Some((when, v)) = last.get(id) {
            if *v == via && at - when < LAST_SEEN_EVERY_MS {
                return Ok(());
            }
        }
        last.insert(id.to_owned(), (at, via));
    }
    ctx.db.exec("UPDATE mobile_devices SET last_seen_at = ?1, last_seen_via = ?2 WHERE id = ?3", params![ms_to_iso(at), via.as_str(), id])?;
    Ok(())
}

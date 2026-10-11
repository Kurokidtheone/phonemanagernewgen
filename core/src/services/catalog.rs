// Brands and categories. Lists the user maintains, not business records: deleted for real, but only
// while nothing points to them.
use super::codes::POPULAR_BRANDS;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::{Brand, Category};
use crate::util::{now, uuid};
use rusqlite::params;

pub fn list_brands(ctx: &Ctx) -> Res<Vec<Brand>> {
    ctx.db.all("SELECT * FROM brands ORDER BY name", [])
}

pub fn list_categories(ctx: &Ctx) -> Res<Vec<Category>> {
    ctx.db.all("SELECT * FROM categories ORDER BY kind, name", [])
}

fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

pub fn create_brand(ctx: &Ctx, name: &str) -> Res<Brand> {
    if list_brands(ctx)?.iter().any(|b| same(&b.name, name)) {
        bail!("name_taken");
    }
    let t = now();
    let row = Brand { id: uuid(), name: name.to_owned(), created_at: t.clone(), updated_at: t };
    ctx.db.exec("INSERT INTO brands (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)", params![row.id, row.name, row.created_at, row.updated_at])?;
    Ok(row)
}

/// Adds the popular brands that are not there yet (ignoring case). Returns how many were added.
pub fn add_popular_brands(ctx: &Ctx) -> Res<i64> {
    let mut have: std::collections::HashSet<String> = list_brands(ctx)?.into_iter().map(|b| b.name.to_lowercase()).collect();
    let mut added = 0;
    for name in POPULAR_BRANDS {
        if !have.insert(name.to_lowercase()) {
            continue;
        }
        let t = now();
        ctx.db.exec("INSERT INTO brands (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", params![uuid(), name, t])?;
        added += 1;
    }
    Ok(added)
}

pub fn rename_brand(ctx: &Ctx, id: &str, name: &str) -> Res<()> {
    if list_brands(ctx)?.iter().any(|b| b.id != id && same(&b.name, name)) {
        bail!("name_taken");
    }
    if ctx.db.exec("UPDATE brands SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now(), id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

pub fn delete_brand(ctx: &Ctx, id: &str) -> Res<()> {
    // Soft-deleted products still point at the brand: they keep it so history stays readable.
    if ctx.db.exists("SELECT 1 FROM products WHERE brand_id = ?1", [id])? {
        bail!("in_use");
    }
    ctx.db.exec("DELETE FROM brands WHERE id = ?1", [id])?;
    Ok(())
}

pub fn create_category(ctx: &Ctx, name: &str, kind: &str) -> Res<Category> {
    let t = now();
    let row = Category { id: uuid(), name: name.to_owned(), kind: kind.to_owned(), created_at: t.clone(), updated_at: t };
    ctx.db.exec(
        "INSERT INTO categories (id, name, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![row.id, row.name, row.kind, row.created_at, row.updated_at],
    )?;
    Ok(row)
}

pub fn rename_category(ctx: &Ctx, id: &str, name: &str) -> Res<()> {
    if ctx.db.exec("UPDATE categories SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now(), id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

pub fn delete_category(ctx: &Ctx, id: &str) -> Res<()> {
    if ctx.db.exists("SELECT 1 FROM products WHERE category_id = ?1", [id])? {
        bail!("in_use");
    }
    ctx.db.exec("DELETE FROM categories WHERE id = ?1", [id])?;
    Ok(())
}

/// The category phone models go in. Created on first use so a new install needs no setup.
pub fn phone_category_id(ctx: &Ctx) -> Res<String> {
    if let Some(id) = ctx.db.opt_val::<String>("SELECT id FROM categories WHERE kind = 'PHONE' LIMIT 1", [])? {
        return Ok(id);
    }
    Ok(create_category(ctx, "Smartphones", "PHONE")?.id)
}

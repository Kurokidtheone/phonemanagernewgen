// Expenses and expense categories. Paid from the drawer: the cash leaves with the expense, in one step.
use super::cash::cash;
use super::files::{import_file, remove_file, DOCUMENT_TYPES};
use crate::core::Ctx;
use crate::db::{DbExt, Filter};
use crate::error::{bail, Res};
use crate::rows::ExpenseCategory;
use crate::util::{now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;

pub fn default_categories(lang: &str) -> &'static [&'static str] {
    match lang {
        "fr" => &["Fournitures", "Loyer", "Eau et électricité", "Entretien", "Nettoyage", "Autre"],
        "en" => &["Supplies", "Rent", "Water and electricity", "Maintenance", "Cleaning", "Other"],
        _ => &["لوازم", "إيجار", "ماء وكهرباء", "صيانة", "نظافة", "أخرى"],
    }
}

pub fn list_categories(ctx: &Ctx) -> Res<Vec<ExpenseCategory>> {
    ctx.db.all("SELECT * FROM expense_categories ORDER BY name", [])
}

pub fn create_category(ctx: &Ctx, name: &str) -> Res<ExpenseCategory> {
    let t = now();
    let row = ExpenseCategory { id: uuid(), name: name.trim().to_owned(), created_at: t.clone(), updated_at: t };
    ctx.db.exec(
        "INSERT INTO expense_categories (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![row.id, row.name, row.created_at, row.updated_at],
    )?;
    Ok(row)
}

pub fn rename_category(ctx: &Ctx, id: &str, name: &str) -> Res<()> {
    if list_categories(ctx)?.iter().any(|c| c.id != id && c.name.to_lowercase() == name.to_lowercase()) {
        bail!("name_taken");
    }
    if ctx.db.exec("UPDATE expense_categories SET name = ?1, updated_at = ?2 WHERE id = ?3", params![name, now(), id])? == 0 {
        bail!("not_found");
    }
    Ok(())
}

/// Only a category no expense uses can go: the expenses keep their category for good.
pub fn delete_category(ctx: &Ctx, id: &str) -> Res<()> {
    if ctx.db.exists("SELECT 1 FROM expenses WHERE category_id = ?1", [id])? {
        bail!("in_use");
    }
    ctx.db.exec("DELETE FROM expense_categories WHERE id = ?1", [id])?;
    Ok(())
}

/// Seeds a first set of categories so the form is usable on day one.
pub fn ensure_default_categories(ctx: &Ctx, names: &[&str]) -> Res<()> {
    if ctx.db.val::<i64>("SELECT count(*) FROM expense_categories", [])? == 0 {
        for n in names {
            create_category(ctx, n)?;
        }
    }
    Ok(())
}

input! {
    #[derive(Default)]
    pub struct ExpenseFilter {
        pub from: Option<String>,
        pub to: Option<String>,
        pub category_id: Option<String>,
        pub search: Option<String>,
    }
}
impl Validate for ExpenseFilter {
    fn validate(&mut self) -> Res<()> {
        valid::opt_date(&self.from, "from")?;
        valid::opt_date(&self.to, "to")
    }
}

row! {
    pub struct ExpenseRow {
        pub id: String,
        pub buyer: String,
        pub category_id: String,
        pub category_name: String,
        pub date: String,
        pub amount: i64,
        pub note: String,
        pub receipt_file: Option<String>,
    }
}

pub fn list_expenses(ctx: &Ctx, filter: &ExpenseFilter) -> Res<Vec<ExpenseRow>> {
    let mut f = Filter::new();
    if let Some(v) = &filter.from {
        f.add_with("e.date >= ?", v.clone());
    }
    if let Some(v) = &filter.to {
        f.add_with("e.date <= ?", v.clone());
    }
    if let Some(v) = filter.category_id.as_ref().filter(|v| !v.is_empty()) {
        f.add_with("e.category_id = ?", v.clone());
    }
    if let Some(v) = filter.search.as_ref().filter(|v| !v.is_empty()) {
        let like = format!("%{v}%");
        f.add_with2("(e.buyer LIKE ? OR e.note LIKE ?)", like.clone(), like);
    }
    let sql = format!(
        "SELECT e.id, e.buyer, e.category_id, c.name AS category_name, e.date, e.amount, e.note, e.receipt_file
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id{} ORDER BY e.date DESC, e.created_at DESC",
        f.sql()
    );
    ctx.db.all(&sql, f.args.params())
}

pub fn total_expenses(ctx: &Ctx, filter: &ExpenseFilter) -> Res<i64> {
    Ok(list_expenses(ctx, filter)?.iter().map(|e| e.amount).sum())
}

input! {
    pub struct ExpenseInput {
        pub buyer: String,
        pub category_id: String,
        pub date: String,
        pub amount: i64,
        #[serde(default)]
        pub note: String,
        #[serde(default)]
        pub receipt_path: Option<String>,
        #[serde(default = "yes")]
        pub from_cash: bool,
    }
}
fn yes() -> bool {
    true
}
impl Validate for ExpenseInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.buyer, 1, 120, "buyer")?;
        valid::id(&self.category_id, "categoryId")?;
        valid::date(&self.date, "date")?;
        valid::range(self.amount, 1, i64::MAX, "amount")?;
        valid::len(&self.note, 0, 400, "note")
    }
}

row! {
    pub struct Expense {
        pub id: String,
        pub buyer: String,
        pub category_id: String,
        pub date: String,
        pub amount: i64,
        pub note: String,
        pub receipt_file: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }
}

pub fn create_expense(ctx: &Ctx, input: &ExpenseInput) -> Res<Expense> {
    if !ctx.db.exists("SELECT 1 FROM expense_categories WHERE id = ?1", [&input.category_id])? {
        bail!("not_found");
    }
    let receipt_file = match &input.receipt_path {
        Some(p) if !p.is_empty() => Some(import_file(ctx, p, DOCUMENT_TYPES)?),
        _ => None,
    };
    let t = now();
    let row = Expense {
        id: uuid(),
        buyer: input.buyer.clone(),
        category_id: input.category_id.clone(),
        date: input.date.clone(),
        amount: input.amount,
        note: input.note.clone(),
        receipt_file,
        created_at: t.clone(),
        updated_at: t,
    };
    ctx.tx(|| {
        ctx.db.exec(
            "INSERT INTO expenses (id, buyer, category_id, date, amount, note, receipt_file, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![row.id, row.buyer, row.category_id, row.date, row.amount, row.note, row.receipt_file, row.created_at, row.updated_at],
        )?;
        if input.from_cash {
            cash(ctx, "OUT", row.amount, "EXPENSE", "expenses", &row.id, &row.buyer, None)?;
        }
        Ok(())
    })?;
    Ok(row)
}

pub fn delete_expense(ctx: &Ctx, id: &str) -> Res<()> {
    let Some(row) = ctx.db.get::<Expense>("SELECT * FROM expenses WHERE id = ?1", [id])? else { bail!("not_found") };
    ctx.tx(|| {
        // If the expense came out of the drawer, deleting it puts the cash back.
        if ctx.db.exists("SELECT 1 FROM cash_movements WHERE ref_table = 'expenses' AND ref_id = ?1 AND type = 'EXPENSE'", [id])? {
            cash(ctx, "IN", row.amount, "EXPENSE_CANCEL", "expenses", id, &row.buyer, None)?;
        }
        ctx.db.exec("DELETE FROM expenses WHERE id = ?1", [id])?;
        Ok(())
    })?;
    remove_file(ctx, row.receipt_file.as_deref());
    Ok(())
}

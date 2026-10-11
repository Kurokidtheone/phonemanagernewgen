// Small services sold over the counter: flexy top-ups and other services. Each sale writes a cash movement IN.
// Margin: a flexy service has a rule, a percentage of the amount or a fixed fee; cost = amount - margin.
// Both are stored on the sale, so changing the rule later does not change past margins.
use super::cash::cash;
use crate::core::Ctx;
use crate::db::DbExt;
use crate::error::{bail, Res};
use crate::rows::Service;
use crate::util::{js_round, now, uuid};
use crate::valid::{self, Validate};
use rusqlite::params;

pub fn margin_for(margin_type: &str, margin_value: i64, amount: i64) -> i64 {
    if margin_type == "FIXED" {
        return margin_value.min(amount);
    }
    js_round((amount * margin_value) as f64 / 10_000.0) // hundredths of a percent
}

pub fn list_services(ctx: &Ctx, only_active: bool) -> Res<Vec<Service>> {
    let all: Vec<Service> = ctx.db.all("SELECT * FROM services ORDER BY kind, name", [])?;
    Ok(all.into_iter().filter(|s| !only_active || s.active).collect())
}

input! {
    pub struct ServiceCreateInput {
        pub name: String,
        #[serde(default)]
        pub default_price: i64,
    }
}
impl Validate for ServiceCreateInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 80, "name")?;
        valid::centimes(self.default_price, "defaultPrice")
    }
}

pub fn create_service(ctx: &Ctx, input: &ServiceCreateInput) -> Res<Service> {
    let t = now();
    let row = Service {
        id: uuid(),
        name: input.name.clone(),
        kind: "OTHER".into(),
        margin_type: "PERCENT".into(),
        margin_value: 0,
        default_price: input.default_price,
        active: true,
        created_at: t.clone(),
        updated_at: t,
    };
    insert(ctx, &row)?;
    Ok(row)
}

fn insert(ctx: &Ctx, r: &Service) -> Res<()> {
    ctx.db.exec(
        "INSERT INTO services (id, name, kind, margin_type, margin_value, default_price, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![r.id, r.name, r.kind, r.margin_type, r.margin_value, r.default_price, r.active, r.created_at, r.updated_at],
    )?;
    Ok(())
}

input! {
    pub struct ServiceUpdateInput {
        pub id: String,
        pub name: String,
        pub margin_type: String,
        pub margin_value: i64,
        #[serde(default)]
        pub default_price: i64,
        pub active: bool,
    }
}
impl Validate for ServiceUpdateInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::text(&mut self.name, 1, 80, "name")?;
        valid::one_of(&self.margin_type, &["PERCENT", "FIXED"], "marginType")?;
        valid::range(self.margin_value, 0, 100_000_000, "marginValue")?;
        valid::centimes(self.default_price, "defaultPrice")
    }
}

pub fn update_service(ctx: &Ctx, i: &ServiceUpdateInput) -> Res<()> {
    let n = ctx.db.exec(
        "UPDATE services SET name = ?1, margin_type = ?2, margin_value = ?3, default_price = ?4, active = ?5, updated_at = ?6 WHERE id = ?7",
        params![i.name, i.margin_type, i.margin_value, i.default_price, i.active, now(), i.id],
    )?;
    if n == 0 {
        bail!("not_found");
    }
    Ok(())
}

/// First-run services, so the quick-sale buttons exist from day one.
pub fn ensure_default_services(ctx: &Ctx) -> Res<()> {
    if ctx.db.exists("SELECT 1 FROM services LIMIT 1", [])? {
        return Ok(());
    }
    for name in ["Mobilis", "Djezzy", "Ooredoo"] {
        let t = now();
        insert(
            ctx,
            &Service {
                id: uuid(),
                name: format!("Flexy {name}"),
                kind: "FLEXY".into(),
                margin_type: "PERCENT".into(),
                margin_value: 300,
                default_price: 0,
                active: true,
                created_at: t.clone(),
                updated_at: t,
            },
        )?;
    }
    Ok(())
}

input! {
    pub struct ServiceSellInput {
        pub service_id: String,
        pub amount: i64,
        pub cost: Option<i64>,
        pub phone_number: Option<String>,
        pub employee_id: Option<String>,
    }
}
impl Validate for ServiceSellInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.service_id, "serviceId")?;
        valid::pos_centimes(self.amount, "amount")?;
        if let Some(c) = self.cost {
            valid::centimes(c, "cost")?;
        }
        valid::opt_text(&mut self.phone_number, 20, "phoneNumber")?;
        valid::empty_to_none(&mut self.employee_id);
        Ok(())
    }
}

row! { pub struct SellResult { pub id: String, pub margin: i64, pub cost: i64 } }

pub fn sell_service(ctx: &Ctx, input: &ServiceSellInput) -> Res<SellResult> {
    ctx.tx(|| {
        let service = ctx.db.get::<Service>("SELECT * FROM services WHERE id = ?1", [&input.service_id])?;
        let Some(service) = service.filter(|s| s.active) else { bail!("not_found") };
        let (margin, cost) = if service.kind == "FLEXY" {
            let m = margin_for(&service.margin_type, service.margin_value, input.amount);
            (m, input.amount - m)
        } else {
            let c = input.cost.unwrap_or(0).min(input.amount);
            (input.amount - c, c)
        };
        let id = uuid();
        let t = now();
        ctx.db.exec(
            "INSERT INTO service_sales (id, service_id, amount, cost, margin, date, phone_number, employee_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6, ?6)",
            params![id, service.id, input.amount, cost, margin, t, input.phone_number, input.employee_id],
        )?;
        cash(ctx, "IN", input.amount, "SERVICE", "service_sales", &id, &service.name, Some(&t))?;
        Ok(SellResult { id, margin, cost })
    })
}

row! {
    pub struct ServiceSaleRow {
        pub id: String,
        pub date: String,
        pub amount: i64,
        pub cost: i64,
        pub margin: i64,
        pub phone_number: Option<String>,
        pub service_name: String,
        #[ts(type = "'FLEXY' | 'OTHER'")]
        pub service_kind: String,
        pub employee_name: Option<String>,
    }
}

row! {
    pub struct ServiceSales {
        pub rows: Vec<ServiceSaleRow>,
        pub total_amount: i64,
        pub total_margin: i64,
    }
}

input! { pub struct ServiceSalesFilter { pub from: String, pub to: String } }
impl Validate for ServiceSalesFilter {
    fn validate(&mut self) -> Res<()> {
        valid::datetime(&self.from, "from")?;
        valid::datetime(&self.to, "to")
    }
}

/// Sales in a period (ISO instants) with their totals.
pub fn list_service_sales(ctx: &Ctx, from: &str, to: &str) -> Res<ServiceSales> {
    let rows: Vec<ServiceSaleRow> = ctx.db.all(
        "SELECT s.id, s.date, s.amount, s.cost, s.margin, s.phone_number, v.name AS service_name, v.kind AS service_kind, e.name AS employee_name
         FROM service_sales s JOIN services v ON v.id = s.service_id LEFT JOIN employees e ON e.id = s.employee_id
         WHERE s.date >= ?1 AND s.date <= ?2 ORDER BY s.date DESC",
        params![from, to],
    )?;
    Ok(ServiceSales { total_amount: rows.iter().map(|r| r.amount).sum(), total_margin: rows.iter().map(|r| r.margin).sum(), rows })
}

/// Delete a sale made by mistake. The cash it brought in goes back out, in the same step.
pub fn delete_service_sale(ctx: &Ctx, id: &str) -> Res<()> {
    ctx.tx(|| {
        let Some((service_id, amount)) = ctx
            .db
            .prepare_cached("SELECT service_id, amount FROM service_sales WHERE id = ?1")?
            .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .ok()
        else {
            bail!("not_found")
        };
        let name: Option<String> = ctx.db.opt_val("SELECT name FROM services WHERE id = ?1", [&service_id])?;
        cash(ctx, "OUT", amount, "SERVICE_VOID", "service_sales", id, name.as_deref().unwrap_or(""), None)?;
        ctx.db.exec("DELETE FROM service_sales WHERE id = ?1", [id])?;
        Ok(())
    })
}

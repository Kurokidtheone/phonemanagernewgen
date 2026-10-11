// Every call from the window (Tauri command) and from the phones (HTTP) goes through this table. To add a feature:
//   1. write the function in a service,  2. add one line here,  3. call api('<channel>', input) in React.
// `sections` makes the manager password apply (a list means shared data: refused only when every one is locked).
// `write` blocks the call when the trial is over. The TypeScript `Api` type is generated from this table.
use crate::caller::Caller;
use crate::core::{Core, Ctx};
use crate::error::{app, invalid, Error, IpcResult, Res};
use crate::services::{
    auth, backup, catalog, counts, customers, employees, expenses, files, finance, import, license, purchases, repairs, returns, sales, seed,
    services as service_catalog, settings, stock, suppliers, sync, visibility::costs_visible, xlsx,
};
use crate::valid::{self, Validate};
use futures_util::future::BoxFuture;
use once_cell::sync::Lazy;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::any::TypeId;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use ts_rs::TS;

type SyncFn = Box<dyn Fn(&Ctx, Value) -> Res<Value> + Send + Sync>;
type AsyncFn = Box<dyn Fn(Arc<Core>, Caller, Value) -> BoxFuture<'static, Res<Value>> + Send + Sync>;

enum Run {
    Sync(SyncFn),
    Async(AsyncFn),
}

pub struct Channel {
    pub name: &'static str,
    pub sections: &'static [&'static str],
    pub write: bool,
    run: Run,
    ts_input: &'static str,
    ts_output: fn(&mut TsCollector) -> String,
}

/// Turns the payload into a checked input, like Zod's parse: defaults, trimming, limits.
fn parse<I: DeserializeOwned + Validate>(v: Value) -> Res<I> {
    let mut i: I = serde_json::from_value(v).map_err(|e| invalid(e.to_string()))?;
    i.validate()?;
    Ok(i)
}

fn out<O: Serialize>(o: O) -> Res<Value> {
    Ok(serde_json::to_value(o)?)
}

const NONE: &[&str] = &[];
const SETTINGS: &[&str] = &["settings"];
const STOCK: &[&str] = &["stock"];
const SELL: &[&str] = &["sell"];
const PEOPLE: &[&str] = &["people"];
const REPAIRS: &[&str] = &["repairs"];
const FINANCE: &[&str] = &["finance"];
const PICKERS: &[&str] = &["sell", "people", "repairs"];
const EMPLOYEE_PICKER: &[&str] = &["sell", "people", "repairs", "settings"];
const SELL_FINANCE: &[&str] = &["sell", "finance"];
const FINANCE_SELL: &[&str] = &["finance", "sell"];
const FINANCE_STOCK: &[&str] = &["finance", "stock"];
const FINANCE_SETTINGS: &[&str] = &["finance", "settings"];
const W: bool = true;
const R: bool = false;

struct Table(Vec<Channel>);

impl Table {
    fn s<I, O, F>(&mut self, name: &'static str, sections: &'static [&'static str], write: bool, ts_input: &'static str, f: F)
    where
        I: DeserializeOwned + Validate + 'static,
        O: Serialize + TS + 'static,
        F: Fn(&Ctx, I) -> Res<O> + Send + Sync + 'static,
    {
        let run: SyncFn = Box::new(move |ctx, v| out(f(ctx, parse::<I>(v)?)?));
        self.0.push(Channel { name, sections, write, run: Run::Sync(run), ts_input, ts_output: ts_type::<O> });
    }

    /// A channel without input.
    fn s0<O, F>(&mut self, name: &'static str, sections: &'static [&'static str], write: bool, f: F)
    where
        O: Serialize + TS + 'static,
        F: Fn(&Ctx) -> Res<O> + Send + Sync + 'static,
    {
        let run: SyncFn = Box::new(move |ctx, _| out(f(ctx)?));
        self.0.push(Channel { name, sections, write, run: Run::Sync(run), ts_input: "void", ts_output: ts_type::<O> });
    }

    /// A channel that waits on something (a dialog, a printer, the phone server).
    fn a<I, O, F, Fut>(&mut self, name: &'static str, sections: &'static [&'static str], write: bool, ts_input: &'static str, f: F)
    where
        I: DeserializeOwned + Validate + Send + 'static,
        O: Serialize + TS + 'static,
        Fut: Future<Output = Res<O>> + Send + 'static,
        F: Fn(Arc<Core>, Caller, I) -> Fut + Send + Sync + 'static,
    {
        let f = Arc::new(f);
        let run: AsyncFn = Box::new(move |core, caller, v| {
            let f = f.clone();
            Box::pin(async move { out(f(core, caller, parse::<I>(v)?).await?) })
        });
        self.0.push(Channel { name, sections, write, run: Run::Async(run), ts_input, ts_output: ts_type::<O> });
    }
}

/// No input (z.void()).
#[derive(Deserialize, Default)]
pub struct NoInput {}
impl Validate for NoInput {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}

// ---------- small inputs ----------

input! { pub struct IdInput { pub id: String } }
impl Validate for IdInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")
    }
}
input! { pub struct NameInput { pub name: String } }
impl Validate for NameInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 80, "name")
    }
}
input! { pub struct IdNameInput { pub id: String, pub name: String } }
impl Validate for IdNameInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.id, "id")?;
        valid::text(&mut self.name, 1, 80, "name")
    }
}
input! { pub struct CategoryInput { pub name: String, pub kind: String } }
impl Validate for CategoryInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 80, "name")?;
        valid::one_of(&self.kind, &["PHONE", "ACCESSORY", "PART"], "kind")
    }
}
input! { pub struct ExpenseCategoryName { pub name: String } }
impl Validate for ExpenseCategoryName {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.name, 1, 60, "name")
    }
}
input! { pub struct LogoInput { pub path: Option<String> } }
impl Validate for LogoInput {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}
input! { pub struct PasswordInput { pub password: String } }
impl Validate for PasswordInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.password, 4, 100, "password")
    }
}
input! { pub struct ChangePasswordInput { pub current: String, pub next: String } }
impl Validate for ChangePasswordInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.next, 4, 100, "next")
    }
}
input! { pub struct CurrentInput { pub current: String } }
impl Validate for CurrentInput {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}
input! { pub struct UnlockInput { pub password: String } }
impl Validate for UnlockInput {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}
input! { pub struct ResetInput { pub code: String, pub next: String } }
impl Validate for ResetInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.next, 4, 100, "next")
    }
}
input! { pub struct SectionsInput { pub sections: Vec<String> } }
impl Validate for SectionsInput {
    fn validate(&mut self) -> Res<()> {
        self.sections.iter().try_for_each(|s| valid::one_of(s, crate::services::codes::SECTION_IDS, "sections"))
    }
}
input! { pub struct KeyInput { pub key: String } }
impl Validate for KeyInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.key, 1, usize::MAX, "key")
    }
}
input! { pub struct PrintSilentInput { pub html: String, pub request_id: Option<String> } }
impl Validate for PrintSilentInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.html, 0, 2_000_000, "html")
    }
}
input! { pub struct PrintInput { pub html: String } }
impl Validate for PrintInput {
    fn validate(&mut self) -> Res<()> {
        valid::len(&self.html, 0, 2_000_000, "html")
    }
}
input! { pub struct SearchInput { pub q: String } }
impl Validate for SearchInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.q, 2, 60, "q")
    }
}
input! { pub struct LookupInput { pub code: String } }
impl Validate for LookupInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.code, 1, 60, "code")
    }
}
input! { pub struct ImeiStatusInput { pub imei: String, pub exclude_unit_id: Option<String> } }
impl Validate for ImeiStatusInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.imei, 0, 40, "imei")
    }
}
input! { pub struct SaleFindInput { pub query: String } }
impl Validate for SaleFindInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.query, 1, 40, "query")
    }
}
input! { pub struct GroupInput { pub group_id: String } }
impl Validate for GroupInput {
    fn validate(&mut self) -> Res<()> {
        valid::id(&self.group_id, "groupId")
    }
}
input! { pub struct ExpenseDeleteInput { pub id: String } }
impl Validate for ExpenseDeleteInput {
    fn validate(&mut self) -> Res<()> {
        Ok(())
    }
}
input! {
    pub struct ExportInput {
        pub title: String,
        pub headers: Vec<String>,
        /// Plain values; money is sent as a number of DA.
        pub rows: Vec<Vec<Value>>,
        #[serde(default)]
        pub money_columns: Vec<i64>,
    }
}
impl Validate for ExportInput {
    fn validate(&mut self) -> Res<()> {
        valid::text(&mut self.title, 1, 60, "title")?;
        valid::max_items(&self.headers, 1, 30, "headers")?;
        self.headers.iter().try_for_each(|h| valid::len(h, 0, 80, "headers"))?;
        valid::max_items(&self.rows, 0, 50_000, "rows")?;
        for row in &self.rows {
            for v in row {
                match v {
                    Value::String(s) => valid::len(s, 0, 500, "rows")?,
                    Value::Number(_) | Value::Null => {}
                    _ => return Err(invalid("rows: not a cell")),
                }
            }
        }
        valid::max_items(&self.money_columns, 0, 30, "moneyColumns")?;
        self.money_columns.iter().try_for_each(|c| valid::range(*c, 0, i64::MAX, "moneyColumns"))
    }
}
input! {
    #[derive(Default)]
    pub struct SettingsPatch {
        #[serde(flatten)]
        pub fields: serde_json::Map<String, Value>,
    }
}
impl Validate for SettingsPatch {
    fn validate(&mut self) -> Res<()> {
        self.fields.remove("logoFile"); // only settings.setLogo changes it
        Ok(())
    }
}

row! { pub struct Saved { pub saved: bool, pub path: Option<String> } }
row! { pub struct Restored { pub restored: bool } }
row! { pub struct Printed { pub printed: bool } }
row! { pub struct Added { pub added: i64 } }
row! {
    pub struct SystemInfo {
        pub version: String,
        pub schema_version: i64,
        pub data_dir: String,
        pub platform: String,
    }
}
row! { pub struct StockSearch { pub units: Vec<stock::UnitRow>, pub items: Vec<stock::ItemRow> } }

// ---------- hiding costs ----------

fn hide_unit(visible: bool, mut u: stock::UnitRow) -> stock::UnitRow {
    if !visible {
        u.cost = None;
    }
    u
}
fn hide_item(visible: bool, mut i: stock::ItemRow) -> stock::ItemRow {
    if !visible {
        i.avg_cost = None;
    }
    i
}

/// "win32" like Node's process.platform, so the screens keep their checks.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

fn file_name(title: &str) -> String {
    title.chars().map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c }).collect()
}

async fn request_print(core: Arc<Core>, kind: &'static str, data: Value) -> Res<Printed> {
    let (id, rx) = core.print.register();
    if !core.host.request_print(id.clone(), kind, data) {
        core.print.done(&id, false);
        return Err(app("print_unavailable"));
    }
    if !core.print.wait(&id, rx).await {
        return Err(app("print_failed"));
    }
    Ok(Printed { printed: true })
}

static TABLE: Lazy<HashMap<&'static str, Channel>> = Lazy::new(|| {
    let mut t = Table(Vec::new());
    // Settings
    t.s0("settings.get", NONE, R, |c| settings::get_public(c.db));
    t.s("settings.update", SETTINGS, W, "Partial<Omit<z.input<typeof s.publicSettingsSchema>, 'logoFile'>>", |c, i: SettingsPatch| {
        settings::update_public(c.db, i.fields)
    });
    t.s("settings.setLogo", SETTINGS, W, "{ path: string | null }", |c, i: LogoInput| {
        let old = settings::get_public(c.db)?.logo_file;
        let logo = match &i.path {
            Some(p) if !p.is_empty() => Some(files::import_file(c, p, files::IMAGE_TYPES)?),
            _ => None,
        };
        files::remove_file(c, old.as_deref());
        settings::set_logo(c.db, logo)
    });

    // Manager password
    t.s0("auth.status", NONE, R, auth::status);
    t.s("auth.setPassword", SETTINGS, R, "{ password: string }", |c, i: PasswordInput| auth::set_password(c, &i.password));
    t.s("auth.change", NONE, R, "{ current: string; next: string }", |c, i: ChangePasswordInput| auth::change_password(c, &i.current, &i.next));
    t.s("auth.remove", NONE, R, "{ current: string }", |c, i: CurrentInput| auth::remove_password(c, &i.current));
    t.s("auth.newRecoveryCode", NONE, R, "{ current: string }", |c, i: CurrentInput| auth::new_recovery_code(c, &i.current));
    t.s("auth.unlock", NONE, R, "{ password: string }", |c, i: UnlockInput| auth::unlock(c, &i.password));
    t.s0("auth.lock", NONE, R, auth::lock);
    t.s("auth.reset", NONE, R, "{ code: string; next: string }", |c, i: ResetInput| auth::reset_with_recovery(c, &i.code, &i.next));
    t.s("auth.setProtected", NONE, R, "{ sections: SectionId[] }", |c, i: SectionsInput| auth::set_protected_sections(c, &i.sections));

    // License
    t.s0("license.status", NONE, R, license::status);
    t.s("license.activate", NONE, R, "{ key: string }", |c, i: KeyInput| license::activate(c, &i.key));

    // Backup (allowed even when the trial is over: customers always keep their data)
    t.a("backup.create", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move {
        let Some(path) = core.host.save_dialog(backup::default_backup_name(), "Backup", &["zip"]).await else { return Ok(Saved { saved: false, path: None }) };
        backup::create_backup(&core, &path)?;
        Ok(Saved { saved: true, path: Some(path.display().to_string()) })
    });
    t.a("backup.restore", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move {
        let Some(path) = core.host.open_dialog("Backup", &["zip"]).await else { return Ok(Restored { restored: false }) };
        backup::restore_backup(&core, &path)?;
        let host = core.host.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            host.relaunch();
        });
        Ok(Restored { restored: true })
    });

    // System
    t.s0("system.info", NONE, R, |c| {
        Ok(SystemInfo {
            version: c.core.app_version.clone(),
            schema_version: crate::migrations::SCHEMA_VERSION as i64,
            data_dir: c.core.paths.data_dir().display().to_string(),
            platform: platform().into(),
        })
    });
    t.s0("system.openDataFolder", SETTINGS, R, |c| {
        c.core.host.open_path(c.core.paths.data_dir().to_path_buf());
        Ok(())
    });
    t.s0("seed.load", SETTINGS, W, seed::seed_sample_data);
    t.a("print.silent", NONE, R, "{ html: string; requestId?: string }", |core: Arc<Core>, _, i: PrintSilentInput| async move {
        let printer = core.desktop(|c| settings::get_public(c.db))?.receipt_printer;
        let ok = core.host.print_silent(i.html, printer).await;
        if let Some(id) = &i.request_id {
            core.print.done(id, ok);
        }
        Ok(ok)
    });
    t.a("print.printers", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move { Ok(core.host.list_printers().await) });
    t.a("print.html", NONE, R, "{ html: string }", |core: Arc<Core>, _, i: PrintInput| async move { Ok(core.host.print_html(i.html).await) });

    // Stock: brands and categories
    t.s0("brands.list", STOCK, R, catalog::list_brands);
    t.s("brands.create", STOCK, W, "z.input<typeof s.nameInputSchema>", |c, i: NameInput| catalog::create_brand(c, &i.name));
    t.s0("brands.addPopular", STOCK, W, |c| Ok(Added { added: catalog::add_popular_brands(c)? }));
    t.s("brands.rename", STOCK, W, "{ id: string; name: string }", |c, i: IdNameInput| catalog::rename_brand(c, &i.id, &i.name));
    t.s("brands.delete", STOCK, W, "{ id: string }", |c, i: IdInput| catalog::delete_brand(c, &i.id));
    t.s0("categories.list", STOCK, R, catalog::list_categories);
    t.s("categories.create", STOCK, W, "z.input<typeof s.categoryInputSchema>", |c, i: CategoryInput| catalog::create_category(c, &i.name, &i.kind));
    t.s("categories.rename", STOCK, W, "{ id: string; name: string }", |c, i: IdNameInput| catalog::rename_category(c, &i.id, &i.name));
    t.s("categories.delete", STOCK, W, "{ id: string }", |c, i: IdInput| catalog::delete_category(c, &i.id));

    // Stock: phones
    t.s0("models.list", STOCK, R, |c| {
        let v = costs_visible(c)?;
        Ok(stock::list_models(c)?
            .into_iter()
            .map(|mut m| {
                if !v {
                    m.avg_cost = None;
                }
                m
            })
            .collect::<Vec<_>>())
    });
    t.s("units.list", STOCK, R, "z.input<typeof s.unitFilterSchema>", |c, f: stock::UnitFilter| {
        let v = costs_visible(c)?;
        Ok(stock::list_units(c, &f)?.into_iter().map(|u| hide_unit(v, u)).collect::<Vec<_>>())
    });
    t.s("units.get", STOCK, R, "{ id: string }", |c, i: IdInput| {
        let mut d = stock::get_unit(c, &i.id)?;
        d.unit = hide_unit(costs_visible(c)?, d.unit);
        Ok(d)
    });
    t.s("units.imeiStatus", STOCK, R, "z.input<typeof s.imeiStatusSchema>", |c, i: ImeiStatusInput| {
        stock::imei_status(c, &i.imei, i.exclude_unit_id.as_deref())
    });
    t.s("units.add", STOCK, W, "z.input<typeof s.unitAddSchema>", |c, i: stock::UnitAddInput| stock::add_unit(c, &i));
    t.s("units.update", STOCK, W, "z.input<typeof s.unitUpdateSchema>", |c, i: stock::UnitUpdateInput| stock::update_unit(c, &i));
    t.s("units.setPrice", STOCK, W, "z.input<typeof s.unitPriceSchema>", |c, i: stock::UnitPriceInput| stock::set_unit_price(c, &i.id, i.sale_price));
    t.s("units.writeOff", STOCK, W, "z.input<typeof s.unitWriteOffSchema>", |c, i: stock::UnitWriteOffInput| stock::write_off_unit(c, &i.id, &i.reason));

    // Stock: accessories and parts
    t.s("items.list", STOCK, R, "z.input<typeof s.itemFilterSchema>", |c, f: stock::ItemFilter| {
        let v = costs_visible(c)?;
        Ok(stock::list_items(c, &f)?.into_iter().map(|i| hide_item(v, i)).collect::<Vec<_>>())
    });
    t.s("items.get", STOCK, R, "{ id: string }", |c, i: IdInput| Ok(hide_item(costs_visible(c)?, stock::get_item(c, &i.id)?)));
    t.s("items.create", STOCK, W, "z.input<typeof s.itemInputSchema>", |c, i: stock::ItemInput| stock::create_item(c, &i));
    t.s("items.update", STOCK, W, "z.input<typeof s.itemUpdateSchema>", |c, i: stock::ItemUpdateInput| stock::update_item(c, &i));
    t.s("items.delete", STOCK, W, "{ id: string }", |c, i: IdInput| stock::delete_item(c, &i.id));
    t.s("items.adjust", STOCK, W, "z.input<typeof s.itemAdjustSchema>", |c, i: stock::ItemAdjustInput| stock::adjust_item(c, &i));
    t.s0("items.generateBarcode", STOCK, W, stock::generate_barcode);
    t.s("stock.search", STOCK, R, "z.input<typeof s.searchSchema>", |c, i: SearchInput| {
        let v = costs_visible(c)?;
        let r = stock::search(c, &i.q)?;
        Ok(StockSearch { units: r.units.into_iter().map(|u| hide_unit(v, u)).collect(), items: r.items.into_iter().map(|x| hide_item(v, x)).collect() })
    });
    t.s("stock.lookup", STOCK, R, "z.input<typeof s.lookupSchema>", |c, i: LookupInput| stock::lookup(c, &i.code));

    // Stock: counts. Scanning only writes count lines; applying (owner) adjusts accessories; phones are decided one by one.
    t.s0("stockCount.list", STOCK, R, counts::list_counts);
    t.s("stockCount.get", STOCK, R, "{ id: string }", |c, i: IdInput| counts::result(c, &i.id));
    t.s("stockCount.start", STOCK, W, "z.input<typeof s.countStartSchema>", |c, i: counts::CountStartInput| counts::start_count(c, &i));
    t.s("stockCount.scanUnit", STOCK, W, "z.input<typeof s.countScanUnitSchema>", |c, i: counts::CountScanInput| counts::scan_unit(c, &i.count_id, &i.code));
    t.s("stockCount.countItem", STOCK, W, "z.input<typeof s.countItemSchema>", |c, i: counts::CountItemInput| {
        counts::count_item(c, &i.count_id, &i.product_id, i.quantity)
    });
    t.s("stockCount.apply", STOCK, W, "{ id: string }", |c, i: IdInput| counts::close_count(c, &i.id, true));
    t.s("stockCount.close", STOCK, W, "{ id: string }", |c, i: IdInput| counts::close_count(c, &i.id, false));
    t.s("stockCount.decide", STOCK, W, "z.input<typeof s.countDecisionSchema>", |c, i: counts::CountDecisionInput| counts::decide_unit(c, &i));

    // Stock: suppliers and purchases
    t.s0("suppliers.list", STOCK, R, suppliers::list_suppliers);
    t.s("suppliers.get", STOCK, R, "{ id: string }", |c, i: IdInput| suppliers::get_supplier(c, &i.id));
    t.s("suppliers.create", STOCK, W, "z.input<typeof s.supplierInputSchema>", |c, i: suppliers::SupplierInput| suppliers::create_supplier(c, &i));
    t.s("suppliers.update", STOCK, W, "z.input<typeof s.supplierUpdateSchema>", |c, i: suppliers::SupplierUpdateInput| suppliers::update_supplier(c, &i));
    t.s("suppliers.delete", STOCK, W, "{ id: string }", |c, i: IdInput| suppliers::delete_supplier(c, &i.id));
    t.s("suppliers.addPayment", STOCK, W, "z.input<typeof s.paymentInputSchema>", |c, i: suppliers::SupplierPaymentInput| suppliers::add_payment(c, &i));
    t.s("purchases.list", STOCK, R, "z.input<typeof s.purchaseFilterSchema>", |c, f: purchases::PurchaseFilter| purchases::list_purchases(c, &f));
    t.s("purchases.get", STOCK, R, "{ id: string }", |c, i: IdInput| purchases::get_purchase(c, &i.id));
    t.s("purchases.create", STOCK, W, "z.input<typeof s.purchaseInputSchema>", |c, i: purchases::PurchaseInput| purchases::create_purchase(c, &i));
    t.s("purchases.cancel", STOCK, W, "{ id: string }", |c, i: IdInput| purchases::cancel_purchase(c, &i.id));
    t.s("purchases.buyFromIndividual", STOCK, W, "z.input<typeof s.buyBackSchema>", |c, i: purchases::BuyBackInput| purchases::buy_from_individual(c, &i));

    // Sell
    t.s0("customers.list", PICKERS, R, customers::list_customers);
    t.s("customers.create", PICKERS, W, "z.input<typeof s.customerInputSchema>", |c, i: customers::CustomerInput| customers::create_customer(c, &i));
    t.s0("employees.list", EMPLOYEE_PICKER, R, customers::list_employees);
    // Selling needs an open cash day: the till asks for the opening float first.
    t.s("sales.create", SELL, W, "z.input<typeof s.saleInputSchema>", |c, i: sales::SaleInput| {
        crate::services::cash::require_open_session(c)?;
        sales::create_sale(c, &i, Default::default())
    });
    // A phone prints at the counter: the desktop window builds the receipt and prints it silently on the chosen printer.
    t.a("sales.printReceipt", SELL, R, "{ id: string }", |core: Arc<Core>, caller: Caller, i: IdInput| async move {
        let sale = core.with(&caller, |c| sales::get_sale(c, &i.id, false))?;
        request_print(core, "receipt", json!({ "sale": sale })).await
    });
    t.s("sales.mine", SELL, R, "{ from: string; to: string }", |c, i: sales::PeriodInput| sales::list_by_device(c, &i.from, &i.to));
    t.s("sales.list", SELL, R, "z.input<typeof s.saleFilterSchema>", |c, f: sales::SaleFilter| sales::list_sales(c, &f, None, None));
    // Costs and profit are shown only while the Finance section is open to the user.
    t.s("sales.get", SELL, R, "{ id: string }", |c, i: IdInput| sales::get_sale(c, &i.id, costs_visible(c)?));

    // Sell: returns and exchanges
    t.s0("returns.list", SELL, R, returns::list_returns);
    t.s("returns.find", SELL, R, "z.input<typeof s.saleFindSchema>", |c, i: SaleFindInput| returns::find_sales(c, &i.query));
    t.s("returns.lines", SELL, R, "{ id: string }", |c, i: IdInput| returns::returnable_lines(c, &i.id));
    t.s("returns.preview", SELL, R, "z.input<typeof s.returnPreviewSchema>", |c, i: returns::ReturnPreviewInput| {
        let p = returns::preview_return(c, &i.sale_id, &i.lines)?;
        Ok(returns::PreviewResult { value: p.value, debt_cancelled: p.debt_cancelled, refund: p.refund })
    });
    t.s("returns.create", SELL, W, "z.input<typeof s.returnInputSchema>", |c, i: returns::ReturnInput| {
        crate::services::cash::require_open_session(c)?;
        returns::create_return(c, &i)
    });

    // People: customers
    t.s("customer.list", PEOPLE, R, "z.input<typeof s.customerFilterSchema>", |c, f: customers::CustomerFilter| customers::customer_overview(c, &f));
    t.s("customer.get", PEOPLE, R, "{ id: string }", |c, i: IdInput| customers::get_customer(c, &i.id));
    t.s("customer.create", PEOPLE, W, "z.input<typeof s.customerInputSchema>", |c, i: customers::CustomerInput| customers::create_customer(c, &i));
    t.s("customer.update", PEOPLE, W, "z.input<typeof s.customerUpdateSchema>", |c, i: customers::CustomerUpdateInput| customers::update_customer(c, &i));
    t.s("customer.delete", PEOPLE, W, "{ id: string }", |c, i: IdInput| customers::delete_customer(c, &i.id));
    t.s("customer.receivePayment", PEOPLE, W, "z.input<typeof s.customerPaymentSchema>", |c, i: customers::CustomerPaymentInput| {
        customers::receive_payment(c, &i)
    });
    t.s("customer.payment", PEOPLE, R, "{ groupId: string }", |c, i: GroupInput| customers::get_payment(c, &i.group_id));

    // Offline sync (phase 17): the phone's change feed, its outbox, and the manager's review of what could not be applied.
    t.s("sync.pull", NONE, R, "{ cursor?: number }", |c, i: sync::PullInput| sync::pull(c, &i));
    t.s("sync.push", NONE, W, "{ ops: Array<{ opId: string; type: string; madeAt: string; payload: unknown }> }", |c, i: sync::PushInput| sync::push(c, &i));
    t.s0("sync.conflicts", SELL, R, |c| sync::list_conflicts(c, true));
    t.s0("sync.conflictCount", NONE, R, sync::open_conflict_count);
    t.s("sync.resolve", SELL, W, "{ id: string; action: 'discard' | 'apply'; unitId?: string }", |c, i: sync::ResolveInput| sync::resolve_conflict(c, &i));
    t.s0("cash.phoneHeld", SELL_FINANCE, R, sync::held_cash);
    t.s("cash.confirmPhoneCash", SELL_FINANCE, W, "{ deviceId: string }", |c, i: sync::ConfirmCashInput| sync::confirm_held_cash(c, &i));

    // Repairs
    t.s("repairs.list", REPAIRS, R, "z.input<typeof s.repairFilterSchema>", |c, f: repairs::RepairFilter| repairs::list_repairs(c, &f));
    t.s("repairs.get", REPAIRS, R, "{ id: string }", |c, i: IdInput| repairs::get_repair(c, &i.id, costs_visible(c)?));
    t.s("repairs.byToken", REPAIRS, R, "z.input<typeof s.repairTokenSchema>", |c, i: repairs::RepairTokenInput| repairs::find_by_token(c, &i.token));
    t.s0("repairs.parts", REPAIRS, R, repairs::list_repair_parts);
    t.s0("repairs.suggestions", REPAIRS, R, repairs::suggestions);
    t.a("repairs.printSlip", REPAIRS, R, "{ id: string }", |core: Arc<Core>, caller: Caller, i: IdInput| async move {
        let repair = core.with(&caller, |c| repairs::get_repair(c, &i.id, false))?;
        request_print(core, "repairSlip", json!({ "repair": repair })).await
    });
    t.s("repairs.addPhoto", REPAIRS, W, "z.input<typeof s.repairPhotoSchema>", |c, i: repairs::RepairPhotoInput| {
        repairs::add_photo(c, &i.repair_id, &i.file_name)
    });
    t.s("repairs.removePhoto", REPAIRS, W, "{ id: string }", |c, i: IdInput| repairs::remove_photo(c, &i.id));
    t.s("repairs.create", REPAIRS, W, "z.input<typeof s.repairInputSchema>", |c, i: repairs::RepairInput| repairs::create_repair(c, &i));
    t.s("repairs.update", REPAIRS, W, "z.input<typeof s.repairUpdateSchema>", |c, i: repairs::RepairUpdateInput| repairs::update_repair(c, &i));
    t.s("repairs.setStatus", REPAIRS, W, "z.input<typeof s.repairStatusSchema>", |c, i: repairs::RepairStatusInput| repairs::set_status(c, &i));
    t.s("repairs.addPart", REPAIRS, W, "z.input<typeof s.repairPartSchema>", |c, i: repairs::RepairPartInput| repairs::add_part(c, &i));
    t.s("repairs.removePart", REPAIRS, W, "{ id: string }", |c, i: IdInput| repairs::remove_part(c, &i.id));
    t.s("repairs.deliver", REPAIRS, W, "z.input<typeof s.repairDeliverSchema>", |c, i: repairs::RepairDeliverInput| repairs::deliver(c, &i));
    t.s("repairs.cancel", REPAIRS, W, "z.input<typeof s.repairCancelSchema>", |c, i: repairs::RepairCancelInput| repairs::cancel(c, &i));

    // Finance: services and the cash drawer
    use crate::services::cash;
    t.s0("cash.state", NONE, R, cash::state);
    t.s("cash.open", SELL_FINANCE, W, "z.input<typeof s.cashOpenSchema>", |c, i: cash::CashOpenInput| cash::open_session(c, &i));
    t.s0("cash.current", FINANCE, R, cash::current);
    t.s("cash.manual", FINANCE, W, "z.input<typeof s.cashManualSchema>", |c, i: cash::CashManualInput| cash::add_manual(c, &i));
    t.s("cash.close", FINANCE, W, "z.input<typeof s.cashCloseSchema>", |c, i: cash::CashCloseInput| cash::close_session(c, &i));
    t.s0("cash.sessions", FINANCE, R, cash::list_sessions);
    t.s("cash.report", FINANCE, R, "{ id: string }", |c, i: IdInput| cash::z_report(c, &i.id));
    t.s0("services.active", FINANCE_SELL, R, |c| service_catalog::list_services(c, true));
    t.s0("services.all", SETTINGS, R, |c| service_catalog::list_services(c, false));
    t.s("services.create", SETTINGS, W, "z.input<typeof s.serviceCreateSchema>", |c, i: service_catalog::ServiceCreateInput| {
        service_catalog::create_service(c, &i)
    });
    t.s("services.update", SETTINGS, W, "z.input<typeof s.serviceUpdateSchema>", |c, i: service_catalog::ServiceUpdateInput| {
        service_catalog::update_service(c, &i)
    });
    t.s("services.sell", FINANCE_SELL, W, "z.input<typeof s.serviceSellSchema>", |c, i: service_catalog::ServiceSellInput| {
        cash::require_open_session(c)?;
        service_catalog::sell_service(c, &i)
    });
    t.s("services.sales", FINANCE, R, "z.input<typeof s.serviceSalesFilterSchema>", |c, i: service_catalog::ServiceSalesFilter| {
        service_catalog::list_service_sales(c, &i.from, &i.to)
    });
    t.s("services.deleteSale", FINANCE, W, "{ id: string }", |c, i: IdInput| service_catalog::delete_service_sale(c, &i.id));

    // People: employees
    t.s0("employee.list", PEOPLE, R, employees::list_employees_overview);
    t.s("employee.get", PEOPLE, R, "{ id: string }", |c, i: IdInput| employees::get_employee(c, &i.id));
    t.s("employee.create", PEOPLE, W, "z.input<typeof s.employeeInputSchema>", |c, i: employees::EmployeeInput| employees::create_employee(c, &i));
    t.s("employee.update", PEOPLE, W, "z.input<typeof s.employeeUpdateSchema>", |c, i: employees::EmployeeUpdateInput| employees::update_employee(c, &i));
    t.s("employee.delete", PEOPLE, W, "{ id: string }", |c, i: IdInput| employees::delete_employee(c, &i.id));
    t.s("employee.paySalary", PEOPLE, W, "z.input<typeof s.salaryPaymentSchema>", |c, i: employees::SalaryPaymentInput| employees::pay_salary(c, &i));
    t.s("employee.advance", PEOPLE, W, "z.input<typeof s.advanceSchema>", |c, i: employees::AdvanceInput| employees::add_advance(c, &i));
    // Profit and commission appear only while the Finance section is open to the user.
    t.s("employee.activity", PEOPLE, R, "z.input<typeof s.employeeActivitySchema>", |c, i: employees::EmployeeActivityInput| {
        employees::activity(c, &i.id, &i.from, &i.to, costs_visible(c)?)
    });

    // Finance: analytics and reports (the Finance section's own lock protects them)
    t.s("finance.summary", FINANCE, R, "z.input<typeof s.periodSchema>", |c, p: finance::Period| finance::summary(c, &p));
    t.s("finance.series", FINANCE, R, "z.input<typeof s.seriesSchema>", |c, i: finance::SeriesInput| {
        let p = finance::Period { from: i.from.clone(), to: i.to.clone() };
        Ok(finance::SeriesResult { days: finance::daily_series(c, &i.metric, &p)?, rows: finance::detail_rows(c, &i.metric, &p)? })
    });
    t.s("finance.report", FINANCE, R, "z.input<typeof s.reportSchema>", |c, i: finance::ReportInput| finance::report(c, &i));
    t.a("file.exportXlsx", FINANCE_STOCK, R, "z.input<typeof s.exportSchema>", |core: Arc<Core>, _, i: ExportInput| async move {
        let name = format!("{}.xlsx", file_name(&i.title));
        let Some(path) = core.host.save_dialog(name, "Excel", &["xlsx"]).await else { return Ok(Saved { saved: false, path: None }) };
        let rows: Vec<Vec<xlsx::Cell>> = i.rows.iter().map(|r| r.iter().map(xlsx::Cell::from_json).collect()).collect();
        let money: Vec<usize> = i.money_columns.iter().map(|c| *c as usize).collect();
        std::fs::write(&path, xlsx::build_xlsx(&i.title, &i.headers, &rows, &money)?)?;
        Ok(Saved { saved: true, path: Some(path.display().to_string()) })
    });
    // Stock: import accessories from Excel (the file is read again when importing)
    t.s("import.itemsPreview", STOCK, R, "z.input<typeof s.importPathSchema>", |c, i: import::ImportPathInput| import::preview_items(c, &i.path));
    t.s("import.itemsCommit", STOCK, W, "z.input<typeof s.importPathSchema>", |c, i: import::ImportPathInput| import::import_items(c, &i.path));
    t.a("import.template", STOCK, R, "void", |core: Arc<Core>, _, _: NoInput| async move {
        let Some(path) = core.host.save_dialog("accessories-template.xlsx".into(), "Excel", &["xlsx"]).await else {
            return Ok(Saved { saved: false, path: None });
        };
        std::fs::write(&path, import::template_file()?)?;
        Ok(Saved { saved: true, path: Some(path.display().to_string()) })
    });
    // The Overview is never locked: profit is simply left out while Finance is locked.
    t.s0("overview.get", NONE, R, |c| finance::overview(c, costs_visible(c)?));

    // Settings: phones on the local network (desktop only: none of these is on the phone allowlist)
    use crate::mobile;
    t.a("mobile.status", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move { mobile::manager::overview(&core) });
    t.a("mobile.configure", SETTINGS, W, "z.input<typeof s.mobileConfigSchema>", |core: Arc<Core>, _, i: mobile::manager::MobileConfigInput| async move {
        mobile::manager::set_config(&core, i).await?;
        mobile::manager::overview(&core)
    });
    t.a("mobile.pairStart", SETTINGS, W, "void", |core: Arc<Core>, _, _: NoInput| async move { mobile::manager::start_pairing(&core) });
    t.a("mobile.pairStatus", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move { Ok(core.mobile.pairing.status()) });
    t.a("mobile.pairCancel", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move {
        core.mobile.pairing.cancel();
        Ok(())
    });
    t.s0("mobile.devices", SETTINGS, R, mobile::devices::list_devices);
    t.s("mobile.updateDevice", SETTINGS, W, "z.input<typeof s.mobileDeviceUpdateSchema>", |c, i: mobile::devices::DeviceUpdateInput| {
        mobile::devices::update_device(c, &i)
    });
    t.a(
        "mobile.remoteConfigure",
        SETTINGS,
        W,
        "z.input<typeof s.mobileRemoteConfigSchema>",
        |core: Arc<Core>, _, i: mobile::manager::RemoteConfigInput| async move {
            mobile::manager::set_remote_mode(&core, &i.mode).await?;
            mobile::manager::overview(&core)
        },
    );
    t.a("mobile.remotePairStart", SETTINGS, W, "void", |core: Arc<Core>, _, _: NoInput| async move { mobile::manager::start_remote_pair(&core).await });
    t.a("mobile.remotePairStatus", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move { Ok(core.mobile.remote_pairing.status()) });
    t.a("mobile.remotePairCancel", SETTINGS, R, "void", |core: Arc<Core>, _, _: NoInput| async move {
        core.mobile.remote_pairing.cancel();
        Ok(())
    });
    // Revoking always works, even when the trial is over.
    t.s("mobile.revoke", SETTINGS, R, "{ id: string }", |c, i: IdInput| mobile::devices::revoke_device(c, &i.id));

    // Expenses
    t.s0("expenses.categories", FINANCE_SETTINGS, R, expenses::list_categories);
    t.s("expenses.createCategory", FINANCE, W, "{ name: string }", |c, i: ExpenseCategoryName| expenses::create_category(c, &i.name));
    t.s("expenses.renameCategory", SETTINGS, W, "{ id: string; name: string }", |c, i: IdNameInput| expenses::rename_category(c, &i.id, &i.name));
    t.s("expenses.deleteCategory", SETTINGS, W, "{ id: string }", |c, i: IdInput| expenses::delete_category(c, &i.id));
    t.s("expenses.list", FINANCE, R, "z.input<typeof s.expenseFilterSchema>", |c, f: expenses::ExpenseFilter| expenses::list_expenses(c, &f));
    t.s("expenses.create", FINANCE, W, "z.input<typeof s.expenseInputSchema>", |c, i: expenses::ExpenseInput| expenses::create_expense(c, &i));
    t.s("expenses.delete", FINANCE, W, "{ id: string }", |c, i: ExpenseDeleteInput| expenses::delete_expense(c, &i.id));

    let mut map = HashMap::new();
    for ch in t.0 {
        assert!(map.insert(ch.name, ch).is_none(), "duplicate channel");
    }
    map
});

pub fn channel(name: &str) -> Option<&'static Channel> {
    TABLE.get(name)
}

/// Every channel name, sorted.
pub fn channel_names() -> Vec<&'static str> {
    let mut v: Vec<&str> = TABLE.keys().copied().collect();
    v.sort();
    v
}

/// Printing at the counter counts as a change for a phone outside the shop, like every write channel.
const PRINT_CHANNELS: &[&str] = &["sales.printReceipt", "repairs.printSlip"];

/// Does this channel change something (or print)? Phones outside the shop may not call it unless the owner allowed changes.
pub fn is_write_channel(name: &str) -> bool {
    PRINT_CHANNELS.contains(&name) || channel(name).is_some_and(|c| c.write)
}

/// The one place a channel is run, for the desktop window and for phones.
/// Order: lock (desktop only), read-only license, input validation, handler. A phone is governed by its role
/// (checked by the HTTP layer), so the manager-password lock does not apply to it.
pub async fn run_channel(core: &Arc<Core>, name: &str, payload: Value, caller: Caller) -> IpcResult {
    let result = run_inner(core, name, payload, caller).await;
    match result {
        Ok(v) => IpcResult::ok(v),
        Err(e) => {
            if let Error::Internal(_) = &e {
                core.log(&format!("ipc:{name}"), &e);
            }
            IpcResult::err(&e)
        }
    }
}

async fn run_inner(core: &Arc<Core>, name: &str, payload: Value, caller: Caller) -> Res<Value> {
    let Some(ch) = channel(name) else { return Err(app("unexpected")) };
    core.with(&caller, |c| {
        if caller == Caller::Desktop && !ch.sections.is_empty() {
            let mut all = true;
            for s in ch.sections {
                if !auth::is_locked(c, s)? {
                    all = false;
                    break;
                }
            }
            if all {
                return Err(app("locked"));
            }
        }
        if ch.write && license::is_read_only(c)? {
            return Err(app("read_only"));
        }
        Ok(())
    })?;
    match &ch.run {
        Run::Sync(f) => core.with(&caller, |c| f(c, payload)),
        Run::Async(f) => f(core.clone(), caller, payload).await,
    }
}

// ---------- TypeScript ----------

pub struct TsCollector {
    cfg: ts_rs::Config,
    seen: HashMap<TypeId, String>,
    decls: Vec<String>,
}

impl ts_rs::TypeVisitor for TsCollector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_some() {
            let name = T::name(&self.cfg);
            if self.seen.contains_key(&TypeId::of::<T>()) {
                return;
            }
            assert!(!self.seen.values().any(|n| *n == name), "two Rust types are both called {name} in TypeScript");
            self.seen.insert(TypeId::of::<T>(), name);
            let decl = T::decl(&self.cfg);
            self.decls.push(format!("export {decl}"));
        }
        T::visit_dependencies(self);
        T::visit_generics(self);
    }
}

fn ts_type<O: TS + 'static>(c: &mut TsCollector) -> String {
    if TypeId::of::<O>() == TypeId::of::<()>() {
        return "void".into();
    }
    <TsCollector as ts_rs::TypeVisitor>::visit::<O>(c);
    O::name(&c.cfg)
}

/// The TypeScript the window and the phone app compile against: every output type and the `Api` map.
pub fn typescript() -> String {
    let mut c = TsCollector { cfg: ts_rs::Config::new().with_large_int("number"), seen: HashMap::new(), decls: Vec::new() };
    let mut lines = Vec::new();
    for name in channel_names() {
        let ch = &TABLE[name];
        let output = (ch.ts_output)(&mut c);
        lines.push(format!("  '{name}': (input: {}) => Promise<{output}>;", ch.ts_input));
    }
    let mut decls = c.decls.clone();
    decls.sort_by_key(|d| d.split_whitespace().nth(2).unwrap_or("").to_owned());
    format!(
        "// Generated from core/src/api.rs by `cargo test -p psm-core` (test api::tests::typescript_is_current). Do not edit.\n\
         import type {{ z }} from 'zod';\n\
         import type {{ SectionId }} from './app.config';\n\
         import type * as s from './schemas';\n\n\
         {}\n\n\
         /** Every channel the window and the phones can call, with its input and what it returns. */\n\
         export type Api = {{\n{}\n}};\n",
        decls.join("\n\n"),
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The product constants are written in src/shared/app.config.ts for the window and here for the core.
    #[test]
    fn product_constants_match_the_app_config() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/app.config.ts");
        let config = std::fs::read_to_string(path).unwrap();
        let field = |name: &str| {
            let re = regex::Regex::new(&format!(r"\b{name}: '?([^',\n]*)'?,")).unwrap();
            re.captures(&config).unwrap_or_else(|| panic!("{name} not found in app.config.ts"))[1].to_owned()
        };
        use crate::services::{backup, license};
        assert_eq!(field("productCode"), license::PRODUCT_CODE);
        assert_eq!(field("slug"), backup::SLUG);
        assert_eq!(field("trialDays"), license::TRIAL_DAYS.to_string());
        assert_eq!(field("url"), crate::mobile::manager::REMOTE_URL);
        assert_eq!(field("anonKey"), crate::mobile::manager::REMOTE_ANON_KEY);
    }

    /// Writes src/shared/api.ts. CI runs the tests and then checks that the file did not change.
    #[test]
    fn typescript_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/shared/api.ts");
        let ts = typescript();
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        if old != ts {
            std::fs::write(&path, &ts).unwrap();
        }
        assert!(ts.contains("'sales.create'"));
    }

    #[test]
    fn every_channel_is_listed_once() {
        assert!(channel_names().len() >= 150);
    }
}

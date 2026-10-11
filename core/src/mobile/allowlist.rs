// The only channels a phone can reach, and the roles allowed to call each one.
// A channel missing from this table is refused for every role, OWNER included.
// Never add: settings writes, auth.*, backup.*, license.*, system.*, cash.close, seed.load, import.*,
// anything that opens a desktop dialog (print.html, file.exportXlsx, backup, import).
use once_cell::sync::Lazy;
use std::collections::HashMap;

const O: &str = "OWNER";
const S: &str = "SELLER";
const T: &str = "TECHNICIAN";
const K: &str = "STOCK";

pub static ALLOWLIST: Lazy<HashMap<&'static str, &'static [&'static str]>> = Lazy::new(|| {
    let mut m: HashMap<&'static str, &'static [&'static str]> = HashMap::new();
    let mut grant = |roles: &'static [&'static str], channels: &[&'static str]| {
        for c in channels {
            m.insert(c, roles);
        }
    };
    // Lookups every role needs
    grant(
        &[O, S, T, K],
        &[
            "brands.list",
            "categories.list",
            "models.list",
            "units.list",
            "units.get",
            "units.imeiStatus",
            "items.list",
            "items.get",
            "stock.lookup",
            "stock.search",
        ],
    );
    grant(&[O, S, T], &["customers.list", "customers.create", "employees.list"]);
    // Offline sync: every role reads its own view of the data and pushes the operations its role may make
    grant(&[O, S, T, K], &["sync.pull", "sync.push"]);
    // Selling
    grant(
        &[O, S],
        &[
            "sales.create",
            "sales.list",
            "sales.get",
            "returns.list",
            "returns.find",
            "returns.lines",
            "returns.preview",
            "returns.create",
            "sales.printReceipt",
            "sales.mine",
            "services.active",
            "services.sell",
            "cash.state",
        ],
    );
    grant(&[O, S], &["customer.list", "customer.get", "customer.create", "customer.receivePayment", "customer.payment"]);
    grant(&[O], &["customer.update", "customer.delete"]);
    // Repairs
    grant(
        &[O, T],
        &[
            "repairs.list",
            "repairs.get",
            "repairs.byToken",
            "repairs.parts",
            "repairs.suggestions",
            "repairs.create",
            "repairs.update",
            "repairs.setStatus",
            "repairs.addPart",
            "repairs.removePart",
            "repairs.deliver",
            "repairs.printSlip",
            "repairs.addPhoto",
            "repairs.removePhoto",
        ],
    );
    grant(&[O], &["repairs.cancel"]);
    // Stock and purchases
    grant(
        &[O, K],
        &[
            "units.add",
            "units.update",
            "units.setPrice",
            "items.create",
            "items.update",
            "items.adjust",
            "items.generateBarcode",
            "brands.create",
            "categories.create",
        ],
    );
    grant(&[O, K], &["stockCount.list", "stockCount.get", "stockCount.start", "stockCount.scanUnit", "stockCount.countItem"]);
    grant(&[O], &["stockCount.apply", "stockCount.close", "stockCount.decide"]);
    grant(&[O], &["units.writeOff", "items.delete"]);
    grant(
        &[O, K],
        &[
            "suppliers.list",
            "suppliers.get",
            "suppliers.create",
            "suppliers.update",
            "purchases.list",
            "purchases.get",
            "purchases.create",
            "purchases.buyFromIndividual",
        ],
    );
    grant(&[O], &["suppliers.delete", "suppliers.addPayment", "purchases.cancel"]);
    // Owner only: money, reports, people
    grant(
        &[O],
        &[
            "overview.get",
            "finance.summary",
            "finance.series",
            "finance.report",
            "cash.open",
            "cash.current",
            "cash.sessions",
            "cash.report",
            "cash.manual",
            "services.sales",
            "services.deleteSale",
        ],
    );
    grant(&[O], &["expenses.categories", "expenses.list", "expenses.create", "expenses.createCategory"]);
    grant(&[O], &["employee.list", "employee.get", "employee.activity"]);
    m
});

/// Channels whose input has an `employeeId` that is the actor. The phone's own employee replaces what it sent.
pub const ACTOR_CHANNELS: &[&str] = &["sales.create", "services.sell", "repairs.create"];

pub fn is_allowed(channel: &str, role: Option<&str>) -> bool {
    match role {
        Some(r) => ALLOWLIST.get(channel).is_some_and(|roles| roles.contains(&r)),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_allowed_channel_exists() {
        for c in super::ALLOWLIST.keys() {
            assert!(crate::api::channel(c).is_some(), "{c}");
        }
    }
}

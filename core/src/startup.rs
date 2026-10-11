//! What every shell does once after opening the database: the default expense categories and counter services,
//! the popular brands (offered once), and the daily automatic backup.
use crate::core::Core;
use crate::services::{backup, catalog, expenses, services as service_catalog, settings};

pub fn prepare(core: &Core) {
    let result = core.desktop(|c| {
        let lang = settings::get_public(c.db)?.language;
        expenses::ensure_default_categories(c, expenses::default_categories(&lang))?;
        service_catalog::ensure_default_services(c)?;
        if !settings::get_value::<bool>(c.db, "brands.seeded")?.unwrap_or(false) {
            catalog::add_popular_brands(c)?;
            settings::set_value(c.db, "brands.seeded", &true)?;
        }
        Ok(())
    });
    if let Err(e) = result {
        core.log("startup", &e);
    }
    if let Err(e) = backup::auto_backup(core) {
        core.log("autoBackup", &e);
    }
}

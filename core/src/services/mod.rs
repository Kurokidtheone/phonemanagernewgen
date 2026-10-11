pub mod auth;
pub mod backup;
pub mod balance;
pub mod cash;
pub mod catalog;
pub mod counts;
pub mod customers;
pub mod employees;
pub mod expenses;
pub mod files;
pub mod finance;
pub mod import;
pub mod license;
pub mod purchases;
pub mod repairs;
pub mod returns;
pub mod sales;
pub mod seed;
// Counter services (flexy top-ups and the like), named like their table.
#[allow(clippy::module_inception)]
pub mod services;
pub mod settings;
pub mod stock;
pub mod suppliers;
pub mod sync;
pub mod visibility;
pub mod xlsx;

/// Shared constants mirroring src/shared.
pub mod codes;

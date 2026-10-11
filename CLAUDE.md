# Phone Store Manager

This repo is a copy of my "Academy Manager" app. We are turning it into
"Phone Store Manager", an offline Windows desktop app for mobile phone
shops in Algeria.

## PRODUCT

- Single PC, single admin, no internet needed, all data local.
- Sections: Overview, Sell, Stock, Repairs, People, Finance, Lock, Settings.
- It sells phones tracked per IMEI and accessories tracked per quantity,
  takes repairs, tracks customer and supplier debts, a daily cash drawer,
  expenses and net profit.

## KEEP FROM THE ACADEMY APP (do not rewrite)

- Stack: Tauri 2 with a Rust core (rusqlite, axum, ts-rs), Vite, React 18,
  TypeScript strict, Tailwind, shadcn/ui, lucide-react, TanStack Query,
  Zustand, React Hook Form + Zod, i18next, Recharts, date-fns, Vitest for
  the window, cargo test for the core, the Tauri NSIS bundler.
- Folder layout: core (Rust: database, services, API channels, phone
  server), src-tauri (Tauri shell: window, dialogs, printing), src/renderer,
  src/shared (Zod schemas, types, and api.ts generated from the Rust types).
- Typed API: one Tauri command; every input is validated in Rust with the
  same rules as the Zod schemas.
- App shell: fixed bottom bar with 8 tabs, PageHeader, SubTabs, DataTable,
  StatCard, dialogs, toasts, skeletons, Ctrl+K command palette.
- i18n (Arabic default and RTL, French, English), themes, fonts.
- Manager password, recovery code, protected sections, Lock tab.
- Backup and restore, automatic daily backup.
- Licensing module and activation screen.
- Expenses screen and expense categories.
- Print helpers for 80 mm and A5 documents, QR generation, the global
  scanner listener.

## DATA RULES

- Money is stored as integers in centimes of DZD. Display "2.400 دج".
- Dates stored as ISO strings in UTC, shown in local time.
- UUID text primary keys. created_at and updated_at on every table.
- Soft delete for products, units, customers, suppliers, employees.
  Nothing that appears in a sale, purchase or repair is ever hard deleted.
- Every operation that moves stock or money runs in ONE SQLite
  transaction and writes a row to stock_movements and/or cash_movements.
  Never change a quantity, a unit status or a balance without that row.
- A sale line stores the cost at the time of sale. Later cost changes
  must not alter past profit.
- IMEI: exactly 15 digits, valid Luhn check digit, unique among units
  that are not deleted.

## UI RULES

- Same visual language as the academy app. Section accent colours:
  Overview teal, Sell blue, Stock green, Repairs orange, People purple,
  Finance pink, Lock neutral, Settings olive.
- No hard-coded text. Every string in all three languages.
- The New sale screen must be fully usable with a scanner and keyboard:
  focus stays in the search field, Enter adds, F2 opens payment, Esc
  cancels.
- Every create or update shows a success toast. Every delete asks first.

## WORKING RULES

- Do only the phase I give you. Do not start the next one.
- Before coding, list the files you will create, change or delete.
- After coding, run typecheck, lint and tests, and fix what fails.
- Add seed data for each new domain so I can test by hand.
- Finish with a short manual test checklist.

Verify these requirements against the current repository when asked.

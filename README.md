# Phone Store Manager

Offline Windows desktop app for mobile phone shops in Algeria: sales (phones by IMEI, accessories by
quantity), stock and purchases, repairs, customers and suppliers, a daily cash drawer, expenses and
net profit. Single PC, single admin, all data local. Arabic (default, RTL), French, English.

Users: see [docs/USER_GUIDE_AR.md](docs/USER_GUIDE_AR.md) (Arabic user guide).

## Develop

The app is a Tauri 2 window: the React screens in `src/renderer` call the Rust core through one `api` command.

- `core/`: the Rust core (database, migrations, services, API channels, phone server, mailbox service).
- `src-tauri/`: the Tauri shell (window, dialogs, printing, file and print protocols).
- `src/renderer/`: the React screens. `src/shared/`: Zod schemas, constants and `api.ts`.
- `wire/`, `remote/`: the end-to-end encrypted mailbox format and client used for outside access.

1. Install Node 22 and Rust (stable, via rustup). On Windows, WebView2 is already present; on Linux, install
   the WebKitGTK libraries listed in `.github/workflows/rust.yml`.
2. `npm install`
3. `npm run license:init` and back up the `license-keys/license-private.pem` it prints
4. `npm run dev`

Checks: `npm run check` runs the typecheck, ESLint, the window's tests (Vitest) and the Rust tests.
Performance check with 5,000 phones, 2,000 items and 20,000 sales: `npm run perf`.
Section ids, order and colours: `src/shared/app.config.ts`. Strings: `src/renderer/src/i18n/*.json`.

`src/shared/api.ts` (the types of every API channel) is written from the Rust types by `cargo test`:
commit it after changing a channel or a row type. CI fails when it is out of date.

## Licensing

This product has its own key pair (`license-keys/`, never committed or shipped) and the product code `PSM`.
The license key carries the code in field `p`; a key without it, or with another code, is rejected, and a key
signed with another product's private key fails the signature check.

## Selling a license

1. The customer opens Settings > License and sends you the device ID.
2. Open `tools/license-desk.html` in a browser, load that product's `license-private.pem`,
   enter the product code, the device ID and the customer name.
3. Send the key. The customer pastes it in Settings > License.

Always enter the product code `PSM` in the license desk. Each product has its own key pair and code, so a key for another app never activates this one.
`tools/license-tool.mjs` does the same from the command line.

## Build the Windows installer

Push a tag like `v1.0.0` to GitHub: the workflow in `.github/workflows/build.yml` runs the checks, builds the NSIS
installer (Windows x64) on `windows-latest`, attaches it to the run and publishes it as a release. Or run
`npm run dist:win` on a Windows PC; the installer is written to `target/release/bundle/nsis/`.
The icons are in `src-tauri/icons/` (regenerate them from `build/icon.png` with `npm run icon`).

## Where data lives

`%APPDATA%/<slug>/` holds the database, uploaded files, automatic backups and logs.
The folder name comes from `slug` in `app.config.ts` (and `SLUG` in `core/src/services/backup.rs`, kept equal
by a test). It is the same folder the Electron version used, so an existing shop's data opens unchanged.

## Tests

- `npm run test`: Vitest for the window (translations, formatting, helpers).
- `npm run test:rust`: the Rust tests. Each one builds a fresh database in a temporary folder; the phone
  server tests start it on a free port, and the outside access tests use an in-memory fake of Supabase.
- Silent printing and the printer list use WebView2 and Windows APIs: test them on a Windows PC.

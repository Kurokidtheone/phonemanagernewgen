# Phone API (desktop side, phase 11)

The desktop app serves paired phones over HTTP while **Settings > Phones on this network** is on (default port 4780, all LAN addresses).

| Route | Auth | What it does |
|---|---|---|
| `GET /hello` | none | `{ app: "PSM", serverId, storeName, appVersion, apiVersion: 1 }` |
| `POST /pair` | none | `{ code, deviceName }` -> `{ token, device }`. Code: 6 digits, 2 minutes, single use. 5 wrong codes block pairing for 5 minutes. |
| `POST /api/:channel` | Bearer | Body = the channel input as JSON. Response = the IPC envelope `{ ok: true, data }` or `{ ok: false, error: { code, params } }`. |
| `GET /me` | Bearer | The device (role, employee) as the owner configured it. |
| `POST /files` | Bearer | One image (jpg, png, webp, max 10 MB), as multipart or as a raw body with an `image/*` Content-Type. Returns `{ name }`. |
| `GET /files/:name` | Bearer | The stored image. |

Header: `Authorization: Bearer <token>`. The token is returned once at pairing; only its SHA-256 is stored.

Transport errors (envelope with HTTP status): `unauthorized` 401, `device_revoked` 403, `forbidden` 403 (no role yet, role not allowed, or channel not on the allowlist), `rate_limited` 429 (20 requests/second/device), `invalid_code` / `code_expired` 403, `pairing_blocked` 429. Business errors come back as HTTP 200 with `ok: false`, exactly as over IPC.

## Rules
- `/api/:channel` runs `api::run_channel()` in `core/src/api.rs`, the same function as the desktop window: same input validation, same handlers.
- Only channels in `core/src/mobile/allowlist.rs` are reachable, each with its roles (OWNER, SELLER, TECHNICIAN, STOCK). Settings writes, `auth.*`, `backup.*`, `license.*`, `system.*`, `cash.close`, imports and anything opening a desktop dialog are never on it.
- The manager-password lock does not apply to phones; the role does. The expired-license read-only rule does apply.
- Only an OWNER device sees costs and profit.
- `sales.create`, `services.sell` and `repairs.create` record the device's employee as the actor (a phone cannot send another `employeeId`). Stock movements, repair status changes and customer payments store it in `employee_id`.

## Receiving and counting stock (phase 13)
- `purchases.create` accepts `requestId` (8-64 chars) and `invoiceFile` (a name returned by `POST /files`). A repeated `requestId` returns the first purchase's `{ id }` and creates nothing. `invoicePath` (a path on the PC) is always ignored for phones.
- Counts (`stockCount.*`): `start` (joins the open count for the same scope), `scanUnit`, `countItem`, `get`, `list` for OWNER and STOCK; `apply`, `close`, `decide` for OWNER only.
  - Scanning writes only `stock_count_lines`. `apply` closes the count and writes one ADJUSTMENT movement per accessory whose system quantity differs (`ref_table = 'stock_counts'`). Phones are never changed by a count: each missing unit is decided afterwards (`decide`: WRITE_OFF or KEEP).
  - Costs in a count result (`cost`, `missingCost`, `differenceCost`) are removed for every role except OWNER, as for every other channel.

## Selling and repairs from a phone (phase 14)
- `sales.create` accepts `requestId`: a repeated id returns the first sale `{ id, receiptNumber }` and sells nothing. A unit sold in the meantime fails with `unit_not_available`; with no open cash day the call fails with `no_cash_session`. Each phone sale stores `sales.device_id`; `sales.mine { from, to }` lists only the calling phone's sales.
- `sales.printReceipt { id }` and `repairs.printSlip { id }` ask the PC to print silently on the printer chosen in Settings > Printing (empty = system default). The desktop window builds the document and prints it, so the PC app must be open; failure is `print_failed`.
- `repairs.create` accepts `photos` (up to 6 names from `POST /files`); `repairs.addPhoto { repairId, fileName }` adds one (max 6, `too_many_photos`); `repairs.get` returns `photos`. Photos are fetched with `GET /files/:name` and the Bearer token.
- A TECHNICIAN or STOCK phone cannot call `sales.*`, `returns.*` or the print channels.

## Access from outside the shop (phase 16)

Optional. A phone away from the shop and the PC leave each other **end-to-end encrypted** messages in a Supabase project used as a mailbox (`supabase/`). There is no server to run. Local mode is unchanged and always preferred.

- **Linking a phone that is away:** the owner presses "Link a phone from another network" (outside access must be on). The PC shows a one-time code with 80 random bits (`XXXX-XXXX-XXXX-XXXX`), valid 10 minutes, used up by the first phone. Both sides derive a private pairing mailbox name and key from it with HKDF-SHA256, so the code is never sent and nobody without it can find or read that mailbox. The phone sends `POST /pair { deviceName }` there; the PC answers once, sealed with the pairing key, with the phone's token, real mailbox and key. The phone gets the Supabase address from its own build (`APP.remote`). A phone linked this way has no shop address and always uses the mailbox. Normal phone mailboxes still cannot reach `/pair`.
- **Keys:** at pairing (on the shop Wi-Fi only) the PC creates a 32-byte key and a mailbox name for that phone and returns both once in the `/pair` answer as `remote: { mailbox, key, deviceId, url, anonKey }`. The PC keeps them with the device row; the phone keeps them in its store. A phone paired before this phase must be paired again.
- **Format:** XChaCha20-Poly1305, fresh 24-byte nonce per message, mailbox and device id as associated data. Request `{ id, ts, method, path, body }`, response `{ id, status, body }`. Sealed text over 300,000 characters is split into numbered parts; a whole message is at most 6 MB. The Rust crate `wire/` and `src/shared/remote/wire.ts` are byte-compatible (`wire/vectors.json` is opened by both).
- **PC** (`core/src/mobile/mailbox.rs`): `mb_beat` every 20 s per phone, fetch on a Realtime wake-up and at least every 20 s. Each message is opened with the phone's key; a message older than 2 minutes or with an id seen in the last 20 minutes is refused; one that does not open is acked, dropped and counted (20 in a minute pauses outside access for 5 minutes). Paths are limited to `/api/<channel>`, `/me`, `/files` and `/files/<name>`, and replayed into the same axum router as LAN requests (`server::handle_remote_request`) with `via = "remote"`: same allowlist, roles, cost stripping and `run_channel`.
- **Modes** (Settings > Mobile devices): Off, Full, View only. In View only, write channels, printing and uploads answer `remote_read_only`. `/pair` is reachable only through a one-time pairing code (above), and `/app.apk` is not served from outside. Revoking a phone clears its mailbox and key.
- **`/hello`** on the shop network returns `remote: { mode }`; the phone saves it.
- **Recorded:** `sales`, `stock_movements`, `repair_status_log` and `customer_payments` have a `via` column (`lan` / `remote`); `mobile_devices.last_seen_via` feeds "last seen: in shop / outside".
- **Phone:** route choice on start, resume and after any network error: the PC's last address with a 1.5 s `/hello`; on Wi-Fi a search of the network; else the mailbox if outside access is on. A request calls `mb_seen` first (over 60 s means `shop_offline`), then sends and waits up to 20 s on wake-ups and a 2 s poll (`shop_timeout`). No timed list refresh outside the shop; photos load when tapped and arrive resized.
- **Errors a phone can see:** `shop_offline`, `shop_timeout`, `shop_blocked`, `shop_busy`, `remote_read_only`, `request_expired`, `body_too_large`, `response_too_large`.
- **Not covered:** the `sync.push` exception to the 2-minute rule belongs to a later phase that does not exist yet (`MailboxOptions.isLateSafe` is the hook).


## Offline sync (phase 17)

The phone keeps a SQLite copy of what it may see and works without the PC. Channels (`core/src/services/sync.rs`):

- **`sync.pull { cursor }`** returns `{ cursor, reset, more, tables, deletes, debts, limits }`: the newest change of every row after `cursor` (at most 2,000 per call; `more` says to pull again), read through views that hide costs, profit, margins and salaries from every role but OWNER, plus each customer's debt. Cursor `0` is a full snapshot (the first migration backfills the change feed). Changes are kept 30 days; a phone whose cursor is older than a forgotten deletion, or ahead of the PC, gets `reset: true` and starts over. `limits` carries `maxStaleDays` (default 7, setting `sync.maxStaleDays`) and `maxOutbox` (500).
- **`sync.push { ops }`** applies `{ opId, type, madeAt, payload }` in order and answers one `{ opId, status: applied | conflict | rejected, reason, result }` each. Types: `sale`, `stock_add_unit`, `stock_add_item`, `price_change`, `customer_create`, `customer_payment`, `repair_create`, `repair_status`; each is checked against the live channel's role list and run through the same service function, in one transaction with its `applied_ops` row. An `opId` already applied returns its stored result and does nothing else.
- **Conflicts, exactly:** a sale line for a phone that is no longer IN_STOCK is `imei_already_sold` (nothing of the sale is applied; the op waits in `sync_conflicts`); a new phone whose IMEI exists is `imei_exists`; an accessory line beyond the stock is applied, the quantity goes negative for that op only and the sale is flagged `negative_stock`; a price change applies and returns old and new; a customer with an existing phone number is reused. Temporary ids made earlier (this push or an older one, kept in `sync_id_map`) are replaced by the real ones.
- **Dates and numbers:** a sale keeps the phone's `madeAt` as its date, `applied_at` is stored separately, the receipt number is assigned at apply time and the phone's temporary number stays in `sales.temp_receipt`.
- **Cash:** cash from a phone's ops is written with `cash_movements.held_by_device`, outside the drawer. Finance > Cash shows "Phone cash to hand over" (`cash.phoneHeld`) and **Confirm received** (`cash.confirmPhoneCash`) moves it into the open session.
- **Needs review:** Sell > Needs review lists open conflicts (`sync.conflicts`) with what the phone tried and what the PC has; `sync.resolve` discards the op or, for a sold phone, applies the sale with another unit the manager picks. The count is `sync.conflictCount`.
- **Through the mailbox:** `sync.push` is the one request that is not refused for being older than 2 minutes (its ops carry their own time and id); a replayed message is still refused.

Phone side (`mobile/src/sync/`): `engine.ts` (outbox, push in batches of 50, pull until the cursor stops, never two at once), `effects.ts` (the local effect of each op and how to undo it), `local.ts` (reads from the copy), `runtime.ts` (start, triggers, 60 s timer), `nativeDb.ts` (Capacitor SQLite). Every offline-capable action goes through the outbox, online or not. New work is refused after 7 days without a sync or with 500 ops waiting. Returns, purchases, deleting, stock counts, the owner's profit view and printing at the counter need the shop PC (`needs_shop_pc`). An app PIN (4 to 6 digits, hashed) is asked on open; `device_revoked` or "Pair again" wipes the local database.

Not done: the local database file is not encrypted at rest (it lives in the app's private folder, behind the PIN screen); SQLCipher would be the next step.

// The phone's own database (SQLite, in the app's private folder). Everything below talks to it through this small
// interface, so the sync engine is tested against an in-memory SQLite and runs on the phone against the native one.

export interface Statement {
  sql: string;
  params?: unknown[];
}

export interface LocalDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs the statements in one transaction: all of them, or none. */
  batch(statements: Statement[]): Promise<void>;
  close(): Promise<void>;
}

/** Created when the database is first opened; `IF NOT EXISTS` keeps opening it again harmless. */
export const SCHEMA: string[] = [
  // The pulled rows, one JSON object per row, by table. What the PC may show this phone, nothing more.
  `CREATE TABLE IF NOT EXISTS mirror (tbl TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (tbl, id))`,
  `CREATE TABLE IF NOT EXISTS debts (customer_id TEXT PRIMARY KEY, balance INTEGER NOT NULL)`,
  // cursor, last_sync_at, server_id, limits, receipt counter, role...
  `CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // What the phone did while it could not reach the PC, in order.
  `CREATE TABLE IF NOT EXISTS outbox (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     op_id TEXT NOT NULL UNIQUE,
     type TEXT NOT NULL,
     made_at TEXT NOT NULL,
     payload TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPLIED','CONFLICT','REJECTED')),
     result_json TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     undo_json TEXT NOT NULL DEFAULT '[]',
     summary TEXT NOT NULL DEFAULT '{}',
     dismissed INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, seq)`,
  // Sales made on this phone, so their receipt can be shown before the PC has numbered them.
  `CREATE TABLE IF NOT EXISTS local_sales (id TEXT PRIMARY KEY, json TEXT NOT NULL)`,
  // A temporary id and the real one the PC gave it: a screen that still holds the old id keeps working.
  `CREATE TABLE IF NOT EXISTS id_alias (temp_id TEXT PRIMARY KEY, real_id TEXT NOT NULL)`,
];

export const ALL_TABLES = ['mirror', 'debts', 'sync_state', 'outbox', 'local_sales', 'id_alias'] as const;

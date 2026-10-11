// Small helpers over the local database: the mirror, the debts and the state values.
import type { LocalDb, Statement } from './db';

export type Row = Record<string, unknown> & { id: string };

export const upsertRow = (tbl: string, row: Row): Statement => ({ sql: 'INSERT OR REPLACE INTO mirror (tbl, id, json) VALUES (?, ?, ?)', params: [tbl, row.id, JSON.stringify(row)] });
export const removeRow = (tbl: string, id: string): Statement => ({ sql: 'DELETE FROM mirror WHERE tbl = ? AND id = ?', params: [tbl, id] });
export const setState = (key: string, value: string): Statement => ({ sql: 'INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)', params: [key, value] });
export const setDebt = (customerId: string, balance: number): Statement =>
  balance > 0 ? { sql: 'INSERT OR REPLACE INTO debts (customer_id, balance) VALUES (?, ?)', params: [customerId, balance] } : { sql: 'DELETE FROM debts WHERE customer_id = ?', params: [customerId] };

export async function getRow(db: LocalDb, tbl: string, id: string): Promise<Row | null> {
  const rows = await db.all<{ json: string }>('SELECT json FROM mirror WHERE tbl = ? AND id = ?', [tbl, id]);
  return rows[0] ? (JSON.parse(rows[0].json) as Row) : null;
}

export async function allRows(db: LocalDb, tbl: string): Promise<Row[]> {
  return (await db.all<{ json: string }>('SELECT json FROM mirror WHERE tbl = ?', [tbl])).map((r) => JSON.parse(r.json) as Row);
}

export async function getState(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.all<{ value: string }>('SELECT value FROM sync_state WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

export async function getDebt(db: LocalDb, customerId: string): Promise<number> {
  const rows = await db.all<{ balance: number }>('SELECT balance FROM debts WHERE customer_id = ?', [customerId]);
  return rows[0]?.balance ?? 0;
}

export async function allDebts(db: LocalDb): Promise<Map<string, number>> {
  return new Map((await db.all<{ customer_id: string; balance: number }>('SELECT customer_id, balance FROM debts')).map((r) => [r.customer_id, r.balance]));
}

export const uuid = (): string => globalThis.crypto.randomUUID();

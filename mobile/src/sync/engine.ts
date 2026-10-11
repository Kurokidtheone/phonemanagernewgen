// The sync engine: an outbox of what the phone did, pushed to the PC in order, then a pull of what changed there.
// It never runs twice at once. Every network call is one `sync.push` or `sync.pull` channel call, made through
// `call` (the shop network or the mailbox: the engine does not know which).
import type { LocalDb, Statement } from './db';
import { ALL_TABLES } from './db';
import { buildEffect, idMapFrom, undoStatements, type Effect, type OpType, type Summary, type Undo, OP_TYPES } from './effects';
import { allDebts, getState, setState, uuid } from './store';

export const BATCH = 50;
export const DEFAULT_MAX_STALE_DAYS = 7;
export const DEFAULT_MAX_OUTBOX = 500;
const DAY_MS = 86_400_000;

export type CallResult = { ok: true; data: unknown } | { ok: false; error: { code: string; params?: Record<string, string | number> } };
/** One channel call to the PC. Throws when the PC cannot be reached at all. */
export type Call = (channel: string, input: unknown) => Promise<CallResult>;

export class SyncError extends Error {
  constructor(
    public code: 'not_synced_yet' | 'offline_too_old' | 'outbox_full' | 'unknown_op',
    public params: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export type OpStatus = 'PENDING' | 'APPLIED' | 'CONFLICT' | 'REJECTED';
export interface OutboxRow {
  seq: number;
  op_id: string;
  type: OpType;
  made_at: string;
  payload: string;
  status: OpStatus;
  result_json: string | null;
  attempts: number;
  last_error: string | null;
  undo_json: string;
  summary: string;
  dismissed: number;
}

export interface SyncStatus {
  pending: number;
  /** Conflict or rejected, not yet dismissed. */
  notSent: number;
  lastSyncAt: string | null;
  syncing: boolean;
}

export interface EngineOptions {
  db: LocalDb;
  call: Call;
  /** This phone's device id (its first characters make the temporary receipt numbers). */
  deviceId: string;
  now?: () => Date;
  /** The PC said this phone was revoked: wipe everything. */
  onRevoked?: () => void | Promise<void>;
  /** Anything the screens show may have changed. */
  onChange?: () => void;
}

export type SyncOutcome = 'done' | 'unreachable' | 'revoked' | 'read_only' | 'busy';

interface PullPage {
  cursor: number;
  reset: boolean;
  more: boolean;
  tables: Record<string, Record<string, unknown>[]>;
  deletes: Record<string, string[]>;
  debts: { customerId: string; balance: number }[];
  limits: { maxStaleDays: number; maxOutbox: number; serverTime: string };
}

export class SyncEngine {
  private running: Promise<SyncOutcome> | null = null;
  private again = false;
  /** Writes to the local database one at a time, so two actions never interleave their reads and writes. */
  private chain: Promise<unknown> = Promise.resolve();
  private syncing = false;

  constructor(private o: EngineOptions) {}

  private now = (): Date => (this.o.now ?? (() => new Date()))();
  private changed = (): void => this.o.onChange?.();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  // ---------- the outbox ----------

  /**
   * Makes an operation: checks the limits, applies its effect to the local copy and queues it, in one step. The screen
   * gets the result it would have got from the PC (with temporary ids and a temporary receipt number).
   */
  enqueue(type: OpType, payload: Record<string, unknown>): Promise<{ opId: string; result: Record<string, unknown>; summary: Summary }> {
    if (!OP_TYPES.includes(type)) return Promise.reject(new SyncError('unknown_op'));
    return this.serial(async () => {
      await this.assertCanQueue();
      const p = { ...payload };
      if (!p.tempId && ['sale', 'stock_add_unit', 'stock_add_item', 'customer_create', 'repair_create'].includes(type)) p.tempId = uuid();
      if (type === 'stock_add_unit' && !p.productId && !p.tempProductId) p.tempProductId = uuid();
      const receiptNumber = async (): Promise<string> => this.nextReceipt();
      if (type === 'sale' && !p.tempReceipt) p.tempReceipt = await receiptNumber();
      const effect: Effect = await buildEffect(this.o.db, type, p, { now: this.now().toISOString(), receiptNumber });
      const opId = uuid();
      const madeAt = this.now().toISOString();
      const statements: Statement[] = [
        ...effect.statements,
        { sql: 'INSERT INTO outbox (op_id, type, made_at, payload, undo_json, summary) VALUES (?, ?, ?, ?, ?, ?)', params: [opId, type, madeAt, JSON.stringify(p), JSON.stringify(effect.undo), JSON.stringify(effect.summary)] },
      ];
      await this.o.db.batch(statements);
      this.changed();
      return { opId, result: effect.result, summary: effect.summary };
    });
  }

  private async nextReceipt(): Promise<string> {
    const n = Number((await getState(this.o.db, 'receipt_counter')) ?? '0') + 1;
    await this.o.db.batch([setState('receipt_counter', String(n))]);
    return `T-${this.o.deviceId.replace(/[^0-9a-z]/gi, '').slice(0, 4).toUpperCase()}-${n}`;
  }

  /** Refuses new offline work when the copy is too old or too much is waiting. */
  async assertCanQueue(): Promise<void> {
    const last = await getState(this.o.db, 'last_sync_at');
    if (!last) throw new SyncError('not_synced_yet');
    const maxDays = Number((await getState(this.o.db, 'max_stale_days')) ?? DEFAULT_MAX_STALE_DAYS);
    const age = this.now().getTime() - new Date(last).getTime();
    if (age > maxDays * DAY_MS) throw new SyncError('offline_too_old', { days: maxDays });
    const maxOutbox = Number((await getState(this.o.db, 'max_outbox')) ?? DEFAULT_MAX_OUTBOX);
    const pending = (await this.o.db.all<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'"))[0]?.n ?? 0;
    if (pending >= maxOutbox) throw new SyncError('outbox_full', { max: maxOutbox });
  }

  async status(): Promise<SyncStatus> {
    const [pending, notSent, last] = await Promise.all([
      this.o.db.all<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'"),
      this.o.db.all<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status IN ('CONFLICT','REJECTED') AND dismissed = 0"),
      getState(this.o.db, 'last_sync_at'),
    ]);
    return { pending: pending[0]?.n ?? 0, notSent: notSent[0]?.n ?? 0, lastSyncAt: last, syncing: this.syncing };
  }

  /** Ops that did not go through, for the "Not sent" list. */
  notSent(): Promise<OutboxRow[]> {
    return this.o.db.all<OutboxRow>("SELECT * FROM outbox WHERE status IN ('CONFLICT','REJECTED') AND dismissed = 0 ORDER BY seq");
  }
  pendingOps(): Promise<OutboxRow[]> {
    return this.o.db.all<OutboxRow>("SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY seq");
  }
  async dismiss(opId: string): Promise<void> {
    await this.o.db.batch([{ sql: 'UPDATE outbox SET dismissed = 1 WHERE op_id = ?', params: [opId] }]);
    this.changed();
  }
  /** Ids created on this phone that the PC has not confirmed yet: what the screens mark "waiting to send". */
  async waitingIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const row of await this.pendingOps()) {
      const p = JSON.parse(row.payload) as Record<string, unknown>;
      for (const k of ['tempId', 'tempProductId']) if (typeof p[k] === 'string') ids.add(p[k] as string);
      if (typeof p.id === 'string') ids.add(p.id);
    }
    return ids;
  }

  // ---------- the loop ----------

  /** Push, then pull. One at a time: a call while one is running makes it run once more when it ends. */
  sync(): Promise<SyncOutcome> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      this.syncing = true;
      this.changed();
      try {
        let outcome = await this.round();
        while (this.again && outcome === 'done') {
          this.again = false;
          outcome = await this.round();
        }
        return outcome;
      } finally {
        this.syncing = false;
        this.running = null;
        this.again = false;
        this.changed();
      }
    })();
    return this.running;
  }

  private async round(): Promise<SyncOutcome> {
    try {
      const pushed = await this.push();
      if (pushed !== 'done') return pushed;
      return await this.pull();
    } catch {
      return 'unreachable'; // the PC could not be reached: everything stays queued
    }
  }

  private revoked = async (): Promise<SyncOutcome> => {
    await this.wipe();
    await this.o.onRevoked?.();
    return 'revoked';
  };

  private async push(): Promise<SyncOutcome> {
    for (;;) {
      const batch = await this.o.db.all<OutboxRow>("SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY seq LIMIT ?", [BATCH]);
      if (batch.length === 0) return 'done';
      const ops = batch.map((r) => ({ opId: r.op_id, type: r.type, madeAt: r.made_at, payload: JSON.parse(r.payload) as unknown }));
      let res: CallResult;
      try {
        res = await this.o.call('sync.push', { ops });
      } catch (err) {
        await this.o.db.batch(batch.map((r) => ({ sql: 'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE op_id = ?', params: ['unreachable', r.op_id] })));
        throw err;
      }
      if (!res.ok) {
        const code = res.error.code;
        if (code === 'device_revoked' || code === 'unauthorized') return this.revoked();
        await this.o.db.batch(batch.map((r) => ({ sql: 'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE op_id = ?', params: [code, r.op_id] })));
        return code === 'remote_read_only' ? 'read_only' : 'unreachable';
      }
      const results = (res.data as { results: { opId: string; status: 'applied' | 'conflict' | 'rejected'; reason?: string | null; result?: Record<string, unknown> | null }[] }).results;
      await this.serial(async () => {
        for (const r of results) await this.applyResult(batch.find((b) => b.op_id === r.opId), r);
      });
      this.changed();
      if (results.length < batch.length) return 'unreachable'; // an answer that does not cover the batch: try again later
    }
  }

  private async applyResult(row: OutboxRow | undefined, r: { status: 'applied' | 'conflict' | 'rejected'; reason?: string | null; result?: Record<string, unknown> | null }): Promise<void> {
    if (!row) return;
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (r.status === 'applied') {
      const map = idMapFrom(row.type, r.result ?? {}, payload);
      const st: Statement[] = [{ sql: "UPDATE outbox SET status = 'APPLIED', result_json = ?, last_error = NULL WHERE op_id = ?", params: [JSON.stringify(r.result ?? {}), row.op_id] }];
      for (const [temp, real] of Object.entries(map)) {
        // The PC's own rows arrive with the next pull; the temporary ones go, and every op still waiting follows the new id.
        for (const tbl of ['phone_units', 'products', 'customers', 'repairs']) st.push({ sql: 'DELETE FROM mirror WHERE tbl = ? AND id = ?', params: [tbl, temp] });
        st.push({ sql: 'DELETE FROM debts WHERE customer_id = ?', params: [temp] });
        st.push({ sql: "UPDATE outbox SET payload = replace(payload, ?, ?) WHERE status = 'PENDING'", params: [temp, real] });
        st.push({ sql: 'UPDATE local_sales SET json = replace(json, ?, ?) WHERE id = ?', params: [temp, real, temp] });
        st.push({ sql: 'UPDATE local_sales SET id = ? WHERE id = ?', params: [real, temp] });
        st.push({ sql: 'INSERT OR REPLACE INTO id_alias (temp_id, real_id) VALUES (?, ?)', params: [temp, real] });
      }
      if (row.type === 'sale' && typeof r.result?.receiptNumber === 'string') {
        const id = map[String(payload.tempId)] ?? String(payload.tempId);
        st.push({ sql: "UPDATE local_sales SET json = json_set(json, '$.receiptNumber', ?, '$.waiting', json('false')) WHERE id = ?", params: [r.result.receiptNumber, id] });
      }
      await this.o.db.batch(st);
      return;
    }
    // Not applied: put the phone's copy back as it was, and keep the reason for the "Not sent" list.
    const undo = JSON.parse(row.undo_json) as Undo[];
    await this.o.db.batch([
      ...undoStatements(undo),
      { sql: 'UPDATE outbox SET status = ?, result_json = ?, last_error = ? WHERE op_id = ?', params: [r.status === 'conflict' ? 'CONFLICT' : 'REJECTED', JSON.stringify({ reason: r.reason ?? null }), r.reason ?? null, row.op_id] },
    ]);
  }

  private async pull(): Promise<SyncOutcome> {
    for (;;) {
      const cursor = Number((await getState(this.o.db, 'cursor')) ?? '0');
      const res = await this.o.call('sync.pull', { cursor });
      if (!res.ok) {
        if (res.error.code === 'device_revoked' || res.error.code === 'unauthorized') return this.revoked();
        return 'unreachable';
      }
      const page = res.data as PullPage;
      const applied = await this.serial(() => this.applyPage(page));
      if (applied === 'pending') return 'done'; // something was made meanwhile: push it first, next round
      this.changed();
      if (!page.more && !page.reset) return 'done';
    }
  }

  /** Writes one pull page. Not while ops wait in the outbox: the pull would erase their effect on the local copy. */
  private async applyPage(page: PullPage): Promise<'ok' | 'pending'> {
    const pending = (await this.o.db.all<{ n: number }>("SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'"))[0]?.n ?? 0;
    if (pending > 0) {
      this.again = true;
      return 'pending';
    }
    const st: Statement[] = [];
    if (page.reset) {
      st.push({ sql: 'DELETE FROM mirror' }, { sql: 'DELETE FROM debts' }, setState('cursor', '0'));
      await this.o.db.batch(st);
      return 'ok';
    }
    for (const [tbl, rows] of Object.entries(page.tables)) {
      for (const row of rows) {
        const id = String(row.id);
        // The settings row is { id: 'public', value: '<json>' }: keep its value as an object.
        const stored = tbl === 'settings' && typeof row.value === 'string' ? { id, ...(JSON.parse(row.value) as object) } : row;
        st.push({ sql: 'INSERT OR REPLACE INTO mirror (tbl, id, json) VALUES (?, ?, ?)', params: [tbl, id, JSON.stringify(stored)] });
      }
    }
    for (const [tbl, ids] of Object.entries(page.deletes)) for (const id of ids) st.push({ sql: 'DELETE FROM mirror WHERE tbl = ? AND id = ?', params: [tbl, id] });
    st.push({ sql: 'DELETE FROM debts' });
    for (const d of page.debts) st.push({ sql: 'INSERT INTO debts (customer_id, balance) VALUES (?, ?)', params: [d.customerId, d.balance] });
    st.push(setState('cursor', String(page.cursor)), setState('max_stale_days', String(page.limits.maxStaleDays)), setState('max_outbox', String(page.limits.maxOutbox)));
    if (!page.more) st.push(setState('last_sync_at', this.now().toISOString()));
    await this.o.db.batch(st);
    return 'ok';
  }

  // ---------- local copy protection ----------

  /** Everything the phone holds locally goes: the copy, the queue, the counters. */
  async wipe(): Promise<void> {
    await this.o.db.batch(ALL_TABLES.map((t) => ({ sql: `DELETE FROM ${t}` })));
    this.changed();
  }

  async debts(): Promise<Map<string, number>> {
    return allDebts(this.o.db);
  }
}

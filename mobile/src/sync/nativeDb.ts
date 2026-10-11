// The phone's database on Android, through the Capacitor SQLite plugin.
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { SCHEMA, type LocalDb, type Statement } from './db';

const NAME = 'psm_offline';

export async function openNativeDb(): Promise<LocalDb> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const existing = (await sqlite.isConnection(NAME, false)).result;
  const conn: SQLiteDBConnection = existing ? await sqlite.retrieveConnection(NAME, false) : await sqlite.createConnection(NAME, false, 'no-encryption', 1, false);
  await conn.open();
  await conn.execute(SCHEMA.join(';\n') + ';', true);
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return ((await conn.query(sql, params as never[])).values ?? []) as T[];
    },
    async batch(statements: Statement[]): Promise<void> {
      if (statements.length === 0) return;
      await conn.executeSet(
        statements.map((s) => ({ statement: s.sql, values: (s.params ?? []) as never[] })),
        true,
      );
    },
    async close(): Promise<void> {
      await sqlite.closeConnection(NAME, false);
    },
  };
}

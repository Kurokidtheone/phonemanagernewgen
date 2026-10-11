// An in-memory SQLite (sql.js, WebAssembly) with the same interface as the phone's database: for tests.
import initSqlJs from 'sql.js';
import { SCHEMA, type LocalDb, type Statement } from './db';

export async function memoryDb(): Promise<LocalDb> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const sql of SCHEMA) db.run(sql);
  return {
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = db.prepare(sql);
      stmt.bind(params as never[]);
      const rows: T[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject() as T);
      stmt.free();
      return rows;
    },
    async batch(statements: Statement[]): Promise<void> {
      db.run('BEGIN');
      try {
        for (const s of statements) db.run(s.sql, (s.params ?? []) as never[]);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

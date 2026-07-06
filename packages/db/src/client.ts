/**
 * DB client factory. SQLite via better-sqlite3 (WAL mode), file at
 * data/hemline.db by default (docs/ARCHITECTURE.md §1).
 *
 * better-sqlite3 is synchronous — keep it out of hot request paths via
 * prepared statements and never import into client components.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface CreateDbOptions {
  /** Path to the SQLite file. Defaults to $DATABASE_PATH or ./data/hemline.db */
  dbPath?: string;
}

export function resolveDbPath(dbPath?: string): string {
  return path.resolve(dbPath ?? process.env.DATABASE_PATH ?? './data/hemline.db');
}

export function createDb(opts: CreateDbOptions = {}): Db {
  const file = resolveDbPath(opts.dbPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

/**
 * Singleton db handle for route handlers.
 *
 * better-sqlite3 is synchronous — one shared connection with prepared
 * statements is the right shape at this scale (ARCHITECTURE §10 risk 4).
 * Cached on globalThis so Next dev HMR doesn't leak file handles.
 *
 * Path resolution: $DATABASE_PATH (absolute, or relative to process.cwd() —
 * NOTE: under `next dev`/`next start` the cwd is apps/web, so prefer absolute
 * paths in env; e2e config computes one), else the
 * first `data/hemline.db` found walking up from cwd — `next dev` runs with
 * cwd=apps/web while the seed writes to <repo>/data/hemline.db.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDb, ensureSchema, type Db } from '@hemline/db';

const GLOBAL_KEY = Symbol.for('hemline.api.db');

interface DbCache {
  db: Db;
  dbPath: string;
}

function findDefaultDbPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'data', 'hemline.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // nothing found — create at the workspace root if we can find it, else cwd
  dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) {
      return path.join(dir, 'data', 'hemline.db');
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), 'data', 'hemline.db');
}

export function resolveApiDbPath(): string {
  const env = process.env.DATABASE_PATH;
  if (env) return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return findDefaultDbPath();
}

export function getDb(): Db {
  const dbPath = resolveApiDbPath();
  const g = globalThis as unknown as Record<symbol, DbCache | undefined>;
  const cached = g[GLOBAL_KEY];
  if (cached && cached.dbPath === dbPath) return cached.db;
  const db = createDb({ dbPath });
  ensureSchema(db); // idempotent; makes a fresh install (no drizzle-kit push yet) usable
  g[GLOBAL_KEY] = { db, dbPath };
  return db;
}

/** test hook: drop the cached handle (e.g. after switching DATABASE_PATH) */
export function __resetDbCache(): void {
  const g = globalThis as unknown as Record<symbol, DbCache | undefined>;
  g[GLOBAL_KEY] = undefined;
}

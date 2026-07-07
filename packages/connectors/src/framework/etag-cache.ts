/**
 * ETag / Last-Modified cache backed by `sources.etag_json`.
 * docs/ARCHITECTURE.md §3, §4.2, §8.
 *
 * `packages/db` depends on this package (for the fixture loader), so we cannot
 * import the Drizzle schema here without a workspace cycle. Instead the opaque
 * `FetchContext.db` (a drizzle better-sqlite3 instance) is accessed through the
 * raw-SQL escape hatch (`db.get`/`db.run` with the `sql` tag) against the
 * `sources` table only. See docs/decisions-data-eng.md.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { EtagCache } from '@hemline/contracts';

type EtagEntry = { etag?: string; lastModified?: string };
type EtagMap = Record<string, EtagEntry>;

/** Structural view of the drizzle better-sqlite3 instance we need. */
interface SqlRunner {
  get(query: SQL): unknown;
  run(query: SQL): unknown;
}

function isSqlRunner(db: unknown): db is SqlRunner {
  return (
    typeof db === 'object' &&
    db !== null &&
    typeof (db as SqlRunner).get === 'function' &&
    typeof (db as SqlRunner).run === 'function'
  );
}

/** DB-backed cache over sources.etag_json. `db` is FetchContext.db. */
export function createEtagCache(sourceId: string, db: unknown): EtagCache {
  if (!isSqlRunner(db)) {
    throw new Error('createEtagCache: db is not a drizzle better-sqlite3 instance');
  }

  const read = (): EtagMap => {
    const row = db.get(sql`SELECT etag_json AS etagJson FROM sources WHERE id = ${sourceId}`) as
      | { etagJson?: string | null }
      | undefined;
    if (!row?.etagJson) return {};
    try {
      return JSON.parse(row.etagJson) as EtagMap;
    } catch {
      return {};
    }
  };

  return {
    async get(url) {
      return read()[url] ?? null;
    },
    async set(url, v) {
      const all = read();
      all[url] = v;
      db.run(sql`UPDATE sources SET etag_json = ${JSON.stringify(all)} WHERE id = ${sourceId}`);
    },
  };
}

/** In-memory cache for tests and one-off runs without a sources row. */
export function createMemoryEtagCache(): EtagCache {
  const map = new Map<string, EtagEntry>();
  return {
    async get(url) {
      return map.get(url) ?? null;
    },
    async set(url, v) {
      map.set(url, v);
    },
  };
}

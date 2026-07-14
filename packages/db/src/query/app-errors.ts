/**
 * Server-side error tracking repository (additive, 2026-07-13 ops).
 *
 * Self-rolled Sentry-lite: errors are DEDUPED by a normalized stack hash and
 * stored as one aggregate row per group (count + first/last seen + an hourly
 * counter for spike detection). The table is bounded — every new group insert
 * triggers a prune (max rows + max age), so a pathological error loop can
 * never grow the db unbounded.
 *
 * Writers: apps/web envelope.serverError (route catch paths), the Next
 * onRequestError instrumentation hook. All writes go through recordAppError;
 * callers wrap it in try/catch so a broken db never turns error *reporting*
 * into error *raising*.
 */
import { createHash } from 'node:crypto';
import { desc, lt, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { appErrors } from '../schema';

const MESSAGE_MAX = 500;
const STACK_MAX = 4000;
const HOUR_MS = 3_600_000;

export const APP_ERRORS_MAX_ROWS = 500;
export const APP_ERRORS_MAX_AGE_MS = 30 * 24 * HOUR_MS; // 30 days

/**
 * Normalized dedup key. Line/col numbers are stripped from stack frames and
 * digits from the message (ids, prices, timestamps) so "listing 123 not
 * found" and "listing 456 not found" collapse into one group. Only the top 5
 * frames participate — deep async tails vary run to run.
 */
export function computeStackHash(route: string, message: string, stack?: string | null): string {
  const normMessage = message.replace(/\d+/g, '#');
  const frames = (stack ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, 5)
    .map((l) => l.replace(/:\d+:\d+\)?$/, '').replace(/:\d+\)?$/, ''));
  return createHash('sha256')
    .update(`${route}\n${normMessage}\n${frames.join('\n')}`)
    .digest('hex');
}

export interface AppErrorInput {
  /** context label: 'api:search', 'onRequestError:/dress/[id]', … */
  route: string;
  message: string;
  stack?: string | null;
  /** injectable clock for tests */
  now?: number;
}

/**
 * Record one error occurrence: upsert the group row (count+1, refresh
 * message/stack/lastSeen, roll the hourly counter) and prune on new groups.
 * Returns the group's stack hash.
 */
export function recordAppError(db: Db, input: AppErrorInput): string {
  const now = input.now ?? Date.now();
  const message = (input.message || 'unknown error').slice(0, MESSAGE_MAX);
  const stack = input.stack ? input.stack.slice(0, STACK_MAX) : null;
  const stackHash = computeStackHash(input.route, message, input.stack);
  const bucket = Math.floor(now / HOUR_MS);

  db.insert(appErrors)
    .values({
      stackHash,
      route: input.route,
      message,
      stack,
      count: 1,
      hourBucket: bucket,
      hourCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: appErrors.stackHash,
      set: {
        message,
        stack,
        count: sql`${appErrors.count} + 1`,
        // UPDATE RHS sees OLD values, so this reads the pre-update bucket
        hourCount: sql`case when ${appErrors.hourBucket} = ${bucket} then ${appErrors.hourCount} + 1 else 1 end`,
        hourBucket: bucket,
        lastSeenAt: now,
      },
    })
    .run();

  // prune only when the row we just wrote is a fresh group (count=1) — dedup
  // updates can't grow the table, so they skip the two prune queries.
  const isNew =
    db
      .select({ c: appErrors.count })
      .from(appErrors)
      .where(sql`${appErrors.stackHash} = ${stackHash}`)
      .get()?.c === 1;
  if (isNew) pruneAppErrors(db, { now });

  return stackHash;
}

export interface PruneOptions {
  maxRows?: number;
  maxAgeMs?: number;
  now?: number;
}

/**
 * Cap the table: drop groups not seen for `maxAgeMs`, then keep only the
 * `maxRows` most-recently-seen groups. Returns rows deleted.
 */
export function pruneAppErrors(db: Db, opts: PruneOptions = {}): number {
  const now = opts.now ?? Date.now();
  const maxRows = opts.maxRows ?? APP_ERRORS_MAX_ROWS;
  const maxAgeMs = opts.maxAgeMs ?? APP_ERRORS_MAX_AGE_MS;

  const aged = db.delete(appErrors).where(lt(appErrors.lastSeenAt, now - maxAgeMs)).run();

  const total = db.select({ n: sql<number>`count(*)` }).from(appErrors).get()?.n ?? 0;
  let overflow = 0;
  if (total > maxRows) {
    const res = db.run(
      sql`delete from ${appErrors} where ${appErrors.stackHash} in (
        select ${appErrors.stackHash} from ${appErrors}
        order by ${appErrors.lastSeenAt} desc limit -1 offset ${maxRows}
      )`,
    );
    overflow = Number((res as { changes?: number }).changes ?? 0);
  }
  return Number((aged as { changes?: number }).changes ?? 0) + overflow;
}

export interface AppErrorGroup {
  stackHash: string;
  route: string;
  message: string;
  stack: string | null;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Grouped errors, most recently seen first (admin Errors panel). */
export function listAppErrors(db: Db, opts: { limit?: number } = {}): AppErrorGroup[] {
  return db
    .select({
      stackHash: appErrors.stackHash,
      route: appErrors.route,
      message: appErrors.message,
      stack: appErrors.stack,
      count: appErrors.count,
      firstSeenAt: appErrors.firstSeenAt,
      lastSeenAt: appErrors.lastSeenAt,
    })
    .from(appErrors)
    .orderBy(desc(appErrors.lastSeenAt))
    .limit(opts.limit ?? 50)
    .all();
}

export interface AppErrorStats {
  /** distinct error groups currently retained */
  groups: number;
  /**
   * Approximate occurrences in the last hour, from the per-group hourly
   * bucket counters (current + previous wall-clock hour — a 1–2h sliding
   * window; documented in docs/decisions-ops.md). Good enough for a spike
   * threshold, not an exact rate.
   */
  lastHour: number;
}

/** Cheap aggregate for /api/health (`errors` field + spike alert). */
export function appErrorStats(db: Db, now = Date.now()): AppErrorStats {
  const bucket = Math.floor(now / HOUR_MS);
  const row = db
    .select({
      groups: sql<number>`count(*)`,
      lastHour: sql<number>`coalesce(sum(case when ${appErrors.hourBucket} >= ${bucket - 1} then ${appErrors.hourCount} else 0 end), 0)`,
    })
    .from(appErrors)
    .get();
  return { groups: row?.groups ?? 0, lastHour: row?.lastHour ?? 0 };
}

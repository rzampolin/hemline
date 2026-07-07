/**
 * Freshness helpers — docs/ARCHITECTURE.md §3 ("Freshness model").
 * Every connector sighting bumps last_seen_at (pipeline.ts); items unseen for
 * 2 × cadence get removed_at set (soft delete).
 */
import { and, inArray, isNull, lt } from 'drizzle-orm';
import { listings, type Db } from '@hemline/db';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Approximate the interval of a 5-field cron expression, for the "2 × cadence"
 * staleness rule. Handles the patterns we actually schedule (daily at HH:MM,
 * every N hours/minutes); anything fancier falls back to daily.
 */
export function cronIntervalMs(cadenceCron: string): number {
  const fields = cadenceCron.trim().split(/\s+/);
  if (fields.length < 5) return DAY;
  const [minute, hour, dayOfMonth] = fields;

  const step = (f: string) => {
    const m = /^\*\/(\d+)$/.exec(f);
    return m ? Number(m[1]) : null;
  };

  if (dayOfMonth !== '*') return 7 * DAY; // monthly-ish: treat as long cadence
  const hourStep = step(hour);
  if (hourStep) return hourStep * HOUR; // '0 */6 * * *' → 6h
  const minuteStep = step(minute);
  if (minuteStep && hour === '*') return minuteStep * 60_000; // '*/30 * * * *' → 30m
  return DAY; // '0 6 * * *' and friends → daily
}

export interface PruneStaleOptions {
  now?: number;
  /** override the 2×cadence window */
  staleAfterMs?: number;
}

/**
 * Soft-delete listings of the given sources unseen for 2 × cadence.
 * Returns the number of listings marked removed.
 */
export function pruneStale(
  db: Db,
  sourceIds: string[],
  cadenceCron: string,
  opts: PruneStaleOptions = {},
): number {
  if (sourceIds.length === 0) return 0;
  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? 2 * cronIntervalMs(cadenceCron);
  const cutoff = now - staleAfterMs;

  const result = db
    .update(listings)
    .set({ removedAt: now })
    .where(
      and(
        inArray(listings.sourceId, sourceIds),
        isNull(listings.removedAt),
        lt(listings.lastSeenAt, cutoff),
      ),
    )
    .run();
  return result.changes;
}

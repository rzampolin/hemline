/**
 * Error tracking: capture / dedup / hourly counter / prune (ops, 2026-07-13).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { appErrors } from '../schema';
import {
  appErrorStats,
  computeStackHash,
  listAppErrors,
  pruneAppErrors,
  recordAppError,
} from './app-errors';

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000; // fixed epoch for deterministic buckets

let tmpDir: string;
let db: Db;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-app-errors-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.delete(appErrors).run();
});

describe('computeStackHash (dedup key normalization)', () => {
  it('ignores line/col numbers and digits in messages', () => {
    const a = computeStackHash(
      'api:search',
      'listing 123 not found',
      'Error: listing 123 not found\n    at handler (/app/route.ts:10:5)\n    at run (/app/lib.ts:44:12)',
    );
    const b = computeStackHash(
      'api:search',
      'listing 456 not found',
      'Error: listing 456 not found\n    at handler (/app/route.ts:99:1)\n    at run (/app/lib.ts:7:3)',
    );
    expect(a).toBe(b);
  });

  it('distinguishes routes and genuinely different messages/frames', () => {
    const base = computeStackHash('api:search', 'boom', 'Error: boom\n    at a (/x.ts:1:1)');
    expect(computeStackHash('api:rank', 'boom', 'Error: boom\n    at a (/x.ts:1:1)')).not.toBe(base);
    expect(computeStackHash('api:search', 'kaboom', 'Error: boom\n    at a (/x.ts:1:1)')).not.toBe(base);
    expect(computeStackHash('api:search', 'boom', 'Error: boom\n    at b (/y.ts:1:1)')).not.toBe(base);
  });

  it('handles missing stacks', () => {
    expect(computeStackHash('api:x', 'no stack')).toMatch(/^[0-9a-f]{64}$/);
    expect(computeStackHash('api:x', 'no stack')).toBe(computeStackHash('api:x', 'no stack', null));
  });
});

describe('recordAppError (capture + dedup)', () => {
  it('inserts a new group with count 1 and first/last seen', () => {
    recordAppError(db, { route: 'api:search', message: 'boom', stack: 'Error: boom\n    at a (/x.ts:1:1)', now: T0 });
    const rows = listAppErrors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route: 'api:search',
      message: 'boom',
      count: 1,
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    expect(rows[0].stack).toContain('at a');
  });

  it('dedups repeats into one row: count grows, lastSeen advances, firstSeen sticks', () => {
    const stack = 'Error: listing 1 gone\n    at h (/r.ts:5:5)';
    recordAppError(db, { route: 'api:listings', message: 'listing 1 gone', stack, now: T0 });
    recordAppError(db, { route: 'api:listings', message: 'listing 2 gone', stack, now: T0 + 1000 });
    recordAppError(db, { route: 'api:listings', message: 'listing 3 gone', stack, now: T0 + 2000 });
    const rows = listAppErrors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].firstSeenAt).toBe(T0);
    expect(rows[0].lastSeenAt).toBe(T0 + 2000);
    // latest message wins (freshest repro detail)
    expect(rows[0].message).toBe('listing 3 gone');
  });

  it('truncates oversized messages and stacks', () => {
    recordAppError(db, {
      route: 'api:x',
      message: 'm'.repeat(2000),
      stack: 's'.repeat(10_000),
      now: T0,
    });
    const row = listAppErrors(db)[0];
    expect(row.message).toHaveLength(500);
    expect(row.stack).toHaveLength(4000);
  });

  it('separate routes stay separate groups', () => {
    recordAppError(db, { route: 'api:a', message: 'boom', now: T0 });
    recordAppError(db, { route: 'api:b', message: 'boom', now: T0 });
    expect(listAppErrors(db)).toHaveLength(2);
  });
});

describe('appErrorStats (hourly spike counter)', () => {
  it('counts occurrences in the current hour bucket', () => {
    for (let i = 0; i < 5; i++)
      recordAppError(db, { route: 'api:x', message: 'boom', now: T0 + i * 1000 });
    const stats = appErrorStats(db, T0 + 5000);
    expect(stats.groups).toBe(1);
    expect(stats.lastHour).toBe(5);
  });

  it('rolls the counter when the wall-clock hour changes', () => {
    recordAppError(db, { route: 'api:x', message: 'boom', now: T0 });
    recordAppError(db, { route: 'api:x', message: 'boom', now: T0 + 2 * HOUR });
    const rows = db.select().from(appErrors).all();
    expect(rows[0].count).toBe(2); // total keeps accumulating
    expect(rows[0].hourCount).toBe(1); // hourly counter reset
    // two hours later, the old bucket falls out of the 1–2h window
    expect(appErrorStats(db, T0 + 2 * HOUR).lastHour).toBe(1);
    expect(appErrorStats(db, T0 + 5 * HOUR).lastHour).toBe(0);
  });
});

describe('pruneAppErrors (bounded table)', () => {
  it('drops groups older than maxAgeMs', () => {
    recordAppError(db, { route: 'api:old', message: 'ancient', now: T0 });
    recordAppError(db, { route: 'api:new', message: 'fresh', now: T0 + 10 * 24 * HOUR });
    // 35d later: 'old' (35d) is past the 30d window, 'new' (25d) is not
    const deleted = pruneAppErrors(db, { now: T0 + 35 * 24 * HOUR, maxAgeMs: 30 * 24 * HOUR });
    expect(deleted).toBe(1);
    const rows = listAppErrors(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('api:new');
  });

  it('caps the table to maxRows, keeping the most recently seen', () => {
    for (let i = 0; i < 10; i++)
      recordAppError(db, { route: `api:r${i}`, message: `boom ${'x'.repeat(i)}`, now: T0 + i * 1000 });
    const deleted = pruneAppErrors(db, { now: T0 + 10_000, maxRows: 3 });
    expect(deleted).toBe(7);
    const rows = listAppErrors(db);
    expect(rows.map((r) => r.route)).toEqual(['api:r9', 'api:r8', 'api:r7']);
  });

  it('is invoked automatically on new-group inserts (recordAppError caps itself)', () => {
    // shrink the effective cap by pre-filling then relying on the built-in
    // prune (uses default 500-row cap) — verify a burst of unique groups
    // does not exceed the cap.
    for (let i = 0; i < 520; i++)
      recordAppError(db, { route: `api:burst${i}`, message: `unique ${'y'.repeat(i % 7)}`, now: T0 + i });
    const total = db.select().from(appErrors).all().length;
    expect(total).toBeLessThanOrEqual(500);
  });
});

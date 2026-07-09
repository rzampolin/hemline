/**
 * First-party product analytics repository (additive, 2026-07-09):
 * batch inserts + windowed SQL aggregates for GET /api/admin/analytics.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { analyticsEvents } from '../schema';
import { analyticsWindowSummary, insertAnalyticsEvents } from './analytics';

let tmpDir: string;
let db: Db;

const NOW = 1_800_000_000_000; // fixed epoch for deterministic windows
const HOUR = 3_600_000;

function seed(
  eventType: string,
  props: Record<string, unknown>,
  opts: { userId?: string | null; anonId?: string; at?: number } = {},
): void {
  db.insert(analyticsEvents)
    .values({
      userId: opts.userId ?? null,
      anonId: opts.anonId ?? 'anon-1',
      eventType,
      propsJson: JSON.stringify(props),
      createdAt: opts.at ?? NOW - HOUR,
    })
    .run();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-analytics-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);

  // ── funnel: 3 starters (u1, u2, guest anon-g), 2 completers (u1, anon-g).
  // u1 fires quiz_started twice — distinct-actor dedup must count once.
  seed('quiz_started', {}, { userId: 'u1' });
  seed('quiz_started', {}, { userId: 'u1' });
  seed('quiz_started', {}, { userId: 'u2', anonId: 'anon-2' });
  seed('quiz_started', {}, { anonId: 'anon-g' });
  seed('quiz_step_completed', { step: 1 }, { userId: 'u1' });
  seed('quiz_step_completed', { step: 1 }, { userId: 'u2', anonId: 'anon-2' });
  seed('quiz_step_completed', { step: 1 }, { anonId: 'anon-g' });
  seed('quiz_step_completed', { step: 2 }, { userId: 'u1' });
  seed('quiz_step_completed', { step: 2 }, { anonId: 'anon-g' });
  seed('quiz_completed', { durationMs: 60_000 }, { userId: 'u1' });
  seed('quiz_completed', { durationMs: 90_000 }, { anonId: 'anon-g' });
  // deck + feed
  seed('deck_completed', {}, { userId: 'u1' });
  seed('feed_viewed', { page: 0 }, { userId: 'u1' });
  seed('feed_viewed', { page: 1 }, { userId: 'u1' });
  seed('feed_viewed', { page: 0 }, { anonId: 'anon-g' });

  // ── searches: "red midi" hits twice (12 then 8 results), "taffeta ballgown"
  // is a catalog gap (0 results, twice), "Blue Wrap" mixed-case dedup check.
  seed('search_submitted', { query: 'red midi', interpreted: true, resultCount: 12 }, { userId: 'u1', at: NOW - 2 * HOUR });
  seed('search_submitted', { query: 'Red Midi', interpreted: true, resultCount: 8 }, { userId: 'u2', anonId: 'anon-2', at: NOW - HOUR });
  seed('search_submitted', { query: 'taffeta ballgown', interpreted: false, resultCount: 0 }, { anonId: 'anon-g' });
  seed('search_submitted', { query: 'taffeta ballgown', interpreted: false, resultCount: 0 }, { userId: 'u1' });
  seed('search_submitted', { query: 'blue wrap', interpreted: true, resultCount: 0, }, { userId: 'u2', anonId: 'anon-2', at: NOW - 3 * HOUR });
  seed('search_submitted', { query: 'blue wrap', interpreted: true, resultCount: 5 }, { userId: 'u2', anonId: 'anon-2', at: NOW - HOUR });

  // ── filters + swipes
  seed('filter_applied', { kind: 'price' }, { userId: 'u1' });
  seed('filter_applied', { kind: 'price' }, { userId: 'u2', anonId: 'anon-2' });
  seed('filter_applied', { kind: 'length' }, { anonId: 'anon-g' });
  seed('deck_swipe', { verdict: 'like', index: 0 }, { userId: 'u1' });
  seed('deck_swipe', { verdict: 'like', index: 1 }, { userId: 'u1' });
  seed('deck_swipe', { verdict: 'save', index: 2 }, { userId: 'u1' });
  seed('deck_swipe', { verdict: 'dislike', index: 3 }, { userId: 'u1' });

  // ── outside the window: must not pollute any aggregate
  seed('quiz_started', {}, { userId: 'old-user', at: NOW - 10 * 24 * HOUR });
  seed('search_submitted', { query: 'ancient query', interpreted: false, resultCount: 0 }, { userId: 'old-user', at: NOW - 10 * 24 * HOUR });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('insertAnalyticsEvents', () => {
  it('inserts a batch with serialized props and server timestamps', () => {
    const before = db.select().from(analyticsEvents).all().length;
    const n = insertAnalyticsEvents(
      db,
      [
        { userId: 'u9', anonId: 'anon-9', eventType: 'feed_viewed', props: { page: 3 } },
        { userId: null, anonId: 'anon-9', eventType: 'deck_completed', props: {} },
      ],
      NOW,
    );
    expect(n).toBe(2);
    const rows = db.select().from(analyticsEvents).all();
    expect(rows.length).toBe(before + 2);
    const last = rows.at(-1)!;
    expect(last.userId).toBeNull();
    expect(last.anonId).toBe('anon-9');
    expect(last.createdAt).toBe(NOW);
    expect(JSON.parse(rows.at(-2)!.propsJson)).toEqual({ page: 3 });
    // remove so the aggregate assertions below stay exact
    db.delete(analyticsEvents).where(eq(analyticsEvents.anonId, 'anon-9')).run();
  });

  it('is a no-op for an empty batch', () => {
    const before = db.select().from(analyticsEvents).all().length;
    expect(insertAnalyticsEvents(db, [])).toBe(0);
    expect(db.select().from(analyticsEvents).all().length).toBe(before);
  });
});

describe('analyticsWindowSummary', () => {
  const since = NOW - 24 * HOUR;

  it('funnel: distinct-actor dedup, completion rate, median duration, step drop-off', () => {
    const s = analyticsWindowSummary(db, since);
    expect(s.funnel.quizStarted).toBe(3); // u1 deduped, old-user excluded
    expect(s.funnel.quizCompleted).toBe(2);
    expect(s.funnel.quizCompletionRate).toBeCloseTo(2 / 3);
    expect(s.funnel.medianQuizDurationMs).toBe(75_000); // even count → midpoint avg
    expect(s.funnel.quizStepActors).toEqual({ '1': 3, '2': 2 });
    expect(s.funnel.deckCompleted).toBe(1);
    expect(s.funnel.feedViewers).toBe(2);
  });

  it('top searches: case-insensitive grouping, counts, zero-result flags', () => {
    const s = analyticsWindowSummary(db, since);
    const byQuery = Object.fromEntries(s.topSearches.map((r) => [r.query, r]));
    expect(byQuery['red midi']).toMatchObject({
      count: 2,
      zeroResultCount: 0,
      alwaysZeroResults: false,
      lastResultCount: 8, // most recent submission
    });
    expect(byQuery['taffeta ballgown']).toMatchObject({
      count: 2,
      zeroResultCount: 2,
      alwaysZeroResults: true, // never matched anything → catalog gap
      lastResultCount: 0,
    });
    expect(byQuery['blue wrap']).toMatchObject({
      count: 2,
      zeroResultCount: 1,
      alwaysZeroResults: false, // matched at least once
      lastResultCount: 5,
    });
    expect(byQuery['ancient query']).toBeUndefined(); // outside the window
    expect(s.topSearches.length).toBeLessThanOrEqual(20);
  });

  it('filter usage histogram', () => {
    const s = analyticsWindowSummary(db, since);
    expect(s.filterUsage).toEqual({ price: 2, length: 1 });
  });

  it('swipe like-rate counts saves as positive', () => {
    const s = analyticsWindowSummary(db, since);
    expect(s.swipes.total).toBe(4);
    expect(s.swipes.byVerdict).toEqual({ like: 2, save: 1, dislike: 1 });
    expect(s.swipes.likeRate).toBeCloseTo(3 / 4);
  });

  it('respects the window boundary and reports raw event counts', () => {
    const s = analyticsWindowSummary(db, since);
    expect(s.eventCounts['quiz_started']).toBe(4); // raw count (u1 double-fire), old-user excluded
    const wide = analyticsWindowSummary(db, NOW - 30 * 24 * HOUR);
    expect(wide.funnel.quizStarted).toBe(4); // old-user now inside
    const empty = analyticsWindowSummary(db, NOW + HOUR);
    expect(empty.funnel.quizStarted).toBe(0);
    expect(empty.funnel.quizCompletionRate).toBeNull();
    expect(empty.funnel.medianQuizDurationMs).toBeNull();
    expect(empty.topSearches).toEqual([]);
    expect(empty.swipes.likeRate).toBeNull();
  });
});

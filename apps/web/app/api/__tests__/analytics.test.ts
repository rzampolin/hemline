/**
 * POST /api/events + GET /api/admin/analytics (additive, 2026-07-09).
 * Route handlers invoked directly against a temp SQLite db (§9.4 pattern):
 * whitelist enforcement, oversized batches, junk props, guest tolerance,
 * silent 204s, admin auth, and end-to-end aggregate shape.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyticsEvents, createDb, createUser, ensureSchema, type Db } from '@hemline/db';
import { ANALYTICS_MAX_BATCH } from '@hemline/contracts';

import { __resetDbCache } from '../lib/db';
import { USER_ID_HEADER } from '../lib/session';
import { POST as eventsPOST } from '../events/route';
import { GET as adminAnalyticsGET } from '../admin/analytics/route';

let tmpDir: string;
let db: Db;

const KNOWN_USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ANON = 'anon-session-1234';

function batchReq(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://test/api/events', {
    method: 'POST',
    // text/plain framing — exactly what sendBeacon(string) ships
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function allRows() {
  return db.select().from(analyticsEvents).all();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-analytics-api-test-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  createUser(db, KNOWN_USER);
  process.env.DATABASE_PATH = dbPath;
  __resetDbCache();
});

afterAll(() => {
  delete process.env.ADMIN_BASIC_AUTH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/events', () => {
  it('accepts a valid batch from a known user → silent 204, rows attributed', async () => {
    const res = await eventsPOST(
      batchReq(
        {
          anonId: ANON,
          events: [
            { type: 'quiz_started', props: {} },
            { type: 'quiz_step_completed', props: { step: 1 } },
            { type: 'search_submitted', props: { query: 'red midi', interpreted: true, resultCount: 7 } },
          ],
        },
        { [USER_ID_HEADER]: KNOWN_USER },
      ),
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe(''); // silent — sendBeacon never reads it
    const rows = allRows();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.userId === KNOWN_USER && r.anonId === ANON)).toBe(true);
    expect(rows.map((r) => r.eventType)).toEqual([
      'quiz_started',
      'quiz_step_completed',
      'search_submitted',
    ]);
    expect(JSON.parse(rows[2].propsJson)).toEqual({ query: 'red midi', interpreted: true, resultCount: 7 });
    expect(rows.every((r) => r.createdAt > 0)).toBe(true);
  });

  it('tolerates guests: no session → user_id NULL, anon id recorded', async () => {
    const res = await eventsPOST(
      batchReq({ anonId: 'anon-guest-9999', events: [{ type: 'feed_viewed', props: { page: 0 } }] }),
    );
    expect(res.status).toBe(204);
    const row = allRows().at(-1)!;
    expect(row.userId).toBeNull();
    expect(row.anonId).toBe('anon-guest-9999');
  });

  it('does not fabricate users: unknown session UUID is recorded as guest', async () => {
    const ghost = '99999999-9999-4999-8999-999999999999';
    const res = await eventsPOST(
      batchReq(
        { anonId: ANON, events: [{ type: 'deck_completed', props: {} }] },
        { [USER_ID_HEADER]: ghost },
      ),
    );
    expect(res.status).toBe(204);
    expect(allRows().at(-1)!.userId).toBeNull();
  });

  it('rejects unknown event types (whitelist enforcement, nothing written)', async () => {
    const before = allRows().length;
    const res = await eventsPOST(
      batchReq({ anonId: ANON, events: [{ type: 'page_snooped', props: { path: '/secret' } }] }),
    );
    expect(res.status).toBe(400);
    expect(allRows().length).toBe(before);
  });

  it('rejects junk props: wrong types, extra keys, oversized query', async () => {
    const before = allRows().length;
    const junk = [
      { type: 'deck_swipe', props: { verdict: 'meh', index: 0 } }, // bad enum
      { type: 'feed_viewed', props: { page: 'zero' } }, // bad type
      { type: 'quiz_started', props: { userAgent: 'spyware' } }, // extra key
      { type: 'search_submitted', props: { query: 'x'.repeat(500), interpreted: false, resultCount: 0 } },
      { type: 'quiz_completed', props: { durationMs: -5 } }, // out of range
    ];
    for (const event of junk) {
      const res = await eventsPOST(batchReq({ anonId: ANON, events: [event] }));
      expect(res.status, JSON.stringify(event)).toBe(400);
    }
    expect(allRows().length).toBe(before);
  });

  it('accepts the adaptive-deck events (additive whitelist, 2026-07-10)', async () => {
    const res = await eventsPOST(
      batchReq({
        anonId: ANON,
        events: [
          { type: 'deck_image_error', props: { position: 0 } },
          { type: 'deck_swipe', props: { verdict: 'like', index: 13, batch: 1 } },
          { type: 'deck_swipe', props: { verdict: 'like', index: 2 } }, // batch optional (old clients)
          { type: 'deck_completed', props: { likes: 5, cardsSeen: 14, reason: 'target' } },
          { type: 'deck_completed', props: {} }, // old empty payload stays valid
        ],
      }),
    );
    expect(res.status).toBe(204);
    const rows = allRows().slice(-5);
    expect(rows.map((r) => r.eventType)).toEqual([
      'deck_image_error',
      'deck_swipe',
      'deck_swipe',
      'deck_completed',
      'deck_completed',
    ]);
    expect(JSON.parse(rows[3].propsJson)).toEqual({ likes: 5, cardsSeen: 14, reason: 'target' });
  });

  it('rejects junk on the adaptive-deck events (closed whitelist holds)', async () => {
    const before = allRows().length;
    const junk = [
      { type: 'deck_image_error', props: { position: 25 } }, // out of range
      { type: 'deck_image_error', props: { position: 0, url: 'https://leak' } }, // extra key
      { type: 'deck_swipe', props: { verdict: 'like', index: 0, batch: 99 } }, // batch out of range
      { type: 'deck_completed', props: { reason: 'rage_quit' } }, // unknown reason
    ];
    for (const event of junk) {
      const res = await eventsPOST(batchReq({ anonId: ANON, events: [event] }));
      expect(res.status, JSON.stringify(event)).toBe(400);
    }
    expect(allRows().length).toBe(before);
  });

  it('rejects an oversized batch (nothing written)', async () => {
    const before = allRows().length;
    const res = await eventsPOST(
      batchReq({
        anonId: ANON,
        events: Array.from({ length: ANALYTICS_MAX_BATCH + 1 }, () => ({
          type: 'feed_viewed',
          props: { page: 0 },
        })),
      }),
    );
    expect(res.status).toBe(400);
    expect(allRows().length).toBe(before);
  });

  it('rejects an oversized raw body with 413', async () => {
    const res = await eventsPOST(batchReq('x'.repeat(40 * 1024)));
    expect(res.status).toBe(413);
  });

  it('rejects non-JSON and empty batches', async () => {
    expect((await eventsPOST(batchReq('not json'))).status).toBe(400);
    expect((await eventsPOST(batchReq({ anonId: ANON, events: [] }))).status).toBe(400);
  });

  it('rejects a malformed anonId', async () => {
    const res = await eventsPOST(
      batchReq({ anonId: 'bad anon id!!', events: [{ type: 'quiz_started', props: {} }] }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/admin/analytics', () => {
  it('enforces basic auth when ADMIN_BASIC_AUTH is set', async () => {
    process.env.ADMIN_BASIC_AUTH = 'op:secret';
    try {
      const denied = await adminAnalyticsGET(new Request('http://test/api/admin/analytics'));
      expect(denied.status).toBe(401);
      const wrong = await adminAnalyticsGET(
        new Request('http://test/api/admin/analytics', {
          headers: { authorization: `Basic ${Buffer.from('op:wrong').toString('base64')}` },
        }),
      );
      expect(wrong.status).toBe(401);
      const allowed = await adminAnalyticsGET(
        new Request('http://test/api/admin/analytics', {
          headers: { authorization: `Basic ${Buffer.from('op:secret').toString('base64')}` },
        }),
      );
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.ADMIN_BASIC_AUTH;
    }
  });

  it('returns 24h/7d aggregates over the events posted above', async () => {
    // add a zero-result search + a completed quiz so every section has data
    await eventsPOST(
      batchReq(
        {
          anonId: ANON,
          events: [
            { type: 'search_submitted', props: { query: 'taffeta ballgown', interpreted: false, resultCount: 0 } },
            { type: 'quiz_completed', props: { durationMs: 45_000 } },
            { type: 'filter_applied', props: { kind: 'price' } },
            { type: 'deck_swipe', props: { verdict: 'like', index: 0 } },
            { type: 'deck_swipe', props: { verdict: 'dislike', index: 1 } },
          ],
        },
        { [USER_ID_HEADER]: KNOWN_USER },
      ),
    );

    const res = await adminAnalyticsGET(new Request('http://test/api/admin/analytics'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: any };
    expect(body.ok).toBe(true);
    const day = body.data.windows['24h'];

    // funnel: KNOWN_USER started (via first batch) and completed
    expect(day.funnel.quizStarted).toBe(1);
    expect(day.funnel.quizCompleted).toBe(1);
    expect(day.funnel.quizCompletionRate).toBe(1);
    expect(day.funnel.medianQuizDurationMs).toBe(45_000);

    // searches: zero-result flag surfaces the catalog gap
    const gap = day.topSearches.find((r: any) => r.query === 'taffeta ballgown');
    expect(gap).toMatchObject({ count: 1, zeroResultCount: 1, alwaysZeroResults: true });
    const hit = day.topSearches.find((r: any) => r.query === 'red midi');
    expect(hit).toMatchObject({ zeroResultCount: 0, alwaysZeroResults: false, lastResultCount: 7 });

    expect(day.filterUsage).toEqual({ price: 1 });
    // 2 swipes here + 2 likes from the adaptive-deck acceptance test above
    expect(day.swipes).toMatchObject({ total: 4, likeRate: 0.75 });
    expect(day.swipes.byVerdict).toEqual({ like: 3, dislike: 1 });

    // 7d window is a superset of 24h
    expect(body.data.windows['7d'].funnel.quizStarted).toBeGreaterThanOrEqual(day.funnel.quizStarted);
    expect(body.data.generatedAt).toBeGreaterThan(0);
  });
});

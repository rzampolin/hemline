/**
 * Rate-limit coverage for the AI-spending + abuse-surface routes
 * (2026-07-14 security audit). The limiter is prod-only, so these tests flip
 * RATE_LIMIT_FORCE=1 and reset the in-memory buckets between cases.
 *
 * Focus:
 *   • /api/search — guests keyed PER-IP (not one global bucket), and the
 *     free-text `q` path capped by a tighter bucket than the filter fast path.
 *   • /api/color-analysis/quiz — modest per-user cap.
 *   • clientIp / rateLimitKey — Fly header trust (no spoofable XFF-leftmost).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, ensureSchema, runSeed, DEMO_USER_ID, type Db } from '@hemline/db';

import { __resetDbCache } from '../lib/db';
import { __resetRateLimiter } from '../lib/rate-limit';
import { clientIp, rateLimitKey, USER_ID_HEADER } from '../lib/session';
import { GET as searchGET } from '../search/route';
import { POST as quizPOST } from '../color-analysis/quiz/route';

let tmpDir: string;
let db: Db;

beforeAll(() => {
  delete process.env.ANTHROPIC_API_KEY; // keep stage 3 off — we only test throttling
  process.env.RATE_LIMIT_FORCE = '1';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-rate-limit-'));
  const dbPath = path.join(tmpDir, 'hemline.db');
  db = createDb({ dbPath });
  ensureSchema(db);
  runSeed(dbPath);
  process.env.DATABASE_PATH = dbPath;
  __resetDbCache();
});

afterAll(() => {
  delete process.env.RATE_LIMIT_FORCE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => __resetRateLimiter());

async function status(res: Response): Promise<number> {
  return res.status;
}
async function code(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { ok: boolean; error?: { code: string } };
  return body.ok ? undefined : body.error?.code;
}

const searchReq = (qs: string, headers: Record<string, string> = {}) =>
  new Request(`http://test/api/search?${qs}`, { headers });

describe('clientIp / rateLimitKey — Fly-aware, non-spoofable', () => {
  it('prefers Fly-Client-IP (the trusted edge value)', () => {
    const req = new Request('http://test/', {
      headers: { 'fly-client-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' },
    });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('uses the RIGHTMOST XFF hop, ignoring a client-spoofed leftmost entry', () => {
    const req = new Request('http://test/', {
      // attacker prepends a fake IP; the real (proxy-appended) hop is last
      headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.42' },
    });
    expect(clientIp(req)).toBe('203.0.113.42');
  });

  it('rateLimitKey is the session user when present, else ip:<addr>', () => {
    const withUser = new Request('http://test/', {
      headers: { [USER_ID_HEADER]: DEMO_USER_ID },
    });
    expect(rateLimitKey(withUser)).toBe(DEMO_USER_ID);
    const guest = new Request('http://test/', { headers: { 'fly-client-ip': '203.0.113.7' } });
    expect(rateLimitKey(guest)).toBe('ip:203.0.113.7');
  });
});

describe('/api/search rate limiting', () => {
  it('caps the free-text (stage-3 spend) path tighter than the fast path', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 16; i++) {
      last = await searchGET(searchReq('q=pink', { 'fly-client-ip': '198.51.100.1' }));
    }
    expect(await status(last!)).toBe(429);
    expect(await code(last!)).toBe('rate_limited');
  });

  it('does not throttle a different guest IP (per-IP, not one global bucket)', async () => {
    for (let i = 0; i < 16; i++) {
      await searchGET(searchReq('q=pink', { 'fly-client-ip': '198.51.100.1' }));
    }
    // a second guest on another IP is unaffected
    const other = await searchGET(searchReq('q=pink', { 'fly-client-ip': '198.51.100.2' }));
    expect(await status(other)).toBe(200);
  });

  it('the filter-only fast path is allowed well past the tight query cap', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 20; i++) {
      last = await searchGET(searchReq('colors=pink', { 'fly-client-ip': '198.51.100.3' }));
    }
    expect(await status(last!)).toBe(200); // 20 < 60 fast-path cap, and no `q`
  });
});

describe('/api/color-analysis/quiz rate limiting', () => {
  it('429s after the per-user cap', async () => {
    const headers = { [USER_ID_HEADER]: DEMO_USER_ID, 'content-type': 'application/json' };
    const body = JSON.stringify({ answers: {} });
    let last: Response | undefined;
    for (let i = 0; i < 21; i++) {
      last = await quizPOST(new Request('http://test/api/color-analysis/quiz', {
        method: 'POST',
        headers,
        body,
      }));
    }
    // Either the schema rejects the empty answers (400) or we hit the cap (429);
    // the cap must engage before unlimited profile writes are allowed.
    expect([429]).toContain(await status(last!));
    expect(await code(last!)).toBe('rate_limited');
  });
});

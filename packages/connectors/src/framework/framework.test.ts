import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIngestionTestDb } from '../test-helpers';
import { createEtagCache, createMemoryEtagCache } from './etag-cache';
import { hemlineUserAgent, politeFetch, resetPoliteness } from './politeness';

describe('etag cache (DB-backed over sources.etag_json)', () => {
  it('round-trips etag/last-modified per url and persists to the sources row', async () => {
    const db = createIngestionTestDb();
    db.run(
      sql`INSERT INTO sources (id, kind, display_name, cadence_cron) VALUES ('shopify:x.com', 'shopify', 'X', '0 6 * * *')`,
    );
    const cache = createEtagCache('shopify:x.com', db);

    expect(await cache.get('https://x.com/products.json?limit=250&page=1')).toBeNull();
    await cache.set('https://x.com/products.json?limit=250&page=1', {
      etag: 'W/"a"',
      lastModified: 'Mon, 06 Jul 2026 00:00:00 GMT',
    });
    await cache.set('https://x.com/other', { etag: 'W/"b"' });

    expect(await cache.get('https://x.com/products.json?limit=250&page=1')).toEqual({
      etag: 'W/"a"',
      lastModified: 'Mon, 06 Jul 2026 00:00:00 GMT',
    });

    // persisted, not in-memory: a fresh cache over the same row still sees it
    const cache2 = createEtagCache('shopify:x.com', db);
    expect(await cache2.get('https://x.com/other')).toEqual({ etag: 'W/"b"' });

    const row = db.get(sql`SELECT etag_json AS j FROM sources WHERE id = 'shopify:x.com'`) as {
      j: string;
    };
    expect(Object.keys(JSON.parse(row.j))).toHaveLength(2);
  });

  it('survives a corrupt etag_json blob', async () => {
    const db = createIngestionTestDb();
    db.run(
      sql`INSERT INTO sources (id, kind, display_name, cadence_cron, etag_json) VALUES ('s', 'shopify', 'S', '0 6 * * *', 'not-json')`,
    );
    const cache = createEtagCache('s', db);
    expect(await cache.get('u')).toBeNull();
    await cache.set('u', { etag: 'e' });
    expect(await cache.get('u')).toEqual({ etag: 'e' });
  });

  it('memory cache round-trips', async () => {
    const cache = createMemoryEtagCache();
    await cache.set('u', { etag: 'e' });
    expect(await cache.get('u')).toEqual({ etag: 'e' });
    expect(await cache.get('v')).toBeNull();
  });
});

describe('politeFetch', () => {
  beforeEach(() => resetPoliteness());

  it('sets the HemlineBot User-Agent with the crawler contact', async () => {
    let ua: string | null = null;
    const fetchImpl = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      ua = new Headers(init?.headers).get('user-agent');
      return new Response('ok');
    }) as unknown as typeof fetch;
    await politeFetch('https://a.example/x', undefined, { fetchImpl, minDelayMs: 0 });
    expect(ua).toBe(hemlineUserAgent());
    expect(hemlineUserAgent({ CRAWLER_CONTACT: 'me@x.com' } as NodeJS.ProcessEnv)).toBe(
      'HemlineBot/1.0 (+me@x.com)',
    );
  });

  it('enforces the per-host delay but not across hosts', async () => {
    const timestamps: Record<string, number[]> = {};
    const fetchImpl = vi.fn(async (u: string | URL) => {
      const host = new URL(String(u)).host;
      (timestamps[host] ??= []).push(Date.now());
      return new Response('ok');
    }) as unknown as typeof fetch;

    const t0 = Date.now();
    await Promise.all([
      politeFetch('https://a.example/1', undefined, { fetchImpl, minDelayMs: 120 }),
      politeFetch('https://a.example/2', undefined, { fetchImpl, minDelayMs: 120 }),
      politeFetch('https://b.example/1', undefined, { fetchImpl, minDelayMs: 120 }),
    ]);

    const [a1, a2] = timestamps['a.example'];
    expect(a2 - a1).toBeGreaterThanOrEqual(100); // ≥ minDelay (timer slop tolerated)
    expect(timestamps['b.example'][0] - t0).toBeLessThan(100); // other host not queued behind a.example
  });

  it('retries once on 429 then returns the final response', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
        : new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await politeFetch('https://c.example/x', undefined, {
      fetchImpl,
      minDelayMs: 0,
      retries: 1,
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });
});

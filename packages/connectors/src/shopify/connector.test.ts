import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchContext, Logger } from '@hemline/contracts';
import { createMemoryEtagCache } from '../framework/etag-cache';
import { resetPoliteness } from '../framework/politeness';
import { createIngestionTestDb } from '../test-helpers';
import page from './__fixtures__/products-page.json';
import { createShopifyConnector, findShopifyStore, verifiedShopifyStores } from './index';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const STORE = { domain: 'staud.clothing', displayName: 'STAUD' };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeCtx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    db: createIngestionTestDb(),
    etagCache: createMemoryEtagCache(),
    logger: silentLogger,
    mockMode: false,
    ...overrides,
  };
}

beforeEach(() => resetPoliteness());

describe('shopify connector', () => {
  it('crawls, filters to dresses, stores the page-1 ETag, and stops on a short page', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /checkout\n', { status: 200 });
      }
      return jsonResponse(page, { headers: { etag: 'W/"abc123"' } });
    }) as unknown as typeof fetch;

    const connector = createShopifyConnector(STORE, { fetchImpl, minDelayMs: 0 });
    expect(connector.id).toBe('shopify:staud.clothing');
    expect(connector.kind).toBe('shopify');

    const ctx = makeCtx();
    const result = await connector.fetchListings(ctx);

    // 5 products on the page, 2 are dresses
    expect(result.listings).toHaveLength(2);
    expect(result.stats).toEqual({ fetched: 2, errors: 0 });
    expect(result.listings.map((l) => l.sourceListingId).sort()).toEqual([
      '8057672073392',
      '8112527411111',
    ]);
    // short page (5 < 250) → exactly robots + page 1
    expect(calls).toEqual([
      'https://staud.clothing/robots.txt',
      'https://staud.clothing/products.json?limit=250&page=1',
    ]);
    // ETag recorded for next run
    const cached = await ctx.etagCache.get(
      'https://staud.clothing/products.json?limit=250&page=1',
    );
    expect(cached?.etag).toBe('W/"abc123"');
  });

  it('sends If-None-Match and re-emits existing listings on 304', async () => {
    const db = createIngestionTestDb();
    db.run(
      sql`INSERT INTO sources (id, kind, display_name, cadence_cron) VALUES ('shopify:staud.clothing', 'shopify', 'STAUD', '0 6 * * *')`,
    );
    db.run(sql`
      INSERT INTO listings (id, source_id, source_listing_id, source_url, title, brand,
        price_cents, currency, condition, size_labels_json, availability_json,
        content_hash, first_seen_at, last_seen_at)
      VALUES ('shopify:staud.clothing:1', 'shopify:staud.clothing', '1',
        'https://staud.clothing/products/old-dress', 'Old Dress', 'STAUD',
        10000, 'USD', 'new', '["S","M"]', '{"S":true,"M":false}', 'hash1', 1, 1)
    `);
    db.run(
      sql`INSERT INTO listing_images (listing_id, url, position) VALUES ('shopify:staud.clothing:1', 'https://cdn/img1.jpg', 0)`,
    );

    let conditional: string | null = null;
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      conditional = new Headers(init?.headers).get('if-none-match');
      return new Response(null, { status: 304 });
    }) as unknown as typeof fetch;

    const etagCache = createMemoryEtagCache();
    await etagCache.set('https://staud.clothing/products.json?limit=250&page=1', {
      etag: 'W/"abc123"',
    });

    const connector = createShopifyConnector(STORE, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx({ db, etagCache }));

    expect(conditional).toBe('W/"abc123"');
    expect(result.stats.errors).toBe(0);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceId: 'shopify:staud.clothing',
      sourceListingId: '1',
      title: 'Old Dress',
      priceCents: 10000,
      sizeLabels: ['S', 'M'],
      availability: { S: true, M: false },
      imageUrls: ['https://cdn/img1.jpg'],
    });
    expect(result.listings[0].seenAt).toBeGreaterThan(1); // bumped, not the stale value
  });

  it('skips the store when robots.txt disallows products.json', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /products.json\n', { status: 200 });
      }
      throw new Error(`unexpected request: ${u}`);
    }) as unknown as typeof fetch;

    const connector = createShopifyConnector(STORE, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result).toEqual({ listings: [], stats: { fetched: 0, errors: 0 } });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only robots.txt
  });

  it('isolates errors: an HTTP 500 yields partial stats, never a throw', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      return new Response('oops', { status: 500 });
    }) as unknown as typeof fetch;

    const connector = createShopifyConnector(STORE, { fetchImpl, minDelayMs: 0, retries: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings).toHaveLength(0);
    expect(result.stats.errors).toBeGreaterThan(0);
  });

  it('skips crawling in mock mode (INGEST_ENABLE_SHOPIFY=false)', async () => {
    const fetchImpl = vi.fn();
    const connector = createShopifyConnector(STORE, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minDelayMs: 0,
    });
    expect(connector.isConfigured({ INGEST_ENABLE_SHOPIFY: 'false' } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    const result = await connector.fetchListings(makeCtx({ mockMode: true }));
    expect(result).toEqual({ listings: [], stats: { fetched: 0, errors: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('stores.json', () => {
  it('curates ~40 stores with an explicit verified flag', () => {
    const all = verifiedShopifyStores().length;
    expect(all).toBeGreaterThanOrEqual(25);
    expect(findShopifyStore('staud.clothing')?.verified).toBe(true);
    // known non-Shopify / blocked storefronts are kept but marked unverified
    expect(findShopifyStore('thereformation.com')?.verified).toBe(false);
  });
});

import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchContext, Logger } from '@hemline/contracts';
import { createMemoryEtagCache } from '../framework/etag-cache';
import { resetPoliteness } from '../framework/politeness';
import { createIngestionTestDb } from '../test-helpers';
import {
  createJsonldConnector,
  findJsonldStore,
  jsonldStores,
  orderProductUrls,
  verifiedJsonldStores,
  type JsonldStoreInfo,
} from './index';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const STORE: JsonldStoreInfo = {
  domain: 'brand.test',
  displayName: 'Brand',
  productUrlPattern: 'brand\\.test/products/',
};

const product = (name: string, price: string, extra: object = {}) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name,
    image: 'https://cdn.brand.test/img.jpg',
    offers: { '@type': 'Offer', price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
    ...extra,
  })}</script></head></html>`;

interface Route {
  status?: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

function makeFetch(routes: Record<string, Route>, calls: string[] = []) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (!r) return new Response('not found', { status: 404 });
    // conditional handling: route may declare an etag; echo 304 on match
    const etag = r.headers?.etag;
    const inm = new Headers(init?.headers).get('if-none-match');
    if (etag && inm && inm === etag) return new Response(null, { status: 304 });
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
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

const ROBOTS = [
  'User-agent: *',
  'Disallow: /cart',
  'Sitemap: https://brand.test/sitemap_index.xml',
  'Sitemap: https://other-domain.test/sitemap.xml', // foreign host — ignored
].join('\n');

const SITEMAP_INDEX = `<sitemapindex>
  <sitemap><loc>https://brand.test/sitemap_0-product.xml</loc></sitemap>
  <sitemap><loc>https://brand.test/sitemap_1-content.xml</loc></sitemap>
</sitemapindex>`;

const PRODUCT_SITEMAP = `<urlset>
  <url><loc>https://brand.test/products/gala-midi-dress</loc></url>
  <url><loc>https://brand.test/products/silk-blouse</loc></url>
  <url><loc>https://brand.test/products/prairie-maxi-dress</loc></url>
  <url><loc>https://brand.test/pages/about-us</loc></url>
</urlset>`;

beforeEach(() => resetPoliteness());

describe('jsonld connector — discovery & extraction', () => {
  it('robots → sitemap index (product child preferred) → PDPs → RawListings', async () => {
    const calls: string[] = [];
    const fetchImpl = makeFetch(
      {
        'https://brand.test/robots.txt': { body: ROBOTS },
        'https://brand.test/sitemap_index.xml': { body: SITEMAP_INDEX },
        'https://brand.test/sitemap_0-product.xml': { body: PRODUCT_SITEMAP },
        'https://brand.test/products/gala-midi-dress': { body: product('Gala Midi Dress', '120.00') },
        'https://brand.test/products/silk-blouse': { body: product('Silk Blouse', '80.00') },
        'https://brand.test/products/prairie-maxi-dress': { body: product('Prairie Maxi Dress', '150.00') },
      },
      calls,
    );

    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0 });
    expect(connector.id).toBe('jsonld:brand.test');
    expect(connector.kind).toBe('jsonld');

    const result = await connector.fetchListings(makeCtx());
    expect(result.stats.errors).toBe(0);
    // blouse fetched (matches URL pattern) but filtered by the dress heuristics
    expect(result.listings.map((l) => l.title).sort()).toEqual(['Gala Midi Dress', 'Prairie Maxi Dress']);
    expect(result.stats.fetched).toBe(2);
    // content sitemap was never fetched (product-named child preferred);
    // /pages/about-us never fetched (URL pattern)
    expect(calls).not.toContain('https://brand.test/sitemap_1-content.xml');
    expect(calls).not.toContain('https://brand.test/pages/about-us');
    const listing = result.listings.find((l) => l.title === 'Gala Midi Dress');
    expect(listing).toMatchObject({
      sourceId: 'jsonld:brand.test',
      sourceUrl: 'https://brand.test/products/gala-midi-dress',
      priceCents: 12000,
      currency: 'USD',
      condition: 'new',
    });
  });

  it('falls back to /sitemap.xml when robots.txt declares no (same-host) sitemap', async () => {
    const fetchImpl = makeFetch({
      'https://brand.test/robots.txt': { status: 404 },
      'https://brand.test/sitemap.xml': {
        body: '<urlset><url><loc>https://brand.test/products/tea-dress</loc></url></urlset>',
      },
      'https://brand.test/products/tea-dress': { body: product('Tea Dress', '90.00') },
    });
    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings).toHaveLength(1);
  });

  it('honors store.sitemapUrl override and gunzips raw-gzip sitemap bodies', async () => {
    const gz = new Uint8Array(
      gzipSync(Buffer.from('<urlset><url><loc>https://brand.test/products/gz-dress</loc></url></urlset>')),
    );
    const fetchImpl = makeFetch({
      'https://brand.test/robots.txt': { status: 404 },
      'https://brand.test/custom-map.xml.gz': { body: gz },
      'https://brand.test/products/gz-dress': { body: product('Gz Dress', '10.00') },
    });
    const connector = createJsonldConnector(
      { ...STORE, sitemapUrl: 'https://brand.test/custom-map.xml.gz' },
      { fetchImpl, minDelayMs: 0 },
    );
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings.map((l) => l.title)).toEqual(['Gz Dress']);
  });
});

describe('jsonld connector — cap & ordering', () => {
  it('caps pages per run, crawls dress-keyword URLs first, and LOGS the skips', async () => {
    const calls: string[] = [];
    const fetchImpl = makeFetch(
      {
        'https://brand.test/robots.txt': { body: 'Sitemap: https://brand.test/sitemap.xml\n' },
        'https://brand.test/sitemap.xml': { body: PRODUCT_SITEMAP },
        'https://brand.test/products/gala-midi-dress': { body: product('Gala Midi Dress', '120.00') },
        'https://brand.test/products/prairie-maxi-dress': { body: product('Prairie Maxi Dress', '150.00') },
        'https://brand.test/products/silk-blouse': { body: product('Silk Blouse', '80.00') },
      },
      calls,
    );
    const warns: string[] = [];
    const logger: Logger = {
      info: () => {},
      warn: (...a: unknown[]) => warns.push(a.map(String).join(' ')),
      error: () => {},
    };

    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0, maxProductPages: 2 });
    const result = await connector.fetchListings(makeCtx({ logger }));

    // both crawled pages are the dress-URL ones — the cap budget is not
    // wasted on silk-blouse even though it matches the product pattern
    expect(result.listings.map((l) => l.title).sort()).toEqual(['Gala Midi Dress', 'Prairie Maxi Dress']);
    expect(calls).not.toContain('https://brand.test/products/silk-blouse');
    expect(warns.some((w) => w.includes('SKIPPING 1'))).toBe(true);
  });

  it('orderProductUrls puts dress URLs first, stable within groups', () => {
    expect(
      orderProductUrls(['/p/a-top', '/p/b-dress', '/p/c-skirt', '/p/d-dress']),
    ).toEqual(['/p/b-dress', '/p/d-dress', '/p/a-top', '/p/c-skirt']);
  });

  it('orderProductUrls prefers fresher lastmod within a group (stale archive last)', () => {
    const lastmod = new Map([
      ['/p/old-dress', Date.parse('2025-01-01')],
      ['/p/new-dress', Date.parse('2026-07-01')],
      // /p/undated-dress has no lastmod → sorts after dated URLs
    ]);
    expect(
      orderProductUrls(['/p/old-dress', '/p/undated-dress', '/p/new-dress', '/p/a-top'], lastmod),
    ).toEqual(['/p/new-dress', '/p/old-dress', '/p/undated-dress', '/p/a-top']);
  });
});

describe('jsonld connector — politeness & robustness', () => {
  it('respects robots.txt Disallow for PDP paths and sitemaps', async () => {
    const calls: string[] = [];
    const robots = [
      'User-agent: *',
      'Disallow: /products/secret-dress',
      'Sitemap: https://brand.test/sitemap.xml',
    ].join('\n');
    const fetchImpl = makeFetch(
      {
        'https://brand.test/robots.txt': { body: robots },
        'https://brand.test/sitemap.xml': {
          body: `<urlset>
            <url><loc>https://brand.test/products/secret-dress</loc></url>
            <url><loc>https://brand.test/products/public-dress</loc></url>
          </urlset>`,
        },
        'https://brand.test/products/public-dress': { body: product('Public Dress', '60.00') },
      },
      calls,
    );
    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings.map((l) => l.title)).toEqual(['Public Dress']);
    expect(calls).not.toContain('https://brand.test/products/secret-dress');
  });

  it('sends If-None-Match and re-emits the stored listing on 304', async () => {
    const db = createIngestionTestDb();
    db.run(
      sql`INSERT INTO sources (id, kind, display_name, cadence_cron) VALUES ('jsonld:brand.test', 'jsonld', 'Brand', '30 6 * * *')`,
    );
    db.run(sql`
      INSERT INTO listings (id, source_id, source_listing_id, source_url, title, brand,
        price_cents, currency, condition, size_labels_json, availability_json,
        content_hash, first_seen_at, last_seen_at)
      VALUES ('jsonld:brand.test:tea-dress', 'jsonld:brand.test', 'tea-dress',
        'https://brand.test/products/tea-dress', 'Tea Dress', 'Brand',
        9000, 'USD', 'new', '["S"]', '{"S":true}', 'hash1', 1, 1)
    `);

    const etagCache = createMemoryEtagCache();
    await etagCache.set('https://brand.test/products/tea-dress', { etag: 'W/"t1"' });

    const fetchImpl = makeFetch({
      'https://brand.test/robots.txt': { status: 404 },
      'https://brand.test/sitemap.xml': {
        body: '<urlset><url><loc>https://brand.test/products/tea-dress</loc></url></urlset>',
      },
      'https://brand.test/products/tea-dress': {
        body: product('Tea Dress', '90.00'),
        headers: { etag: 'W/"t1"' },
      },
    });

    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx({ db, etagCache }));
    expect(result.stats.errors).toBe(0);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0]).toMatchObject({
      sourceListingId: 'tea-dress',
      title: 'Tea Dress',
      priceCents: 9000,
      sizeLabels: ['S'],
    });
    expect(result.listings[0].seenAt).toBeGreaterThan(1);
  });

  it('isolates per-PDP failures and keeps partial results', async () => {
    const fetchImpl = makeFetch({
      'https://brand.test/robots.txt': { status: 404 },
      'https://brand.test/sitemap.xml': {
        body: `<urlset>
          <url><loc>https://brand.test/products/bad-dress</loc></url>
          <url><loc>https://brand.test/products/good-dress</loc></url>
        </urlset>`,
      },
      'https://brand.test/products/bad-dress': { status: 500, body: 'oops' },
      'https://brand.test/products/good-dress': { body: product('Good Dress', '70.00') },
    });
    const connector = createJsonldConnector(STORE, { fetchImpl, minDelayMs: 0, retries: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings.map((l) => l.title)).toEqual(['Good Dress']);
    expect(result.stats.errors).toBe(1);
  });

  it('abandons a store after maxConsecutiveErrors (bot-block circuit breaker)', async () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://brand.test/products/dress-${i}`);
    const calls: string[] = [];
    const fetchImpl = makeFetch(
      {
        'https://brand.test/robots.txt': { status: 404 },
        'https://brand.test/sitemap.xml': {
          body: `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`,
        },
        ...Object.fromEntries(urls.map((u) => [u, { status: 403, body: 'blocked' }])),
      },
      calls,
    );
    const connector = createJsonldConnector(STORE, {
      fetchImpl,
      minDelayMs: 0,
      retries: 0,
      maxConsecutiveErrors: 3,
    });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings).toHaveLength(0);
    expect(result.stats.errors).toBe(3); // stopped at the breaker, not 6
    expect(calls.filter((c) => c.includes('/products/'))).toHaveLength(3);
  });

  it('skips crawling in mock mode (INGEST_ENABLE_JSONLD=false)', async () => {
    const fetchImpl = vi.fn();
    const connector = createJsonldConnector(STORE, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      minDelayMs: 0,
    });
    expect(connector.isConfigured({ INGEST_ENABLE_JSONLD: 'false' } as NodeJS.ProcessEnv)).toBe(false);
    expect(connector.isConfigured({} as NodeJS.ProcessEnv)).toBe(true);
    const result = await connector.fetchListings(makeCtx({ mockMode: true }));
    expect(result).toEqual({ listings: [], stats: { fetched: 0, errors: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('jsonld-stores.json', () => {
  it('every entry has a compilable productUrlPattern and unique domain', () => {
    const domains = new Set<string>();
    for (const s of jsonldStores) {
      expect(() => new RegExp(s.productUrlPattern, 'i')).not.toThrow();
      expect(domains.has(s.domain)).toBe(false);
      domains.add(s.domain);
    }
  });

  it('curates verified stores incl. the flagship, and keeps blockers unverified', () => {
    const verified = verifiedJsonldStores().map((s) => s.domain);
    expect(verified).toContain('thereformation.com');
    expect(verified.length).toBeGreaterThanOrEqual(4);
    for (const blocked of ['sezane.com', 'hellomolly.com', 'anthropologie.com', 'aritzia.com']) {
      expect(findJsonldStore(blocked)?.verified).toBe(false);
    }
    // every non-verified entry explains itself
    for (const s of jsonldStores.filter((x) => !x.verified)) {
      expect(s.notes, `${s.domain} needs a note`).toBeTruthy();
    }
  });

  it('verified patterns match the real PDP URLs captured live', () => {
    const cases: Record<string, string> = {
      'thereformation.com': 'https://www.thereformation.com/products/gene-dress/0103940.html',
      'lulus.com':
        'https://www.lulus.com/products/easy-on-the-eyes-cream-floral-print-off-the-shoulder-maxi-dress/497792.html',
      'madewell.com': 'https://www.madewell.com/p/womens/sale/dresses-skirts/ruched-high-low-slip-dress/NW045/',
      'whistles.com': 'https://www.whistles.com/product/anna-dress-38714.html',
      'forloveandlemons.com': 'https://forloveandlemons.com/products/adahlia-floral-midi-dress-cream',
    };
    for (const [domain, url] of Object.entries(cases)) {
      const store = findJsonldStore(domain);
      expect(store?.verified, domain).toBe(true);
      expect(new RegExp(store!.productUrlPattern, 'i').test(url), `${domain} pattern vs ${url}`).toBe(true);
    }
  });
});

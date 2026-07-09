/**
 * Stratified candidate cap (2026-07-09 monoculture fix): when more rows match
 * than the cap, `queryCandidates` fills the pool breadth-first across
 * (source, brand) strata instead of taking the 500 newest — a sequential
 * store crawl must not evict every other brand from the feed's pool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { listings, sources } from '../schema';
import { CANDIDATE_CAP, queryCandidates } from './listings';

let tmpDir: string;
let db: Db;

const NOW = Date.now();
const HOUR = 3_600_000;

function addSource(id: string) {
  db.insert(sources)
    .values({ id, kind: 'shopify', displayName: id, cadenceCron: '0 6 * * *' })
    .run();
}

function addListing(
  id: string,
  opts: {
    sourceId: string;
    brand: string | null;
    lastSeenAt: number;
    priceCents?: number;
    sizes?: number[];
  },
) {
  db.insert(listings)
    .values({
      id,
      sourceId: opts.sourceId,
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title: `Dress ${id}`,
      brand: opts.brand,
      priceCents: opts.priceCents ?? 15000,
      sizeNormalizedJson: JSON.stringify(opts.sizes ?? [8]),
      contentHash: `hash-${id}`,
      firstSeenAt: opts.lastSeenAt - 24 * HOUR,
      lastSeenAt: opts.lastSeenAt,
    })
    .run();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-strat-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  for (const s of ['shopify:a.com', 'shopify:b.com', 'shopify:c.com', 'shopify:d.com']) {
    addSource(s);
  }
  // Sequential-crawl shape: brand A landed 600 listings in the last hour;
  // B/C/D were crawled earlier (but inside the 48h shopify window).
  for (let i = 0; i < 600; i++) {
    addListing(`a${i}`, {
      sourceId: 'shopify:a.com',
      brand: 'Brand A',
      lastSeenAt: NOW - HOUR + i * 1000,
      // every 3rd A listing is out of the test budget / in another size
      priceCents: i % 3 === 0 ? 90_000 : 15_000,
      sizes: i % 3 === 0 ? [2] : [8],
    });
  }
  const bases: Array<[string, string, number]> = [
    ['b', 'Brand B', NOW - 10 * HOUR],
    ['c', 'Brand C', NOW - 20 * HOUR],
    ['d', 'Brand D', NOW - 30 * HOUR],
  ];
  for (const [p, brand, base] of bases) {
    for (let i = 0; i < 30; i++) {
      addListing(`${p}${i}`, {
        sourceId: `shopify:${p}.com`,
        brand,
        lastSeenAt: base + i * 1000,
      });
    }
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queryCandidates — stratified cap', () => {
  it('minority brands survive a dominant fresh crawl (690 match → 500 pool has all 4 brands)', () => {
    const result = queryCandidates(db, {});
    expect(result).toHaveLength(CANDIDATE_CAP);
    const byBrand = new Map<string, number>();
    for (const c of result) {
      byBrand.set(c.listing.brand ?? '?', (byBrand.get(c.listing.brand ?? '?') ?? 0) + 1);
    }
    expect(byBrand.get('Brand B')).toBe(30);
    expect(byBrand.get('Brand C')).toBe(30);
    expect(byBrand.get('Brand D')).toBe(30);
    expect(byBrand.get('Brand A')).toBe(CANDIDATE_CAP - 90);
  });

  it('within the dominant stratum, the freshest listings survive', () => {
    const result = queryCandidates(db, {});
    const aTimes = result
      .filter((c) => c.listing.brand === 'Brand A')
      .map((c) => c.listing.lastSeenAt);
    // 600 A listings at NOW-1h + i·1s; only the 410 newest survive
    expect(Math.min(...aTimes)).toBe(NOW - HOUR + (600 - (CANDIDATE_CAP - 90)) * 1000);
  });

  it('returned order stays newest-first (caller ordering contract unchanged)', () => {
    const result = queryCandidates(db, {});
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].listing.lastSeenAt).toBeGreaterThanOrEqual(
        result[i].listing.lastSeenAt,
      );
    }
  });

  it('respects size/budget hard filters AND the cap together', () => {
    const result = queryCandidates(db, {
      sizesNormalized: [8],
      priceMaxCents: 20_000,
      cap: 300,
    });
    expect(result).toHaveLength(300);
    expect(result.every((c) => c.listing.priceCents <= 20_000)).toBe(true);
    // 400 in-budget A + 90 B/C/D → stratified 300 keeps all four brands
    const brands = new Set(result.map((c) => c.listing.brand));
    expect(brands).toEqual(new Set(['Brand A', 'Brand B', 'Brand C', 'Brand D']));
  });

  it('explicit brand filter is unaffected: plain newest-first within the brand', () => {
    const result = queryCandidates(db, { brands: ['Brand A'], cap: 100 });
    expect(result).toHaveLength(100);
    expect(result.every((c) => c.listing.brand === 'Brand A')).toBe(true);
    // single stratum → identical to plain newest-100
    expect(result[0].listing.id).toBe('a599');
    expect(result[99].listing.id).toBe('a500');
  });

  it('under the cap: every matching row returned, stratification changes nothing', () => {
    const result = queryCandidates(db, { brands: ['Brand B', 'Brand C'] });
    expect(result).toHaveLength(60);
  });
});

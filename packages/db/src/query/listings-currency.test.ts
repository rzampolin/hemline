/**
 * Currency handling in the SQL query layer (QA P1 #3, 2026-07-08): budget
 * filtering and the price facet operate on USD-cent equivalents computed from
 * the static FX table (contracts/fx.ts); native prices stay untouched for
 * display.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../client';
import { ensureSchema } from '../ddl';
import { listings, sources } from '../schema';
import { metaFilters, queryCandidates } from './listings';

let tmpDir: string;
let db: Db;

function addListing(id: string, priceCents: number, currency: string) {
  db.insert(listings)
    .values({
      id,
      sourceId: 'fixture:test',
      sourceListingId: id,
      sourceUrl: `https://example.com/${id}`,
      title: `Dress ${id}`,
      priceCents,
      currency,
      contentHash: `hash-${id}`,
      firstSeenAt: Date.now() - 86_400_000,
      lastSeenAt: Date.now(),
    })
    .run();
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-fx-test-'));
  db = createDb({ dbPath: path.join(tmpDir, 'test.db') });
  ensureSchema(db);
  db.insert(sources)
    .values({ id: 'fixture:test', kind: 'fixture', displayName: 'Test', cadenceCron: '0 6 * * *' })
    .run();
  addListing('usd-100', 10000, 'USD'); // $100.00
  addListing('gbp-129', 12900, 'GBP'); // £129.00 → 16383 USD cents at 1.27
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('queryCandidates — USD-equivalent budget filter', () => {
  const ids = (opts: Parameters<typeof queryCandidates>[1]) =>
    queryCandidates(db, opts)
      .map((c) => c.listing.id)
      .sort();

  it('excludes a GBP listing whose USD equivalent exceeds the budget', () => {
    // raw pence (12900) would slip under a $150 budget; 16383 USD¢ must not
    expect(ids({ priceMaxCents: 15000 })).toEqual(['usd-100']);
  });

  it('includes the GBP listing once the USD budget covers its equivalent', () => {
    expect(ids({ priceMaxCents: 16383 })).toEqual(['gbp-129', 'usd-100']);
    expect(ids({ priceMaxCents: 16382 })).toEqual(['usd-100']);
  });

  it('applies the same conversion to the minimum bound', () => {
    expect(ids({ priceMinCents: 16000 })).toEqual(['gbp-129']);
  });

  it('leaves the native price untouched on the returned listing (display)', () => {
    const gbp = queryCandidates(db, { priceMinCents: 16000 })[0];
    expect(gbp.listing.priceCents).toBe(12900);
    expect(gbp.listing.currency).toBe('GBP');
  });
});

describe('metaFilters — price facet in USD equivalents', () => {
  it('priceRange spans USD-converted min/max', () => {
    const { priceRange } = metaFilters(db);
    expect(priceRange).toEqual([10000, 16383]);
  });
});

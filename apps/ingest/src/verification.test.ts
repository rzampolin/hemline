/**
 * Sold-detection verification worker tests — mocked fetch only (no live
 * crawling): outcome matrix per source kind (gone / sold-out / size-gone /
 * fine / transient), clickout-queue semantics, and rolling batch selection.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetPoliteness } from '@hemline/connectors';
import {
  createDb,
  dequeueVerification,
  enqueueVerification,
  ensureSchema,
  listings,
  normalizeSizeLabels,
  peekVerificationQueue,
  selectOldestVerifiedActive,
  sources,
  verificationQueue,
  verificationQueueSize,
  type Db,
} from '@hemline/db';
import { drainVerificationQueue, shopifyProductUrl, verifyListings } from './verification';

// ── harness ───────────────────────────────────────────────────────────────

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hemline-verify-test-'));
  db = createDb({ dbPath: path.join(dir, 'test.db') });
  ensureSchema(db);
  resetPoliteness();
  db.insert(sources)
    .values([
      { id: 'shopify:test-store.com', kind: 'shopify', displayName: 'Test Store', cadenceCron: '0 6 * * *' },
      { id: 'jsonld:thereformation.com', kind: 'jsonld', displayName: 'Reformation', cadenceCron: '30 6 * * *' },
      { id: 'ebay', kind: 'ebay', displayName: 'eBay', cadenceCron: '0 */6 * * *' },
    ])
    .run();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

interface ListingOverrides {
  id?: string;
  sourceId?: string;
  sourceUrl?: string;
  sizeLabels?: string[];
  availability?: Record<string, boolean>;
  lastSeenAt?: number;
  verifiedAt?: number | null;
  removedAt?: number | null;
}

function insertListing(over: ListingOverrides = {}): string {
  const id = over.id ?? 'shopify:test-store.com:1001';
  const sizeLabels = over.sizeLabels ?? ['S', 'M'];
  db.insert(listings)
    .values({
      id,
      sourceId: over.sourceId ?? 'shopify:test-store.com',
      sourceListingId: id.split(':').pop()!,
      sourceUrl: over.sourceUrl ?? 'https://test-store.com/products/silk-midi-dress',
      title: 'Silk Midi Dress',
      priceCents: 12800,
      currency: 'USD',
      sizeLabelsJson: JSON.stringify(sizeLabels),
      sizeNormalizedJson: JSON.stringify(normalizeSizeLabels(sizeLabels)),
      availabilityJson: JSON.stringify(over.availability ?? { S: true, M: true }),
      contentHash: `hash-${id}`,
      firstSeenAt: 1_000,
      lastSeenAt: over.lastSeenAt ?? 1_000,
      verifiedAt: over.verifiedAt ?? null,
      removedAt: over.removedAt ?? null,
    })
    .run();
  return id;
}

function row(id: string) {
  return db.select().from(listings).where(eq(listings.id, id)).get()!;
}

/** url → response factory; unknown urls throw (network error) */
function fetchStub(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const make = routes[url];
    if (!make) throw new Error(`unexpected fetch: ${url}`);
    return make();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/html' } });

const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, minDelayMs: 0, retries: 0 });

/** bare product payload — the `.js` storefront endpoint shape */
function shopifyProduct(variants: Array<Record<string, unknown>>) {
  return {
    id: 1001,
    title: 'Silk Midi Dress',
    handle: 'silk-midi-dress',
    options: [{ name: 'Size', position: 1 }],
    variants,
  };
}

const SHOPIFY_JS_URL = 'https://test-store.com/products/silk-midi-dress.js';
const SHOPIFY_JSON_URL = 'https://test-store.com/products/silk-midi-dress.json';

// ── shopify signal ────────────────────────────────────────────────────────

describe('verifyListings — shopify', () => {
  it('builds the single-product url from the PDP url', () => {
    expect(shopifyProductUrl('https://s.com/products/a-dress', '.js')).toBe('https://s.com/products/a-dress.js');
    expect(shopifyProductUrl('https://s.com/products/a-dress/?variant=1#x', '.json')).toBe('https://s.com/products/a-dress.json');
  });

  it('404 on .js AND .json → gone: removed_at set (existing soft-delete semantics)', async () => {
    const id = insertListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json({}, 404),
      [SHOPIFY_JSON_URL]: () => json({}, 404),
    })));
    expect(results).toEqual([{ listingId: id, outcome: 'gone', note: 'http_404' }]);
    expect(row(id).removedAt).not.toBeNull();
  });

  it('404 on .js but .json alive → NOT gone (falls back to the weaker signal)', async () => {
    const id = insertListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json({}, 404),
      // .json mirror serves the product but omits `available` (live-verified shape)
      [SHOPIFY_JSON_URL]: () => json({ product: shopifyProduct([
        { id: 1, title: 'S', option1: 'S', price: '128.00' },
      ]) }),
    })));
    expect(results[0]).toMatchObject({ outcome: 'ok', note: 'no_stock_signal' });
    expect(row(id).removedAt).toBeNull();
    expect(row(id).verifiedAt).not.toBeNull();
  });

  it('all variants explicitly unavailable → sold_out: removed_at set', async () => {
    const id = insertListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json(shopifyProduct([
        { id: 1, title: 'S', option1: 'S', available: false, price: '128.00' },
        { id: 2, title: 'M', option1: 'M', available: false, price: '128.00' },
      ])),
    })));
    expect(results[0].outcome).toBe('sold_out');
    expect(row(id).removedAt).not.toBeNull();
  });

  it('one size gone → availability + size_normalized narrowed to in-stock labels', async () => {
    const id = insertListing({ sizeLabels: ['S', 'M'], availability: { S: true, M: true } });
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json(shopifyProduct([
        { id: 1, title: 'S', option1: 'S', available: true, price: '128.00' },
        { id: 2, title: 'M', option1: 'M', available: false, price: '128.00' },
      ])),
    })));
    expect(results[0].outcome).toBe('availability_updated');
    const r = row(id);
    expect(JSON.parse(r.availabilityJson)).toEqual({ S: true, M: false });
    expect(JSON.parse(r.sizeNormalizedJson)).toEqual(normalizeSizeLabels(['S']));
    // raw labels untouched — they feed content_hash
    expect(JSON.parse(r.sizeLabelsJson)).toEqual(['S', 'M']);
    expect(r.removedAt).toBeNull();
    expect(r.verifiedAt).not.toBeNull();
  });

  it('verified fine → verified_at bumped, nothing else changes', async () => {
    const id = insertListing();
    const before = row(id);
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json(shopifyProduct([
        { id: 1, title: 'S', option1: 'S', available: true, price: '128.00' },
        { id: 2, title: 'M', option1: 'M', available: true, price: '128.00' },
      ])),
    })), );
    expect(results[0].outcome).toBe('ok');
    const r = row(id);
    expect(r.verifiedAt).not.toBeNull();
    expect(r.removedAt).toBeNull();
    expect(r.availabilityJson).toBe(before.availabilityJson);
    expect(r.lastSeenAt).toBe(before.lastSeenAt); // verified_at ≠ last_seen_at
  });

  it('payload without explicit available flags NEVER infers sold (alive-only signal)', async () => {
    const id = insertListing({ availability: { S: true, M: false } });
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json(shopifyProduct([
        { id: 1, title: 'S', option1: 'S', price: '128.00' },
      ])),
    })));
    expect(results[0]).toMatchObject({ outcome: 'ok', note: 'no_stock_signal' });
    const r = row(id);
    expect(r.removedAt).toBeNull();
    expect(JSON.parse(r.availabilityJson)).toEqual({ S: true, M: false }); // untouched
  });

  it('transient network error → inconclusive, NO state change (timeout ≠ sold)', async () => {
    const id = insertListing();
    const results = await verifyListings(db, [id], deps(fetchStub({}))); // every fetch throws
    expect(results[0].outcome).toBe('inconclusive');
    const r = row(id);
    expect(r.removedAt).toBeNull();
    expect(r.verifiedAt).toBeNull();
  });

  it('5xx → inconclusive, NO state change', async () => {
    const id = insertListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [SHOPIFY_JS_URL]: () => json({ error: 'boom' }, 503),
    })));
    expect(results[0]).toMatchObject({ outcome: 'inconclusive', note: 'http_503' });
    expect(row(id).removedAt).toBeNull();
    expect(row(id).verifiedAt).toBeNull();
  });

  it('per-host circuit breaker abandons a failing host within the run', async () => {
    const ids = [1, 2, 3, 4].map((n) =>
      insertListing({
        id: `shopify:test-store.com:${n}`,
        sourceUrl: `https://test-store.com/products/dress-${n}`,
      }),
    );
    const results = await verifyListings(db, ids, deps(fetchStub({}))); // all fetches throw
    expect(results.map((r) => r.outcome)).toEqual(new Array(4).fill('inconclusive'));
    expect(results[3].note).toBe('host_circuit_open'); // 4th never fetched
  });
});

// ── jsonld signal ─────────────────────────────────────────────────────────

const PDP_URL = 'https://www.thereformation.com/products/juliette-silk-dress/1309.html';

function jsonldPdp(offers: Array<{ size?: string; availability: string; price?: string }>): string {
  const offerJson = offers.map((o) => ({
    '@type': 'Offer',
    ...(o.price ? { price: o.price, priceCurrency: 'USD' } : {}),
    ...(o.size ? { size: o.size } : {}),
    availability: o.availability,
  }));
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Juliette Silk Dress',
    brand: 'Reformation',
    image: 'https://cdn.example.com/juliette.jpg',
    offers: offerJson,
  })}</script></head><body></body></html>`;
}

function jsonldListing(over: ListingOverrides = {}): string {
  return insertListing({
    id: 'jsonld:thereformation.com:1309',
    sourceId: 'jsonld:thereformation.com',
    sourceUrl: PDP_URL,
    sizeLabels: ['4', '8'],
    availability: { 4: true, 8: true },
    ...over,
  });
}

describe('verifyListings — jsonld', () => {
  it('404 PDP → gone', async () => {
    const id = jsonldListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [PDP_URL]: () => html('not found', 404),
    })));
    expect(results[0].outcome).toBe('gone');
    expect(row(id).removedAt).not.toBeNull();
  });

  it('every sized offer OutOfStock → sold_out', async () => {
    const id = jsonldListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [PDP_URL]: () => html(jsonldPdp([
        { size: '4', availability: 'https://schema.org/OutOfStock', price: '248.00' },
        { size: '8', availability: 'https://schema.org/OutOfStock', price: '248.00' },
      ])),
    })));
    expect(results[0].outcome).toBe('sold_out');
    expect(row(id).removedAt).not.toBeNull();
  });

  it('one size gone → availability + size_normalized updated from JSON-LD offers', async () => {
    const id = jsonldListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [PDP_URL]: () => html(jsonldPdp([
        { size: '4', availability: 'https://schema.org/InStock', price: '248.00' },
        { size: '8', availability: 'https://schema.org/OutOfStock', price: '248.00' },
      ])),
    })));
    expect(results[0].outcome).toBe('availability_updated');
    const r = row(id);
    expect(JSON.parse(r.availabilityJson)).toEqual({ 4: true, 8: false });
    expect(JSON.parse(r.sizeNormalizedJson)).toEqual(normalizeSizeLabels(['4']));
    expect(r.removedAt).toBeNull();
  });

  it('archived PDP (Product kept, price dropped, explicit OutOfStock) → sold_out', async () => {
    // decisions-data-eng #16: archived/sold-out products collapse to a single
    // sizeless OutOfStock offer with no price — extractListingFromHtml yields
    // no listing, but the explicit availability signal is trusted.
    const id = jsonldListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [PDP_URL]: () => html(jsonldPdp([{ availability: 'https://schema.org/OutOfStock' }])),
    })));
    expect(results[0].outcome).toBe('sold_out');
    expect(row(id).removedAt).not.toBeNull();
  });

  it('page with no structured product data → inconclusive, NO state change', async () => {
    const id = jsonldListing();
    const results = await verifyListings(db, [id], deps(fetchStub({
      [PDP_URL]: () => html('<html><body>window.__APP__ renders here</body></html>'),
    })));
    expect(results[0].outcome).toBe('inconclusive');
    const r = row(id);
    expect(r.removedAt).toBeNull();
    expect(r.verifiedAt).toBeNull();
  });
});

// ── unsupported kinds / guard rails ───────────────────────────────────────

describe('verifyListings — guard rails', () => {
  it('eBay listings are unsupported (never marked)', async () => {
    const id = insertListing({
      id: 'ebay:123',
      sourceId: 'ebay',
      sourceUrl: 'https://www.ebay.com/itm/123',
    });
    const results = await verifyListings(db, [id], deps(fetchStub({})));
    expect(results[0].outcome).toBe('unsupported');
    expect(row(id).removedAt).toBeNull();
  });

  it('unknown / already-removed listings change nothing', async () => {
    const removed = insertListing({ removedAt: 42 });
    const results = await verifyListings(db, [removed, 'shopify:test-store.com:nope'], deps(fetchStub({})));
    expect(results[0]).toMatchObject({ outcome: 'ok', note: 'already_removed' });
    expect(results[1]).toMatchObject({ outcome: 'unsupported', note: 'unknown_listing' });
    expect(row(removed).removedAt).toBe(42);
  });
});

// ── clickout queue ────────────────────────────────────────────────────────

describe('verification queue', () => {
  it('enqueues verifiable listings once (repeat clicks dedupe)', () => {
    const id = insertListing();
    expect(enqueueVerification(db, id, 'clickout', 100)).toBe(true);
    expect(enqueueVerification(db, id, 'clickout', 200)).toBe(false); // dedupe
    const queued = peekVerificationQueue(db, 10);
    expect(queued).toEqual([{ listingId: id, reason: 'clickout', enqueuedAt: 100 }]);
  });

  it('refuses removed listings, unverifiable kinds, and unknown ids', () => {
    const removed = insertListing({ removedAt: 42 });
    const ebayId = insertListing({ id: 'ebay:9', sourceId: 'ebay', sourceUrl: 'https://ebay.com/itm/9' });
    expect(enqueueVerification(db, removed, 'clickout')).toBe(false);
    expect(enqueueVerification(db, ebayId, 'clickout')).toBe(false);
    expect(enqueueVerification(db, 'shopify:test-store.com:nope', 'clickout')).toBe(false);
    expect(verificationQueueSize(db)).toBe(0);
  });

  it('drainVerificationQueue verifies queued listings and clears entries (any outcome)', async () => {
    const sold = insertListing({ id: 'shopify:test-store.com:1', sourceUrl: 'https://test-store.com/products/d1' });
    const flaky = insertListing({ id: 'shopify:test-store.com:2', sourceUrl: 'https://other-store.com/products/d2' });
    enqueueVerification(db, sold, 'clickout', 100);
    enqueueVerification(db, flaky, 'clickout', 200);

    const results = await drainVerificationQueue(db, 10, deps(fetchStub({
      'https://test-store.com/products/d1.js': () => json({}, 404),
      'https://test-store.com/products/d1.json': () => json({}, 404),
      // other-store.com throws → transient
    })));

    expect(results.find((r) => r.listingId === sold)?.outcome).toBe('gone');
    expect(results.find((r) => r.listingId === flaky)?.outcome).toBe('inconclusive');
    expect(verificationQueueSize(db)).toBe(0); // inconclusive retried by rolling sweep, not the queue
    expect(row(sold).removedAt).not.toBeNull();
    expect(row(flaky).removedAt).toBeNull();
  });

  it('respects the batch limit, oldest first', async () => {
    const a = insertListing({ id: 'shopify:test-store.com:a', sourceUrl: 'https://test-store.com/products/a' });
    const b = insertListing({ id: 'shopify:test-store.com:b', sourceUrl: 'https://test-store.com/products/b' });
    enqueueVerification(db, b, 'clickout', 200);
    enqueueVerification(db, a, 'clickout', 100);
    const results = await drainVerificationQueue(db, 1, deps(fetchStub({
      'https://test-store.com/products/a.js': () => json({}, 404),
      'https://test-store.com/products/a.json': () => json({}, 404),
    })));
    expect(results.map((r) => r.listingId)).toEqual([a]); // enqueued earliest
    expect(peekVerificationQueue(db, 10).map((q) => q.listingId)).toEqual([b]);
  });

  it('dequeueVerification removes explicit entries', () => {
    const id = insertListing();
    enqueueVerification(db, id, 'manual');
    dequeueVerification(db, [id]);
    expect(verificationQueueSize(db)).toBe(0);
    expect(db.select().from(verificationQueue).all()).toEqual([]);
  });
});

// ── rolling batch selection ───────────────────────────────────────────────

describe('selectOldestVerifiedActive', () => {
  it('orders never-verified first (by last_seen_at), then oldest verified_at; skips removed + unverifiable', () => {
    insertListing({ id: 'shopify:test-store.com:v-old', verifiedAt: 1_000, lastSeenAt: 10 });
    insertListing({ id: 'shopify:test-store.com:v-new', verifiedAt: 2_000, lastSeenAt: 10 });
    insertListing({ id: 'shopify:test-store.com:never-b', verifiedAt: null, lastSeenAt: 20 });
    insertListing({ id: 'shopify:test-store.com:never-a', verifiedAt: null, lastSeenAt: 5 });
    insertListing({ id: 'shopify:test-store.com:removed', verifiedAt: null, removedAt: 42 });
    insertListing({ id: 'ebay:77', sourceId: 'ebay', sourceUrl: 'https://ebay.com/itm/77' });
    insertListing({
      id: 'jsonld:thereformation.com:9',
      sourceId: 'jsonld:thereformation.com',
      sourceUrl: PDP_URL,
      verifiedAt: 500,
    });

    expect(selectOldestVerifiedActive(db, 10)).toEqual([
      'shopify:test-store.com:never-a',
      'shopify:test-store.com:never-b',
      'jsonld:thereformation.com:9',
      'shopify:test-store.com:v-old',
      'shopify:test-store.com:v-new',
    ]);
    expect(selectOldestVerifiedActive(db, 2)).toEqual([
      'shopify:test-store.com:never-a',
      'shopify:test-store.com:never-b',
    ]);
  });
});

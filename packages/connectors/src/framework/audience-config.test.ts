/**
 * Per-store audience escape hatches (kids-in-catalog founder bug, 2026-07-09):
 * Shopify `kidsCollections` (collection-membership exclusion — the Dôen case)
 * and JSON-LD `excludeUrlPatterns` (URL-path exclusion), both fail-OPEN.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchContext, Logger } from '@hemline/contracts';
import { createMemoryEtagCache } from './etag-cache';
import { resetPoliteness } from './politeness';
import { createIngestionTestDb } from '../test-helpers';
import {
  createShopifyConnector,
  fetchKidsCollectionIds,
  findShopifyStore,
  type ShopifyProduct,
} from '../shopify/index';
import { createJsonldConnector, type JsonldStoreInfo } from '../jsonld/index';

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

function makeCtx(overrides: Partial<FetchContext> = {}): FetchContext {
  return {
    db: createIngestionTestDb(),
    etagCache: createMemoryEtagCache(),
    logger: silentLogger,
    mockMode: false,
    ...overrides,
  };
}

function shopifyProduct(id: number, title: string): ShopifyProduct {
  return {
    id,
    title,
    handle: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    product_type: 'Dresses',
    variants: [
      { id: id * 10, title: '4', option1: '4', option2: null, option3: null, price: '138.00', available: true },
    ],
    options: [{ name: 'Size', position: 1, values: ['4'] }],
    images: [{ src: `https://cdn.test/${id}.jpg`, position: 1 }],
  };
}

beforeEach(() => resetPoliteness());

describe('shopify kidsCollections exclusion', () => {
  const routes = (kids: { id: number }[], all: ShopifyProduct[]) => {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return new Response('User-agent: *\n', { status: 200 });
      if (u.includes('/collections/kids/products.json')) {
        return new Response(JSON.stringify({ products: kids }), { status: 200 });
      }
      if (u.includes('/products.json')) {
        return new Response(JSON.stringify({ products: all }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  };

  it('fetchKidsCollectionIds collects ids across the collection', async () => {
    const fetchImpl = routes([{ id: 1 }, { id: 2 }], []);
    const ids = await fetchKidsCollectionIds(
      'https://doen.test',
      ['kids'],
      { fetchImpl, minDelayMs: 0 },
      silentLogger,
    );
    expect([...ids].sort()).toEqual([1, 2]);
  });

  it('fail-open: an unreachable collection excludes nothing', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/collections/')) return new Response('nope', { status: 403 });
      return new Response('User-agent: *\n', { status: 200 });
    }) as unknown as typeof fetch;
    const ids = await fetchKidsCollectionIds(
      'https://doen.test',
      ['kids'],
      { fetchImpl, minDelayMs: 0 },
      silentLogger,
    );
    expect(ids.size).toBe(0);
  });

  it('the connector drops kids-collection members even when their metadata reads adult (Dôen case)', async () => {
    // LUCY (id 7): adult-looking product_type/sizes — only collection membership flags it
    const lucy = shopifyProduct(7, 'LUCY DRESS AMBLE PLAID');
    const adult = shopifyProduct(8, 'ISCHIA MIDI DRESS');
    const fetchImpl = routes([{ id: 7 }], [lucy, adult]);
    const connector = createShopifyConnector(
      { domain: 'doen.test', displayName: 'Dôen', kidsCollections: ['kids'] },
      { fetchImpl, minDelayMs: 0 },
    );
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings.map((l) => l.title)).toEqual(['ISCHIA MIDI DRESS']);
    expect(result.stats.errors).toBe(0);
  });

  it('shopdoen.com ships the kidsCollections config', () => {
    expect(findShopifyStore('shopdoen.com')?.kidsCollections).toEqual(['kids']);
  });
});

describe('jsonld excludeUrlPatterns exclusion', () => {
  it('skips matching product URLs before crawling them', async () => {
    const product = (name: string) =>
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name,
        offers: { '@type': 'Offer', price: '120.00', priceCurrency: 'USD' },
      })}</script></head></html>`;
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/robots.txt')) return new Response('', { status: 404 });
      if (u.endsWith('/sitemap.xml')) {
        return new Response(
          `<urlset>
            <url><loc>https://brand.test/products/gala-midi-dress</loc></url>
            <url><loc>https://brand.test/products/kids/twirl-dress</loc></url>
          </urlset>`,
          { status: 200 },
        );
      }
      if (u.includes('gala-midi-dress')) return new Response(product('Gala Midi Dress'), { status: 200 });
      if (u.includes('twirl-dress')) return new Response(product('Twirl Dress'), { status: 200 });
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    const store: JsonldStoreInfo = {
      domain: 'brand.test',
      displayName: 'Brand',
      productUrlPattern: 'brand\\.test/products/',
      excludeUrlPatterns: ['/products/kids/'],
    };
    const connector = createJsonldConnector(store, { fetchImpl, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings.map((l) => l.title)).toEqual(['Gala Midi Dress']);
    expect(calls).not.toContain('https://brand.test/products/kids/twirl-dress');
  });
});

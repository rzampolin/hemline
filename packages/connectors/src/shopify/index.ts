/**
 * Shopify products.json crawler — docs/ARCHITECTURE.md §8.
 *
 * - paginates https://{store}/products.json?limit=250&page=N until a short page
 * - dresses only (product_type/tags/title heuristics — normalize.ts)
 * - politeness: SolineBot UA, per-host delay (politeFetch), robots.txt gate
 * - ETag/If-None-Match on page 1 via the EtagCache contract; a 304 short-
 *   circuits the crawl and re-emits the source's existing listings so
 *   last_seen_at still bumps
 * - per-store error isolation: fetchListings never throws; errors are counted
 *   in stats and partial results are returned
 */
import type {
  FetchContext,
  FetchResult,
  Logger,
  RawListing,
  SourceConnector,
} from '@hemline/contracts';
import { createMemoryEtagCache } from '../framework/etag-cache';
import { loadExistingRawListings } from '../framework/existing-listings';
import { politeFetch, type PolitenessOptions } from '../framework/politeness';
import { createRobotsGate, type RobotsGate } from '../framework/robots';
import {
  normalizeShopifyProduct,
  type ShopifyProduct,
  type ShopifyStoreInfo,
} from './normalize';
import storesJson from './stores.json';

export * from './normalize';

export interface ShopifyStore extends ShopifyStoreInfo {
  /** products.json probed live and confirmed open (see stores.json / decisions doc) */
  verified: boolean;
  note?: string;
}

export const shopifyStores: ShopifyStore[] = storesJson as ShopifyStore[];

/** Stores the default ingest run crawls (probed live, products.json open). */
export function verifiedShopifyStores(): ShopifyStore[] {
  return shopifyStores.filter((s) => s.verified);
}

export function findShopifyStore(domain: string): ShopifyStore | undefined {
  return shopifyStores.find((s) => s.domain === domain);
}

export interface ShopifyConnectorOptions extends PolitenessOptions {
  /** hard cap on pages per store (default 40 → 10k products) */
  maxPages?: number;
}

const PAGE_SIZE = 250;

/**
 * Product ids of a store's configured kids collections (ShopifyStoreInfo
 * .kidsCollections), fetched via `/collections/{handle}/products.json` —
 * the authoritative signal for stores whose kids-line items carry NO textual
 * metadata (live-probed 2026-07-09: shopdoen.com /collections/kids). Fail-OPEN:
 * an unreachable collection logs a warning and excludes nothing (the audience
 * keyword/size heuristics and the extraction-level audience field still apply).
 */
export async function fetchKidsCollectionIds(
  origin: string,
  handles: string[],
  opts: PolitenessOptions,
  log: Logger,
  maxPagesPerCollection = 4,
): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const handle of handles) {
    for (let page = 1; page <= maxPagesPerCollection; page++) {
      const url = `${origin}/collections/${encodeURIComponent(handle)}/products.json?limit=${PAGE_SIZE}&page=${page}`;
      try {
        const res = await politeFetch(url, { headers: { accept: 'application/json' } }, opts);
        if (!res.ok) {
          log.warn(`[shopify] kids collection '${handle}' → HTTP ${res.status} — excluding nothing from it`);
          break;
        }
        const body = (await res.json()) as { products?: Array<{ id?: number }> };
        const products = Array.isArray(body.products) ? body.products : [];
        for (const p of products) if (typeof p.id === 'number') ids.add(p.id);
        if (products.length < PAGE_SIZE) break;
      } catch (e) {
        log.warn(`[shopify] kids collection '${handle}' fetch failed — excluding nothing from it`, e);
        break;
      }
    }
  }
  return ids;
}

export function createShopifyConnector(
  store: ShopifyStoreInfo,
  opts: ShopifyConnectorOptions = {},
): SourceConnector {
  const maxPages = opts.maxPages ?? 40;
  let robotsGate: RobotsGate | null = null;

  return {
    id: `shopify:${store.domain}`,
    kind: 'shopify',
    defaultCadence: '0 6 * * *', // max 1/day/store
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      // No credentials needed, but crawling can be disabled in dev.
      return env.INGEST_ENABLE_SHOPIFY !== 'false';
    },
    async fetchListings(ctx: FetchContext): Promise<FetchResult> {
      const sourceId = `shopify:${store.domain}`;
      const log = ctx.logger;

      if (ctx.mockMode) {
        log.info(`[shopify:${store.domain}] crawling disabled (INGEST_ENABLE_SHOPIFY=false) — skipping`);
        return { listings: [], stats: { fetched: 0, errors: 0 } };
      }

      const origin = `https://${store.domain}`;
      robotsGate ??= createRobotsGate(opts);
      try {
        if (!(await robotsGate.isAllowed(origin, '/products.json'))) {
          log.warn(`[shopify:${store.domain}] robots.txt disallows /products.json — skipping store`);
          return { listings: [], stats: { fetched: 0, errors: 0 } };
        }
      } catch (e) {
        log.warn(`[shopify:${store.domain}] robots.txt check failed, proceeding`, e);
      }

      // kids-line exclusion set (curated stores.json kidsCollections; Dôen case)
      let kidsIds = new Set<number>();
      if (store.kidsCollections && store.kidsCollections.length > 0) {
        kidsIds = await fetchKidsCollectionIds(origin, store.kidsCollections, opts, log);
        log.info(
          `[shopify:${store.domain}] kids-collection exclusion: ${kidsIds.size} product id(s) from [${store.kidsCollections.join(', ')}]`,
        );
      }

      const etagCache = ctx.etagCache ?? createMemoryEtagCache();
      const listings: RawListing[] = [];
      const seen = new Set<string>();
      let errors = 0;
      let kidsSkipped = 0;

      for (let page = 1; page <= maxPages; page++) {
        const url = `${origin}/products.json?limit=${PAGE_SIZE}&page=${page}`;
        try {
          const headers: Record<string, string> = { accept: 'application/json' };
          if (page === 1) {
            const cached = await etagCache.get(url);
            if (cached?.etag) headers['if-none-match'] = cached.etag;
            if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;
          }

          const res = await politeFetch(url, { headers }, opts);

          if (res.status === 304 && page === 1) {
            const existing = loadExistingRawListings(ctx.db, sourceId, Date.now());
            log.info(
              `[shopify:${store.domain}] 304 Not Modified — re-emitting ${existing.length} known listings`,
            );
            return { listings: existing, stats: { fetched: existing.length, errors: 0 } };
          }
          if (!res.ok) {
            log.warn(`[shopify:${store.domain}] HTTP ${res.status} on page ${page} — stopping`);
            errors += 1;
            break;
          }

          if (page === 1) {
            const etag = res.headers.get('etag') ?? undefined;
            const lastModified = res.headers.get('last-modified') ?? undefined;
            if (etag || lastModified) await etagCache.set(url, { etag, lastModified });
          }

          const body = (await res.json()) as { products?: ShopifyProduct[] };
          const products = Array.isArray(body.products) ? body.products : [];
          const seenAt = Date.now();
          for (const p of products) {
            try {
              if (kidsIds.has(p.id)) {
                kidsSkipped += 1;
                continue;
              }
              const raw = normalizeShopifyProduct(p, store, seenAt);
              if (raw && !seen.has(raw.sourceListingId)) {
                seen.add(raw.sourceListingId);
                listings.push(raw);
              }
            } catch (e) {
              errors += 1;
              log.warn(`[shopify:${store.domain}] failed to normalize product ${p?.id}`, e);
            }
          }

          log.info(
            `[shopify:${store.domain}] page ${page}: ${products.length} products → ${listings.length} dresses so far`,
          );
          if (products.length < PAGE_SIZE) break; // short page = last page
        } catch (e) {
          errors += 1;
          log.warn(`[shopify:${store.domain}] page ${page} failed — stopping store`, e);
          break; // one bad page stops THIS store; the pipeline isolates stores
        }
      }

      if (kidsSkipped > 0) {
        log.info(`[shopify:${store.domain}] kids-collection exclusion skipped ${kidsSkipped} product(s)`);
      }
      return { listings, stats: { fetched: listings.length, errors } };
    },
  };
}

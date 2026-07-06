/**
 * Shopify products.json crawler — docs/ARCHITECTURE.md §8.
 *
 * TODO(data-eng):
 * - paginate https://{store}/products.json?limit=250&page=N until empty
 * - filter product_type/tags to dresses; variants → per-size availability/prices
 * - ETag/If-None-Match via EtagCache; ≥1s delay per host; cadence 1/day/store
 * - curate & verify stores.json (~40 stores; some disable products.json)
 */
import type { FetchContext, FetchResult, SourceConnector } from '@hemline/contracts';
import storesJson from './stores.json';

export interface ShopifyStore {
  domain: string;
  displayName: string;
}

export const shopifyStores: ShopifyStore[] = storesJson as ShopifyStore[];

export function createShopifyConnector(store: ShopifyStore): SourceConnector {
  return {
    id: `shopify:${store.domain}`,
    kind: 'shopify',
    defaultCadence: '0 6 * * *', // max 1/day/store
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      // No credentials needed, but crawling can be disabled in dev.
      return env.INGEST_ENABLE_SHOPIFY !== 'false';
    },
    async fetchListings(_ctx: FetchContext): Promise<FetchResult> {
      throw new Error(
        `not yet implemented (data-eng): Shopify products.json crawler for ${store.domain} — docs/ARCHITECTURE.md §8`,
      );
    },
  };
}

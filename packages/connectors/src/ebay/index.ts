/**
 * eBay Browse API connector — docs/ARCHITECTURE.md §8.
 *
 * - OAuth client-credentials flow (token cached until near expiry)
 * - item_summary/search: q=dress + category_ids=63861 (Women's Dresses) +
 *   aspect_filter (size/color/dress length/condition — configurable via
 *   EBAY_ASPECT_FILTER) + FIXED_PRICE filter
 * - EPN affiliate support: X-EBAY-C-ENDUSERCTX affiliateCampaignId header when
 *   EBAY_AFFILIATE_CAMPAIGN_ID is set (API then returns itemAffiliateWebUrl;
 *   normalize.ts also builds rover URLs as a fallback)
 * - MOCK MODE: without EBAY_CLIENT_ID/SECRET it serves fixtures/ebay-sample.json
 *   with a visible `[MOCK]` log
 */
import type { FetchContext, FetchResult, RawListing, SourceConnector } from '@hemline/contracts';
import { politeFetch, type PolitenessOptions } from '../framework/politeness';
import { normalizeEbayItem, type EbayItemSummary } from './normalize';
// Static JSON import (not fs + import.meta.url): survives the Next server
// bundle where import.meta.url is not a file:// URL (integration 2026-07-06).
import ebaySampleJson from '../fixtures/ebay-sample.json';

export * from './normalize';

/** eBay category 63861 = Clothing, Shoes & Accessories > Women > Dresses */
export const EBAY_DRESS_CATEGORY_ID = '63861';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const PAGE_SIZE = 200;

interface EbaySearchResponse {
  total?: number;
  itemSummaries?: EbayItemSummary[];
}

export interface EbayConnectorOptions extends PolitenessOptions {
  /** hard cap on items per run (default EBAY_MAX_ITEMS or 1000) */
  maxItems?: number;
  env?: NodeJS.ProcessEnv;
}

export function loadEbaySample(): { itemSummaries: EbayItemSummary[] } {
  // structuredClone: callers may mutate; keep the module-level object pristine
  // (fs.readFileSync used to hand out a fresh copy per call).
  return structuredClone(ebaySampleJson) as { itemSummaries: EbayItemSummary[] };
}

export function createEbayConnector(opts: EbayConnectorOptions = {}): SourceConnector {
  let token: { value: string; expiresAt: number } | null = null;

  const getEnv = () => opts.env ?? process.env;

  async function getAccessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const env = getEnv();
    const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString(
      'base64',
    );
    const res = await politeFetch(
      TOKEN_URL,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'https://api.ebay.com/oauth/api_scope',
        }).toString(),
      },
      opts,
    );
    if (!res.ok) {
      throw new Error(`eBay OAuth failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  }

  return {
    id: 'ebay',
    kind: 'ebay',
    defaultCadence: '0 */6 * * *',
    isConfigured(env: NodeJS.ProcessEnv): boolean {
      return Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET);
    },
    async fetchListings(ctx: FetchContext): Promise<FetchResult> {
      const env = getEnv();
      const log = ctx.logger;
      const affiliateCampaignId = env.EBAY_AFFILIATE_CAMPAIGN_ID || undefined;
      const seenAt = Date.now();

      // ── MOCK MODE ────────────────────────────────────────────────────
      if (ctx.mockMode) {
        log.warn(
          '[ebay] [MOCK MODE] EBAY_CLIENT_ID/SECRET not set — serving fixtures/ebay-sample.json (no network)',
        );
        const sample = loadEbaySample();
        const listings = sample.itemSummaries
          .map((item) => normalizeEbayItem(item, { affiliateCampaignId, seenAt }))
          .filter((l): l is RawListing => l !== null);
        return { listings, stats: { fetched: listings.length, errors: 0 } };
      }

      // ── LIVE ─────────────────────────────────────────────────────────
      const maxItems = opts.maxItems ?? (Number(env.EBAY_MAX_ITEMS) || 1000);
      const marketplace = env.EBAY_MARKETPLACE ?? 'EBAY_US';
      const listings: RawListing[] = [];
      let errors = 0;

      try {
        const accessToken = await getAccessToken();
        const headers: Record<string, string> = {
          authorization: `Bearer ${accessToken}`,
          'x-ebay-c-marketplace-id': marketplace,
          accept: 'application/json',
        };
        if (affiliateCampaignId) {
          headers['x-ebay-c-enduserctx'] = `affiliateCampaignId=${affiliateCampaignId}`;
        }

        for (let offset = 0; offset < maxItems; offset += PAGE_SIZE) {
          const params = new URLSearchParams({
            q: 'dress',
            category_ids: EBAY_DRESS_CATEGORY_ID,
            limit: String(Math.min(PAGE_SIZE, maxItems - offset)),
            offset: String(offset),
            filter: 'buyingOptions:{FIXED_PRICE}',
          });
          // aspect_filter for size/color/dress length/condition, e.g.
          // `categoryId:63861,Dress Length:{Midi|Maxi},Size:{6|8}` (doc §8)
          if (env.EBAY_ASPECT_FILTER) params.set('aspect_filter', env.EBAY_ASPECT_FILTER);

          const res = await politeFetch(`${SEARCH_URL}?${params}`, { headers }, opts);
          if (!res.ok) {
            errors += 1;
            log.warn(`[ebay] search HTTP ${res.status} at offset ${offset} — stopping`);
            break;
          }
          const body = (await res.json()) as EbaySearchResponse;
          const items = body.itemSummaries ?? [];
          for (const item of items) {
            try {
              const raw = normalizeEbayItem(item, { affiliateCampaignId, seenAt });
              if (raw) listings.push(raw);
            } catch (e) {
              errors += 1;
              log.warn(`[ebay] failed to normalize item ${item?.itemId}`, e);
            }
          }
          log.info(`[ebay] offset ${offset}: ${items.length} items → ${listings.length} listings`);
          if (items.length < PAGE_SIZE || offset + PAGE_SIZE >= (body.total ?? Infinity)) break;
        }
      } catch (e) {
        errors += 1;
        log.error('[ebay] fetch failed', e);
      }

      return { listings, stats: { fetched: listings.length, errors } };
    },
  };
}

/** Default instance used by the ingest worker and registry. */
export const ebayConnector: SourceConnector = createEbayConnector();

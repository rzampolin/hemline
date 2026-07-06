/**
 * eBay Browse API connector — docs/ARCHITECTURE.md §8.
 *
 * TODO(data-eng):
 * - OAuth client-credentials flow
 * - item_summary/search: q=dress + category_ids (women's dresses) + aspect_filter
 * - EPN affiliate params when EBAY_AFFILIATE_CAMPAIGN_ID is set
 * - mock mode: serve ../fixtures/ebay-sample.json with a visible `[MOCK]` log
 *   and stats flagged `mock:true`
 */
import type { FetchContext, FetchResult, SourceConnector } from '@hemline/contracts';

export const ebayConnector: SourceConnector = {
  id: 'ebay',
  kind: 'ebay',
  defaultCadence: '0 */6 * * *',
  isConfigured(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET);
  },
  async fetchListings(_ctx: FetchContext): Promise<FetchResult> {
    throw new Error(
      'not yet implemented (data-eng): eBay Browse API connector (+ mock mode via fixtures/ebay-sample.json) — docs/ARCHITECTURE.md §8',
    );
  },
};

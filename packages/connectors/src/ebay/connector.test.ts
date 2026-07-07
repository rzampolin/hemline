import { describe, expect, it, vi } from 'vitest';
import { RawListingSchema, type FetchContext, type Logger } from '@hemline/contracts';
import { createMemoryEtagCache } from '../framework/etag-cache';
import { createEbayConnector, ebayConnector } from './index';

function makeCtx(overrides: Partial<FetchContext> = {}): FetchContext {
  const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { db: {}, etagCache: createMemoryEtagCache(), logger, mockMode: true, ...overrides };
}

describe('eBay connector — mock mode', () => {
  it('is unconfigured without EBAY_CLIENT_ID/SECRET', () => {
    expect(ebayConnector.isConfigured({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      ebayConnector.isConfigured({
        EBAY_CLIENT_ID: 'id',
        EBAY_CLIENT_SECRET: 'secret',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('serves the recorded sample with a visible MOCK MODE log and zero network', async () => {
    const fetchImpl = vi.fn();
    const connector = createEbayConnector({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: {} as NodeJS.ProcessEnv,
    });
    const ctx = makeCtx();

    const result = await connector.fetchListings(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.listings.length).toBe(20);
    expect(result.stats).toEqual({ fetched: 20, errors: 0 });
    for (const l of result.listings) {
      expect(RawListingSchema.safeParse(l).success).toBe(true);
      expect(l.sourceId).toBe('ebay');
    }
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[MOCK MODE]'));
  });

  it('applies the EPN campaign id from env even in mock mode', async () => {
    const connector = createEbayConnector({
      env: { EBAY_AFFILIATE_CAMPAIGN_ID: '5339001' } as NodeJS.ProcessEnv,
    });
    const result = await connector.fetchListings(makeCtx());
    expect(result.listings[0].affiliateUrl).toContain('campid=5339001');
  });
});

describe('eBay connector — live path (faked HTTP)', () => {
  it('runs OAuth then paginated search with affiliate header', async () => {
    const requests: { url: string; headers: Headers }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      requests.push({ url: u, headers: new Headers(init?.headers) });
      if (u.includes('/identity/v1/oauth2/token')) {
        return new Response(
          JSON.stringify({ access_token: 'tok_123', expires_in: 7200 }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          total: 1,
          itemSummaries: [
            {
              itemId: 'v1|1|0',
              title: 'Silk Midi Dress',
              itemWebUrl: 'https://www.ebay.com/itm/1',
              price: { value: '50.00', currency: 'USD' },
              conditionId: '3000',
              localizedAspects: [{ name: 'Size', value: 'M' }],
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const env = {
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
      EBAY_AFFILIATE_CAMPAIGN_ID: '777',
      EBAY_MARKETPLACE: 'EBAY_US',
    } as NodeJS.ProcessEnv;
    const connector = createEbayConnector({ fetchImpl, env, minDelayMs: 0 });
    const result = await connector.fetchListings(makeCtx({ mockMode: false }));

    expect(result.stats.errors).toBe(0);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sizeLabels).toEqual(['M']);

    const [tokenReq, searchReq] = requests;
    expect(tokenReq.url).toContain('oauth2/token');
    expect(tokenReq.headers.get('authorization')).toMatch(/^Basic /);
    expect(searchReq.url).toContain('item_summary/search');
    expect(searchReq.url).toContain('category_ids=63861');
    expect(searchReq.headers.get('authorization')).toBe('Bearer tok_123');
    expect(searchReq.headers.get('x-ebay-c-marketplace-id')).toBe('EBAY_US');
    expect(searchReq.headers.get('x-ebay-c-enduserctx')).toBe('affiliateCampaignId=777');
  });

  it('degrades to stats.errors on OAuth failure instead of throwing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 401 }),
    ) as unknown as typeof fetch;
    const env = { EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'bad' } as NodeJS.ProcessEnv;
    const connector = createEbayConnector({ fetchImpl, env, minDelayMs: 0, retries: 0 });
    const result = await connector.fetchListings(makeCtx({ mockMode: false }));
    expect(result.listings).toHaveLength(0);
    expect(result.stats.errors).toBe(1);
  });
});

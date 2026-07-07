import { describe, expect, it } from 'vitest';
import { RawListingSchema } from '@hemline/contracts';
import { loadEbaySample } from './index';
import {
  buildEpnAffiliateUrl,
  colorFamily,
  mapEbayCondition,
  mapEbayDressLength,
  normalizeEbayItem,
} from './normalize';

const SEEN_AT = 1_750_000_000_000;
const sample = loadEbaySample();

describe('normalizeEbayItem (against recorded item_summary/search sample)', () => {
  it('normalizes every sample item into a valid RawListing', () => {
    for (const item of sample.itemSummaries) {
      const raw = normalizeEbayItem(item, { seenAt: SEEN_AT });
      expect(raw, item.itemId).not.toBeNull();
      const res = RawListingSchema.safeParse(raw);
      expect(res.success, `invalid RawListing for ${item.itemId}`).toBe(true);
    }
  });

  it('maps summary fields, aspects, and images', () => {
    const item = sample.itemSummaries[0]; // ModCloth plum sheath, NWT, $87
    const raw = normalizeEbayItem(item, { seenAt: SEEN_AT })!;
    expect(raw).toMatchObject({
      sourceId: 'ebay',
      sourceListingId: 'v1|221262846182|0',
      sourceUrl: 'https://www.ebay.com/itm/221262846182',
      brand: 'ModCloth', // Brand aspect
      priceCents: 8700,
      currency: 'USD',
      condition: 'new', // conditionId 1000
      sizeLabels: ['4'], // Size aspect
      availability: { '4': true },
      isVintage: false,
      seenAt: SEEN_AT,
    });
    expect(raw.imageUrls.length).toBeGreaterThanOrEqual(2); // image + additionalImages
    expect(raw.attributeHints?.colors).toEqual([{ name: 'plum', family: 'purple', hex: null }]);
    expect(raw.attributeHints?.lengthClass).toBe('mini'); // Dress Length: Short
  });

  it('detects vintage + era from the Decade aspect and title', () => {
    const vtg = sample.itemSummaries.find((i) => /VTG 1990s Gunne Sax/.test(i.title))!;
    const raw = normalizeEbayItem(vtg, { seenAt: SEEN_AT })!;
    expect(raw.isVintage).toBe(true);
    expect(raw.era).toBe('1990s');
    expect(raw.condition).toBe('good'); // Pre-owned / 3000
  });

  it('builds an EPN affiliate URL when a campaign id is configured', () => {
    const raw = normalizeEbayItem(sample.itemSummaries[0], {
      seenAt: SEEN_AT,
      affiliateCampaignId: '5339000000',
    })!;
    const u = new URL(raw.affiliateUrl!);
    expect(u.searchParams.get('campid')).toBe('5339000000');
    expect(u.searchParams.get('mkcid')).toBe('1');
    expect(u.pathname).toBe('/itm/221262846182');
  });

  it('prefers itemAffiliateWebUrl straight from the API', () => {
    const raw = normalizeEbayItem(
      { ...sample.itemSummaries[0], itemAffiliateWebUrl: 'https://ebay.com/aff?x=1' },
      { seenAt: SEEN_AT, affiliateCampaignId: '5339000000' },
    )!;
    expect(raw.affiliateUrl).toBe('https://ebay.com/aff?x=1');
  });

  it('rejects unpriceable items', () => {
    const { price: _price, ...noPrice } = sample.itemSummaries[0];
    expect(normalizeEbayItem(noPrice, { seenAt: SEEN_AT })).toBeNull();
  });
});

describe('mapping helpers', () => {
  it('maps condition ids and falls back to text', () => {
    expect(mapEbayCondition('1000')).toBe('new');
    expect(mapEbayCondition('1500')).toBe('new');
    expect(mapEbayCondition('2990')).toBe('like_new');
    expect(mapEbayCondition('3000')).toBe('good');
    expect(mapEbayCondition('5000')).toBe('fair');
    expect(mapEbayCondition(undefined, 'Pre-owned')).toBe('good');
    expect(mapEbayCondition(undefined, undefined)).toBe('unknown');
  });

  it('maps eBay Dress Length aspect values to LengthClass', () => {
    expect(mapEbayDressLength('Short')).toBe('mini');
    expect(mapEbayDressLength('Knee Length')).toBe('knee');
    expect(mapEbayDressLength('Midi')).toBe('midi');
    expect(mapEbayDressLength('Long')).toBe('maxi');
    expect(mapEbayDressLength('gibberish')).toBeNull();
  });

  it('groups colors into families', () => {
    expect(colorFamily('plum')).toBe('purple');
    expect(colorFamily('leopard')).toBe('brown');
    expect(colorFamily('chartreuse-ish')).toBe('multi');
  });

  it('keeps existing query params when building rover URLs', () => {
    const url = buildEpnAffiliateUrl('https://www.ebay.com/itm/123?var=456', '99');
    const u = new URL(url);
    expect(u.searchParams.get('var')).toBe('456');
    expect(u.searchParams.get('campid')).toBe('99');
  });
});

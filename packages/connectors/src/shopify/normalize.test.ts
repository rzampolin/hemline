import { describe, expect, it } from 'vitest';
import { RawListingSchema } from '@hemline/contracts';
import page from './__fixtures__/products-page.json';
import {
  isDressProduct,
  normalizeShopifyProduct,
  shopifyAttributeHints,
  stripHtml,
  type ShopifyProduct,
} from './normalize';

const products = page.products as unknown as ShopifyProduct[];
const store = { domain: 'staud.clothing', displayName: 'STAUD' };
const SEEN_AT = 1_750_000_000_000;

const byHandle = (handle: string) => {
  const p = products.find((x) => x.handle === handle);
  if (!p) throw new Error(`missing fixture product: ${handle}`);
  return p;
};

describe('isDressProduct', () => {
  it('accepts products typed as dresses', () => {
    expect(isDressProduct(byHandle('vinnie-dress-white'))).toBe(true);
  });
  it('accepts dress-tagged products with empty product_type', () => {
    expect(isDressProduct(byHandle('wells-gown-black'))).toBe(true);
  });
  it('rejects handbags, gift cards, and dress shirts', () => {
    expect(isDressProduct(byHandle('christos-mini-tote-espresso'))).toBe(false);
    expect(isDressProduct(byHandle('gift-card'))).toBe(false);
    expect(isDressProduct(byHandle('poplin-dress-shirt-blue'))).toBe(false);
  });
  it('rejects a title-only "dress shirt" even without a product_type', () => {
    const p = { ...byHandle('poplin-dress-shirt-blue'), product_type: '', tags: [] };
    expect(isDressProduct(p)).toBe(false);
  });
});

describe('normalizeShopifyProduct', () => {
  it('normalizes a dress with per-size availability and images in position order', () => {
    const raw = normalizeShopifyProduct(byHandle('vinnie-dress-white'), store, SEEN_AT);
    expect(raw).not.toBeNull();
    expect(RawListingSchema.safeParse(raw).success).toBe(true);
    expect(raw).toMatchObject({
      sourceId: 'shopify:staud.clothing',
      sourceListingId: '8057672073392',
      sourceUrl: 'https://staud.clothing/products/vinnie-dress-white',
      brand: 'With Jéan', // vendor wins over store displayName
      priceCents: 15800, // min available variant price
      currency: 'USD',
      condition: 'new',
      isVintage: false,
      sizeLabels: ['XXS', 'XS', 'S', 'M'],
      availability: { XXS: true, XS: false, S: true, M: true },
      seenAt: SEEN_AT,
    });
    // images sorted by position (fixture stores them out of order)
    expect(raw!.imageUrls[0]).toContain('vinnie-dress-white-01');
    expect(raw!.imageUrls[1]).toContain('vinnie-dress-white-02');
    // body_html stripped to text
    expect(raw!.description).toContain('midi-length');
    expect(raw!.description).not.toContain('<');
  });

  it('finds the size option when it is not option1 and falls back to store brand', () => {
    const raw = normalizeShopifyProduct(byHandle('wells-gown-black'), store, SEEN_AT);
    expect(raw).not.toBeNull();
    expect(raw!.sizeLabels).toEqual(['2', '4', '6']);
    expect(raw!.availability).toEqual({ '2': false, '4': true, '6': true });
    expect(raw!.brand).toBe('STAUD'); // empty vendor → store displayName
    expect(raw!.priceCents).toBe(39900); // cheapest in-stock variant
  });

  it('returns null for non-dresses', () => {
    expect(normalizeShopifyProduct(byHandle('christos-mini-tote-espresso'), store, SEEN_AT)).toBe(
      null,
    );
    expect(normalizeShopifyProduct(byHandle('gift-card'), store, SEEN_AT)).toBe(null);
  });

  it('respects the curated store currency', () => {
    const raw = normalizeShopifyProduct(
      byHandle('vinnie-dress-white'),
      { domain: 'rixo.co.uk', displayName: 'RIXO', currency: 'GBP' },
      SEEN_AT,
    );
    expect(raw!.currency).toBe('GBP');
  });
});

describe('shopifyAttributeHints', () => {
  it('derives length/fabric/occasion hints from type, tags, and title', () => {
    expect(shopifyAttributeHints(byHandle('vinnie-dress-white'))).toMatchObject({
      lengthClass: 'midi',
      fabric: 'linen',
    });
    const gownHints = shopifyAttributeHints(byHandle('wells-gown-black'));
    expect(gownHints.fabric).toBe('silk');
    expect(gownHints.occasions).toContain('evening');
  });
});

describe('stripHtml', () => {
  it('drops tags, decodes entities, and collapses whitespace', () => {
    expect(stripHtml('<p>Hello &amp; <strong>world</strong></p><p>bye</p>')).toBe(
      'Hello & world\nbye',
    );
  });
});

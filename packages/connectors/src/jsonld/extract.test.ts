/**
 * JSON-LD extraction + normalization against recorded live captures
 * (thereformation.com, forloveandlemons.com, whistles.com — 2026-07-07) and
 * synthetic schema.org shapes (ProductGroup/hasVariant, AggregateOffer).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  collectProductNodes,
  extractJsonLdBlocks,
  extractOgImage,
  sizesFromAdditionalProperty,
} from './extract';
import {
  extractListingFromHtml,
  isDressJsonld,
  type JsonldStoreInfo,
} from './normalize';

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf-8');

const SEEN_AT = 1_750_000_000_000;

describe('recorded capture: thereformation.com (SFCC, per-size Offers)', () => {
  const store: JsonldStoreInfo = {
    domain: 'thereformation.com',
    displayName: 'Reformation',
    productUrlPattern: 'thereformation\\.com/products/',
  };
  const url = 'https://www.thereformation.com/products/gene-dress/0103940.html';

  it('normalizes to a full RawListing with per-size availability', () => {
    const { listing, outcome } = extractListingFromHtml(fixture('reformation-pdp.html'), store, url, SEEN_AT);
    expect(outcome).toBe('ok');
    expect(listing).toMatchObject({
      sourceId: 'jsonld:thereformation.com',
      sourceListingId: '0103940BEO',
      sourceUrl: url,
      title: 'Gene Dress',
      brand: 'Reformation',
      priceCents: 19800,
      currency: 'USD',
      condition: 'new',
      isVintage: false,
      seenAt: SEEN_AT,
    });
    expect(listing?.sizeLabels).toEqual(['000', '002', '004', '006', '008', '010', '012']);
    expect(listing?.availability).toMatchObject({ '000': true, '012': true });
    expect(listing?.imageUrls[0]).toContain('media.thereformation.com');
    expect(listing?.description).toContain('sweetheart neckline');
    // hints come from title+category only ("Gene Dress" carries none) — the
    // description's "mini dress" is left for the AI extraction pass
    expect(listing?.attributeHints).toBeUndefined();
  });
});

describe('recorded capture: forloveandlemons.com (@graph wrapper, cents-as-dollars)', () => {
  const store: JsonldStoreInfo = {
    domain: 'forloveandlemons.com',
    displayName: 'For Love & Lemons',
    productUrlPattern: 'forloveandlemons\\.com/products/',
    priceDivisor: 100,
  };
  const url = 'https://forloveandlemons.com/products/adahlia-floral-midi-dress-cream';

  it('finds the Product inside @graph and applies the price divisor', () => {
    const { listing, outcome } = extractListingFromHtml(fixture('fll-graph-pdp.html'), store, url, SEEN_AT);
    expect(outcome).toBe('ok');
    expect(listing).toMatchObject({
      sourceListingId: '7615217729584', // productID beats variant sku
      title: 'Adahlia Floral Midi Dress — Cream',
      priceCents: 21299, // 21299.00 "dollars" ÷ 100 → $212.99
      currency: 'USD',
      brand: 'For Love & Lemons', // JSON-LD brand is "Ready-to-Wear" (a category) → store name
    });
    // sizes parsed from offer names: "… - XXS / Cream"
    expect(listing?.sizeLabels).toEqual(['XXS', 'XS', 'S', 'M', 'L', 'XL']);
    expect(listing?.availability?.XXS).toBe(true);
    expect(listing?.imageUrls.length).toBeGreaterThanOrEqual(3);
    expect(listing?.imageUrls[0]).toContain('cdn.shopify.com');
  });
});

describe('recorded capture: whistles.com (malformed JSON-LD — raw control chars)', () => {
  const store: JsonldStoreInfo = {
    domain: 'whistles.com',
    displayName: 'Whistles',
    productUrlPattern: 'whistles\\.com/product/',
    currency: 'GBP',
  };
  const url = 'https://www.whistles.com/product/anna-dress-38714.html';

  it('raw block does not JSON.parse but the recovery pass extracts it', () => {
    const html = fixture('whistles-malformed-pdp.html');
    const { parsed, malformed } = extractJsonLdBlocks(html);
    expect(parsed).toHaveLength(1); // recovered, not counted malformed
    expect(malformed).toBe(0);
    expect(collectProductNodes(parsed)).toHaveLength(1);
  });

  it('normalizes: GBP price, entity-decoded images, double-encoded description stripped', () => {
    const { listing, outcome } = extractListingFromHtml(fixture('whistles-malformed-pdp.html'), store, url, SEEN_AT);
    expect(outcome).toBe('ok');
    expect(listing).toMatchObject({
      title: 'Brown Anna Dress',
      priceCents: 9900,
      currency: 'GBP',
    });
    expect(listing?.sizeLabels).toEqual([]); // single sizeless offer
    expect(listing?.imageUrls[0]).toContain('sw=1000&sh=1400'); // &amp; decoded
    // description was &lt;p&gt;…-encoded HTML with explicit garment length
    expect(listing?.description).toContain('Length: 145cm');
    expect(listing?.description).not.toContain('&lt;');
    expect(listing?.description).not.toContain('<br');
  });
});

describe('ProductGroup / hasVariant (synthetic, jcrew/ba-sh shape with offers)', () => {
  const store: JsonldStoreInfo = {
    domain: 'example-brand.com',
    displayName: 'Example Brand',
    productUrlPattern: 'example-brand\\.com/p/',
  };
  const url = 'https://www.example-brand.com/p/womens/dresses/pleated-midi-dress/PG-1234';

  it('aggregates variant sizes, per-size stock, and the min in-stock price', () => {
    const { listing, outcome } = extractListingFromHtml(fixture('productgroup-pdp.html'), store, url, SEEN_AT);
    expect(outcome).toBe('ok');
    expect(listing).toMatchObject({
      sourceListingId: 'PG-1234',
      title: 'Pleated Midi Dress',
      brand: 'Example Brand',
      priceCents: 9800, // min across in-stock variants (S is OutOfStock)
      currency: 'USD',
    });
    expect(listing?.sizeLabels).toEqual(['XS', 'S', 'M']);
    expect(listing?.availability).toEqual({ XS: true, S: false, M: true });
    // group has no image → falls back to the first variant image
    expect(listing?.imageUrls).toEqual(['https://cdn.example.com/products/pg-1234-front.jpg']);
    expect(listing?.attributeHints?.lengthClass).toBe('midi');
    expect(listing?.description).toBe('A pleated midi dress in crinkled satin.');
  });
});

const page = (ld: object | string): string =>
  `<html><head><script type="application/ld+json">${
    typeof ld === 'string' ? ld : JSON.stringify(ld)
  }</script></head><body/></html>`;

const STORE: JsonldStoreInfo = {
  domain: 'x.test',
  displayName: 'X',
  productUrlPattern: 'x\\.test/products/',
};
const URL_ = 'https://x.test/products/slip-dress';

describe('offer shapes', () => {
  it('AggregateOffer → lowPrice + currency', () => {
    const { listing } = extractListingFromHtml(
      page({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Slip Dress',
        image: 'https://cdn.x.test/slip.jpg',
        offers: {
          '@type': 'AggregateOffer',
          lowPrice: '99.50',
          highPrice: '149.00',
          priceCurrency: 'EUR',
          offerCount: 4,
        },
      }),
      STORE,
      URL_,
      SEEN_AT,
    );
    expect(listing).toMatchObject({ priceCents: 9950, currency: 'EUR' });
  });

  it('priceSpecification fallback + numeric price', () => {
    const { listing } = extractListingFromHtml(
      page({
        '@type': 'Product',
        name: 'Wrap Dress',
        offers: { '@type': 'Offer', priceSpecification: { price: 75, priceCurrency: 'USD' } },
      }),
      STORE,
      'https://x.test/products/wrap-dress',
      SEEN_AT,
    );
    expect(listing).toMatchObject({ priceCents: 7500, currency: 'USD' });
  });

  it('a dress with no price anywhere is rejected as no_price', () => {
    const { listing, outcome } = extractListingFromHtml(
      page({ '@type': 'Product', name: 'Mystery Dress' }),
      STORE,
      URL_,
      SEEN_AT,
    );
    expect(listing).toBeNull();
    expect(outcome).toBe('no_price');
  });

  it('@type arrays and additionalProperty sizes are handled', () => {
    const { listing } = extractListingFromHtml(
      page({
        '@type': ['Product', 'IndividualProduct'],
        name: 'Column Dress',
        offers: { '@type': 'Offer', price: '210.00', priceCurrency: 'USD' },
        additionalProperty: [
          { '@type': 'PropertyValue', name: 'Size', value: 'XS, S, M' },
          { '@type': 'PropertyValue', name: 'Fit', value: 'Regular' },
        ],
      }),
      STORE,
      URL_,
      SEEN_AT,
    );
    expect(listing?.sizeLabels).toEqual(['XS', 'S', 'M']);
  });
});

describe('malformed + fallback behavior', () => {
  it('an unrecoverable block is counted and reported as malformed_only', () => {
    const { listing, outcome, malformedBlocks } = extractListingFromHtml(
      page('{"@type": "Product", "name": "Broken Dress", '),
      STORE,
      URL_,
      SEEN_AT,
    );
    expect(listing).toBeNull();
    expect(outcome).toBe('malformed_only');
    expect(malformedBlocks).toBe(1);
  });

  it('a malformed block does not poison a later valid block', () => {
    const html = `<html><head>
      <script type="application/ld+json">{"broken": </script>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Good Dress',
        offers: { '@type': 'Offer', price: '50.00', priceCurrency: 'USD' },
      })}</script>
      </head></html>`;
    const { listing, malformedBlocks } = extractListingFromHtml(html, STORE, URL_, SEEN_AT);
    expect(listing?.title).toBe('Good Dress');
    expect(malformedBlocks).toBe(1);
  });

  it('no JSON-LD at all → no_jsonld_product', () => {
    const { outcome } = extractListingFromHtml('<html><body>hi</body></html>', STORE, URL_, SEEN_AT);
    expect(outcome).toBe('no_jsonld_product');
  });

  it('falls back to og:image when the Product has no image', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.x.test/og.jpg?a=1&amp;b=2"/>
      <script type="application/ld+json">${JSON.stringify({
        '@type': 'Product',
        name: 'Tiered Maxi Dress',
        offers: { '@type': 'Offer', price: '80', priceCurrency: 'USD' },
      })}</script></head></html>`;
    const { listing } = extractListingFromHtml(html, STORE, URL_, SEEN_AT);
    expect(listing?.imageUrls).toEqual(['https://cdn.x.test/og.jpg?a=1&b=2']);
  });

  it('extractOgImage handles content-before-property attribute order', () => {
    expect(
      extractOgImage('<meta content="https://cdn.x.test/i.jpg" property="og:image"/>'),
    ).toBe('https://cdn.x.test/i.jpg');
  });
});

describe('dresses-only filter', () => {
  const mk = (name: string, category = '', url = 'https://x.test/products/item') =>
    isDressJsonld(name, category, url);

  it('accepts by title, category, or URL slug', () => {
    expect(mk('Gene Dress')).toBe(true);
    expect(mk('The Ellery', 'Dresses')).toBe(true);
    expect(mk('The Ellery', '', 'https://x.test/products/ellery-midi-dress')).toBe(true);
  });

  it('rejects non-dresses and dress-adjacent products', () => {
    expect(mk('Silk Blouse')).toBe(false);
    expect(mk('Oxford Dress Shirt')).toBe(false);
    expect(mk('Ludlow Derbys', '', 'https://x.test/products/shoes/dress-shoes/ludlow-derbys')).toBe(false);
    expect(mk('Pleated Skirt', 'Skirts')).toBe(false);
    expect(mk('Linen Jumpsuit', 'Dresses & Jumpsuits')).toBe(true); // dress category wins
  });

  it('rejects sizeFromOfferName-less non-products via extractListingFromHtml', () => {
    const { listing, outcome } = extractListingFromHtml(
      page({
        '@type': 'Product',
        name: 'Cashmere Sweater',
        offers: { '@type': 'Offer', price: '150', priceCurrency: 'USD' },
      }),
      STORE,
      'https://x.test/products/cashmere-sweater',
      SEEN_AT,
    );
    expect(listing).toBeNull();
    expect(outcome).toBe('not_a_dress');
  });
});

describe('sizesFromAdditionalProperty', () => {
  it('only reads PropertyValues named size/sizes', () => {
    expect(
      sizesFromAdditionalProperty([
        { name: 'size', value: 'S/M | L/XL' },
        { name: 'Color', value: 'Red' },
      ]),
    ).toEqual(['S', 'M', 'L', 'XL']);
    expect(sizesFromAdditionalProperty(undefined)).toEqual([]);
  });
});

describe('per-store brand strategy (schema.org brand has the same junk exposure)', () => {
  const slipDress = (brand?: string): object => ({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Slip Dress',
    ...(brand ? { brand } : {}),
    offers: { '@type': 'Offer', price: '99.00', priceCurrency: 'USD' },
  });

  it('multi-brand stores (lulus.com) preserve genuine third-party brands', () => {
    const lulus: JsonldStoreInfo = {
      domain: 'lulus.com',
      displayName: 'Lulus',
      brandName: 'Lulus',
      brandMode: 'multi',
      productUrlPattern: 'lulus\\.com/products/',
    };
    const url = 'https://www.lulus.com/products/red-slip-dress/123.html';
    const keep = extractListingFromHtml(page(slipDress('Free People')), lulus, url, SEEN_AT);
    expect(keep.listing?.brand).toBe('Free People');
    // …but a junk code still falls back to the canonical store brand
    const junk = extractListingFromHtml(page(slipDress('LU123')), lulus, url, SEEN_AT);
    expect(junk.listing?.brand).toBe('Lulus');
    const missing = extractListingFromHtml(page(slipDress()), lulus, url, SEEN_AT);
    expect(missing.listing?.brand).toBe('Lulus');
  });

  it('single-brand stores force the canonical brand over whatever the theme ships', () => {
    const reformation: JsonldStoreInfo = {
      domain: 'thereformation.com',
      displayName: 'Reformation',
      brandName: 'Reformation',
      brandMode: 'single',
      productUrlPattern: 'thereformation\\.com/products/',
    };
    const url = 'https://www.thereformation.com/products/slip-dress/1.html';
    const forced = extractListingFromHtml(
      page(slipDress('REF SPRING 2026 SALE')),
      reformation,
      url,
      SEEN_AT,
    );
    expect(forced.listing?.brand).toBe('Reformation');
  });
});

/**
 * External-PDP parser tests (paste-a-dress-link fit check, 2026-07-13).
 *
 * Fallback chain coverage on RECORDED fixtures:
 *  - __fixtures__/staud-yuca-dress.js.json — VERBATIM live capture of
 *    https://staud.clothing/products/yuca-dress-tidal-shell.js (2026-07-13):
 *    integer-cent prices, bare-string images, `type`/`description` fields.
 *  - __fixtures__/reformation-winslow-dress.html — the real JSON-LD block,
 *    og: metas and model-info snippet from a live polite probe of
 *    https://www.thereformation.com/products/winslow-dress/0503333.html
 *    (2026-07-13), wrapped in minimal HTML (page trimmed from 498KB).
 *  - synthetic microdata / og-only / garbage samples for the lower tiers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isShopifyProductUrl,
  keywordsFromUrl,
  parseExternalProductPage,
  parseExternalShopifyProduct,
  shopifyJsUrl,
} from './index';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, '__fixtures__', name), 'utf-8');

const STAUD_URL = 'https://staud.clothing/products/yuca-dress-tidal-shell';
const REF_URL = 'https://www.thereformation.com/products/winslow-dress/0503333.html';

describe('shopify url helpers', () => {
  it('detects /products/ URLs and builds the .js target', () => {
    expect(isShopifyProductUrl(STAUD_URL)).toBe(true);
    expect(isShopifyProductUrl('https://staud.clothing/collections/dresses')).toBe(false);
    expect(shopifyJsUrl(`${STAUD_URL}?variant=123#detail`)).toBe(`${STAUD_URL}.js`);
    expect(shopifyJsUrl(REF_URL)).toBe(
      'https://www.thereformation.com/products/winslow-dress/0503333.js',
    );
  });
});

describe('tier 1: Shopify .js payload (live capture, staud.clothing)', () => {
  const payload = JSON.parse(fixture('staud-yuca-dress.js.json')) as unknown;

  it('parses title, integer-cent price, sizes and per-variant availability', () => {
    const parsed = parseExternalShopifyProduct(payload, STAUD_URL);
    expect(parsed.outcome).toBe('ok');
    const p = parsed.product!;
    expect(p.via).toBe('shopify_js');
    expect(p.title).toBe('YUCA COVERUP DRESS | TIDAL SHELL');
    expect(p.priceCents).toBe(37500); // .js prices are integer cents
    expect(p.sizeLabels).toEqual(['XS', 'S', 'M', 'L', 'XL']);
    expect(Object.keys(p.availability)).toContain('XS');
    expect(p.images.length).toBeGreaterThan(0);
    // protocol-relative CDN urls resolve against the PDP
    expect(p.images[0]).toMatch(/^https:\/\/cdn\.shopify\.com\//);
    expect(p.description).toMatch(/chiffon maxi/i);
  });

  it('reports a non-product payload as no_product (falls to the HTML chain)', () => {
    expect(parseExternalShopifyProduct({ error: 'not found' }, STAUD_URL).outcome).toBe(
      'no_product',
    );
    expect(parseExternalShopifyProduct('garbage', STAUD_URL).outcome).toBe('no_product');
  });

  it('reports a non-dress Shopify product honestly', () => {
    const bag = {
      title: 'HARLOW BAG | SUEDE PATCHWORK',
      type: 'FASHION HANDBAGS',
      price: 25000,
      variants: [],
    };
    expect(
      parseExternalShopifyProduct(bag, 'https://staud.clothing/products/harlow-bag').outcome,
    ).toBe('not_a_dress');
  });

  it('flags kids items as child_audience', () => {
    const kid = {
      title: 'Mini Me Smocked Dress',
      type: 'Dresses',
      price: 4500,
      options: [{ name: 'Size', position: 1, values: ['2T', '3T', '4T'] }],
      variants: [
        { id: 1, title: '2T', option1: '2T', option2: null, option3: null, price: 4500, available: true },
        { id: 2, title: '3T', option1: '3T', option2: null, option3: null, price: 4500, available: true },
        { id: 3, title: '4T', option1: '4T', option2: null, option3: null, price: 4500, available: true },
      ],
      tags: ['kids', 'toddler girls'],
    };
    expect(
      parseExternalShopifyProduct(kid, 'https://store.com/products/mini-me-smocked-dress').outcome,
    ).toBe('child_audience');
  });
});

describe('tier 2: JSON-LD (live capture, thereformation.com)', () => {
  const html = fixture('reformation-winslow-dress.html');

  it('parses the Product node with per-size offers', () => {
    const parsed = parseExternalProductPage(html, REF_URL);
    expect(parsed.outcome).toBe('ok');
    const p = parsed.product!;
    expect(p.via).toBe('jsonld');
    expect(p.title).toBe('Winslow Dress');
    expect(p.brand).toBe('Reformation');
    expect(p.priceCents).toBe(34800);
    expect(p.currency).toBe('USD');
    expect(p.sizeLabels).toContain('0XS');
    expect(p.availability['0XS']).toBe(true); // InStock
    expect(p.availability['00S']).toBe(false); // OutOfStock
    expect(p.images[0]).toMatch(/^https:\/\/media\.thereformation\.com\//);
  });
});

describe('tier 3: microdata fallback', () => {
  const MICRODATA_PDP = `<!DOCTYPE html><html><head><title>The Christy</title></head><body>
    <ul itemscope itemtype="http://schema.org/BreadcrumbList">
      <li itemprop="itemListElement" itemscope itemtype="http://schema.org/ListItem">
        <span itemprop="name">Mini Dresses</span><meta itemprop="position" content="1" />
      </li>
    </ul>
    <div itemscope itemtype="http://schema.org/Product">
      <h1 itemprop="name">The Christy - Black</h1>
      <div itemprop="offers" itemscope itemtype="http://schema.org/Offer">
        <meta itemprop="price" content="185.00" />
        <meta itemprop="priceCurrency" content="USD" />
        <link itemprop="availability" href="http://schema.org/InStock" />
      </div>
    </div>
  </body></html>`;

  it('parses a microdata-only PDP with the breadcrumb as category', () => {
    const parsed = parseExternalProductPage(
      MICRODATA_PDP,
      'https://realisationpar.com/the-christy-black/',
    );
    expect(parsed.outcome).toBe('ok');
    const p = parsed.product!;
    expect(p.via).toBe('microdata');
    expect(p.title).toBe('The Christy - Black');
    expect(p.priceCents).toBe(18500);
  });
});

describe('tier 4: og:-metas only', () => {
  const OG_ONLY = `<!DOCTYPE html><html><head>
    <title>Silk Slip Dress — Some Boutique</title>
    <meta property="og:title" content="Silk Slip Midi Dress" />
    <meta property="og:image" content="https://cdn.someboutique.com/slip.jpg" />
    <meta property="og:site_name" content="Some Boutique" />
    <meta property="product:price:amount" content="240.00" />
    <meta property="product:price:currency" content="GBP" />
  </head><body><h1>Silk Slip Midi Dress</h1></body></html>`;

  it('parses title/image/price from og metas when no schema.org data exists', () => {
    const parsed = parseExternalProductPage(
      OG_ONLY,
      'https://someboutique.com/products/silk-slip-midi-dress',
    );
    expect(parsed.outcome).toBe('ok');
    const p = parsed.product!;
    expect(p.via).toBe('og');
    expect(p.title).toBe('Silk Slip Midi Dress');
    expect(p.images[0]).toBe('https://cdn.someboutique.com/slip.jpg');
    expect(p.priceCents).toBe(24000);
    expect(p.currency).toBe('GBP');
    expect(p.sizeLabels).toEqual([]); // og tier has no size data
  });

  it('rejects og-only pages whose title/slug never says dress', () => {
    const parsed = parseExternalProductPage(
      OG_ONLY.replace(/Silk Slip Midi Dress/g, 'Leather Tote'),
      'https://someboutique.com/products/leather-tote',
    );
    expect(parsed.outcome).toBe('not_a_dress');
  });
});

describe('garbage / empty pages', () => {
  it('yields no_product on garbage HTML', () => {
    expect(parseExternalProductPage('<<<%%% not html at all', 'https://x.com/products/y').outcome).toBe(
      'no_product',
    );
    expect(parseExternalProductPage('', 'https://x.com/products/y').outcome).toBe('no_product');
  });

  it('yields no_product on a bot-block interstitial', () => {
    const blocked = `<html><head><title>Access Denied</title></head><body>Request blocked.</body></html>`;
    const parsed = parseExternalProductPage(blocked, 'https://store.com/products/maxi-dress');
    // "Access Denied" title + dressy slug: outcome must not be 'ok'
    expect(parsed.outcome).not.toBe('ok');
  });
});

describe('keywordsFromUrl (degradation: unreadable → catalog search)', () => {
  it('derives keywords from the slug, dropping stopwords and style codes', () => {
    expect(keywordsFromUrl('https://store.com/products/maxi-slip-dress-in-black')).toEqual([
      'maxi',
      'slip',
      'dress',
      'black',
    ]);
    expect(keywordsFromUrl(REF_URL)).toEqual(['winslow', 'dress']);
  });

  it('returns [] for unparseable URLs', () => {
    expect(keywordsFromUrl('not a url')).toEqual([]);
  });
});

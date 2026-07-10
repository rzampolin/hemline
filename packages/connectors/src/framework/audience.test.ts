/**
 * Audience gate (kids-in-catalog founder bug, 2026-07-09): the layer-1
 * heuristics matrix. Every MUST-KEEP case is an adult false-positive trap
 * that has burned real aggregators; every MUST-EXCLUDE case mirrors a live
 * product shape (loveshackfancy.com Girls line, shopdoen.com kids line).
 */
import { describe, expect, it } from 'vitest';
import {
  detectChildAudience,
  looksLikeKidSizeLabel,
  majorityKidSizeLabels,
} from './dress-heuristics';
import {
  normalizeShopifyProduct,
  shopifyChildAudienceReason,
  type ShopifyProduct,
  type ShopifyStoreInfo,
} from '../shopify/normalize';
import { normalizeJsonldProduct, type JsonldStoreInfo } from '../jsonld/normalize';

const child = (text: string, sizeLabels: string[] = []) =>
  detectChildAudience({ text, sizeLabels }).child;

describe('detectChildAudience — keyword matrix', () => {
  // ── MUST-KEEP: adult styles/copy that merely sound kid-adjacent ──────────
  it.each([
    'Serena Mini Dress',
    'Baby Blue Midi Dress',
    'Baby Pink Satin Slip Dress',
    'Babydoll Midi Dress',
    'Baby Doll Dress in Cream',
    'The Baby Shower Wrap Dress',
    'Baby Bump Friendly Maxi', // maternity = adult
    "Baby's Breath Floral Print Dress",
    'Girls Night Out Sequin Mini',
    "Girls' Night Dress",
    'Girls Trip Linen Set',
    'Girl Boss Blazer Dress', // bare singular "girl" never matches
    'It Girl Slip Dress',
    'Little Black Dress',
    'Juniors Ruched Bodycon Dress', // plain junior(s) = adult US size category
    'Youthful Floral Midi', // "youthful" ≠ "youth" (word boundary)
  ])('KEEPS adult: %s', (title) => {
    expect(child(title)).toBe(false);
  });

  // ── MUST-EXCLUDE: unambiguous kid copy ───────────────────────────────────
  it.each([
    'Girls Decker Cotton Floral Dress', // live: loveshackfancy 8038485491897
    "Girl's Smocked Party Dress",
    'Kids Gingham Sundress',
    "Kid's Twirl Dress",
    'Children Holiday Dress',
    "Children's Velvet Dress",
    'Toddler Ruffle Dress',
    'Infant Bubble Romper Dress',
    'Newborn Coming Home Dress',
    'Tween Maxi Dress',
    'Youth Flower Dress',
    'Junior Girls Prairie Dress',
    'Baby Ruffle Dress', // bare "baby" garment (not a color/silhouette)
    'Mini Me Floral Dress',
    'Mini-Me Matching Dress',
    'Mommy and Me Smocked Dress (Kid)',
    'Mommy & Me Twirl Dress',
    'Young girl in a plaid dress standing in dry grass', // live: shopdoen alt text
    'Little Girl Party Dress',
  ])('EXCLUDES kid: %s', (title) => {
    expect(child(title)).toBe(true);
  });

  it('reports which signal fired', () => {
    expect(detectChildAudience({ text: 'Girls Decker Dress' }).reason).toMatch(/^keyword:girls/);
    expect(
      detectChildAudience({ text: 'Plaid Dress', sizeLabels: ['2/3', '3/4', '4/5'] }).reason,
    ).toBe('kid_sizes');
  });
});

describe('kid-size label patterns', () => {
  it.each(['2/3', '3/4', '7/8', '8/9', '14/15', '2T', '4t', 'NB', '4Y', '10 yrs', '8 years', '12M', '18-24M', '3-6 months', '24 mo'])(
    'kid label: %s',
    (label) => expect(looksLikeKidSizeLabel(label)).toBe(true),
  );

  it.each(['XS', 'S', 'M', 'L', 'XL', 'XS/S', 'M/L', '2', '8', '14', 'US 6', '6/8', '10/12', 'One Size', '38'])(
    'adult label: %s',
    (label) => expect(looksLikeKidSizeLabel(label)).toBe(false),
  );

  it('majority rule: the real LSF girls size run excludes', () => {
    // live: loveshackfancy 8038485491897 — 6 of 9 labels are kid slash-pairs
    expect(
      majorityKidSizeLabels(['2/3', '3/4', '4/5', '5/6', '7/8', '8/9', '10', '12', '14']),
    ).toBe(true);
  });

  it('plain numerics [2,4,6,8,10] alone are a valid ADULT run — never excluded', () => {
    // live: shopdoen LUCY DRESS (kids) shares this run with countless adult dresses;
    // sizes alone must not decide (the vision layer handles the Dôen case)
    expect(majorityKidSizeLabels(['2', '4', '6', '8', '10'])).toBe(false);
    expect(child('LUCY DRESS -- AMBLE PLAID', ['2', '4', '6', '8', '10'])).toBe(false);
  });

  it('empty size set is not a signal', () => {
    expect(majorityKidSizeLabels([])).toBe(false);
  });
});

// ── Shopify normalization gate ──────────────────────────────────────────────

const store: ShopifyStoreInfo = {
  domain: 'example.com',
  displayName: 'Example',
  brandName: 'Example',
  brandMode: 'single',
};

function product(overrides: Partial<ShopifyProduct>): ShopifyProduct {
  return {
    id: 1,
    title: 'Floral Midi Dress',
    handle: 'floral-midi-dress',
    product_type: 'Dresses',
    variants: [
      { id: 11, title: 'S', option1: 'S', option2: null, option3: null, price: '120.00', available: true },
    ],
    options: [{ name: 'Size', position: 1, values: ['S'] }],
    images: [{ src: 'https://example.com/a.jpg', position: 1 }],
    ...overrides,
  };
}

describe('Shopify audience gate', () => {
  it('drops the live LSF shape: "Girls …" title + Girls product_type + kid tags + kid sizes', () => {
    const p = product({
      title: 'Girls Decker Cotton Floral Dress',
      product_type: 'Girls Dresses',
      tags: ['GIRLS', 'kids', 'tween'],
      options: [{ name: 'Size', position: 1 }],
      variants: ['2/3', '3/4', '4/5', '5/6', '7/8', '8/9', '10', '12', '14'].map((s, i) => ({
        id: i,
        title: s,
        option1: s,
        option2: null,
        option3: null,
        price: '95.00',
        available: true,
      })),
    });
    expect(shopifyChildAudienceReason(p)).not.toBeNull();
    expect(normalizeShopifyProduct(p, store, Date.now())).toBeNull();
  });

  it('drops on product_type alone ("Girls Dresses") even with a clean title', () => {
    const p = product({ title: 'Decker Cotton Floral Dress', product_type: 'Girls Dresses' });
    expect(normalizeShopifyProduct(p, store, Date.now())).toBeNull();
  });

  it('drops on a kid TAG alone', () => {
    const p = product({ tags: ['dress', 'toddler'] });
    expect(normalizeShopifyProduct(p, store, Date.now())).toBeNull();
  });

  it('drops the live Dôen shape via image ALT text ("Young girl in …")', () => {
    // products.json metadata reads adult (product_type 'FALL 25', sizes 2-10);
    // the only textual signal is the photo alt (probed live 2026-07-09)
    const p = product({
      title: 'LUCY DRESS -- AMBLE PLAID',
      product_type: 'FALL 25',
      tags: ['in-stock', 'NEW ARRIVALS'],
      images: [
        { src: 'https://example.com/lucy.jpg', position: 1, alt: 'Young girl in a plaid dress standing in dry grass' },
      ],
      variants: ['2', '4', '6', '8', '10'].map((s, i) => ({
        id: i,
        title: s,
        option1: s,
        option2: null,
        option3: null,
        price: '138.00',
        available: true,
      })),
    });
    expect(shopifyChildAudienceReason(p)).toMatch(/young girl/);
    expect(normalizeShopifyProduct(p, store, Date.now())).toBeNull();
  });

  it('KEEPS adult traps: babydoll / mini / baby blue titles with adult runs', () => {
    for (const title of ['Babydoll Mini Dress', 'Baby Blue Wrap Dress', 'Girls Night Out Dress']) {
      const p = product({ title });
      expect(shopifyChildAudienceReason(p)).toBeNull();
      expect(normalizeShopifyProduct(p, store, Date.now())).not.toBeNull();
    }
  });

  it('KEEPS an adult dress with a numeric 2-10 size run (the non-kid Dôen shape)', () => {
    const p = product({
      title: 'ISCHIA DRESS -- SALT',
      product_type: 'FALL 25',
      variants: ['2', '4', '6', '8', '10'].map((s, i) => ({
        id: i,
        title: s,
        option1: s,
        option2: null,
        option3: null,
        price: '298.00',
        available: true,
      })),
    });
    expect(normalizeShopifyProduct(p, store, Date.now())).not.toBeNull();
  });

  it('adult description cross-sell copy ("mini me version") does NOT exclude', () => {
    const p = product({
      body_html: '<p>Twirl-worthy. Shop the mini me version for your little one!</p>',
    });
    expect(shopifyChildAudienceReason(p)).toBeNull();
    expect(normalizeShopifyProduct(p, store, Date.now())).not.toBeNull();
  });
});

// ── JSON-LD normalization gate ──────────────────────────────────────────────

const jsonldStore: JsonldStoreInfo = {
  domain: 'example.com',
  displayName: 'Example',
  brandName: 'Example',
  brandMode: 'single',
  productUrlPattern: 'example\\.com/products/',
};

describe('JSON-LD audience gate', () => {
  const node = (overrides: Record<string, unknown>) => ({
    '@type': 'Product',
    name: 'Floral Midi Dress',
    offers: [{ '@type': 'Offer', price: 120, priceCurrency: 'USD' }],
    ...overrides,
  });

  it('drops on a kids category', () => {
    const listing = normalizeJsonldProduct(
      node({ category: 'Kids > Dresses' }),
      jsonldStore,
      'https://example.com/products/floral-midi-dress',
      Date.now(),
    );
    expect(listing).toBeNull();
  });

  it('drops on kid copy in the URL slug', () => {
    const listing = normalizeJsonldProduct(
      node({}),
      jsonldStore,
      'https://example.com/products/girls-floral-midi-dress',
      Date.now(),
    );
    expect(listing).toBeNull();
  });

  it('drops on image ALT text (ImageObject.name) — the live Dôen shape', () => {
    const listing = normalizeJsonldProduct(
      node({
        name: 'LUCY DRESS -- AMBLE PLAID',
        image: [
          {
            '@type': 'ImageObject',
            url: 'https://example.com/lucy.jpg',
            name: 'Young girl in a plaid dress standing in dry grass',
          },
        ],
      }),
      jsonldStore,
      'https://example.com/products/lucy-dress-amble-plaid',
      Date.now(),
    );
    expect(listing).toBeNull();
  });

  it('image alts that merely echo the product title do not exclude', () => {
    const listing = normalizeJsonldProduct(
      node({
        name: 'Girls Night Out Dress', // adult copy, guarded keyword
        image: [
          { '@type': 'ImageObject', url: 'https://example.com/a.jpg', name: 'Girls Night Out Dress' },
        ],
      }),
      jsonldStore,
      'https://example.com/products/party-dress',
      Date.now(),
    );
    expect(listing).not.toBeNull();
  });

  it('KEEPS adult traps (babydoll title, baby-blue slug)', () => {
    expect(
      normalizeJsonldProduct(
        node({ name: 'Babydoll Mini Dress' }),
        jsonldStore,
        'https://example.com/products/babydoll-mini-dress',
        Date.now(),
      ),
    ).not.toBeNull();
    expect(
      normalizeJsonldProduct(
        node({}),
        jsonldStore,
        'https://example.com/products/baby-blue-midi-dress',
        Date.now(),
      ),
    ).not.toBeNull();
  });
});

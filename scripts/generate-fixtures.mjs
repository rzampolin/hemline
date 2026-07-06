#!/usr/bin/env node
/**
 * Deterministic fixture generator (seeded PRNG — same output every run).
 *
 * Emits:
 *   packages/connectors/src/fixtures/listings.json     150 demo listings with
 *     pre-baked extractions (the zero-key demo dataset + test corpus)
 *   packages/connectors/src/fixtures/ebay-sample.json  mock eBay Browse API
 *     item_summary/search response (eBay connector mock mode + normalizer tests)
 *
 * Owned by data-eng (packages/connectors). Regenerate:
 *   node scripts/generate-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const OUT_DIR = path.join(ROOT, 'packages/connectors/src/fixtures');

// ── seeded PRNG ────────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260706);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const round1 = (n) => Math.round(n * 10) / 10;
const chance = (p) => rand() < p;

// ── pools ──────────────────────────────────────────────────────────────
const SHOPIFY_BRANDS = [
  { brand: 'STAUD', domain: 'staud.clothing', band: [175, 425] },
  { brand: 'Reformation', domain: 'thereformation.com', band: [148, 348] },
  { brand: 'Free People', domain: 'freepeople.com', band: [78, 228] },
  { brand: 'Rouje', domain: 'rouje.com', band: [130, 285] },
  { brand: 'Réalisation Par', domain: 'realisationpar.com', band: [180, 295] },
  { brand: 'Faithfull the Brand', domain: 'faithfullthebrand.com', band: [120, 260] },
  { brand: 'With Jéan', domain: 'withjean.com', band: [110, 240] },
  { brand: 'Christy Dawn', domain: 'christydawn.com', band: [188, 428] },
  { brand: 'Dôen', domain: 'shopdoen.com', band: [148, 398] },
  { brand: 'Sézane', domain: 'sezane.com', band: [95, 245] },
  { brand: 'GANNI', domain: 'ganni.com', band: [155, 465] },
  { brand: 'RIXO', domain: 'rixo.co.uk', band: [185, 495] },
  { brand: 'For Love & Lemons', domain: 'forloveandlemons.com', band: [128, 289] },
  { brand: 'House of CB', domain: 'houseofcb.com', band: [99, 259] },
];

const EBAY_BRANDS = [
  { brand: 'Gunne Sax', vintage: true },
  { brand: 'Laura Ashley', vintage: true },
  { brand: 'Diane von Furstenberg', vintage: true },
  { brand: 'Betsey Johnson', vintage: true },
  { brand: 'Jessica McClintock', vintage: true },
  { brand: 'Norma Kamali', vintage: true },
  { brand: 'Lilly Pulitzer', vintage: false },
  { brand: 'Escada', vintage: true },
  { brand: 'ModCloth', vintage: false },
  { brand: 'Anthropologie', vintage: false },
  { brand: 'Ralph Lauren', vintage: false },
  { brand: 'Reformation', vintage: false },
  { brand: 'Free People', vintage: false },
  { brand: null, vintage: true }, // unbranded / handmade
];

const DRESS_NAMES = [
  'Wells', 'Amaya', 'Juliette', 'Ines', 'Camille', 'Sylvie', 'Delphine', 'Farrow',
  'Marlowe', 'Odette', 'Rosalie', 'Bettina', 'Clementine', 'Margaux', 'Iris',
  'Willa', 'Frankie', 'Salma', 'Nadia', 'Esme', 'Colette', 'Petra', 'Louisa',
  'Vivienne', 'Harlow', 'Sabine', 'Tallulah', 'Wren', 'Poppy', 'Celeste',
];

const COLORS = [
  { name: 'rust', family: 'orange', hex: '#B7410E' },
  { name: 'terracotta', family: 'orange', hex: '#E2725B' },
  { name: 'burnt orange', family: 'orange', hex: '#CC5500' },
  { name: 'burgundy', family: 'red', hex: '#800020' },
  { name: 'cherry red', family: 'red', hex: '#D2042D' },
  { name: 'blush', family: 'pink', hex: '#F4C2C2' },
  { name: 'dusty rose', family: 'pink', hex: '#DCAE96' },
  { name: 'hot pink', family: 'pink', hex: '#FF69B4' },
  { name: 'emerald', family: 'green', hex: '#50C878' },
  { name: 'sage', family: 'green', hex: '#9CAF88' },
  { name: 'olive', family: 'green', hex: '#808000' },
  { name: 'forest green', family: 'green', hex: '#228B22' },
  { name: 'navy', family: 'blue', hex: '#000080' },
  { name: 'cobalt', family: 'blue', hex: '#0047AB' },
  { name: 'powder blue', family: 'blue', hex: '#B0E0E6' },
  { name: 'black', family: 'black', hex: '#000000' },
  { name: 'ivory', family: 'white', hex: '#FFFFF0' },
  { name: 'cream', family: 'white', hex: '#FFFDD0' },
  { name: 'white', family: 'white', hex: '#FFFFFF' },
  { name: 'chocolate', family: 'brown', hex: '#5D3A1A' },
  { name: 'camel', family: 'brown', hex: '#C19A6B' },
  { name: 'leopard', family: 'brown', hex: null },
  { name: 'mustard', family: 'yellow', hex: '#E1AD01' },
  { name: 'butter yellow', family: 'yellow', hex: '#FFFD74' },
  { name: 'lilac', family: 'purple', hex: '#C8A2C8' },
  { name: 'plum', family: 'purple', hex: '#8E4585' },
  { name: 'charcoal', family: 'gray', hex: '#36454F' },
  { name: 'gold', family: 'metallic', hex: '#D4AF37' },
];

const SILHOUETTES = ['a_line', 'sheath', 'wrap', 'fit_and_flare', 'slip', 'shirt', 'bodycon', 'tent', 'empire', 'other'];
const NECKLINES = ['v_neck', 'square', 'sweetheart', 'halter', 'crew', 'scoop', 'boat', 'cowl', 'off_shoulder', 'high_neck', 'collared', 'one_shoulder'];
const SLEEVES = ['sleeveless', 'spaghetti_strap', 'cap', 'short', 'elbow', 'three_quarter', 'long', 'puff', 'flutter', 'balloon'];
const FABRICS = ['silk charmeuse', 'silk', 'cotton poplin', 'cotton', 'linen', 'rayon', 'viscose crepe', 'satin', 'chiffon', 'crepe', 'jersey knit', 'velvet', 'taffeta', 'lace', 'seersucker', 'polyester'];
const PATTERNS = ['solid', 'solid', 'solid', 'floral', 'floral', 'ditsy_floral', 'polka_dot', 'stripe', 'gingham', 'animal', 'paisley', 'abstract', 'plaid'];
const OCCASIONS = ['casual', 'work', 'cocktail', 'wedding_guest', 'formal', 'vacation', 'date_night', 'brunch'];
const VIBES = ['romantic', 'minimalist', 'boho', 'retro', 'classic', 'edgy', 'cottagecore', 'glam', 'preppy'];
const ERAS = ['1970s', '1980s', '1990s', 'Y2K'];

const LENGTH_RANGES = {
  micro: [28, 31], mini: [31, 35], above_knee: [35, 38], knee: [38, 41],
  midi: [42, 46], mid_calf: [46, 50], maxi: [52, 58], floor: [58, 62],
};
// weighted class pool (per-doc coverage of every band)
const CLASS_POOL = [
  ...Array(5).fill('micro'), ...Array(20).fill('mini'), ...Array(12).fill('above_knee'),
  ...Array(15).fill('knee'), ...Array(35).fill('midi'), ...Array(15).fill('mid_calf'),
  ...Array(25).fill('maxi'), ...Array(10).fill('floor'),
];

const CLASS_WORD = {
  micro: 'Micro Mini Dress', mini: 'Mini Dress', above_knee: 'Short Dress',
  knee: 'Knee-Length Dress', midi: 'Midi Dress', mid_calf: 'Midi Dress',
  maxi: 'Maxi Dress', floor: 'Gown',
};

const HUMAN = {
  v_neck: 'V-neck', square: 'square-neck', sweetheart: 'sweetheart', halter: 'halter',
  crew: 'crew-neck', scoop: 'scoop-neck', boat: 'boatneck', cowl: 'cowl-neck',
  off_shoulder: 'off-the-shoulder', high_neck: 'high-neck', collared: 'collared',
  one_shoulder: 'one-shoulder', a_line: 'A-line', sheath: 'sheath', wrap: 'wrap',
  fit_and_flare: 'fit-and-flare', slip: 'slip', shirt: 'shirt', bodycon: 'bodycon',
  tent: 'trapeze', empire: 'empire-waist', other: 'relaxed',
};

const LETTER_SIZES = { XXS: [0], XS: [0, 2], S: [4, 6], M: [8, 10], L: [12, 14], XL: [16] };

function img(text, n) {
  const t = encodeURIComponent(`${text}${n > 0 ? ' ' + (n + 1) : ''}`).replace(/%20/g, '+');
  return `https://placehold.co/600x800?text=${t}`;
}
function slug(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function digits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randInt(0, 9));
  return s;
}

function buildExtraction({ lengthClass, lengthInches, measurements, colors, fabric, neckline, silhouette, sleeve, pattern, occasions, isVintage }) {
  const vector = {};
  if (lengthClass) vector[`length:${lengthClass}`] = 1;
  if (silhouette) vector[`silhouette:${silhouette}`] = 1;
  for (const c of colors) vector[`color:${c.family}`] = 0.8;
  if (fabric) vector[`fabric:${fabric.split(' ')[0]}`] = 0.6;
  if (pattern && pattern !== 'solid') vector[`pattern:${pattern}`] = 0.7;
  if (neckline) vector[`neckline:${neckline}`] = 0.5;
  for (const o of occasions) vector[`occasion:${o}`] = 0.4;
  vector[`vibe:${pick(VIBES)}`] = 0.5;
  if (isVintage) vector['era:vintage'] = 0.6;

  const hasMeasured = measurements.length != null;
  const confidence = lengthInches != null
    ? round1((hasMeasured ? 0.88 : 0.8) + rand() * 0.1) // measured/stated length
    : lengthClass != null
      ? round1(0.72 + rand() * 0.15)                    // class only
      : round1(0.35 + rand() * 0.2);                    // nothing to go on

  return {
    lengthClass, lengthInches, measurements, colors,
    fabric, neckline, silhouette, sleeve, pattern, occasions,
    attributeVector: vector,
    confidence: Math.min(confidence, 0.98),
  };
}

// ── 150 listings: 85 shopify-style + 65 ebay-style ─────────────────────
const entries = [];
const usedTitles = new Set();

// Deterministically choose which indexes have NO length info (13 total)
const NO_LENGTH = new Set([9, 22, 41, 58, 70, 83, 91, 102, 113, 121, 133, 140, 148]);

for (let i = 0; i < 150; i++) {
  const isShopify = i < 85;
  const noLength = NO_LENGTH.has(i);
  const lengthClass = noLength ? null : pick(CLASS_POOL);
  // most classed listings carry inches; ~22% are class-only
  const lengthInches = lengthClass && chance(0.78)
    ? round1(randInt(LENGTH_RANGES[lengthClass][0], LENGTH_RANGES[lengthClass][1]) + rand())
    : null;

  const pattern = pick(PATTERNS);
  const colors = pattern === 'solid' ? [pick(COLORS)] : [pick(COLORS), pick(COLORS)].filter((c, idx, a) => a.findIndex((x) => x.name === c.name) === idx);
  const silhouette = pick(SILHOUETTES);
  const neckline = chance(0.9) ? pick(NECKLINES) : null;
  const sleeve = chance(0.9) ? pick(SLEEVES) : null;
  const fabric = chance(0.92) ? pick(FABRICS) : null;
  const occasions = [...new Set([pick(OCCASIONS), ...(chance(0.5) ? [pick(OCCASIONS)] : [])])];

  let entry;
  if (isShopify) {
    const b = SHOPIFY_BRANDS[i % SHOPIFY_BRANDS.length];
    let name;
    let title;
    do {
      name = pick(DRESS_NAMES);
      const typeWord = silhouette === 'slip' ? 'Slip Dress' : silhouette === 'wrap' ? 'Wrap Dress' : silhouette === 'shirt' ? 'Shirt Dress' : (lengthClass ? CLASS_WORD[lengthClass] : 'Dress');
      const patternWord = pattern !== 'solid' ? ` ${pattern.replace(/_/g, ' ')}` : '';
      title = `${name} ${typeWord} — ${colors[0].name.replace(/\b\w/g, (m) => m.toUpperCase())}${patternWord}`;
    } while (usedTitles.has(title));
    usedTitles.add(title);

    const priceDollars = randInt(b.band[0], b.band[1]);
    const numericSizes = chance(0.4);
    const labels = numericSizes
      ? ['0', '2', '4', '6', '8', '10', '12'].slice(randInt(0, 1), randInt(5, 7))
      : ['XS', 'S', 'M', 'L', 'XL'].slice(randInt(0, 1), randInt(3, 5));
    const availability = {};
    for (const l of labels) availability[l] = chance(0.82);
    if (!Object.values(availability).some(Boolean)) availability[labels[0]] = true;
    const sizeNormalized = [...new Set(labels.flatMap((l) => (numericSizes ? [Number(l)] : LETTER_SIZES[l] ?? [])))].sort((a, z) => a - z);

    const handle = `${slug(title)}-${digits(4)}`;
    const nImgs = randInt(2, 4);
    const measurements = {
      bust: null, waist: null, hip: null,
      length: lengthInches != null && chance(0.75) ? lengthInches : null,
    };
    const descBits = [
      `The ${name} in ${colors.map((c) => c.name).join(' and ')}.`,
      `${HUMAN[silhouette] ?? silhouette} silhouette${fabric ? ` in ${fabric}` : ''}${neckline ? ` with a ${HUMAN[neckline]} neckline` : ''}${sleeve ? ` and ${sleeve.replace(/_/g, ' ')} sleeves` : ''}.`,
      measurements.length != null
        ? `Length: ${measurements.length}" from high point of shoulder (size ${numericSizes ? '6' : 'S'}).`
        : lengthClass
          ? `Falls to a ${lengthClass.replace(/_/g, ' ')} length.`
          : '',
      `Perfect for ${occasions[0].replace(/_/g, ' ')}.`,
    ].filter(Boolean);

    entry = {
      raw: {
        sourceId: 'fixture:shopify',
        sourceListingId: handle,
        sourceUrl: `https://${b.domain}/products/${handle}`,
        title,
        description: descBits.join(' '),
        brand: b.brand,
        priceCents: priceDollars * 100 + pick([0, 0, 50]),
        currency: 'USD',
        imageUrls: Array.from({ length: nImgs }, (_, k) => img(`${b.brand} ${name}`, k)),
        sizeLabels: labels,
        availability,
        condition: 'new',
        isVintage: false,
        seenAt: 0, // placeholder; seed uses lastSeenHoursAgo
      },
      sizeNormalized,
      lastSeenHoursAgo: round1(chance(0.94) ? rand() * 46 : 60 + rand() * 12),
      firstSeenDaysAgo: randInt(1, 90),
      extraction: buildExtraction({ lengthClass, lengthInches, measurements, colors, fabric, neckline, silhouette, sleeve, pattern, occasions, isVintage: false }),
    };
  } else {
    const b = pick(EBAY_BRANDS);
    const isVintage = b.vintage && chance(0.85);
    const era = isVintage ? pick(ERAS) : undefined;
    const condition = pick(isVintage ? ['good', 'good', 'fair', 'like_new', 'unknown'] : ['like_new', 'good', 'new', 'unknown']);
    const tagSize = pick(['2', '4', '6', '8', '8', '10', '12', '14', 'S', 'M', 'M', 'L']);
    const isLetter = isNaN(Number(tagSize));
    // vintage numeric label ≈ modern −4..−6 (weak prior — doc §5 edge cases)
    const sizeNormalized = isLetter
      ? LETTER_SIZES[tagSize] ?? [8]
      : isVintage
        ? [Math.max(0, Number(tagSize) - 6), Math.max(0, Number(tagSize) - 4)]
        : [Number(tagSize)];

    const hasMeasurements = chance(0.62);
    const bust = hasMeasurements ? randInt(32, 44) : null;
    const measurements = hasMeasurements
      ? {
          bust,
          waist: chance(0.85) ? bust - randInt(6, 10) : null,
          hip: chance(0.6) ? bust + randInt(0, 4) : null,
          length: lengthInches,
        }
      : { bust: null, waist: null, hip: null, length: lengthInches };

    const colorWord = colors[0].name.replace(/\b\w/g, (m) => m.toUpperCase());
    const lengthWord = lengthClass ? { micro: 'Micro', mini: 'Mini', above_knee: 'Short', knee: 'Knee Length', midi: 'Midi', mid_calf: 'Midi', maxi: 'Maxi', floor: 'Full Length' }[lengthClass] : '';
    let title = [
      isVintage ? `VTG ${era}` : '',
      b.brand ?? 'Handmade',
      colorWord,
      pattern !== 'solid' ? pattern.replace(/_/g, ' ') : '',
      HUMAN[silhouette] ?? '',
      lengthWord,
      'Dress',
      `Sz ${tagSize}`,
      fabric ? fabric.split(' ')[0] : '',
    ].filter(Boolean).join(' ');
    if (usedTitles.has(title)) title += ` ${digits(2)}`;
    usedTitles.add(title);

    const itemDigits = `2${digits(11)}`;
    const priceDollars = 14 + Math.floor(rand() * rand() * 400);
    const descBits = [
      isVintage ? `True vintage ${era} ${b.brand ?? 'handmade'} dress.` : `${b.brand ?? 'Unbranded'} dress, ${condition === 'like_new' ? 'worn once' : condition === 'fair' ? 'well loved' : 'gently used'}.`,
      hasMeasurements
        ? `Flat measurements: pit to pit ${round1(measurements.bust / 2)}"${measurements.waist ? `, waist ${round1(measurements.waist / 2)}" flat` : ''}${measurements.hip ? `, hips ${round1(measurements.hip / 2)}" flat` : ''}${lengthInches != null ? `, length ${lengthInches}" shoulder to hem` : ''}.`
        : `No measurements taken — tag size ${tagSize}, see photos.`,
      isVintage ? 'Vintage sizing runs small — check measurements.' : '',
      condition === 'fair' ? 'Small flaw at hem, priced accordingly.' : '',
    ].filter(Boolean);

    const nImgs = randInt(1, 3);
    entry = {
      raw: {
        sourceId: 'fixture:ebay',
        sourceListingId: `v1|${itemDigits}|0`,
        sourceUrl: `https://www.ebay.com/itm/${itemDigits}`,
        title,
        description: descBits.join(' '),
        ...(b.brand ? { brand: b.brand } : {}),
        priceCents: priceDollars * 100 + pick([0, 0, 99]),
        currency: 'USD',
        imageUrls: Array.from({ length: nImgs }, (_, k) => img(`${b.brand ?? 'Vintage'} ${colorWord} Dress`, k)),
        sizeLabels: [tagSize],
        availability: { [tagSize]: true },
        condition,
        isVintage,
        ...(era ? { era } : {}),
        // some eBay listings carry structured aspects → attributeHints
        ...(lengthClass && chance(0.3)
          ? { attributeHints: { lengthClass, colors: [colors[0]] } }
          : {}),
        seenAt: 0, // placeholder; seed uses lastSeenHoursAgo
      },
      sizeNormalized,
      lastSeenHoursAgo: round1(chance(0.92) ? rand() * 24 : 55 + rand() * 17),
      firstSeenDaysAgo: randInt(1, 60),
      extraction: buildExtraction({ lengthClass, lengthInches, measurements, colors, fabric, neckline, silhouette, sleeve, pattern, occasions, isVintage }),
    };
  }
  entries.push(entry);
}

// bake seenAt from the offsets so RawListing validates standalone
const NOW = Date.UTC(2026, 6, 6); // generation-time anchor; seed re-derives freshness from offsets
for (const e of entries) e.raw.seenAt = NOW - Math.round(e.lastSeenHoursAgo * 3_600_000);

// ── ebay-sample.json: mock Browse API item_summary/search response ─────
const ebayEntries = entries.filter((e) => e.raw.sourceId === 'fixture:ebay').slice(0, 20);
const ebaySample = {
  href: 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=dress&category_ids=63861&limit=50&offset=0',
  total: ebayEntries.length,
  limit: 50,
  offset: 0,
  itemSummaries: ebayEntries.map((e, i) => {
    const id = e.raw.sourceListingId.split('|')[1];
    return {
      itemId: e.raw.sourceListingId,
      title: e.raw.title,
      leafCategoryIds: ['63861'],
      categories: [{ categoryId: '63861', categoryName: 'Dresses' }],
      image: { imageUrl: e.raw.imageUrls[0] },
      additionalImages: e.raw.imageUrls.slice(1).map((u) => ({ imageUrl: u })),
      price: { value: (e.raw.priceCents / 100).toFixed(2), currency: 'USD' },
      itemHref: `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(e.raw.sourceListingId)}`,
      itemWebUrl: e.raw.sourceUrl,
      seller: {
        username: `closet_curator_${100 + i}`,
        feedbackPercentage: (96 + rand() * 4).toFixed(1),
        feedbackScore: randInt(40, 5000),
      },
      condition: { new: 'New with tags', like_new: 'Pre-owned - Excellent', good: 'Pre-owned - Good', fair: 'Pre-owned - Fair', unknown: 'Pre-owned' }[e.raw.condition],
      conditionId: e.raw.condition === 'new' ? '1000' : '3000',
      buyingOptions: ['FIXED_PRICE'],
      itemLocation: { postalCode: `${randInt(10, 98)}0**`, country: 'US' },
      localizedAspects: [
        { type: 'STRING', name: 'Size', value: e.raw.sizeLabels[0] },
        { type: 'STRING', name: 'Color', value: e.extraction.colors[0]?.name ?? 'multi' },
        ...(e.raw.brand ? [{ type: 'STRING', name: 'Brand', value: e.raw.brand }] : []),
        ...(e.extraction.lengthClass
          ? [{ type: 'STRING', name: 'Dress Length', value: { micro: 'Mini', mini: 'Mini', above_knee: 'Short', knee: 'Knee Length', midi: 'Midi', mid_calf: 'Midi', maxi: 'Maxi', floor: 'Long' }[e.extraction.lengthClass] }]
          : []),
        ...(e.raw.era ? [{ type: 'STRING', name: 'Decade', value: e.raw.era }] : []),
      ],
      legacyItemId: id,
    };
  }),
};

fs.writeFileSync(path.join(OUT_DIR, 'listings.json'), JSON.stringify(entries, null, 2) + '\n');
fs.writeFileSync(path.join(OUT_DIR, 'ebay-sample.json'), JSON.stringify(ebaySample, null, 2) + '\n');

const withInches = entries.filter((e) => e.extraction.lengthInches != null).length;
const withClassOnly = entries.filter((e) => e.extraction.lengthInches == null && e.extraction.lengthClass != null).length;
const withMeasurements = entries.filter((e) => e.extraction.measurements.bust != null).length;
console.log(`[fixtures] wrote ${entries.length} listings → ${path.relative(ROOT, OUT_DIR)}/listings.json`);
console.log(`[fixtures]   length inches: ${withInches}, class-only: ${withClassOnly}, no length: ${entries.length - withInches - withClassOnly}, bust/waist measured: ${withMeasurements}`);
console.log(`[fixtures] wrote ${ebaySample.itemSummaries.length} itemSummaries → ebay-sample.json`);

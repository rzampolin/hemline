/**
 * External-PDP parsing for the paste-a-dress-link fit check (2026-07-13).
 *
 * Unlike the crawl normalizers, this parser reads ONE user-pasted page from
 * ANY store — no store config exists and nothing is stored as a listing — so
 * the rules are deliberately softer:
 *  - a missing price is fine (the fit check works without one);
 *  - a kids item is REPORTED ('child_audience'), not silently dropped;
 *  - after JSON-LD and microdata, an og:-meta-only tier catches pages with no
 *    schema.org data at all (title/image/price from OpenGraph tags).
 *
 * Fallback chain (richest first):
 *   Shopify /products/{handle}.js payload (route fetches it when the URL
 *   matches) → JSON-LD Product/ProductGroup → schema.org microdata (with the
 *   BreadcrumbList trail as category of last resort) → og: metas.
 *
 * Shapes verified against live captures (2026-07-13):
 *   staud.clothing /products/….js — integer-cent prices at both product and
 *   variant level, images as bare url strings, `type` instead of
 *   product_type, `description` instead of body_html;
 *   thereformation.com PDP — Product JSON-LD with per-size Offers and stated
 *   model height in the page copy.
 */
import type { ExtractedAttributes } from '@hemline/contracts';
import {
  attributeHintsFromText,
  detectChildAudience,
} from '../framework/dress-heuristics';
import {
  asString,
  brandName,
  extractJsonLdBlocks,
  extractOgImage,
  collectProductNodes,
  flattenOffers,
  imageAltTexts,
  imageUrls,
  sizesFromAdditionalProperty,
  type JsonLdNode,
  type ParsedOffer,
} from '../jsonld/extract';
import { extractMicrodata } from '../jsonld/microdata';
import { cleanDescription, isDressJsonld } from '../jsonld/normalize';
import { decodeXmlEntities } from '../jsonld/sitemap';
import {
  shopifyAvailability,
  stripHtml,
  type ShopifyImage,
  type ShopifyProduct,
} from '../shopify/normalize';

export interface ExternalProduct {
  title: string;
  description: string | null;
  brand: string | null;
  /** null when the page states no machine-readable price */
  priceCents: number | null;
  currency: string | null;
  images: string[];
  sizeLabels: string[];
  /** size label → in stock (empty when the page has no per-size signal) */
  availability: Record<string, boolean>;
  /** deterministic hints from title/category text (extraction pre-fill) */
  attributeHints: Partial<ExtractedAttributes> | null;
  via: 'shopify_js' | 'jsonld' | 'microdata' | 'og';
}

export interface ParsedExternalPage {
  outcome: 'ok' | 'not_a_dress' | 'child_audience' | 'no_product';
  product: ExternalProduct | null;
}

// ── shared helpers ─────────────────────────────────────────────────────────

function categoryText(v: unknown): string {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr
    .map((x) =>
      typeof x === 'object' && x !== null
        ? (asString((x as JsonLdNode).name) ?? '')
        : (asString(x) ?? ''),
    )
    .join(' ');
}

function variantNodes(node: JsonLdNode): JsonLdNode[] {
  const hv = node.hasVariant;
  const arr = Array.isArray(hv) ? hv : hv == null ? [] : [hv];
  return arr.filter((v): v is JsonLdNode => typeof v === 'object' && v !== null);
}

function urlSlugText(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, ' ');
  } catch {
    return '';
  }
}

function resolveImages(images: string[], baseUrl: string): string[] {
  return images
    .map((src) => {
      try {
        return new URL(src, baseUrl).toString();
      } catch {
        return '';
      }
    })
    .filter((src, i, arr) => Boolean(src) && arr.indexOf(src) === i);
}

// ── tier 1: Shopify single-product payload (/products/{handle}.js) ─────────

/** Does this look like a Shopify PDP URL (…/products/{handle})? */
export function isShopifyProductUrl(url: string): boolean {
  try {
    return /\/products\/[^/]+/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** `https://store/products/handle[?q][#h][.js|.json]` → `…/handle.js` */
export function shopifyJsUrl(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  u.pathname = u.pathname
    .replace(/\/+$/, '')
    .replace(/\.(js|json|html?)$/i, '');
  u.pathname += '.js';
  return u.toString();
}

/**
 * The storefront `.js` payload deviates from products.json: integer-cent
 * prices, bare-string images, `type`/`description` field names. This shape
 * tolerates BOTH (the `.json` mirror serves the products.json shape).
 */
export interface ShopifyJsLikeProduct {
  title?: unknown;
  description?: unknown;
  body_html?: unknown;
  vendor?: unknown;
  type?: unknown;
  product_type?: unknown;
  tags?: unknown;
  price?: unknown;
  variants?: unknown;
  images?: unknown;
  featured_image?: unknown;
  options?: unknown;
}

function shopifyImagesOf(p: ShopifyJsLikeProduct): ShopifyImage[] {
  const raw = Array.isArray(p.images) ? p.images : [];
  const images: ShopifyImage[] = [];
  for (const item of raw) {
    if (typeof item === 'string') images.push({ src: item });
    else if (typeof item === 'object' && item !== null && typeof (item as ShopifyImage).src === 'string') {
      images.push(item as ShopifyImage);
    }
  }
  if (images.length === 0 && typeof p.featured_image === 'string') {
    images.push({ src: p.featured_image });
  }
  return images;
}

function shopifyTagsOf(p: ShopifyJsLikeProduct): string {
  if (Array.isArray(p.tags)) return p.tags.filter((t): t is string => typeof t === 'string').join(' ');
  return typeof p.tags === 'string' ? p.tags : '';
}

function shopifyPriceCents(p: ShopifyJsLikeProduct): number | null {
  // `.js` top-level price: integer cents (verified live, staud.clothing)
  if (typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0) {
    return Math.round(p.price);
  }
  const variants = Array.isArray(p.variants) ? (p.variants as Array<Record<string, unknown>>) : [];
  const prices: number[] = [];
  for (const v of variants) {
    if (typeof v.price === 'number' && Number.isFinite(v.price) && v.price >= 0) {
      prices.push(Math.round(v.price)); // `.js` variants: cents
    } else if (typeof v.price === 'string') {
      const n = Number.parseFloat(v.price);
      if (Number.isFinite(n) && n >= 0) prices.push(Math.round(n * 100)); // products.json: dollar strings
    }
  }
  return prices.length > 0 ? Math.min(...prices) : null;
}

/**
 * Parse a Shopify single-product payload (`.js` or `.json` mirror shape)
 * into an ExternalProduct — the richest tier when the pasted URL is a
 * Shopify PDP (explicit per-variant availability, clean price/size data).
 */
export function parseExternalShopifyProduct(
  payload: unknown,
  url: string,
): ParsedExternalPage {
  const p = (
    typeof payload === 'object' && payload !== null
      ? ((payload as { product?: unknown }).product ?? payload)
      : null
  ) as ShopifyJsLikeProduct | null;
  if (!p || typeof p.title !== 'string' || !p.title.trim()) {
    return { outcome: 'no_product', product: null };
  }

  const title = stripHtml(p.title).trim();
  const productType =
    (typeof p.type === 'string' ? p.type : '') ||
    (typeof p.product_type === 'string' ? p.product_type : '');
  const tags = shopifyTagsOf(p);
  const category = [productType, tags].filter(Boolean).join(' ');
  if (!isDressJsonld(title, category, url)) {
    return { outcome: 'not_a_dress', product: null };
  }

  const images = shopifyImagesOf(p);
  const forAvailability: ShopifyProduct = {
    id: 0,
    title,
    handle: '',
    variants: (Array.isArray(p.variants) ? p.variants : []) as ShopifyProduct['variants'],
    options: (Array.isArray(p.options) ? p.options : []) as ShopifyProduct['options'],
  };
  const { sizeLabels, availability, hasStockSignal } = shopifyAvailability(forAvailability);

  const alts = images.map((i) => i.alt ?? '').filter(Boolean);
  const audience = detectChildAudience({
    text: [title, productType, tags, urlSlugText(url), alts.join('\n')].join('\n'),
    sizeLabels,
  });
  if (audience.child) return { outcome: 'child_audience', product: null };

  const rawDesc =
    (typeof p.description === 'string' ? p.description : '') ||
    (typeof p.body_html === 'string' ? p.body_html : '');
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 2000) : null;
  const hints = attributeHintsFromText([title, productType, tags].join(' '));

  return {
    outcome: 'ok',
    product: {
      title,
      description,
      brand: typeof p.vendor === 'string' && p.vendor.trim() ? stripHtml(p.vendor).trim() : null,
      priceCents: shopifyPriceCents(p),
      currency: null, // the storefront .js payload states no currency
      images: resolveImages(
        images.map((i) => i.src),
        url,
      ),
      sizeLabels,
      availability: hasStockSignal ? availability : {},
      attributeHints: Object.keys(hints).length > 0 ? hints : null,
      via: 'shopify_js',
    },
  };
}

// ── tiers 2–3: JSON-LD / microdata nodes ───────────────────────────────────

interface NodeParse {
  product: ExternalProduct | null;
  isDress: boolean;
  child: boolean;
}

function externalFromNode(
  node: JsonLdNode,
  url: string,
  via: 'jsonld' | 'microdata',
  fallbackCategory: string | null,
): NodeParse {
  const rawTitle = asString(node.name);
  if (!rawTitle) return { product: null, isDress: false, child: false };
  const title = stripHtml(decodeXmlEntities(rawTitle)).trim();
  const category = categoryText(node.category) || (fallbackCategory ?? '');
  if (!isDressJsonld(title, category, url)) {
    return { product: null, isDress: false, child: false };
  }

  const variants = variantNodes(node);
  const offers: ParsedOffer[] = [...flattenOffers(node.offers)];
  for (const v of variants) {
    const variantSize = asString(v.size);
    for (const o of flattenOffers(v.offers)) {
      offers.push(variantSize != null && o.size == null ? { ...o, size: variantSize } : o);
    }
  }
  const extraSizes = [
    ...variants.map((v) => asString(v.size)).filter((s): s is string => s != null),
    ...sizesFromAdditionalProperty(node.additionalProperty),
    ...variants.flatMap((v) => sizesFromAdditionalProperty(v.additionalProperty)),
  ];

  const sizeLabels: string[] = [];
  const availability: Record<string, boolean> = {};
  let currency: string | null = null;
  const prices: number[] = [];
  for (const o of offers) {
    currency ??= o.currency;
    if (o.price != null) prices.push(o.price);
    if (o.size) {
      if (!sizeLabels.includes(o.size)) sizeLabels.push(o.size);
      if (o.available != null) {
        availability[o.size] = Boolean(availability[o.size] || o.available);
      }
    }
  }
  for (const s of extraSizes) if (!sizeLabels.includes(s)) sizeLabels.push(s);
  const inStockPrices = offers
    .filter((o) => o.available !== false)
    .map((o) => o.price)
    .filter((p): p is number => p != null);
  const pool = inStockPrices.length > 0 ? inStockPrices : prices;
  const priceCents = pool.length > 0 ? Math.round(Math.min(...pool) * 100) : null;

  const alts = imageAltTexts(node.image)
    .concat(variants.flatMap((v) => imageAltTexts(v.image)))
    .filter((alt) => alt.toLowerCase() !== title.toLowerCase());
  const audience = detectChildAudience({
    text: [title, category, urlSlugText(url), alts.join('\n')].join('\n'),
    sizeLabels,
  });
  if (audience.child) return { product: null, isDress: true, child: true };

  let images = imageUrls(node.image).map(decodeXmlEntities);
  if (images.length === 0) {
    for (const v of variants) {
      images = imageUrls(v.image).map(decodeXmlEntities);
      if (images.length > 0) break;
    }
  }

  const rawDescription = asString(node.description);
  const hints = attributeHintsFromText(`${title} ${category}`);

  return {
    isDress: true,
    child: false,
    product: {
      title,
      description: rawDescription ? cleanDescription(rawDescription) : null,
      brand: brandName(node.brand),
      priceCents,
      currency,
      images: resolveImages(images, url),
      sizeLabels,
      availability,
      attributeHints: Object.keys(hints).length > 0 ? hints : null,
      via,
    },
  };
}

// ── tier 4: og: metas only ─────────────────────────────────────────────────

function metaContent(html: string, property: string): string | null {
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = [
    new RegExp(
      `<meta[^>]*(?:property|name)\\s*=\\s*["']${esc}["'][^>]*content\\s*=\\s*["']([^"']+)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]*content\\s*=\\s*["']([^"']+)["'][^>]*(?:property|name)\\s*=\\s*["']${esc}["']`,
      'i',
    ),
  ];
  for (const re of res) {
    const m = html.match(re);
    if (m) {
      const v = decodeXmlEntities(m[1]).trim();
      if (v) return v;
    }
  }
  return null;
}

/**
 * Bot-block / error interstitial titles: pages whose <title> reads like an
 * access wall must never parse as a product, even when the URL slug is dressy
 * (Cloudflare & friends serve these with a 200 all the time).
 */
const BLOCK_PAGE_TITLE_RE =
  /access denied|attention required|just a moment|are you a (?:human|robot)|robot check|captcha|verification required|page not found|error \d{3}|\b(?:403|404|503)\b|forbidden|unavailable/i;

function ogTier(html: string, url: string): ParsedExternalPage {
  const title =
    metaContent(html, 'og:title') ??
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
  const cleanTitle = title ? stripHtml(decodeXmlEntities(title)).trim() : '';
  if (!cleanTitle) return { outcome: 'no_product', product: null };
  if (BLOCK_PAGE_TITLE_RE.test(cleanTitle)) return { outcome: 'no_product', product: null };
  if (!isDressJsonld(cleanTitle, '', url)) {
    // og-only pages have no category signal — the slug/title must say "dress"
    return { outcome: 'not_a_dress', product: null };
  }

  const audience = detectChildAudience({
    text: [cleanTitle, urlSlugText(url)].join('\n'),
    sizeLabels: [],
  });
  if (audience.child) return { outcome: 'child_audience', product: null };

  const image = extractOgImage(html);
  const rawPrice =
    metaContent(html, 'product:price:amount') ?? metaContent(html, 'og:price:amount');
  const priceNum = rawPrice ? Number.parseFloat(rawPrice.replace(/[^0-9.]/g, '')) : NaN;
  const currency =
    metaContent(html, 'product:price:currency') ?? metaContent(html, 'og:price:currency');
  const description = metaContent(html, 'og:description');
  const hints = attributeHintsFromText(cleanTitle);

  return {
    outcome: 'ok',
    product: {
      title: cleanTitle,
      description: description ? stripHtml(description).slice(0, 2000) : null,
      brand: metaContent(html, 'og:site_name'),
      priceCents: Number.isFinite(priceNum) && priceNum >= 0 ? Math.round(priceNum * 100) : null,
      currency,
      images: image ? resolveImages([image], url) : [],
      sizeLabels: [],
      availability: {},
      attributeHints: Object.keys(hints).length > 0 ? hints : null,
      via: 'og',
    },
  };
}

// ── the chain ──────────────────────────────────────────────────────────────

/**
 * Full PDP HTML → ExternalProduct via the fallback chain
 * (JSON-LD → microdata → og:). Pure; the caller handles the Shopify `.js`
 * tier (it needs a second fetch) via {@link parseExternalShopifyProduct}.
 */
export function parseExternalProductPage(html: string, url: string): ParsedExternalPage {
  let sawDress = false;
  let sawChild = false;

  const jsonldNodes = collectProductNodes(extractJsonLdBlocks(html).parsed);
  for (const node of jsonldNodes) {
    const r = externalFromNode(node, url, 'jsonld', null);
    if (r.product) return { outcome: 'ok', product: r.product };
    sawDress ||= r.isDress;
    sawChild ||= r.child;
  }

  const micro = extractMicrodata(html);
  for (const node of micro.products) {
    const title = asString(node.name);
    const trail = micro.breadcrumbs.filter((b) => b !== title).join(' ') || null;
    const r = externalFromNode(node, url, 'microdata', trail);
    if (r.product) return { outcome: 'ok', product: r.product };
    sawDress ||= r.isDress;
    sawChild ||= r.child;
  }

  if (sawChild) return { outcome: 'child_audience', product: null };

  const og = ogTier(html, url);
  if (og.outcome === 'ok' || og.outcome === 'child_audience') return og;

  if (jsonldNodes.length > 0 || micro.products.length > 0 || og.outcome === 'not_a_dress') {
    return { outcome: sawDress ? 'no_product' : 'not_a_dress', product: null };
  }
  return { outcome: 'no_product', product: null };
}

// ── slug keywords (degradation: unreadable page → offer a catalog search) ──

const SLUG_STOPWORDS = new Set([
  'products',
  'product',
  'collections',
  'collection',
  'item',
  'items',
  'shop',
  'store',
  'www',
  'html',
  'htm',
  'php',
  'aspx',
  'en',
  'us',
  'gb',
  'the',
  'a',
  'an',
  'and',
  'in',
  'of',
  'new',
  'sale',
  'p',
  'dp',
  'id',
  'sku',
  'ref',
]);

/**
 * Derive catalog-search keywords from a PDP URL slug — the honest fallback
 * when the page itself can't be read ("maxi-slip-dress-in-black" → ["maxi",
 * "slip", "dress", "black"]). Numeric/style-code tokens are dropped.
 */
export function keywordsFromUrl(url: string, max = 6): string[] {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return [];
  }
  const tokens = pathname
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(
      (t) =>
        t.length >= 2 &&
        !SLUG_STOPWORDS.has(t) &&
        // drop style codes like "0503333" fragments split into letters+digits
        !/^\d+$/.test(t),
    );
  const out: string[] = [];
  for (const t of tokens) {
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

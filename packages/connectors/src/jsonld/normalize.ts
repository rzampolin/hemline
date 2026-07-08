/**
 * schema.org Product/ProductGroup JSON-LD → RawListing (pure functions).
 *
 * Shapes verified against live captures (2026-07-07): thereformation.com
 * (SFCC, per-size Offers with `size`), forloveandlemons.com (Shopify theme,
 * @graph wrapper, size in offer name, prices emitted in cents — priceDivisor),
 * whistles.com (SFCC, control chars in JSON, entity-encoded HTML description),
 * jcrew.com / ba-sh.com (ProductGroup + hasVariant).
 *
 * When a PDP yields no usable JSON-LD Product, the same normalization runs
 * over schema.org MICRODATA (microdata.ts → JSON-LD-shaped nodes; category
 * falls back to the BreadcrumbList trail) — verified live 2026-07-08 on
 * realisationpar.com (BigCommerce). JSON-LD stays preferred when both exist.
 */
import type { RawListing } from '@hemline/contracts';
import {
  attributeHintsFromText,
  isDressText,
  looksLikeSizeLabel,
  NOT_A_DRESS_RE,
  OTHER_CATEGORY_RE,
} from '../framework/dress-heuristics';
import { stripHtml } from '../shopify/normalize';
import {
  asString,
  brandName,
  collectProductNodes,
  extractJsonLdBlocks,
  extractOgImage,
  flattenOffers,
  imageUrls,
  sizeFromOfferName,
  sizesFromAdditionalProperty,
  type JsonLdNode,
  type ParsedOffer,
} from './extract';
import { extractMicrodata } from './microdata';
import { decodeXmlEntities } from './sitemap';

export interface JsonldStoreInfo {
  domain: string;
  displayName: string;
  /** override discovery (robots.txt Sitemap: lines → /sitemap.xml fallback) */
  sitemapUrl?: string;
  /** regex (case-insensitive) a product-page URL must match */
  productUrlPattern: string;
  /** fallback when offers carry no priceCurrency (default USD) */
  currency?: string;
  /**
   * divide JSON-LD prices by this before converting to cents — some themes
   * emit integer cents in the `price` field (seen live: forloveandlemons.com)
   */
  priceDivisor?: number;
}

const DESCRIPTION_MAX = 2000;

/** category-ish strings some themes ship in Product.brand (seen live: FL&L → "Ready-to-Wear") */
const GENERIC_BRAND_RE = /^(ready.to.wear|clothing|apparel|dresses|womens?wear)$/i;

/** Entity-decode THEN strip: real stores double-encode markup (&lt;p&gt;…). */
export function cleanDescription(raw: string): string {
  return stripHtml(decodeXmlEntities(raw)).slice(0, DESCRIPTION_MAX);
}

function categoryText(v: unknown): string {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr
    .map((x) =>
      typeof x === 'object' && x !== null ? (asString((x as JsonLdNode).name) ?? '') : (asString(x) ?? ''),
    )
    .join(' ');
}

/**
 * Dresses-only filter for JSON-LD products: title first, then category, then
 * the URL slug (many stores put "dress" only in the URL/category).
 */
export function isDressJsonld(title: string, category: string, url: string): boolean {
  if (isDressText(title)) return true;
  if (category) {
    if (isDressText(category)) return true;
    if (OTHER_CATEGORY_RE.test(category)) return false; // typed as another category
  }
  if (OTHER_CATEGORY_RE.test(title)) return false;
  const urlText = decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, ' ');
  return isDressText(urlText) && !NOT_A_DRESS_RE.test(urlText);
}

/** stable listing id: productID → sku → mpn → URL slug */
function sourceListingIdFor(node: JsonLdNode, url: string): string {
  const explicit =
    asString(node.productID) ??
    asString(node.productGroupID) ??
    asString(node.productGroupId) ??
    asString(node.sku) ??
    asString(node.mpn);
  if (explicit) return explicit;
  const path = new URL(url).pathname.replace(/\/+$/, '');
  const last = path.split('/').pop() ?? path;
  return (last.replace(/\.[a-z0-9]+$/i, '') || path || url).toLowerCase();
}

interface OfferRollup {
  priceCents: number | null;
  currency: string | null;
  sizeLabels: string[];
  availability: Record<string, boolean>;
}

function rollupOffers(offers: ParsedOffer[], priceDivisor: number): OfferRollup {
  const sizeLabels: string[] = [];
  const availability: Record<string, boolean> = {};
  let currency: string | null = null;

  for (const o of offers) {
    currency ??= o.currency;
    const size = o.size ?? (o.name ? sizeFromOfferName(o.name, looksLikeSizeLabel) : null);
    if (size) {
      if (!sizeLabels.includes(size)) sizeLabels.push(size);
      // several offers can share a size (per color) → in stock if ANY is
      availability[size] = Boolean(availability[size] || (o.available ?? true));
    }
  }

  const prices = offers.map((o) => o.price).filter((p): p is number => p != null);
  const inStockPrices = offers
    .filter((o) => o.available !== false)
    .map((o) => o.price)
    .filter((p): p is number => p != null);
  const pool = inStockPrices.length > 0 ? inStockPrices : prices;
  const priceCents =
    pool.length > 0 ? Math.round((Math.min(...pool) / priceDivisor) * 100) : null;

  return { priceCents, currency, sizeLabels, availability };
}

/** ProductGroup → its hasVariant Products (which carry sizes/offers). */
function variantNodes(node: JsonLdNode): JsonLdNode[] {
  const hv = node.hasVariant;
  const arr = Array.isArray(hv) ? hv : hv == null ? [] : [hv];
  return arr.filter((v): v is JsonLdNode => typeof v === 'object' && v !== null);
}

/**
 * Normalize one Product/ProductGroup node to a RawListing, or null when it is
 * not a dress or has no usable price. `fallbackCategory` (e.g. the microdata
 * BreadcrumbList trail) only applies when the node carries no category of its
 * own — many stores put "dress" nowhere but the breadcrumb.
 */
export function normalizeJsonldProduct(
  node: JsonLdNode,
  store: JsonldStoreInfo,
  url: string,
  seenAt: number,
  html?: string,
  fallbackCategory?: string | null,
): RawListing | null {
  const title = asString(node.name);
  if (!title) return null;
  const cleanTitle = stripHtml(decodeXmlEntities(title)).trim();
  const category = categoryText(node.category) || (fallbackCategory ?? '');
  if (!isDressJsonld(cleanTitle, category, url)) return null;

  const variants = variantNodes(node);
  const offers: ParsedOffer[] = [...flattenOffers(node.offers)];
  for (const v of variants) {
    // the size usually lives on the variant Product, not its Offer — carry it over
    const variantSize = asString(v.size);
    for (const o of flattenOffers(v.offers)) {
      offers.push(variantSize != null && o.size == null ? { ...o, size: variantSize } : o);
    }
  }
  // variant-level size without its own offer (ProductGroup shapes)
  const variantSizes = variants
    .map((v) => asString(v.size))
    .filter((s): s is string => s != null);
  const extraSizes = [
    ...variantSizes,
    ...sizesFromAdditionalProperty(node.additionalProperty),
    ...variants.flatMap((v) => sizesFromAdditionalProperty(v.additionalProperty)),
  ];

  const rollup = rollupOffers(offers, store.priceDivisor ?? 1);
  if (rollup.priceCents == null) return null; // no price → unusable listing

  const sizeLabels = [...rollup.sizeLabels];
  for (const s of extraSizes) if (!sizeLabels.includes(s)) sizeLabels.push(s);

  let images = imageUrls(node.image).map(decodeXmlEntities);
  if (images.length === 0) {
    for (const v of variants) {
      images = imageUrls(v.image).map(decodeXmlEntities);
      if (images.length > 0) break;
    }
  }
  if (images.length === 0 && html) {
    const og = extractOgImage(html);
    if (og) images = [og];
  }
  // resolve protocol-relative / relative image URLs against the PDP
  images = images
    .map((src) => {
      try {
        return new URL(src, url).toString();
      } catch {
        return '';
      }
    })
    .filter((src, i, arr) => Boolean(src) && arr.indexOf(src) === i);

  const rawDescription = asString(node.description);
  const description = rawDescription ? cleanDescription(rawDescription) : undefined;
  const hints = attributeHintsFromText(`${cleanTitle} ${category}`);

  const rawBrand = brandName(node.brand);
  const brand = rawBrand && !GENERIC_BRAND_RE.test(rawBrand) ? rawBrand : store.displayName;

  return {
    sourceId: `jsonld:${store.domain}`,
    sourceListingId: sourceListingIdFor(node, url),
    sourceUrl: url,
    title: cleanTitle,
    ...(description ? { description } : {}),
    brand,
    priceCents: rollup.priceCents,
    currency: rollup.currency ?? store.currency ?? 'USD',
    imageUrls: images,
    sizeLabels,
    availability: rollup.availability,
    condition: 'new',
    isVintage: false,
    ...(Object.keys(hints).length > 0 ? { attributeHints: hints } : {}),
    seenAt,
  };
}

export interface PageExtraction {
  listing: RawListing | null;
  /** why the page yielded nothing (stats/debugging) */
  outcome: 'ok' | 'no_jsonld_product' | 'not_a_dress' | 'no_price' | 'malformed_only';
  /** which structured-data source produced the listing (outcome 'ok' only) */
  via?: 'jsonld' | 'microdata';
  malformedBlocks: number;
}

/**
 * Full PDP HTML → RawListing (or a categorized miss).
 * JSON-LD Product nodes are tried first; when none yields a usable listing,
 * the microdata fallback runs (with the breadcrumb trail as the category of
 * last resort — minus the product's own name, which ends most trails).
 */
export function extractListingFromHtml(
  html: string,
  store: JsonldStoreInfo,
  url: string,
  seenAt: number,
): PageExtraction {
  const { parsed, malformed } = extractJsonLdBlocks(html);
  const jsonldNodes = collectProductNodes(parsed);

  let sawDress = false;
  const tryNodes = (
    nodes: JsonLdNode[],
    fallbackCategory: string | null,
  ): RawListing | null => {
    for (const node of nodes) {
      const listing = normalizeJsonldProduct(node, store, url, seenAt, html, fallbackCategory);
      if (listing) return listing;
      const title = asString(node.name);
      if (title) {
        const cleanTitle = stripHtml(decodeXmlEntities(title)).trim();
        const category = categoryText(node.category) || (fallbackCategory ?? '');
        if (isDressJsonld(cleanTitle, category, url)) sawDress = true; // dress, but no price
      }
    }
    return null;
  };

  const fromJsonld = tryNodes(jsonldNodes, null);
  if (fromJsonld) {
    return { listing: fromJsonld, outcome: 'ok', via: 'jsonld', malformedBlocks: malformed };
  }

  // ── microdata fallback (no usable JSON-LD Product on this page) ────────
  const micro = extractMicrodata(html);
  for (const node of micro.products) {
    const title = asString(node.name);
    const trail = micro.breadcrumbs.filter((b) => b !== title).join(' ') || null;
    const listing = tryNodes([node], trail);
    if (listing) {
      return { listing, outcome: 'ok', via: 'microdata', malformedBlocks: malformed };
    }
  }

  if (jsonldNodes.length === 0 && micro.products.length === 0) {
    return {
      listing: null,
      outcome: malformed > 0 && parsed.length === 0 ? 'malformed_only' : 'no_jsonld_product',
      malformedBlocks: malformed,
    };
  }
  return {
    listing: null,
    outcome: sawDress ? 'no_price' : 'not_a_dress',
    malformedBlocks: malformed,
  };
}

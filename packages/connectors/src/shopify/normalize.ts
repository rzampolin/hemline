/**
 * Shopify products.json → RawListing normalization (pure functions).
 *
 * Shape verified against live captures of `/products.json` (with-jean,
 * staud.clothing, 2026-07). Dresses-only filtering uses product_type → tags →
 * title heuristics; variants become size labels + per-size availability;
 * body_html is stripped to plain text for the description.
 */
import type { ExtractedAttributes, LengthClass, RawListing } from '@hemline/contracts';

export interface ShopifyVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  available?: boolean;
  price: string;
  compare_at_price?: string | null;
  sku?: string;
  position?: number;
}

export interface ShopifyImage {
  src: string;
  position?: number;
}

export interface ShopifyOption {
  name: string;
  position: number;
  values?: string[];
}

export interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html?: string | null;
  vendor?: string;
  product_type?: string;
  tags?: string[] | string;
  variants: ShopifyVariant[];
  images?: ShopifyImage[];
  options?: ShopifyOption[];
  published_at?: string | null;
}

export interface ShopifyStoreInfo {
  domain: string;
  displayName: string;
  /** presentment currency for USD-less stores (curated; default USD) */
  currency?: string;
}

const DESCRIPTION_MAX = 2000;

export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function tagList(tags: string[] | string | undefined): string[] {
  if (!tags) return [];
  return Array.isArray(tags) ? tags : tags.split(',').map((t) => t.trim());
}

const DRESS_RE = /\bdress(es)?\b/i;
/** things that contain the word "dress" but are not dresses */
const NOT_A_DRESS_RE = /\bdress shirt\b|\bdressing gown\b|\bdress(ing)? (robe|coat)\b/i;
/** product types that are definitely another category */
const OTHER_CATEGORY_RE =
  /\b(top|tee|t-shirt|shirt|blouse|skirt|pant|trouser|jean|short|jumpsuit|romper|playsuit|sweater|knitwear|cardigan|jacket|coat|blazer|swim|bikini|bag|tote|shoe|boot|sandal|belt|hat|scarf|jewel|earring|necklace|accessor|gift card)\b/i;

/** Dresses-only filter: product_type first, then tags, then title. */
export function isDressProduct(p: ShopifyProduct): boolean {
  const pt = (p.product_type ?? '').trim();
  if (pt) {
    if (DRESS_RE.test(pt) && !NOT_A_DRESS_RE.test(pt)) return true;
    if (OTHER_CATEGORY_RE.test(pt)) return false; // typed as another category
  }
  const tags = tagList(p.tags);
  if (tags.some((t) => DRESS_RE.test(t) && !NOT_A_DRESS_RE.test(t))) return true;
  return DRESS_RE.test(p.title) && !NOT_A_DRESS_RE.test(p.title);
}

/** Which variant option position holds the size, if any. */
function sizeOptionKey(p: ShopifyProduct): 'option1' | 'option2' | 'option3' | null {
  const opt = p.options?.find((o) => /size/i.test(o.name));
  if (opt && opt.position >= 1 && opt.position <= 3) {
    return `option${opt.position}` as 'option1' | 'option2' | 'option3';
  }
  return null;
}

const SIZE_LABEL_RE = /^(xxs|xs|s|m|l|xl|xxl|2xl|3xl|xs\/s|m\/l|one size|os|\d{1,2}|us ?\d{1,2}|uk ?\d{1,2}|eu ?\d{2})$/i;

function looksLikeSizeLabel(v: string): boolean {
  return SIZE_LABEL_RE.test(v.trim());
}

const LENGTH_HINTS: [RegExp, LengthClass][] = [
  [/\bmicro\b/i, 'micro'],
  [/\bmini\b/i, 'mini'],
  [/\bmidi\b/i, 'midi'],
  [/\bmaxi\b/i, 'maxi'],
  [/\bknee[- ]length\b/i, 'knee'],
  [/\bfloor[- ]length\b|\bgown\b/i, 'floor'],
];

const FABRIC_HINTS = ['linen', 'silk', 'satin', 'cotton', 'denim', 'velvet', 'knit', 'crochet'];
const PATTERN_HINTS = ['floral', 'stripe', 'gingham', 'polka dot', 'leopard', 'paisley', 'plaid'];
const OCCASION_HINTS: [RegExp, string][] = [
  [/wedding guest/i, 'wedding_guest'],
  [/\bbridal|bride\b/i, 'bridal'],
  [/\bparty|cocktail\b/i, 'party'],
  [/\bwork(wear)?|office\b/i, 'work'],
  [/\bvacation|holiday|resort|beach\b/i, 'vacation'],
  [/\bevening|formal\b/i, 'evening'],
];

/** Pre-fill structured hints from product_type/tags/title (doc §4.1). */
export function shopifyAttributeHints(p: ShopifyProduct): Partial<ExtractedAttributes> {
  const haystack = [p.product_type ?? '', tagList(p.tags).join(' '), p.title].join(' ');
  const hints: Partial<ExtractedAttributes> = {};

  for (const [re, cls] of LENGTH_HINTS) {
    if (re.test(haystack)) {
      hints.lengthClass = cls;
      break;
    }
  }
  const fabric = FABRIC_HINTS.find((f) => new RegExp(`\\b${f}\\b`, 'i').test(haystack));
  if (fabric) hints.fabric = fabric;
  const pattern = PATTERN_HINTS.find((f) => new RegExp(`\\b${f}\\b`, 'i').test(haystack));
  if (pattern) hints.pattern = pattern;
  const occasions = OCCASION_HINTS.filter(([re]) => re.test(haystack)).map(([, o]) => o);
  if (occasions.length > 0) hints.occasions = occasions;

  return hints;
}

/**
 * Normalize one Shopify product to a RawListing, or null when it is not a
 * dress / not purchasable (no variants).
 */
export function normalizeShopifyProduct(
  p: ShopifyProduct,
  store: ShopifyStoreInfo,
  seenAt: number,
): RawListing | null {
  if (!isDressProduct(p)) return null;
  if (!Array.isArray(p.variants) || p.variants.length === 0) return null;

  const sizeKey = sizeOptionKey(p);
  const sizeLabels: string[] = [];
  const availability: Record<string, boolean> = {};
  for (const v of p.variants) {
    let label = sizeKey ? v[sizeKey] : null;
    if (!label && v.title && v.title !== 'Default Title' && looksLikeSizeLabel(v.title)) {
      label = v.title;
    }
    if (!label) continue;
    label = label.trim();
    if (!sizeLabels.includes(label)) sizeLabels.push(label);
    // multiple variants can share a size (e.g. per color) → in stock if ANY is
    availability[label] = Boolean(availability[label] || (v.available ?? true));
  }

  const priced = p.variants
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n) && n >= 0);
  if (priced.length === 0) return null;
  const availablePrices = p.variants
    .filter((v) => v.available ?? true)
    .map((v) => Number.parseFloat(v.price))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const price = (availablePrices.length > 0 ? availablePrices : priced).reduce((a, b) =>
    Math.min(a, b),
  );

  const imageUrls = [...(p.images ?? [])]
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((i) => i.src)
    .filter((src, i, arr) => Boolean(src) && arr.indexOf(src) === i);

  const description = p.body_html ? stripHtml(p.body_html).slice(0, DESCRIPTION_MAX) : undefined;
  const hints = shopifyAttributeHints(p);

  return {
    sourceId: `shopify:${store.domain}`,
    sourceListingId: String(p.id),
    sourceUrl: `https://${store.domain}/products/${p.handle}`,
    title: p.title,
    ...(description ? { description } : {}),
    brand: p.vendor?.trim() || store.displayName,
    priceCents: Math.round(price * 100),
    currency: store.currency ?? 'USD',
    imageUrls,
    sizeLabels,
    availability,
    condition: 'new',
    isVintage: false,
    ...(Object.keys(hints).length > 0 ? { attributeHints: hints } : {}),
    seenAt,
  };
}

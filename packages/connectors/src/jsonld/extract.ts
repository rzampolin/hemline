/**
 * schema.org Product extraction from PDP HTML (pure functions).
 *
 * Reads every `<script type="application/ld+json">` block, tolerates the
 * malformed JSON real stores actually ship (raw control characters inside
 * string literals — seen live on whistles.com), walks @graph wrappers /
 * top-level arrays / mainEntity, and yields Product + ProductGroup nodes.
 * Offer handling covers: Offer arrays (per-size offers with `size` — seen on
 * thereformation.com), size-in-offer-name ("… - XXS / Cream" — seen on
 * forloveandlemons.com), AggregateOffer (lowPrice), priceSpecification, and
 * ProductGroup/hasVariant variants.
 */

export type JsonLdNode = Record<string, unknown>;

// ── block extraction ─────────────────────────────────────────────────────

const LDJSON_BLOCK_RE =
  /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export interface JsonLdBlocks {
  parsed: unknown[];
  /** blocks that failed JSON.parse even after control-char recovery */
  malformed: number;
}

export function extractJsonLdBlocks(html: string): JsonLdBlocks {
  const parsed: unknown[] = [];
  let malformed = 0;
  for (const m of html.matchAll(LDJSON_BLOCK_RE)) {
    const body = m[1].replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '').trim();
    if (!body) continue;
    try {
      parsed.push(JSON.parse(body));
    } catch {
      try {
        // real-world emitters leave raw newlines/tabs inside string literals
        // (invalid JSON); escaped sequences are two chars and unaffected.
        // eslint-disable-next-line no-control-regex -- matching raw control chars is the point
        parsed.push(JSON.parse(body.replace(/[\u0000-\u001f]/g, ' ')));
      } catch {
        malformed += 1;
      }
    }
  }
  return { parsed, malformed };
}

// ── node walking ─────────────────────────────────────────────────────────

function typeSet(node: JsonLdNode): string[] {
  const t = node['@type'];
  const arr = Array.isArray(t) ? t : [t];
  return arr.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
}

function isProductNode(node: JsonLdNode): boolean {
  return typeSet(node).includes('product');
}

function isProductGroupNode(node: JsonLdNode): boolean {
  return typeSet(node).includes('productgroup');
}

/**
 * Collect Product/ProductGroup nodes from parsed JSON-LD roots.
 * ProductGroups come first (their variants carry the size/price detail);
 * a group's hasVariant children are NOT collected as standalone products.
 */
export function collectProductNodes(roots: unknown[]): JsonLdNode[] {
  const groups: JsonLdNode[] = [];
  const products: JsonLdNode[] = [];

  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (typeof n !== 'object' || n === null) return;
    const node = n as JsonLdNode;
    if (isProductGroupNode(node)) {
      groups.push(node);
      return; // variants are handled through the group
    }
    if (isProductNode(node)) {
      products.push(node);
      return;
    }
    for (const key of ['@graph', 'mainEntity']) {
      if (key in node) walk(node[key]);
    }
  };

  for (const root of roots) walk(root);
  return [...groups, ...products];
}

// ── field helpers ────────────────────────────────────────────────────────

export function asString(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** brand: "Reformation" | { "@type": "Brand", name } */
export function brandName(v: unknown): string | null {
  if (typeof v === 'object' && v !== null) return asString((v as JsonLdNode).name);
  return asString(v);
}

/** image: string | ImageObject | (string | ImageObject)[] → url list */
export function imageUrls(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const urls: string[] = [];
  for (const item of arr) {
    const url =
      typeof item === 'object' && item !== null
        ? (asString((item as JsonLdNode).url) ?? asString((item as JsonLdNode).contentUrl))
        : asString(item);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

const IN_STOCK_RE = /instock|instoreonly|onlineonly|limitedavailability|preorder|presale/i;
const OUT_OF_STOCK_RE = /outofstock|soldout|discontinued/i;

export function offerAvailable(v: unknown): boolean | null {
  const s = asString(v);
  if (!s) return null;
  if (OUT_OF_STOCK_RE.test(s)) return false;
  if (IN_STOCK_RE.test(s)) return true;
  return null;
}

export function parsePrice(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v !== 'string') return null;
  const n = Number.parseFloat(v.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** size: "M" | { name/value } | QuantitativeValue-ish */
function sizeValue(v: unknown): string | null {
  if (typeof v === 'object' && v !== null) {
    const node = v as JsonLdNode;
    return asString(node.name) ?? asString(node.value);
  }
  return asString(v);
}

// ── offers ───────────────────────────────────────────────────────────────

export interface ParsedOffer {
  price: number | null;
  currency: string | null;
  size: string | null;
  available: boolean | null;
  name: string | null;
}

function parseOfferNode(o: JsonLdNode): ParsedOffer {
  const priceSpec =
    typeof o.priceSpecification === 'object' && o.priceSpecification !== null
      ? (o.priceSpecification as JsonLdNode)
      : null;
  const price =
    parsePrice(o.price) ??
    parsePrice(o.lowPrice) ??
    (priceSpec ? (parsePrice(priceSpec.price) ?? parsePrice(priceSpec.minPrice)) : null);
  const currency =
    asString(o.priceCurrency) ?? (priceSpec ? asString(priceSpec.priceCurrency) : null);
  const itemOffered =
    typeof o.itemOffered === 'object' && o.itemOffered !== null
      ? (o.itemOffered as JsonLdNode)
      : null;
  const size = sizeValue(o.size) ?? (itemOffered ? sizeValue(itemOffered.size) : null);
  return {
    price,
    currency,
    size,
    available: offerAvailable(o.availability),
    name: asString(o.name),
  };
}

/** Flatten offers | AggregateOffer(.offers) | arrays into ParsedOffers. */
export function flattenOffers(offers: unknown): ParsedOffer[] {
  const out: ParsedOffer[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const node = v as JsonLdNode;
    const nested = node.offers;
    if (nested != null) visit(nested); // AggregateOffer with per-size children
    const parsed = parseOfferNode(node);
    if (parsed.price != null || parsed.size != null || parsed.available != null) {
      out.push(parsed);
    }
  };
  visit(offers);
  return out;
}

/** additionalProperty: PropertyValue[] with name ≈ size → labels */
export function sizesFromAdditionalProperty(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const sizes: string[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const node = item as JsonLdNode;
    if (!/^sizes?$/i.test(asString(node.name) ?? '')) continue;
    const value = asString(node.value);
    if (!value) continue;
    for (const part of value.split(/[,/|]/)) {
      const s = part.trim();
      if (s && !sizes.includes(s)) sizes.push(s);
    }
  }
  return sizes;
}

/**
 * Derive a size label from an offer/variant display name.
 * Live pattern (forloveandlemons.com): "Adahlia Floral Midi Dress - XXS / Cream".
 */
export function sizeFromOfferName(name: string, looksLikeSize: (v: string) => boolean): string | null {
  const segments = name.split(/\s+[-–]\s+/);
  if (segments.length < 2) return null;
  const tail = segments[segments.length - 1];
  for (const part of tail.split('/')) {
    const candidate = part.trim();
    if (candidate && looksLikeSize(candidate)) return candidate;
  }
  return null;
}

// ── page-level fallbacks ─────────────────────────────────────────────────

const OG_IMAGE_RE = [
  /<meta[^>]*property\s*=\s*["']og:image(?::secure_url)?["'][^>]*content\s*=\s*["']([^"']+)["']/i,
  /<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image(?::secure_url)?["']/i,
];

/** og:image / og:image:secure_url content, entity-decoded (attribute order agnostic). */
export function extractOgImage(html: string): string | null {
  for (const re of OG_IMAGE_RE) {
    const m = html.match(re);
    if (m) return m[1].replace(/&amp;/gi, '&').trim() || null;
  }
  return null;
}

/**
 * schema.org MICRODATA extraction from PDP HTML (pure functions).
 *
 * Fallback for stores that render Product structured data as HTML microdata
 * (itemscope/itemtype="…schema.org/Product", itemprop) instead of JSON-LD —
 * seen live 2026-07-08 on realisationpar.com (BigCommerce stencil theme:
 * Product > Offer > PriceSpecification via meta tags, name on the <h1>,
 * description on an <article>, category only in BreadcrumbList microdata).
 *
 * Regex tag-stream parser — no DOM/heavy deps, same style as extract.ts. It
 * walks every tag, tracks element nesting to know when an itemscope or a
 * text-valued itemprop ends, and emits JSON-LD-SHAPED nodes
 * ({ '@type': 'Product', offers: { priceSpecification: {…} } }) so
 * normalize.ts reuses the exact same Product → RawListing path.
 *
 * Tolerances (malformed HTML in the wild): attributes spanning newlines,
 * boolean itemscope, unclosed/implicitly-closed elements (a stray close tag
 * pops to the nearest matching open), script/style bodies skipped wholesale,
 * unterminated scopes finalized at EOF.
 */
import { stripHtml } from '../shopify/normalize';
import type { JsonLdNode } from './extract';
import { decodeXmlEntities } from './sitemap';

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/** elements that never take a closing tag */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** itemprop value attribute per element (WHATWG microdata §5.2.4) */
const VALUE_ATTR: Record<string, string> = {
  meta: 'content',
  audio: 'src', embed: 'src', iframe: 'src', img: 'src', source: 'src',
  track: 'src', video: 'src',
  a: 'href', area: 'href', link: 'href',
  object: 'data',
  data: 'value', meter: 'value',
  time: 'datetime',
};

function attrValue(attrs: string, name: string): string | null {
  const m = attrs.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=>]+))`, 'i'),
  );
  if (!m) return null;
  const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return v ? decodeXmlEntities(v) : null;
}

function hasBooleanAttr(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=[\\s=]|$)`, 'i').test(attrs);
}

/** "http://schema.org/Product" → "Product" (query/hash tolerated) */
function typeFromItemtype(itemtype: string | null): string {
  if (!itemtype) return 'Thing';
  const first = itemtype.trim().split(/\s+/)[0];
  const cleaned = first.replace(/[#?].*$/, '').replace(/\/+$/, '');
  return cleaned.split('/').pop() || 'Thing';
}

/** element text content → single-spaced plain text */
function textify(raw: string): string {
  return stripHtml(decodeXmlEntities(raw)).trim();
}

/** attach a value under each (space-separated) itemprop name, arrayifying repeats */
function assignProp(node: JsonLdNode, itemprop: string, value: unknown): void {
  for (const name of itemprop.trim().split(/\s+/)) {
    if (!name) continue;
    const existing = node[name];
    if (existing === undefined) node[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else node[name] = [existing, value];
  }
}

interface PropCapture {
  node: JsonLdNode;
  itemprop: string;
  start: number; // html offset where the element's text content begins
}

interface Frame {
  tag: string;
  /** scope opened BY this element (itemscope) */
  scope: JsonLdNode | null;
  /** text-valued itemprop owned by this element */
  prop: PropCapture | null;
}

export interface MicrodataExtraction {
  /** every itemscope found, JSON-LD-shaped, in document order */
  scopes: JsonLdNode[];
  /** the Product/ProductGroup subset of `scopes` */
  products: JsonLdNode[];
  /** BreadcrumbList item names in order (e.g. ['Home','Shop','Mini Dresses','The Christy - Black']) */
  breadcrumbs: string[];
}

/**
 * Parse all microdata itemscopes out of a page. Never throws on malformed
 * input — worst case it returns empty results.
 */
export function extractMicrodata(html: string): MicrodataExtraction {
  const scopes: JsonLdNode[] = [];
  const roots: JsonLdNode[] = [];
  const stack: Frame[] = [];

  const innermostScope = (): JsonLdNode | null => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].scope) return stack[i].scope;
    }
    return null;
  };

  const finalizeProp = (frame: Frame, end: number): void => {
    if (!frame.prop) return;
    const text = textify(html.slice(frame.prop.start, Math.max(frame.prop.start, end)));
    if (text) assignProp(frame.prop.node, frame.prop.itemprop, text);
    frame.prop = null;
  };

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(html); m !== null; m = TAG_RE.exec(html)) {
    const [, slash, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();

    if (slash) {
      // close tag: pop to the nearest matching open frame (implicit closes on
      // the way — tolerates unclosed <p>/<li> style markup)
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          while (stack.length > i) finalizeProp(stack.pop()!, m.index);
          break;
        }
      }
      continue;
    }

    // script/style bodies can contain '<' soup — skip them wholesale
    if (tag === 'script' || tag === 'style') {
      const close = html.toLowerCase().indexOf(`</${tag}`, TAG_RE.lastIndex);
      TAG_RE.lastIndex = close === -1 ? html.length : close;
      continue;
    }

    const selfClosing = /\/\s*$/.test(attrs);
    const isVoid = VOID_TAGS.has(tag) || selfClosing;
    const itemprop = attrValue(attrs, 'itemprop');
    const parentScope = innermostScope();

    let scope: JsonLdNode | null = null;
    if (hasBooleanAttr(attrs, 'itemscope')) {
      scope = { '@type': typeFromItemtype(attrValue(attrs, 'itemtype')) };
      scopes.push(scope);
      if (itemprop && parentScope) assignProp(parentScope, itemprop, scope);
      else roots.push(scope);
    }

    let prop: PropCapture | null = null;
    if (!scope && itemprop && parentScope) {
      const valueAttr = VALUE_ATTR[tag];
      const explicit =
        attrValue(attrs, 'content') ?? (valueAttr ? attrValue(attrs, valueAttr) : null);
      if (explicit != null) {
        assignProp(parentScope, itemprop, explicit);
      } else if (!isVoid) {
        // value is the element's text content — capture until it closes
        prop = { node: parentScope, itemprop, start: TAG_RE.lastIndex };
      }
    }

    if (!isVoid) stack.push({ tag, scope, prop });
  }
  // unterminated elements: finalize any pending text captures at EOF
  while (stack.length > 0) finalizeProp(stack.pop()!, html.length);

  const products = scopes.filter((s) => {
    const t = String(s['@type'] ?? '').toLowerCase();
    return t === 'product' || t === 'productgroup';
  });

  return { scopes, products, breadcrumbs: breadcrumbNames(roots) };
}

/** BreadcrumbList → its ListItem names, in document order. */
function breadcrumbNames(roots: JsonLdNode[]): string[] {
  const names: string[] = [];
  for (const root of roots) {
    if (String(root['@type'] ?? '').toLowerCase() !== 'breadcrumblist') continue;
    const items = root.itemListElement;
    const arr = Array.isArray(items) ? items : items == null ? [] : [items];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const name = (item as JsonLdNode).name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return names;
}

/**
 * Stage 1 of hybrid free-text search: the deterministic query-token mapper
 * (docs/decisions-search.md). Always on, free, pure.
 *
 * Tokens/bigrams are mapped onto the SAME closed vocabularies the extraction
 * pipeline uses (extraction/taxonomy.ts — occasions, COLOR_TABLE incl.
 * synonyms like blush→pink, length words, fabrics, silhouettes, necklines,
 * patterns), plus price expressions ("under $200", "$100-$200"), size
 * expressions ("size 8") and known brand names. Consumed spans become
 * structured signals; RESIDUAL tokens stay for lexical + semantic matching.
 *
 * Hard/soft rule (the critical design rule): only things the user explicitly
 * CONSTRAINED become hard filters — price, size, length class, brand. Vibe /
 * mood / attribute language (occasion, color, fabric, silhouette, neckline,
 * pattern, and anything residual like "summer" or "cottagecore") NEVER hard
 * filters; it flows into soft ranking signals + the semantic query text.
 */
import type { LengthClass, Silhouette } from '@hemline/contracts';
import {
  COLOR_TABLE,
  FABRIC_KEYWORDS,
  LENGTH_KEYWORDS,
  NECKLINE_KEYWORDS,
  OCCASION_KEYWORDS,
  PATTERN_KEYWORDS,
  SILHOUETTE_KEYWORDS,
} from '../extraction/taxonomy';

export type QuerySignalKind =
  | 'occasion'
  | 'color'
  | 'length'
  | 'fabric'
  | 'silhouette'
  | 'neckline'
  | 'pattern'
  | 'brand'
  | 'price'
  | 'size';

export interface QuerySignal {
  kind: QuerySignalKind;
  /** the raw query text consumed (chip-removal key) */
  term: string;
  /** canonical taxonomy value / display value */
  value: string;
  /** true → SQL hard filter; false → ranking boost only */
  hard: boolean;
}

export interface ParsedQueryHard {
  priceMinCents?: number;
  priceMaxCents?: number;
  sizesNormalized?: number[];
  lengthClasses?: LengthClass[];
  /** expanded to the stored brand labels ("staud" → every "STAUD …" label) */
  brands?: string[];
}

export interface ParsedQuerySoft {
  occasions: string[];
  colorFamilies: string[];
  /** first-word canonical fabric names ('silk', 'linen') */
  fabrics: string[];
  silhouettes: Silhouette[];
  necklines: string[];
  patterns: string[];
}

export interface ParsedQuery {
  signals: QuerySignal[];
  hard: ParsedQueryHard;
  soft: ParsedQuerySoft;
  /** unconsumed, non-stopword tokens — lexical + semantic material */
  residualTokens: string[];
  /** query text for the semantic stage (price/size expressions stripped) */
  semanticText: string;
}

export interface ParseQueryOptions {
  /** distinct stored brand labels (metaFilters.brands) for brand matching */
  knownBrands?: string[];
  /**
   * Terms the user un-chipped: excluded from ALL interpretation (structured
   * and semantic), kept as plain lexical tokens (chips are removable).
   */
  excludeTerms?: string[];
}

/** Query noise that should not become lexical evidence ("a dress for work"). */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'without', 'in', 'on', 'of',
  'to', 'me', 'my', 'i', 'im', "i'm", 'it', 'that', 'this', 'some',
  'something', 'someone', 'please', 'want', 'need', 'looking', 'find', 'show',
  'dress', 'dresses', 'clothes', 'outfit',
]);

/** Tokens with no lexical value once their price/size expression is un-chipped. */
const CONSTRAINT_NOISE = new Set([
  'under', 'over', 'below', 'above', 'between', 'less', 'more', 'than', 'at',
  'least', 'most', 'max', 'maximum', 'min', 'minimum', 'up', 'to', 'and',
  'size', 'sz', 'us', 'dollars', 'bucks', 'usd',
]);

const MONEY = String.raw`\$?\s?(\d{1,5}(?:\.\d{1,2})?)`;
const MONEY_SUFFIX = String.raw`(?:\s*(?:dollars|bucks|usd))?`;

const PRICE_MAX_RE = new RegExp(
  String.raw`\b(?:under|below|less\s+than|at\s+most|max(?:imum)?(?:\s+of)?|up\s+to|no\s+more\s+than|cheaper\s+than)\s+${MONEY}${MONEY_SUFFIX}`,
  'i',
);
const PRICE_MIN_RE = new RegExp(
  String.raw`\b(?:over|above|more\s+than|at\s+least|min(?:imum)?(?:\s+of)?|starting\s+at)\s+${MONEY}${MONEY_SUFFIX}`,
  'i',
);
const PRICE_RANGE_RES = [
  new RegExp(String.raw`\bbetween\s+${MONEY}\s+and\s+${MONEY}${MONEY_SUFFIX}`, 'i'),
  // at least one side must carry a "$" so "size 8-10" never reads as a price
  /\$\s?(\d{1,5}(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$?\s?(\d{1,5}(?:\.\d{1,2})?)/i,
  /(\d{1,5}(?:\.\d{1,2})?)\s*(?:-|–|—|to)\s*\$\s?(\d{1,5}(?:\.\d{1,2})?)/i,
];

const SIZE_RE = /\b(?:size|sz|us)\s*(\d{1,2})\b/i;

/* ── search-side synonym tables (2026-07 zero-result mining) ────────────────
 * Prod's admin analytics had NO zero-result queries yet (every founder search
 * returned results), so beyond the two real-data gaps ("funeral"; "gown"
 * already partially mapped) these are the most plausible fashion-vocabulary
 * gaps. They live HERE, not in extraction/taxonomy.ts, because they are
 * QUERY vocabulary — sellers don't title dresses "LBD", shoppers type it —
 * and extending the shared extraction tables would change extraction output.
 */

/**
 * Color words shoppers use that the extraction COLOR_TABLE lacks. Consumed
 * exactly like COLOR_TABLE entries (soft family signal, token leaves the
 * residual). Families must exist in COLOR_TABLE (COLOR_FAMILIES validation).
 */
export const SEARCH_COLOR_SYNONYMS: Array<[RegExp, { family: string }]> = [
  [/\bcoral\b/i, { family: 'pink' }],
  [/\bfuchsia\b/i, { family: 'pink' }],
  [/\bmagenta\b/i, { family: 'pink' }],
  [/\bmint\b/i, { family: 'green' }],
  [/\bturquoise\b/i, { family: 'blue' }],
  [/\baqua\b/i, { family: 'blue' }],
  [/\bindigo\b/i, { family: 'blue' }],
  [/\bmaroon\b/i, { family: 'red' }],
  [/\bpeach\b/i, { family: 'orange' }],
  [/\bchampagne\b/i, { family: 'metallic' }],
];

interface VibeSynonym {
  occasions?: string[];
  colorFamilies?: string[];
  patterns?: string[];
  silhouettes?: Silhouette[];
}

/**
 * Aesthetic/occasion vocabulary → soft ranking boosts. Matched
 * NON-consumingly: the word keeps its lexical + semantic value (a listing
 * titled "Cottagecore gingham midi" must still match the query "cottagecore"
 * lexically), it just ALSO carries deterministic attribute boosts so these
 * queries survive keyless/no-sidecar deployments. Soft only — the hard/soft
 * rule stands: vibe language never filters.
 */
export const VIBE_SYNONYMS: Array<[RegExp, VibeSynonym]> = [
  [/\bsundress(?:es)?\b/i, { occasions: ['casual', 'vacation'] }],
  [
    /\b(?:lbd|little\s+black\s+dress)\b/i,
    { colorFamilies: ['black'], occasions: ['cocktail', 'party'] },
  ],
  // real prod query (7d topSearches): "funeral" mapped to nothing
  [/\bfunerals?\b/i, { occasions: ['formal'], colorFamilies: ['black'] }],
  [/\bboho(?:[-\s]?chic)?\b|\bbohemian\b/i, { patterns: ['floral'], silhouettes: ['tent'] }],
  [/\bcottage[-\s]?core\b/i, { patterns: ['floral', 'gingham'] }],
  [/\bpreppy\b/i, { patterns: ['gingham', 'plaid'] }],
  [/\bminimal(?:ist)?\b/i, { patterns: ['solid'] }],
];

/**
 * "gown" (ball/evening gown, plural too): a formal long-dress word. Hard
 * length widened to BOTH maxi and floor — catalogs class gowns either way,
 * and a floor-only filter starved "gown" queries of maxi-classed gowns —
 * plus a soft formal boost.
 */
export const GOWN_RE = /\b(?:ball[\s-]+|evening[\s-]+)?gowns?\b/i;

const toCents = (s: string): number => Math.round(Number(s) * 100);

/** Blank a span in-place-safe: same length, spaces (offsets stay stable). */
function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

/** Consume every (non-overlapping) match of `re` in `working`, blanking spans. */
function consumeRegex(
  working: { text: string },
  re: RegExp,
): Array<{ term: string; groups: string[] }> {
  const out: Array<{ term: string; groups: string[] }> = [];
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = global.exec(working.text)) !== null) {
    out.push({ term: m[0].trim(), groups: m.slice(1) });
    working.text = blank(working.text, m.index, m[0].length);
    global.lastIndex = m.index + m[0].length;
  }
  return out;
}

/**
 * Consume all matches of a keyword table (first-listed regex wins overlapping
 * spans, mirroring extraction's multi-word-before-substring convention).
 */
function consumeTable<T>(
  working: { text: string },
  table: Array<[RegExp, T]>,
): Array<{ term: string; value: T }> {
  const out: Array<{ term: string; value: T }> = [];
  for (const [re, value] of table) {
    for (const hit of consumeRegex(working, re)) {
      out.push({ term: hit.term, value });
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Brand match: an n-gram (3→1 words, longest first) counts as a brand when it
 * equals a known brand label or is its LEADING word sequence ("staud" →
 * "STAUD FALL 2025"; "sister jane" → "Sister Jane Exclusives"). Leading-only
 * on purpose: mid-label containment would let "the" consume
 * "Before The Break …". The hard filter expands to EVERY label containing the
 * n-gram as a word sequence, because store feeds use collection-suffixed
 * labels ("POPPY x Sister Jane") that exact `brand IN (…)` SQL would miss.
 */
function matchBrands(
  working: { text: string },
  knownBrands: string[],
): Array<{ term: string; canonical: string; expanded: string[] }> {
  if (knownBrands.length === 0) return [];
  const out: Array<{ term: string; canonical: string; expanded: string[] }> = [];
  for (let n = 3; n >= 1; n--) {
    const tokens = working.text.toLowerCase().split(/\s+/);
    // regenerate n-grams against the current (partially blanked) text
    const ngrams = new Set<string>();
    for (let i = 0; i + n <= tokens.length; i++) {
      const g = tokens.slice(i, i + n).filter(Boolean);
      if (g.length === n) ngrams.add(g.join(' '));
    }
    for (const g of ngrams) {
      const match = expandKnownBrand(g, knownBrands);
      if (!match) continue;
      const re = new RegExp(String.raw`\b${escapeRegExp(g).replace(/ /g, String.raw`\s+`)}\b`, 'i');
      const consumed = consumeRegex(working, re);
      if (consumed.length === 0) continue;
      out.push({ term: consumed[0].term, canonical: match.canonical, expanded: match.expanded });
    }
  }
  return out;
}

/**
 * Validate/expand a brand mention against the stored brand labels. Returns
 * null when `name` is not a known brand (LLM-suggested brands go through this
 * so a hallucinated brand can never hard-filter the results to zero).
 */
export function expandKnownBrand(
  name: string,
  knownBrands: string[],
): { canonical: string; expanded: string[] } | null {
  const gWords = words(name);
  if (gWords.length === 0 || gWords.every((w) => STOPWORDS.has(w))) return null;
  const brandWords = knownBrands.map((b) => ({ raw: b, words: words(b) }));
  const isLeading = (bw: string[]) =>
    bw.length >= gWords.length && gWords.every((w, i) => bw[i] === w);
  const leadingHits = brandWords.filter((b) => isLeading(b.words));
  if (leadingHits.length === 0) return null;
  const containsSeq = (bw: string[]) => {
    for (let i = 0; i + gWords.length <= bw.length; i++) {
      if (gWords.every((w, j) => bw[i + j] === w)) return true;
    }
    return false;
  };
  const expanded = brandWords.filter((b) => containsSeq(b.words)).map((b) => b.raw);
  const canonical = leadingHits.map((b) => b.raw).sort((a, b) => a.length - b.length)[0];
  return { canonical, expanded };
}

function formatPrice(minCents?: number, maxCents?: number): string {
  const f = (c: number) => `$${Math.round(c / 100)}`;
  if (minCents != null && maxCents != null) return `${f(minCents)}–${f(maxCents)}`;
  if (maxCents != null) return `under ${f(maxCents)}`;
  return `over ${f(minCents!)}`;
}

const unique = <T,>(xs: T[]): T[] => [...new Set(xs)];

/**
 * The stage-1 parser. Pure and synchronous — same input, same output.
 */
export function parseQueryDeterministic(
  q: string,
  opts: ParseQueryOptions = {},
): ParsedQuery {
  const signals: QuerySignal[] = [];
  const hard: ParsedQueryHard = {};
  const soft: ParsedQuerySoft = {
    occasions: [],
    colorFamilies: [],
    fabrics: [],
    silhouettes: [],
    necklines: [],
    patterns: [],
  };

  const working = { text: q };
  const forcedLexical: string[] = [];

  // 0. un-chipped terms: strip them BEFORE interpretation; they re-enter as
  //    plain lexical tokens only (and never reach the semantic text either).
  for (const term of opts.excludeTerms ?? []) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const re = new RegExp(
      String.raw`\b${escapeRegExp(trimmed).replace(/\s+/g, String.raw`\s+`)}\b`,
      'i',
    );
    for (const hit of consumeRegex(working, re)) {
      for (const tok of words(hit.term)) {
        if (!STOPWORDS.has(tok) && !CONSTRAINT_NOISE.has(tok) && !/^\$?\d/.test(tok)) {
          forcedLexical.push(tok);
        }
      }
    }
  }

  // 1. price expressions (hard) — ranges first so "under" never eats one bound
  for (const re of PRICE_RANGE_RES) {
    for (const hit of consumeRegex(working, re)) {
      const [lo, hi] = [toCents(hit.groups[0]), toCents(hit.groups[1])].sort((a, b) => a - b);
      hard.priceMinCents ??= lo;
      hard.priceMaxCents ??= hi;
      signals.push({ kind: 'price', term: hit.term, value: formatPrice(lo, hi), hard: true });
    }
  }
  for (const hit of consumeRegex(working, PRICE_MAX_RE)) {
    const cents = toCents(hit.groups[0]);
    hard.priceMaxCents ??= cents;
    signals.push({ kind: 'price', term: hit.term, value: formatPrice(undefined, cents), hard: true });
  }
  for (const hit of consumeRegex(working, PRICE_MIN_RE)) {
    const cents = toCents(hit.groups[0]);
    hard.priceMinCents ??= cents;
    signals.push({ kind: 'price', term: hit.term, value: formatPrice(cents, undefined), hard: true });
  }

  // 2. size expressions (hard)
  for (const hit of consumeRegex(working, SIZE_RE)) {
    const size = Number(hit.groups[0]);
    if (size >= 0 && size <= 26) {
      hard.sizesNormalized = unique([...(hard.sizesNormalized ?? []), size]);
      signals.push({ kind: 'size', term: hit.term, value: `size ${size}`, hard: true });
    }
  }

  // 3. brand names (hard) — before taxonomy so a brand word that happens to be
  //    a color/fabric word ("Camel Collective") is claimed by the brand.
  for (const b of matchBrands(working, opts.knownBrands ?? [])) {
    hard.brands = unique([...(hard.brands ?? []), ...b.expanded]);
    signals.push({ kind: 'brand', term: b.term, value: b.canonical, hard: true });
  }

  // semantic text keeps attribute/vibe words but not constraint syntax —
  // capture it here, after hard-expression blanking, before soft consumption.
  const semanticText = working.text.replace(/\s+/g, ' ').trim();

  // 4. length classes (hard — an explicit garment-length constraint)
  //    4a. "gown" first (before LENGTH_KEYWORDS' floor rule claims it):
  //        widened to maxi+floor, plus a soft formal boost.
  for (const hit of consumeRegex(working, GOWN_RE)) {
    for (const lc of ['maxi', 'floor'] as LengthClass[]) {
      if (!hard.lengthClasses?.includes(lc)) {
        hard.lengthClasses = [...(hard.lengthClasses ?? []), lc];
        signals.push({ kind: 'length', term: hit.term, value: lc, hard: true });
      }
    }
    if (!soft.occasions.includes('formal')) {
      soft.occasions.push('formal');
      signals.push({ kind: 'occasion', term: hit.term, value: 'formal', hard: false });
    }
  }
  for (const hit of consumeTable(working, LENGTH_KEYWORDS)) {
    if (!hard.lengthClasses?.includes(hit.value)) {
      hard.lengthClasses = [...(hard.lengthClasses ?? []), hit.value];
      signals.push({ kind: 'length', term: hit.term, value: hit.value, hard: true });
    }
  }

  // 5. soft taxonomy signals (ranking boosts, never filters)
  //    5a. vibe synonyms first, NON-consuming: the aesthetic word keeps its
  //        lexical/semantic value and additionally boosts mapped attributes.
  for (const [re, syn] of VIBE_SYNONYMS) {
    const m = re.exec(working.text);
    if (!m) continue;
    const term = m[0].trim();
    for (const o of syn.occasions ?? []) {
      if (soft.occasions.includes(o)) continue;
      soft.occasions.push(o);
      signals.push({ kind: 'occasion', term, value: o, hard: false });
    }
    for (const c of syn.colorFamilies ?? []) {
      if (soft.colorFamilies.includes(c)) continue;
      soft.colorFamilies.push(c);
      signals.push({ kind: 'color', term, value: c, hard: false });
    }
    for (const p of syn.patterns ?? []) {
      if (soft.patterns.includes(p)) continue;
      soft.patterns.push(p);
      signals.push({ kind: 'pattern', term, value: p, hard: false });
    }
    for (const s of syn.silhouettes ?? []) {
      if (soft.silhouettes.includes(s)) continue;
      soft.silhouettes.push(s);
      signals.push({ kind: 'silhouette', term, value: s, hard: false });
    }
  }
  for (const hit of consumeTable(working, SILHOUETTE_KEYWORDS)) {
    if (!soft.silhouettes.includes(hit.value)) {
      soft.silhouettes.push(hit.value);
      signals.push({ kind: 'silhouette', term: hit.term, value: hit.value, hard: false });
    }
  }
  for (const hit of consumeTable(working, NECKLINE_KEYWORDS)) {
    if (!soft.necklines.includes(hit.value)) {
      soft.necklines.push(hit.value);
      signals.push({ kind: 'neckline', term: hit.term, value: hit.value, hard: false });
    }
  }
  for (const hit of consumeTable(working, FABRIC_KEYWORDS)) {
    const fabric = hit.value.split(/\s+/)[0];
    if (!soft.fabrics.includes(fabric)) {
      soft.fabrics.push(fabric);
      signals.push({ kind: 'fabric', term: hit.term, value: fabric, hard: false });
    }
  }
  for (const hit of consumeTable(working, PATTERN_KEYWORDS)) {
    if (!soft.patterns.includes(hit.value)) {
      soft.patterns.push(hit.value);
      signals.push({ kind: 'pattern', term: hit.term, value: hit.value, hard: false });
    }
  }
  for (const hit of consumeTable(working, COLOR_TABLE)) {
    if (!soft.colorFamilies.includes(hit.value.family)) {
      soft.colorFamilies.push(hit.value.family);
      signals.push({ kind: 'color', term: hit.term, value: hit.value.family, hard: false });
    }
  }
  for (const hit of consumeTable(working, SEARCH_COLOR_SYNONYMS)) {
    if (!soft.colorFamilies.includes(hit.value.family)) {
      soft.colorFamilies.push(hit.value.family);
      signals.push({ kind: 'color', term: hit.term, value: hit.value.family, hard: false });
    }
  }
  for (const hit of consumeTable(working, OCCASION_KEYWORDS)) {
    if (!soft.occasions.includes(hit.value)) {
      soft.occasions.push(hit.value);
      signals.push({ kind: 'occasion', term: hit.term, value: hit.value, hard: false });
    }
  }

  // 6. residual = whatever survived, minus stopwords, plus un-chipped terms
  const residualTokens = unique([
    ...working.text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ...forcedLexical,
  ]);

  return { signals, hard, soft, residualTokens, semanticText };
}

/** Known color FAMILIES (validation set for LLM-suggested families). */
export const COLOR_FAMILIES: readonly string[] = unique(
  COLOR_TABLE.map(([, tag]) => tag.family),
);

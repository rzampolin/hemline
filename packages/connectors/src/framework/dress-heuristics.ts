/**
 * Dresses-only heuristics + attribute-hint keyword tables, shared by the
 * Shopify and JSON-LD connectors (extracted from shopify/normalize.ts so both
 * stay in lockstep). Pure regex/string matching — no HTTP, no schema types
 * beyond @hemline/contracts.
 */
import type { ExtractedAttributes, LengthClass } from '@hemline/contracts';

export const DRESS_RE = /\bdress(es)?\b/i;

/** things that contain the word "dress" but are not dresses */
export const NOT_A_DRESS_RE =
  /\bdress[ -](shirt|shoe|pant|sock|watch|belt)s?\b|\bdressing gown\b|\bdress(ing)? (robe|coat)\b/i;

/** product types/categories that are definitely another category */
export const OTHER_CATEGORY_RE =
  /\b(top|tee|t-shirt|shirt|blouse|skirt|pant|trouser|jean|short|jumpsuit|romper|playsuit|sweater|knitwear|cardigan|jacket|coat|blazer|swim|bikini|bag|tote|shoe|boot|sandal|belt|hat|scarf|jewel|earring|necklace|accessor|gift card)\b/i;

/** Does this text affirmatively read as a dress (and not a dress shirt…)? */
export function isDressText(text: string): boolean {
  return DRESS_RE.test(text) && !NOT_A_DRESS_RE.test(text);
}

const SIZE_LABEL_RE =
  /^(xxs|xs|s|m|l|xl|xxl|2xl|3xl|xs\/s|m\/l|one size|os|\d{1,2}|us ?\d{1,2}|uk ?\d{1,2}|eu ?\d{2})$/i;

export function looksLikeSizeLabel(v: string): boolean {
  return SIZE_LABEL_RE.test(v.trim());
}

// ── audience gate: is this dress for a CHILD? (founder bug 2026-07-09) ─────
//
// Two independent signals, either of which excludes a listing:
//  1. child keywords in the product-level metadata (title / product_type /
//     tags / image alt text — NEVER the description, which routinely carries
//     cross-sell copy like "shop the mini-me version for your little one" on
//     ADULT dresses);
//  2. a size set that is MAJORITY kid-pattern labels (slash-pair years 2/3…,
//     toddler 2T–6T, 4Y, "18-24M" months). Plain numerics [2,4,6,8,10] alone
//     are NOT a signal — that is a perfectly valid adult US run (and exactly
//     what Dôen's kids line ships, which is why the vision layer exists).
//
// Adult false-positive traps handled explicitly (all MUST-KEEP, tested):
// "mini dress" (mini = length class), "baby blue / baby pink" (color),
// "babydoll / baby doll dress" (adult silhouette), "baby shower dress"
// (adult occasion), "girls night out" (adult party copy), "girl boss" /
// "it girl" (bare singular "girl" never matches), "junior" alone (adult US
// size category), "little black dress".

/**
 * Child-audience keywords, word-boundary + context-guarded. Matched against
 * product-level metadata text only (see block comment above).
 */
export const CHILD_KEYWORD_RE = new RegExp(
  [
    // girls / girl's — but NOT adult "girls night/trip/weekend" copy
    String.raw`\bgirl'?s\b(?!'?\s+(?:night|trip|weekend|getaway))`,
    // kids / kid's — bare singular "kid" excluded ("kid mohair" is a fabric)
    String.raw`\bkid'?s\b`,
    // child/children — but NOT print/name copy like Motel Rocks' "Star Child
    // Glitter Net" (prod false positive 2026-07-09): require it NOT be
    // preceded by star/moon/wild/flower (adult print vocabulary)
    String.raw`(?<!\bstar\s)(?<!\bmoon\s)(?<!\bwild\s)(?<!\bflower\s)\bchild(?:ren)?(?:'s)?\b`,
    String.raw`\btoddlers?\b`,
    String.raw`\binfants?\b`,
    String.raw`\bnewborns?\b`,
    String.raw`\btweens?\b`,
    String.raw`\byouth\b`,
    String.raw`\bjunior\s+girls\b`,
    // baby — but NOT color ("baby blue"), silhouette ("baby doll"; one-word
    // "babydoll" never matches \bbaby\b), occasion ("baby shower"), maternity
    // ("baby bump"), the flower print ("baby's breath"), or Selkie's adult
    // "Baby Soft <name>" fabric-collection titles and cutesy adult names like
    // "The Baby Banana Puff Dress" (prod false positives 2026-07-09): "baby"
    // followed by soft/banana or any capitalized-fruit-ish single token then
    // an adult garment word is name-copy, not audience. Pragmatic guard:
    // require baby NOT be immediately followed by soft/banana.
    String.raw`\bbaby\b(?!\s+(?:blues?\b|pinks?\b|yellows?\b|greens?\b|doll\b|showers?\b|bump\b|soft\b|banana\b)|'s\s+breath)`,
    // the kid half of a matching set
    String.raw`\bmini[\s-]?me\b`,
    String.raw`\bmomm?y[\s-]?(?:and|&|n)[\s-]?me\b`,
    String.raw`\bmatching\s+family\b`,
    // photo alt copy (live-probed 2026-07-09: shopdoen.com LUCY DRESS carries
    // alt "Young girl in a plaid dress" while every other field reads adult)
    String.raw`\b(?:young|little)\s+(?:girl|boy)s?\b`,
  ].join('|'),
  'i',
);

/**
 * Does one variant label look like a KID size?
 * - slash-pair years: 2/3 … 14/15 (consecutive only — adult dual sizing like
 *   "6/8" keeps a gap of 2 and must NOT match)
 * - toddler: 2T–6T, NB (newborn)
 * - years: 4Y, "10 yrs", "8 years"
 * - months: 12M, 18-24M, "3-6 months"
 */
export function looksLikeKidSizeLabel(label: string): boolean {
  const v = label.trim().toLowerCase();
  const pair = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(v);
  if (pair) {
    const a = Number(pair[1]);
    const b = Number(pair[2]);
    return a >= 1 && b <= 16 && b - a === 1;
  }
  if (/^[2-6]t$/.test(v)) return true;
  if (v === 'nb') return true;
  if (/^\d{1,2}\s*(?:y|yrs?|years?)$/.test(v)) return true;
  if (/^\d{1,2}(?:\s*-\s*\d{1,2})?\s*m(?:o|os|onths?)?$/.test(v)) return true;
  return false;
}

/** True when MORE THAN HALF of the size labels are kid patterns. */
export function majorityKidSizeLabels(labels: string[]): boolean {
  if (labels.length === 0) return false;
  const kid = labels.filter(looksLikeKidSizeLabel).length;
  return kid * 2 > labels.length;
}

export interface AudienceSignal {
  /** product-level metadata: title, product_type, tags, image alts — NOT the description */
  text?: string;
  sizeLabels?: string[];
}

export interface ChildAudienceVerdict {
  child: boolean;
  /** which signal fired, for reports/logs ('keyword:<match>' | 'kid_sizes') */
  reason: string | null;
}

/** The shared audience gate — used by the Shopify + JSON-LD connectors and the purge script. */
export function detectChildAudience(signal: AudienceSignal): ChildAudienceVerdict {
  if (signal.text) {
    const m = CHILD_KEYWORD_RE.exec(signal.text);
    if (m) return { child: true, reason: `keyword:${m[0].toLowerCase()}` };
  }
  if (signal.sizeLabels && majorityKidSizeLabels(signal.sizeLabels)) {
    return { child: true, reason: 'kid_sizes' };
  }
  return { child: false, reason: null };
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

/** Pre-fill structured hints from free text (title/type/tags — doc §4.1). */
export function attributeHintsFromText(haystack: string): Partial<ExtractedAttributes> {
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

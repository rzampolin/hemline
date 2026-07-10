/**
 * Closed vocabularies + keyword tables — docs/ARCHITECTURE.md §7.2.
 *
 * Fashionpedia-derived enums shared by the live prompt (as schema enums) and
 * the deterministic mock extractor (as keyword matchers). Multi-word phrases
 * are listed before their single-word substrings so first-match wins.
 */
import type { ColorTag, ExtractedAttributes, LengthClass, Silhouette } from '@hemline/contracts';

export const NECKLINES = [
  'v_neck',
  'crew',
  'scoop',
  'square',
  'sweetheart',
  'halter',
  'off_shoulder',
  'one_shoulder',
  'cowl',
  'boat',
  'high_neck',
  'collared',
  'strapless',
  'keyhole',
] as const;

export const SLEEVES = [
  'sleeveless',
  'spaghetti_strap',
  'strapless',
  'cap',
  'short',
  'elbow',
  'three_quarter',
  'long',
  'puff',
  'balloon',
  'flutter',
  'bell',
] as const;

export const PATTERNS = [
  'solid',
  'floral',
  'ditsy_floral',
  'polka_dot',
  'stripe',
  'gingham',
  'plaid',
  'paisley',
  'animal',
  'abstract',
  'geometric',
  'tie_dye',
] as const;

export const OCCASIONS = [
  'casual',
  'work',
  'cocktail',
  'formal',
  'wedding_guest',
  'date_night',
  'brunch',
  'vacation',
  'party',
] as const;

/** Who the garment is for (contracts AudienceSchema; additive 2026-07-09). */
export const AUDIENCES = ['adult', 'child'] as const;

/**
 * Keyword fallback for the mock extractor: 'child' on unambiguous kid copy,
 * null otherwise (never guess 'adult' from silence). Context-guarded against
 * the adult traps — "mini dress", "baby blue", "baby doll"/"babydoll" (adult
 * silhouette), "baby shower", "girls night out", "girl boss" (bare singular
 * "girl" never matches), plain "junior" (adult US size category). Mirrors the
 * connector-level gate in @hemline/connectors framework/dress-heuristics.ts —
 * kept separate because the packages share no dependency edge (same pattern
 * as LENGTH_KEYWORDS here vs LENGTH_HINTS there).
 */
export const CHILD_AUDIENCE_RE = new RegExp(
  [
    String.raw`\bgirl'?s\b(?!'?\s+(?:night|trip|weekend|getaway))`,
    String.raw`\bkid'?s\b`,
    String.raw`\bchild(?:ren)?(?:'s)?\b`,
    String.raw`\btoddlers?\b`,
    String.raw`\binfants?\b`,
    String.raw`\bnewborns?\b`,
    String.raw`\btweens?\b`,
    String.raw`\byouth\b`,
    String.raw`\bjunior\s+girls\b`,
    String.raw`\bbaby\b(?!\s+(?:blues?\b|pinks?\b|yellows?\b|greens?\b|doll\b|showers?\b|bump\b)|'s\s+breath)`,
    String.raw`\bmini[\s-]?me\b`,
    String.raw`\bmomm?y[\s-]?(?:and|&|n)[\s-]?me\b`,
    String.raw`\b(?:young|little)\s+(?:girl|boy)s?\b`,
  ].join('|'),
  'i',
);

export function audienceFromText(text: string): 'child' | null {
  return CHILD_AUDIENCE_RE.test(text) ? 'child' : null;
}

// ── keyword → taxonomy tables (checked in order; first match wins) ─────────

export const LENGTH_KEYWORDS: Array<[RegExp, LengthClass]> = [
  [/\bmicro\b/i, 'micro'],
  [/\bmini\b/i, 'mini'],
  [/\babove[-\s]knee\b/i, 'above_knee'],
  [/\bshort\s+dress\b/i, 'above_knee'],
  [/\bknee[-\s]?length\b/i, 'knee'],
  [/\bknee\b/i, 'knee'],
  [/\bmidi\b/i, 'midi'],
  [/\b(mid[-\s]?calf|tea[-\s]?length)\b/i, 'mid_calf'],
  [/\bmaxi\b/i, 'maxi'],
  // "ankle length/ankle-grazing" is common DTC copy (e.g. Christy Dawn);
  // garment-class maxi (55" prior) lands in the ankle zone on the ref body.
  [/\bankle[-\s]?(?:length|grazing)\b/i, 'maxi'],
  [/\b(floor[-\s]?length|gown|full[-\s]?length)\b/i, 'floor'],
];

export const SILHOUETTE_KEYWORDS: Array<[RegExp, Silhouette]> = [
  [/\b(fit[-\s]?(?:and|&|n)[-\s]?flare|skater)\b/i, 'fit_and_flare'],
  [/\ba[-\s]?line\b/i, 'a_line'],
  [/\bsheath\b/i, 'sheath'],
  [/\bfaux[-\s]?wrap\b/i, 'wrap'],
  [/\bwrap\b/i, 'wrap'],
  [/\bslip\b/i, 'slip'],
  [/\b(shirt[-\s]?dress|shirtdress|shirt\s+silhouette)\b/i, 'shirt'],
  [/\b(bodycon|body[-\s]?con|bandage)\b/i, 'bodycon'],
  [/\b(trapeze|tent|swing|smock(?:ed)?\s+silhouette)\b/i, 'tent'],
  [/\bempire(?:[-\s]waist)?\b/i, 'empire'],
  [/\bshift\b/i, 'sheath'],
  [/\brelaxed\s+silhouette\b/i, 'other'],
];

export const NECKLINE_KEYWORDS: Array<[RegExp, string]> = [
  [/\bv[-\s]?neck\b/i, 'v_neck'],
  [/\b(crew|round)[-\s]?neck\b/i, 'crew'],
  [/\bcrew\b/i, 'crew'],
  [/\bscoop\b/i, 'scoop'],
  [/\bsquare[-\s]?neck\b/i, 'square'],
  [/\bsquare\b/i, 'square'],
  [/\bsweetheart\b/i, 'sweetheart'],
  [/\bhalter\b/i, 'halter'],
  [/\boff[-\s](?:the[-\s])?shoulder\b/i, 'off_shoulder'],
  [/\bone[-\s]shoulder\b/i, 'one_shoulder'],
  [/\bcowl\b/i, 'cowl'],
  [/\b(boat[-\s]?neck|boatneck|bateau)\b/i, 'boat'],
  [/\b(high[-\s]?neck|mock[-\s]?neck|turtleneck)\b/i, 'high_neck'],
  [/\b(collared|collar)\b/i, 'collared'],
  [/\bstrapless\b/i, 'strapless'],
  [/\bkeyhole\b/i, 'keyhole'],
];

export const SLEEVE_KEYWORDS: Array<[RegExp, string]> = [
  [/\bspaghetti[-\s]strap/i, 'spaghetti_strap'],
  [/\bsleeveless\b/i, 'sleeveless'],
  [/\bstrapless\b/i, 'strapless'],
  [/\bcap[-\s]sleeve/i, 'cap'],
  [/\bshort[-\s]sleeve/i, 'short'],
  [/\belbow[-\s]sleeve/i, 'elbow'],
  [/\b(three[-\s]quarter|3\/4)[-\s]sleeve/i, 'three_quarter'],
  [/\blong[-\s]sleeve/i, 'long'],
  [/\bpuff(?:ed)?[-\s]sleeve/i, 'puff'],
  [/\bballoon[-\s]sleeve/i, 'balloon'],
  [/\bflutter[-\s]sleeve/i, 'flutter'],
  [/\bbell[-\s]sleeve/i, 'bell'],
];

export const PATTERN_KEYWORDS: Array<[RegExp, string]> = [
  [/\bditsy[-\s]floral\b/i, 'ditsy_floral'],
  [/\bfloral\b/i, 'floral'],
  [/\bpolka[-\s]dot/i, 'polka_dot'],
  [/\bstripe[sd]?\b/i, 'stripe'],
  [/\bgingham\b/i, 'gingham'],
  [/\bplaid\b/i, 'plaid'],
  [/\bpaisley\b/i, 'paisley'],
  [/\b(animal(?:[-\s]print)?|zebra|snake(?:skin)?|cheetah)\b/i, 'animal'],
  [/\babstract\b/i, 'abstract'],
  [/\bgeometric\b/i, 'geometric'],
  [/\btie[-\s]dye\b/i, 'tie_dye'],
  [/\bsolid\b/i, 'solid'],
];

export const FABRIC_KEYWORDS: Array<[RegExp, string]> = [
  [/\bviscose\s+crepe\b/i, 'viscose crepe'],
  [/\bcotton\s+poplin\b/i, 'cotton poplin'],
  [/\bjersey(?:\s+knit)?\b/i, 'jersey knit'],
  [/\bsilk\s+charmeuse\b/i, 'silk charmeuse'],
  [/\bseersucker\b/i, 'seersucker'],
  [/\bchiffon\b/i, 'chiffon'],
  [/\bsatin\b/i, 'satin'],
  [/\bvelvet\b/i, 'velvet'],
  [/\btaffeta\b/i, 'taffeta'],
  [/\blinen\b/i, 'linen'],
  [/\blace\b/i, 'lace'],
  [/\bcrepe\b/i, 'crepe'],
  [/\bsilk\b/i, 'silk'],
  [/\brayon\b/i, 'rayon'],
  [/\bviscose\b/i, 'viscose'],
  [/\bpolyester\b/i, 'polyester'],
  [/\bcotton\b/i, 'cotton'],
  [/\bdenim\b/i, 'denim'],
  [/\bwool\b/i, 'wool'],
  [/\bknit\b/i, 'knit'],
];

/** Fabrics that drape/stretch → §5 "stretchy" hem adjustment. */
export const STRETCHY_FABRICS = new Set(['jersey knit', 'knit', 'rib knit']);

export const OCCASION_KEYWORDS: Array<[RegExp, string]> = [
  [/\bwedding[-\s]guest\b/i, 'wedding_guest'],
  [/\bwedding\b/i, 'wedding_guest'],
  [/\bcocktail\b/i, 'cocktail'],
  [/\b(formal|black[-\s]tie|evening)\b/i, 'formal'],
  [/\b(work|office)\b/i, 'work'],
  [/\bdate[-\s]night\b/i, 'date_night'],
  [/\bbrunch\b/i, 'brunch'],
  [/\b(vacation|beach|resort)\b/i, 'vacation'],
  [/\bparty\b/i, 'party'],
  [/\b(casual|everyday)\b/i, 'casual'],
];

/** Multi-word color names first; family + representative hex per name. */
export const COLOR_TABLE: Array<[RegExp, ColorTag]> = [
  [/\bburnt\s+orange\b/i, { name: 'burnt orange', family: 'orange', hex: '#CC5500' }],
  [/\bhot\s+pink\b/i, { name: 'hot pink', family: 'pink', hex: '#FF69B4' }],
  [/\bdusty\s+rose\b/i, { name: 'dusty rose', family: 'pink', hex: '#DCAE96' }],
  [/\bpowder\s+blue\b/i, { name: 'powder blue', family: 'blue', hex: '#B0E0E6' }],
  [/\bbutter\s+yellow\b/i, { name: 'butter yellow', family: 'yellow', hex: '#FFFD74' }],
  [/\bforest\s+green\b/i, { name: 'forest green', family: 'green', hex: '#228B22' }],
  [/\bcherry\s+red\b/i, { name: 'cherry red', family: 'red', hex: '#D2042D' }],
  [/\bburgundy\b/i, { name: 'burgundy', family: 'red', hex: '#800020' }],
  [/\bplum\b/i, { name: 'plum', family: 'purple', hex: '#8E4585' }],
  [/\blilac\b/i, { name: 'lilac', family: 'purple', hex: '#C8A2C8' }],
  [/\blavender\b/i, { name: 'lavender', family: 'purple', hex: '#B57EDC' }],
  [/\bpurple\b/i, { name: 'purple', family: 'purple', hex: '#800080' }],
  [/\bcharcoal\b/i, { name: 'charcoal', family: 'gray', hex: '#36454F' }],
  [/\bgr[ae]y\b/i, { name: 'gray', family: 'gray', hex: '#808080' }],
  [/\bblack\b/i, { name: 'black', family: 'black', hex: '#000000' }],
  [/\bivory\b/i, { name: 'ivory', family: 'white', hex: '#FFFFF0' }],
  [/\bcream\b/i, { name: 'cream', family: 'white', hex: '#FFFDD0' }],
  [/\bwhite\b/i, { name: 'white', family: 'white', hex: '#FFFFFF' }],
  [/\bnavy\b/i, { name: 'navy', family: 'blue', hex: '#000080' }],
  [/\bcobalt\b/i, { name: 'cobalt', family: 'blue', hex: '#0047AB' }],
  [/\bblue\b/i, { name: 'blue', family: 'blue', hex: '#0000CD' }],
  [/\bemerald\b/i, { name: 'emerald', family: 'green', hex: '#50C878' }],
  [/\bsage\b/i, { name: 'sage', family: 'green', hex: '#9CAF88' }],
  [/\bolive\b/i, { name: 'olive', family: 'green', hex: '#808000' }],
  [/\bgreen\b/i, { name: 'green', family: 'green', hex: '#008000' }],
  [/\bmustard\b/i, { name: 'mustard', family: 'yellow', hex: '#E1AD01' }],
  [/\byellow\b/i, { name: 'yellow', family: 'yellow', hex: '#FFD700' }],
  [/\bterracotta\b/i, { name: 'terracotta', family: 'orange', hex: '#E2725B' }],
  [/\brust\b/i, { name: 'rust', family: 'orange', hex: '#B7410E' }],
  [/\borange\b/i, { name: 'orange', family: 'orange', hex: '#FF8C00' }],
  [/\bblush\b/i, { name: 'blush', family: 'pink', hex: '#F4C2C2' }],
  [/\bpink\b/i, { name: 'pink', family: 'pink', hex: '#FFC0CB' }],
  [/\bred\b/i, { name: 'red', family: 'red', hex: '#DC143C' }],
  [/\bcamel\b/i, { name: 'camel', family: 'brown', hex: '#C19A6B' }],
  [/\bchocolate\b/i, { name: 'chocolate', family: 'brown', hex: '#5D3A1A' }],
  [/\btan\b/i, { name: 'tan', family: 'brown', hex: '#D2B48C' }],
  [/\bbrown\b/i, { name: 'brown', family: 'brown', hex: '#8B4513' }],
  [/\bleopard\b/i, { name: 'leopard', family: 'brown', hex: null }],
  [/\bgold\b/i, { name: 'gold', family: 'metallic', hex: '#D4AF37' }],
  [/\bsilver\b/i, { name: 'silver', family: 'metallic', hex: '#C0C0C0' }],
  [/\bbeige\b/i, { name: 'beige', family: 'brown', hex: '#F5F5DC' }],
  [/\bteal\b/i, { name: 'teal', family: 'blue', hex: '#008080' }],
];

/**
 * inches → length class thresholds (midpoints between the §5 canonical
 * reference lengths: micro 30 / mini 33 / above_knee 36 / knee 39 / midi 44 /
 * mid_calf 47 / maxi 55 / floor 60). Used when text states inches but no
 * length word.
 */
export function lengthClassFromInches(lengthInches: number): LengthClass {
  if (lengthInches < 31.5) return 'micro';
  if (lengthInches < 34.5) return 'mini';
  if (lengthInches < 37.5) return 'above_knee';
  if (lengthInches < 41.5) return 'knee';
  if (lengthInches < 45.5) return 'midi';
  if (lengthInches < 51) return 'mid_calf';
  if (lengthInches < 57.5) return 'maxi';
  return 'floor';
}

/**
 * Sparse tag→weight vector construction — mirrors the fixture corpus so mock,
 * live, and pre-baked extractions are vector-compatible for cosine similarity.
 */
export function buildAttributeVector(
  attrs: Pick<
    ExtractedAttributes,
    'lengthClass' | 'silhouette' | 'colors' | 'pattern' | 'neckline' | 'occasions' | 'fabric'
  >,
  opts: { isVintage?: boolean } = {},
): Record<string, number> {
  const v: Record<string, number> = {};
  if (attrs.lengthClass) v[`length:${attrs.lengthClass}`] = 1;
  if (attrs.silhouette) v[`silhouette:${attrs.silhouette}`] = 1;
  for (const c of attrs.colors) v[`color:${c.family}`] = 0.8;
  if (attrs.pattern && attrs.pattern !== 'solid') v[`pattern:${attrs.pattern}`] = 0.7;
  if (attrs.neckline) v[`neckline:${attrs.neckline}`] = 0.5;
  for (const o of attrs.occasions) v[`occasion:${o}`] = 0.4;
  if (attrs.fabric) v[`fabric:${attrs.fabric.split(/\s+/)[0]}`] = 0.6;
  if (opts.isVintage) v['era:vintage'] = 0.6;
  return v;
}

export function firstMatch<T>(text: string, table: Array<[RegExp, T]>): T | null {
  for (const [re, value] of table) if (re.test(text)) return value;
  return null;
}

export function allMatches<T>(text: string, table: Array<[RegExp, T]>): T[] {
  const out: T[] = [];
  for (const [re, value] of table) if (re.test(text)) out.push(value);
  return out;
}

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

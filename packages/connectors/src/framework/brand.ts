/**
 * Per-store brand strategy — fixes the founder-reported "listing brand is an
 * internal vendor code" bug (2026-07-09).
 *
 * Shopify's products.json `vendor` and schema.org Product `brand` are
 * free-text fields that single-brand storefronts routinely abuse for internal
 * bookkeeping. Cataloged live from the production facet (~8.3k listings):
 *   - christydawn.com   → season codes (SP23, SP26B, F24A, PF25, U25B, BF24B…)
 *                         and even the manufacturing legal entity
 *                         ("OSHADI COLLECTIVE (OPC) PRIVATE LIMITED")
 *   - staud.clothing    → collection labels ("STAUD FALL 2023",
 *                         "STAUD HOLIDAY SALE 2024", "STAUD SPRING 20 CORE")
 *   - petalandpup.com   → drop codes (PUP3…PUP139, lowercase "pup129")
 *   - sisterjane.com    → collection names ("DREAM Voyage Voyage",
 *                         "Playback by Ghospell", "Secrets The Water Keeps")
 *   - us.rouje.com      → collection names ("La Madrague", "Cadaqués"…)
 *   - rixo.co.uk        → decorated variants ("RIXO ⋆", mojibake "RIXO â‹†")
 *
 * Strategy per store (stores.json / jsonld-stores.json):
 *   - brandMode 'single' (DTC storefront selling its own label): the brand is
 *     ALWAYS `brandName`; the vendor string is demoted to an attribute-hint
 *     input. `knownBrands` carves out genuinely distinct labels sold on the
 *     same storefront (sisterjane.com sells Ghospell — verified live
 *     2026-07-09: vendor "Playback by Ghospell" et al → brand "Ghospell").
 *   - brandMode 'multi' (marketplace / multi-label retailer, e.g. lulus.com):
 *     the vendor IS the brand and must be preserved ("Free People", "ASTR the
 *     Label") — but it still runs through `looksLikeVendorCode` and falls
 *     back to `brandName` when it is plainly an internal code.
 *
 * Default when no strategy is configured (ad-hoc `--store=<domain>` runs):
 * 'multi' — the historical vendor-wins behavior, minus the junk codes.
 */

export interface BrandStrategyInfo {
  /** storefront display name — canonical-brand fallback when brandName unset */
  displayName: string;
  /** canonical brand for listings from this store (e.g. "Christy Dawn") */
  brandName?: string;
  /** 'single' → always brandName (minus knownBrands); 'multi' → vendor unless junk */
  brandMode?: 'single' | 'multi';
  /**
   * distinct labels genuinely sold on this storefront: a vendor string
   * containing one of these (word-boundary, case-insensitive) maps to it,
   * in BOTH modes ("Playback by Ghospell" → "Ghospell").
   */
  knownBrands?: string[];
}

/** the canonical brand a store's listings fall back to */
export function canonicalBrandName(store: BrandStrategyInfo): string {
  return store.brandName ?? store.displayName;
}

/** SP26B, PUP129, pup129, F24A, BF25, PS23A, U25B, W25, H25… */
const CODE_RE = /^[A-Za-z]{1,6}[-_]?\d{1,4}[A-Za-z]{0,2}$/;

/** abbreviated season codes anywhere in the string: FW23, SS2024, AW21, PF22 (uppercase on purpose) */
const SEASON_CODE_RE = /\b(?:FW|SS|AW|PF|SP)[\s-]?\d{2,4}[A-Za-z]?\b/;

/**
 * season word + a year in either order ("STAUD FALL 2023", "Summer 24",
 * "STAUD SPRING 20 CORE", "2024 Resort"). Requiring BOTH keeps real brands
 * containing a season word (e.g. "Winter Kate") safe.
 */
const SEASON_WORD =
  '(?:FALL|AUTUMN|SPRING|SUMMER|WINTER|RESORT|HOLIDAY|CRUISE|PRE[\\s-]?FALL|PRE[\\s-]?SPRING|BRIDAL)';
const YEAR = "(?:['’]?\\d{2}|(?:19|20)\\d{2})";
const SEASON_YEAR_RE = new RegExp(
  `\\b${SEASON_WORD}\\b[\\s\\S]{0,40}(?:^|\\s)${YEAR}\\b|\\b${YEAR}\\b[\\s\\S]{0,40}\\b${SEASON_WORD}\\b`,
  'i',
);

/** merchandising labels are never brands ("STAUD FALL 2024 SALE") */
const MERCH_RE = /\b(?:SALE|PREORDER|PRE-ORDER|LATE ADDS|MARKDOWN|OUTLET)\b/i;

/** manufacturing/legal entities ("OSHADI COLLECTIVE (OPC) PRIVATE LIMITED") */
const LEGAL_ENTITY_RE = /\b(?:PRIVATE LIMITED|PVT\.?\s?LTD\.?|LLC|GMBH|PTY\s?LTD|CO\.,?\s?LTD)\b/i;

/**
 * Does this vendor string look like an internal code / collection label
 * rather than a wearable brand? Heuristics tuned against the real junk in the
 * production facet (see module doc) — deliberately conservative so genuine
 * multi-brand vendors ("Free People", "Betsey Johnson", "ASTR the Label",
 * "4th & Reckless") pass through untouched.
 */
export function looksLikeVendorCode(vendor: string): boolean {
  const v = vendor.trim();
  if (!v) return true;
  if (CODE_RE.test(v)) return true;
  if (SEASON_CODE_RE.test(v)) return true;
  if (SEASON_YEAR_RE.test(v)) return true;
  if (MERCH_RE.test(v)) return true;
  if (LEGAL_ENTITY_RE.test(v)) return true;
  return false;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Vendor string → the brand a listing should carry, per the store's strategy.
 * Pure and total: always returns a non-empty brand (canonical fallback).
 */
export function resolveBrand(
  vendor: string | null | undefined,
  store: BrandStrategyInfo,
): string {
  const v = (vendor ?? '').trim();
  if (v) {
    for (const known of store.knownBrands ?? []) {
      if (new RegExp(`(?:^|\\W)${escapeRegExp(known)}(?:\\W|$)`, 'i').test(v)) return known;
    }
  }
  if ((store.brandMode ?? 'multi') === 'single') return canonicalBrandName(store);
  if (!v || looksLikeVendorCode(v)) return canonicalBrandName(store);
  return v;
}

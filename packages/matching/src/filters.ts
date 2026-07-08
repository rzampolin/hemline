/**
 * Hard filters — docs/ARCHITECTURE.md §6 + §5 (vintage sizing / ease table).
 *
 * Pure predicates over already-loaded `Listing`s. backend-eng translates the
 * cheap dimensions (price, brand, condition, freshness window) into SQL and
 * uses these predicates for the parts SQL can't express (per-user hem
 * position, measurement-based size compatibility, vintage priors), plus as the
 * source of truth in tests.
 */
import type { HardFilters, HemResult, Listing, Silhouette } from '@hemline/contracts';
import { computeHem } from './effective-length';

/** Candidate pool cap: 500 newest-first (doc §6). */
export const CANDIDATE_CAP = 500;

/**
 * Silhouette ease over body measurements, inches (doc §5 edge cases).
 * Garment measurement ≈ body measurement + ease when a dress "fits".
 */
export const SILHOUETTE_EASE_INCHES: Record<Silhouette, number> = {
  bodycon: 1,
  sheath: 1.5,
  slip: 1.5,
  a_line: 2.5,
  wrap: 2.5,
  fit_and_flare: 2.5,
  shirt: 2.5,
  tent: 4,
  empire: 4,
  other: 2,
};

/** Stretch/negative-ease allowance below body measurement (knits). */
export const FIT_STRETCH_ALLOWANCE_INCHES = 1;
/** Slack above intended ease before we call a garment "too big". */
export const FIT_SLACK_INCHES = 2;

/**
 * Vintage labels are a weak prior (doc §5): a vintage "12" matches modern
 * 6–10, i.e. modern ≈ vintage − 2 … vintage − 6.
 */
export const VINTAGE_SIZE_SHIFT_MIN = 2;
export const VINTAGE_SIZE_SHIFT_MAX = 6;

export interface UserFitContext {
  /** Required for `lengthOnBody` filtering. */
  heightInches?: number | null;
  heelInches?: number;
  /** Body measurements; enable measurement-based size compatibility. */
  bodyMeasurements?: { bust: number | null; waist: number | null; hip: number | null };
  /** When true, listings with unknown hem position pass `lengthOnBody`. */
  includeUnknownLength?: boolean;
}

/**
 * Size compatibility (doc §5 vintage edge case):
 * 1. Garment measurements present AND user body measurements present →
 *    measurements ± silhouette ease win (labels ignored).
 * 2. Otherwise normalized size labels; vintage labels are shifted by the weak
 *    prior (vintage 12 ≈ modern 6–10).
 * 3. A listing with no size information at all is NOT excluded (unknown ≠ no).
 */
export function sizeCompatible(
  listing: Pick<
    Listing,
    'sizeNormalized' | 'isVintage' | 'measurements' | 'silhouette'
  >,
  userSizes: number[],
  body?: UserFitContext['bodyMeasurements'],
): boolean {
  if (userSizes.length === 0) return true;

  // 1. measurements win when both sides have them
  if (body && hasAnyMeasurement(listing.measurements) && hasAnyBodyMeasurement(body)) {
    const verdict = measurementsFit(listing, body);
    if (verdict !== null) return verdict;
  }

  // 2. label-based
  if (listing.sizeNormalized.length === 0) return true; // 3. unknown ≠ no
  if (listing.isVintage) {
    // weak prior: vintage s fits users sized s−6 … s−2 (and, generously, s itself
    // is NOT included — vintage sizing runs small).
    return listing.sizeNormalized.some((s) =>
      userSizes.some(
        (u) => u >= s - VINTAGE_SIZE_SHIFT_MAX && u <= s - VINTAGE_SIZE_SHIFT_MIN,
      ),
    );
  }
  return listing.sizeNormalized.some((s) => userSizes.includes(s));
}

/**
 * Compare garment circumference measurements against body + silhouette ease.
 * Returns null when no comparable pair exists (fall back to labels).
 * Fits when, for every comparable pair:
 *   body − stretchAllowance ≤ garment ≤ body + ease + slack
 */
export function measurementsFit(
  listing: Pick<Listing, 'measurements' | 'silhouette'>,
  body: NonNullable<UserFitContext['bodyMeasurements']>,
): boolean | null {
  const ease = SILHOUETTE_EASE_INCHES[listing.silhouette ?? 'other'];
  const pairs: Array<[number | null | undefined, number | null | undefined]> = [
    [listing.measurements.bust, body.bust],
    [listing.measurements.waist, body.waist],
    [listing.measurements.hip, body.hip],
  ];
  let compared = 0;
  for (const [garment, bodyMeas] of pairs) {
    if (garment == null || bodyMeas == null) continue;
    compared++;
    const min = bodyMeas - FIT_STRETCH_ALLOWANCE_INCHES;
    const max = bodyMeas + ease + FIT_SLACK_INCHES;
    if (garment < min || garment > max) return false;
  }
  return compared > 0 ? true : null;
}

/**
 * Contract predicate (doc §6): size ∩ price ∩ hem-position-for-user ∩
 * condition ∩ brand ∩ color family ∩ free-text query.
 *
 * `ctx` is optional and additive: without it, `lengthOnBody` falls back to the
 * listing's own hem computed for nobody (i.e. it is skipped) and size
 * compatibility is label-only.
 */
export function matchesHardFilters(
  listing: Listing,
  filters: HardFilters,
  ctx?: UserFitContext,
): boolean {
  if (filters.priceMinCents !== undefined && listing.priceCents < filters.priceMinCents) {
    return false;
  }
  if (filters.priceMaxCents !== undefined && listing.priceCents > filters.priceMaxCents) {
    return false;
  }
  if (filters.conditions && filters.conditions.length > 0) {
    if (!filters.conditions.includes(listing.condition)) return false;
  }
  if (filters.brands && filters.brands.length > 0) {
    const brand = (listing.brand ?? '').toLowerCase();
    if (!filters.brands.some((b) => b.toLowerCase() === brand)) return false;
  }
  if (filters.colorFamilies && filters.colorFamilies.length > 0) {
    const families = new Set(listing.colors.map((c) => c.family.toLowerCase()));
    if (!filters.colorFamilies.some((f) => families.has(f.toLowerCase()))) return false;
  }
  if (filters.sizesNormalized && filters.sizesNormalized.length > 0) {
    if (!sizeCompatible(listing, filters.sizesNormalized, ctx?.bodyMeasurements)) {
      return false;
    }
  }
  if (filters.lengthOnBody && filters.lengthOnBody.length > 0) {
    const hem = hemForFilter(listing, ctx);
    if (hem.position === null) {
      if (!ctx?.includeUnknownLength) return false;
    } else if (!filters.lengthOnBody.includes(hem.position)) {
      return false;
    }
  }
  if (filters.query && filters.query.trim().length > 0) {
    if (!matchesQuery(listing, filters.query)) return false;
  }
  return true;
}

/**
 * Apply all hard filters and the §6 candidate cap: 500 newest-first (by
 * `lastSeenAt` desc — freshest sighting first).
 */
export function applyHardFilters(
  listings: Listing[],
  filters: HardFilters,
  ctx?: UserFitContext,
  cap: number = CANDIDATE_CAP,
): Listing[] {
  return listings
    .filter((l) => matchesHardFilters(l, filters, ctx))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, cap);
}

function hemForFilter(listing: Listing, ctx?: UserFitContext): HemResult {
  if (ctx?.heightInches == null) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }
  return computeHem({
    lengthInches: listing.lengthInches,
    lengthClass: listing.lengthClass,
    heightInches: ctx.heightInches,
    heelInches: ctx.heelInches ?? 0,
    lengthSource: listing.lengthBasis === 'image_estimate' ? 'image_estimate' : 'seller_text',
  });
}

/** Simple token-AND text match over title + brand (Listing carries no description). */
export function matchesQuery(
  listing: Pick<Listing, 'title' | 'brand'>,
  query: string,
): boolean {
  const haystack = `${listing.title} ${listing.brand ?? ''}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

function hasAnyMeasurement(m: Listing['measurements']): boolean {
  return m.bust != null || m.waist != null || m.hip != null;
}

function hasAnyBodyMeasurement(
  b: NonNullable<UserFitContext['bodyMeasurements']>,
): boolean {
  return b.bust != null || b.waist != null || b.hip != null;
}

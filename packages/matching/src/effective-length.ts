/**
 * Effective-length algorithm — docs/ARCHITECTURE.md §5. THE MOAT.
 *
 * Pure functions only. Classifies where a garment's hem falls on *this* user's
 * body, not the vendor's label.
 *
 * Formula (doc §5, implemented exactly as written):
 *   H_eff          = H + heelInches × 0.85
 *   S              = 0.82 × H_eff            (HPS-to-floor)
 *   hemAboveFloor  = S − L
 *   r              = hemAboveFloor / H_eff   (height-normalized, unitless)
 *
 * NOTE: the doc's §5 worked example ("r=0.135" for a 44″ dress on 5'2″) was
 * computed as hem/S rather than the formula's hem/H_eff. We implement the
 * formula as written — it is the one consistent with the anthropometric band
 * rationale (knee crease ≈ 0.285·H). See docs/decisions-ai-eng.md.
 */
import type { HemPosition, HemResult, LengthClass, Listing } from '@hemline/contracts';

/** Heel raises the hem proportionally less than heel height (doc §5). */
export const HEEL_FACTOR = 0.85;
/** HPS (high-point-shoulder) sits ≈18% of height below crown. */
export const HPS_TO_FLOOR_RATIO = 0.82;
/** Waist-to-hem measured garments (drop-waist / skirts measured from waist). */
export const WAIST_TO_FLOOR_RATIO = 0.62;
/** Knit/bias fabrics drape ≈1″ longer on-body (doc §5 edge cases). */
export const STRETCH_DROP_INCHES = 1;

/**
 * Canonical HPS-to-hem lengths for a 5'6″ reference body, used when only a
 * length_class is known (doc §5 fallback 2).
 */
export const LENGTH_CLASS_PRIOR_INCHES: Record<LengthClass, number> = {
  micro: 30,
  mini: 33,
  above_knee: 36,
  knee: 39,
  midi: 44,
  mid_calf: 47,
  maxi: 55,
  floor: 60,
};

/**
 * Classification bands over r = hemAboveFloor / H_eff (doc §5 table).
 * Boundaries are half-open exactly as specified: a band owns (lower, upper].
 */
export function classifyHemRatio(r: number): HemPosition {
  if (r > 0.42) return 'upper_thigh';
  if (r > 0.31) return 'above_knee';
  if (r > 0.26) return 'knee';
  if (r > 0.2) return 'below_knee';
  if (r > 0.12) return 'mid_calf';
  if (r > 0.03) return 'ankle';
  return 'floor';
}

export interface HemInput {
  /** Garment length in inches. When present it wins over lengthClass. */
  lengthInches: number | null;
  lengthClass: LengthClass | null;
  /** User height in inches (no heels). */
  heightInches: number;
  /** User's usual heel height; applied at HEEL_FACTOR. Default 0. */
  heelInches?: number;
  /**
   * 'hps' (default): seller measured high-point-shoulder → hem.
   * 'waist': seller measured waist → hem (detected by extraction, e.g.
   * "waist to hem 24in") → use S = 0.62 × H_eff instead of 0.82.
   */
  measuredFrom?: 'hps' | 'waist';
  /** Knit/bias fabric flag from extraction → subtract 1″ effective hem height. */
  stretchy?: boolean;
  /**
   * Where the measured length came from — seller text (high confidence) or a
   * model estimate from the image (medium). Ignored unless lengthInches set.
   */
  lengthSource?: 'seller_text' | 'image_estimate';
}

/** Full-fidelity variant with all §5 edge cases exposed. */
export function computeHem(input: HemInput): HemResult {
  const {
    lengthInches,
    lengthClass,
    heightInches,
    heelInches = 0,
    measuredFrom = 'hps',
    stretchy = false,
    lengthSource = 'seller_text',
  } = input;

  if (!Number.isFinite(heightInches) || heightInches <= 0) {
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }

  let L: number | null = null;
  let basis: HemResult['basis'] = 'none';
  let confidence: HemResult['confidence'] = 'low';

  if (lengthInches != null && Number.isFinite(lengthInches) && lengthInches > 0) {
    L = lengthInches;
    basis = 'measured_length';
    confidence = lengthSource === 'image_estimate' ? 'medium' : 'high';
  } else if (lengthClass != null) {
    L = LENGTH_CLASS_PRIOR_INCHES[lengthClass];
    basis = 'length_class_prior';
    confidence = 'medium';
  }

  if (L == null) {
    // Nothing to compute from — item stays rankable, hem filters exclude it
    // unless the user opts into "unknown length" (doc §5 fallback 3).
    return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
  }

  const hEff = heightInches + heelInches * HEEL_FACTOR;
  const ratio = measuredFrom === 'waist' ? WAIST_TO_FLOOR_RATIO : HPS_TO_FLOOR_RATIO;
  const s = ratio * hEff;
  let hemAboveFloor = s - L;
  if (stretchy) hemAboveFloor -= STRETCH_DROP_INCHES;
  const r = hemAboveFloor / hEff;

  return {
    position: classifyHemRatio(r),
    hemAboveFloorInches: round2(hemAboveFloor),
    basis,
    confidence,
  };
}

/**
 * Contract-conformant signature (`MatchingService.hemForUser`,
 * docs/ARCHITECTURE.md §4.4). Assumes HPS-measured, non-stretch, seller-text
 * length; use {@link computeHem} for the waist-basis / stretch / image-estimate
 * edge cases.
 */
export function hemForUser(
  listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
  heightInches: number,
  heelInches = 0,
): HemResult {
  return computeHem({
    lengthInches: listing.lengthInches,
    lengthClass: listing.lengthClass,
    heightInches,
    heelInches,
  });
}

export const HEM_POSITION_ORDER: readonly HemPosition[] = [
  'upper_thigh',
  'above_knee',
  'knee',
  'below_knee',
  'mid_calf',
  'ankle',
  'floor',
] as const;

/**
 * Adjacent band widening for UI copy at confidence != 'high'
 * (doc §5: "likely hits knee–below-knee on you"). Individual torso:leg ratio
 * varies ~±3% of H, so class-prior results always show a range.
 */
export function adjacentPositions(position: HemPosition): HemPosition[] {
  const i = HEM_POSITION_ORDER.indexOf(position);
  const out: HemPosition[] = [position];
  if (i > 0) out.unshift(HEM_POSITION_ORDER[i - 1]);
  if (i < HEM_POSITION_ORDER.length - 1) out.push(HEM_POSITION_ORDER[i + 1]);
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

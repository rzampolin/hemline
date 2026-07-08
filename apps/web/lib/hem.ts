/**
 * Effective-length computation — MOCK-MODE ONLY mirror of
 * docs/ARCHITECTURE.md §5. In live mode the hem always comes from the server
 * (`RankedListing.hem` / detail response); this exists so mock mode can compute
 * "hits mid-calf on you" per user without the (stubbed) packages/matching.
 */
import type { HemPosition, HemResult, LengthClass, Listing } from '@hemline/contracts';

/** Canonical class → inches priors for a 5'6" reference body (ARCHITECTURE §5). */
const CLASS_PRIOR_INCHES: Record<LengthClass, number> = {
  micro: 30,
  mini: 33,
  above_knee: 36,
  knee: 39,
  midi: 44,
  mid_calf: 47,
  maxi: 55,
  floor: 60,
};

export function hemForUser(
  listing: Pick<Listing, 'lengthInches' | 'lengthClass'> & {
    lengthBasis?: Listing['lengthBasis'];
  },
  heightInches: number,
  heelInches = 0,
): HemResult {
  const hEff = heightInches + heelInches * 0.85;
  const shoulderToFloor = 0.82 * hEff;

  let garmentLength = listing.lengthInches;
  let basis: HemResult['basis'] = 'measured_length';
  if (garmentLength == null) {
    if (listing.lengthClass) {
      garmentLength = CLASS_PRIOR_INCHES[listing.lengthClass];
      basis = 'length_class_prior';
    } else {
      return { position: null, hemAboveFloorInches: null, basis: 'none', confidence: 'low' };
    }
  }

  const hemAboveFloor = shoulderToFloor - garmentLength;
  const r = hemAboveFloor / hEff;

  const position: HemPosition =
    r > 0.42
      ? 'upper_thigh'
      : r > 0.31
        ? 'above_knee'
        : r > 0.26
          ? 'knee'
          : r > 0.2
            ? 'below_knee'
            : r > 0.12
              ? 'mid_calf'
              : r > 0.03
                ? 'ankle'
                : 'floor';

  return {
    position,
    hemAboveFloorInches: Math.max(0, Math.round(hemAboveFloor * 10) / 10),
    basis,
    // Image-estimated lengths are 'medium' (§5 fallback 1), same as the server.
    confidence:
      basis === 'measured_length' && listing.lengthBasis !== 'image_estimate'
        ? 'high'
        : 'medium',
  };
}

/** Fallback height when the profile has none yet (landing strip, previews). */
export const DEFAULT_HEIGHT_INCHES = 65; // 5'5" — US average

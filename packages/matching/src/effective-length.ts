/**
 * Effective-length algorithm — docs/ARCHITECTURE.md §5. THE MOAT.
 *
 * TODO(ai-eng): implement the pure function + exhaustive Vitest band table
 * (petite/average/tall × every band boundary × heel offsets).
 *
 * Formula: H_eff = H + heel×0.85; S = 0.82×H_eff; r = (S − L)/H_eff → bands.
 * Fallback: length_class prior for a 5'6" reference body (micro 30" … floor 60").
 */
import type { HemResult, Listing } from '@hemline/contracts';

export function hemForUser(
  _listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
  _heightInches: number,
  _heelInches = 0,
): HemResult {
  throw new Error(
    'not yet implemented (ai-eng): effective-length classification — docs/ARCHITECTURE.md §5',
  );
}

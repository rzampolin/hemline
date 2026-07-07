/**
 * Mock-mode effective-length math (mirror of ARCHITECTURE §5).
 * The canonical implementation + exhaustive band table live in
 * packages/matching (ai-eng); these tests pin the mock so the demo's hem
 * copy stays truthful. The core demo moment: the same 44″ dress classifies
 * differently on a 5'2″ and a 5'10″ body.
 */
import { describe, expect, it } from 'vitest';
import { hemForUser } from './hem';

describe('hemForUser', () => {
  it('reclassifies the same 44″ dress per height (the moat)', () => {
    const dress = { lengthInches: 44, lengthClass: 'midi' as const };
    // 5'2": S = 0.82×62 = 50.84 → hem 6.84″ above floor, r ≈ 0.110 → ankle
    expect(hemForUser(dress, 62).position).toBe('ankle');
    // 5'5": r ≈ 0.138 → mid-calf
    expect(hemForUser(dress, 65).position).toBe('mid_calf');
    // 5'10": r ≈ 0.191 → still mid-calf band, but 6.6″ higher on the leg
    const tall = hemForUser(dress, 70);
    expect(tall.position).toBe('mid_calf');
    expect(tall.hemAboveFloorInches).toBeGreaterThan(
      hemForUser(dress, 62).hemAboveFloorInches! + 6,
    );
  });

  it('uses measured length with high confidence', () => {
    const r = hemForUser({ lengthInches: 35, lengthClass: 'mini' }, 65);
    expect(r.basis).toBe('measured_length');
    expect(r.confidence).toBe('high');
    // S = 53.3 → hem 18.3 above floor, r ≈ 0.282 → knee
    expect(r.position).toBe('knee');
  });

  it('falls back to length-class priors with medium confidence', () => {
    const r = hemForUser({ lengthInches: null, lengthClass: 'maxi' }, 65);
    expect(r.basis).toBe('length_class_prior');
    expect(r.confidence).toBe('medium');
    expect(r.position).toBe('floor'); // 55″ prior on 5'5" → r ≈ −0.026 → floor
  });

  it('returns none when there is nothing to compute from', () => {
    const r = hemForUser({ lengthInches: null, lengthClass: null }, 65);
    expect(r).toEqual({
      position: null,
      hemAboveFloorInches: null,
      basis: 'none',
      confidence: 'low',
    });
  });

  it('heels raise the effective hem (0.85 factor)', () => {
    const flat = hemForUser({ lengthInches: 44, lengthClass: null }, 62, 0);
    const heeled = hemForUser({ lengthInches: 44, lengthClass: null }, 62, 3);
    expect(heeled.hemAboveFloorInches!).toBeGreaterThan(flat.hemAboveFloorInches!);
  });

  it('band boundaries are height-proportional (fractions of H)', () => {
    // upper_thigh boundary: r > 0.42 → L < S − 0.42H (26″ on 5'5" sits exactly at r = 0.42)
    expect(hemForUser({ lengthInches: 26, lengthClass: null }, 65).position).toBe('above_knee');
    expect(hemForUser({ lengthInches: 25, lengthClass: null }, 65).position).toBe('upper_thigh');
    expect(hemForUser({ lengthInches: 60, lengthClass: null }, 65).position).toBe('floor');
  });
});

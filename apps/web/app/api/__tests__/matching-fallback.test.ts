/**
 * Unit tests for the api-layer glue that REMAINS after integration: style-tag
 * learning (lib/style-learning.ts) and the null-safe wrappers in
 * lib/matching.ts. The §5/§6 formulas themselves are exhaustively tested in
 * packages/matching; the color paths in packages/ai — the INLINE fallback
 * copies this file used to guard are deleted.
 */
import { describe, expect, it } from 'vitest';
import type { UserProfile } from '@hemline/contracts';
import { classifyFromQuiz } from '@hemline/ai';
import { applySwipesToStyleTags } from '../lib/style-learning';
import { hemForUser, paletteMatches } from '../lib/matching';

describe('hemForUser wrapper (real packages/matching underneath)', () => {
  it('classifies the same 44" dress differently by height (§5 formula, r = hem/H_eff)', () => {
    const dress = { lengthInches: 44, lengthClass: 'midi' as const };
    // 5'2": hem = 0.82×62 − 44 = 6.84 → r = 0.110 → ankle (doc example, corrected)
    expect(hemForUser(dress, 62).position).toBe('ankle');
    // 5'4" demo user: hem = 8.48 → r = 0.1325 → mid_calf
    expect(hemForUser(dress, 64).position).toBe('mid_calf');
    // 5'10": hem = 13.4 → r = 0.191 → mid_calf (upper end of the band)
    expect(hemForUser(dress, 70).position).toBe('mid_calf');
    // 6'1": hem = 15.86 → r = 0.217 → below_knee
    expect(hemForUser(dress, 73).position).toBe('below_knee');
  });

  it('returns a null result when height is unknown (guest browse)', () => {
    const r = hemForUser({ lengthInches: 44, lengthClass: 'midi' }, null);
    expect(r.position).toBeNull();
    expect(r.basis).toBe('none');
  });

  it('measured length → high confidence; class prior → medium', () => {
    expect(hemForUser({ lengthInches: 39, lengthClass: null }, 64).confidence).toBe('high');
    const prior = hemForUser({ lengthInches: null, lengthClass: 'mini' }, 66);
    expect(prior.basis).toBe('length_class_prior');
    expect(prior.confidence).toBe('medium');
  });
});

describe('paletteMatches (RankedListing.paletteMatch contract field)', () => {
  const profile = {
    palette: [
      { hex: '#B7410E', name: 'rust' },
      { hex: '#9CAF88', name: 'sage' },
    ],
  } as unknown as UserProfile;
  const listing = (colors: { name: string; family: string; hex: string | null }[]) =>
    ({ colors }) as never;

  it('matches by name or nearby hex, never on empty palettes', () => {
    expect(paletteMatches(profile, listing([{ name: 'rust', family: 'orange', hex: null }]))).toBe(true);
    expect(paletteMatches(profile, listing([{ name: 'moss', family: 'green', hex: '#9CAF80' }]))).toBe(true);
    expect(paletteMatches(profile, listing([{ name: 'ice blue', family: 'blue', hex: '#B0E0E6' }]))).toBe(false);
    expect(paletteMatches({ palette: [] } as unknown as UserProfile, listing([{ name: 'rust', family: 'orange', hex: null }]))).toBe(false);
  });
});

describe('style learning', () => {
  it('likes push tags up, dislikes push them down, clamped to [-1,1]', () => {
    const vectors = new Map<string, Record<string, number>>([
      ['l1', { 'silhouette:wrap': 1, 'color:green': 0.5 }],
      ['l2', { 'silhouette:bodycon': 1 }],
    ]);
    const next = applySwipesToStyleTags(
      { 'silhouette:bodycon': -0.95 },
      [
        { listingId: 'l1', verdict: 'like', context: 'calibration' },
        { listingId: 'l2', verdict: 'dislike', context: 'calibration' },
      ],
      vectors,
    );
    expect(next['silhouette:wrap']).toBeCloseTo(0.15);
    expect(next['color:green']).toBeCloseTo(0.075);
    expect(next['silhouette:bodycon']).toBe(-1); // clamped
  });
});

describe('quiz classification is deterministic and labeled (via @hemline/ai)', () => {
  it('same answers → same season, source=quiz', () => {
    const answers = {
      veinColor: 'blue_purple',
      jewelryMetal: 'silver',
      whiteVsCream: 'white',
      sunReaction: 'burns_easily',
      naturalHair: 'black',
      eyeColor: 'blue',
    } as const;
    const a = classifyFromQuiz(answers);
    const b = classifyFromQuiz(answers);
    expect(a.season).toBe(b.season);
    expect(a.source).toBe('quiz');
    expect(a.palette.length).toBeGreaterThanOrEqual(10);
  });
});

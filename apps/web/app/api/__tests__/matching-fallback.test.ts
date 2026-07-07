/**
 * Unit tests for the deterministic in-route fallbacks (ARCHITECTURE §5/§6
 * formulas). These guard the INLINE copies only — the exhaustive band table
 * is ai-eng's job in packages/matching.
 */
import { describe, expect, it } from 'vitest';
import {
  applySwipesToStyleTags,
} from '../lib/style-learning';
import {
  decodeCursor,
  encodeCursor,
  hexToFamily,
  inlineHemForUser,
} from '../lib/matching';
import { classifyQuizFallback, selfieFallback } from '../lib/color';

describe('inlineHemForUser (§5 formula)', () => {
  it('classifies the same 44" dress differently by height (the core demo moment)', () => {
    const dress = { lengthInches: 44, lengthClass: 'midi' as const };
    // 5'4" demo user: S = 0.82×64 = 52.48 → r = 8.48/64 = 0.1325 → mid_calf
    expect(inlineHemForUser(dress, 64).position).toBe('mid_calf');
    // 5'10": S = 57.4 → r = 13.4/70 = 0.191 → still mid_calf band's upper end
    expect(inlineHemForUser(dress, 70).position).toBe('mid_calf');
    // 6'1": S = 59.86 → r = 15.86/73 = 0.217 → below_knee
    expect(inlineHemForUser(dress, 73).position).toBe('below_knee');
  });

  it('heels raise the hem (H_eff = H + heel×0.85)', () => {
    const dress = { lengthInches: 50, lengthClass: null };
    const flat = inlineHemForUser(dress, 64, 0);
    const heels = inlineHemForUser(dress, 64, 3);
    expect(heels.hemAboveFloorInches!).toBeGreaterThan(flat.hemAboveFloorInches!);
  });

  it('falls back to length-class priors with medium confidence', () => {
    // 33" mini prior on the 5'6" reference body: r = (54.12−33)/66 = 0.32 → above_knee
    const r = inlineHemForUser({ lengthInches: null, lengthClass: 'mini' }, 66);
    expect(r.basis).toBe('length_class_prior');
    expect(r.confidence).toBe('medium');
    expect(r.position).toBe('above_knee');
  });

  it('returns none when nothing to compute from', () => {
    const r = inlineHemForUser({ lengthInches: null, lengthClass: null }, 64);
    expect(r.position).toBeNull();
    expect(r.basis).toBe('none');
  });

  it('measured length → high confidence', () => {
    expect(inlineHemForUser({ lengthInches: 39, lengthClass: null }, 64).confidence).toBe('high');
  });
});

describe('cursor', () => {
  it('roundtrips and rejects garbage', () => {
    expect(decodeCursor(encodeCursor(48))).toBe(48);
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor('!!not-base64!!')).toBe(0);
  });
});

describe('hexToFamily', () => {
  it('buckets common colors', () => {
    expect(hexToFamily('#B7410E')).toBe('brown'); // rust (dark orange)
    expect(hexToFamily('#000000')).toBe('black');
    expect(hexToFamily('#FFFFFF')).toBe('white');
    expect(hexToFamily('#1E90FF')).toBe('blue');
    expect(hexToFamily('#9CAF88')).toBe('green'); // sage
    expect(hexToFamily('nope')).toBeNull();
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

describe('color fallbacks are deterministic', () => {
  it('same quiz answers → same season', () => {
    const answers = {
      veinColor: 'blue_purple',
      jewelryMetal: 'silver',
      whiteVsCream: 'white',
      sunReaction: 'burns_easily',
      naturalHair: 'black',
      eyeColor: 'blue',
    } as const;
    const a = classifyQuizFallback(answers);
    const b = classifyQuizFallback(answers);
    expect(a.season).toBe(b.season);
    expect(a.season).toContain('winter'); // cool + deep + bright axes
    expect(a.palette.length).toBeGreaterThanOrEqual(10);
  });

  it('same selfie bytes → same season; different bytes may differ', () => {
    const img = Buffer.from('selfie-bytes-1');
    expect(selfieFallback(img).season).toBe(selfieFallback(img).season);
    expect(selfieFallback(img).caveat).toBeTruthy(); // honest demo-mode caveat
  });
});

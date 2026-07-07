import { describe, expect, it } from 'vitest';
import {
  blendScores,
  freshnessDecay,
  halfLifeDaysForSource,
  hexDistance,
  paletteBoost,
  paletteMatchesColor,
  rankPositionToScore,
  score0,
} from './scoring';

describe('freshnessDecay', () => {
  it('fresh item → 1', () => {
    expect(freshnessDecay(0, 7)).toBe(1);
  });
  it('one half-life → 0.5 (7d resale, 21d DTC)', () => {
    expect(freshnessDecay(7, 7)).toBeCloseTo(0.5, 10);
    expect(freshnessDecay(21, 21)).toBeCloseTo(0.5, 10);
    expect(freshnessDecay(14, 7)).toBeCloseTo(0.25, 10);
  });
  it('negative age clamps to 1 (clock skew tolerance)', () => {
    expect(freshnessDecay(-3, 7)).toBe(1);
  });
});

describe('halfLifeDaysForSource', () => {
  it('resale sources decay fast', () => {
    expect(halfLifeDaysForSource('ebay')).toBe(7);
    expect(halfLifeDaysForSource('fixture:ebay')).toBe(7);
  });
  it('DTC sources decay slowly', () => {
    expect(halfLifeDaysForSource('shopify:staud.clothing')).toBe(21);
    expect(halfLifeDaysForSource('fixture:shopify')).toBe(21);
  });
});

describe('paletteBoost (soft, 1.0–1.25)', () => {
  const palette = [
    { hex: '#800020', name: 'burgundy' },
    { hex: '#9CAF88', name: 'sage' },
  ];

  it('no palette or no colors → exactly 1 (never penalizes)', () => {
    expect(paletteBoost([], [{ name: 'red', family: 'red', hex: '#ff0000' }])).toBe(1);
    expect(paletteBoost(palette, [])).toBe(1);
  });

  it('full match → 1.25, partial match scales linearly', () => {
    const burgundy = { name: 'burgundy', family: 'red', hex: '#800020' };
    const neonYellow = { name: 'neon yellow', family: 'yellow', hex: '#f0ff00' };
    expect(paletteBoost(palette, [burgundy])).toBeCloseTo(1.25, 10);
    expect(paletteBoost(palette, [burgundy, neonYellow])).toBeCloseTo(1.125, 10);
    expect(paletteBoost(palette, [neonYellow])).toBe(1);
  });

  it('matches by name or by close hex', () => {
    expect(
      paletteMatchesColor(palette, { name: 'Burgundy', family: 'red', hex: null }),
    ).toBe(true);
    // #7a0025 is within RGB distance 80 of #800020
    expect(
      paletteMatchesColor(palette, { name: 'wine', family: 'red', hex: '#7a0025' }),
    ).toBe(true);
    expect(
      paletteMatchesColor(palette, { name: 'cobalt', family: 'blue', hex: '#0047AB' }),
    ).toBe(false);
  });
});

describe('blend & score₀', () => {
  it('blend = 0.6·llm + 0.4·score₀', () => {
    expect(blendScores(1, 0)).toBeCloseTo(0.6, 10);
    expect(blendScores(0, 1)).toBeCloseTo(0.4, 10);
    expect(blendScores(0.5, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('score₀ multiplies the three factors and clamps to 0..1', () => {
    expect(
      score0({ similarity: 0.8, paletteBoost: 1.25, freshnessDecay: 0.5 }),
    ).toBeCloseTo(0.5, 10);
    expect(score0({ similarity: 1, paletteBoost: 1.25, freshnessDecay: 1 })).toBe(1);
  });

  it('rankPositionToScore maps positions to a 0..1 ramp', () => {
    expect(rankPositionToScore(0, 5)).toBe(1);
    expect(rankPositionToScore(4, 5)).toBe(0);
    expect(rankPositionToScore(0, 1)).toBe(1);
  });
});

describe('hexDistance', () => {
  it('identical hexes → 0; invalid → Infinity', () => {
    expect(hexDistance('#800020', '800020')).toBe(0);
    expect(hexDistance('#800020', 'oops')).toBe(Number.POSITIVE_INFINITY);
  });
});

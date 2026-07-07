/**
 * Exhaustive unit table for the effective-length algorithm (doc §5).
 * This is the signature feature — the most-tested code in the repo.
 */
import { describe, expect, it } from 'vitest';
import type { HemPosition, LengthClass } from '@hemline/contracts';
import {
  adjacentPositions,
  classifyHemRatio,
  computeHem,
  hemForUser,
  HEEL_FACTOR,
  HPS_TO_FLOOR_RATIO,
  LENGTH_CLASS_PRIOR_INCHES,
} from './effective-length';

const PETITE = 59; // 4'11"
const AVERAGE = 64; // 5'4"
const TALL = 72; // 6'0"

describe('classifyHemRatio — every band boundary (bands own (lower, upper])', () => {
  const cases: Array<[number, HemPosition]> = [
    [0.5, 'upper_thigh'],
    [0.421, 'upper_thigh'],
    [0.42, 'above_knee'], // boundary belongs to lower band
    [0.32, 'above_knee'],
    [0.311, 'above_knee'],
    [0.31, 'knee'],
    [0.285, 'knee'], // knee crease ≈ 0.285·H
    [0.261, 'knee'],
    [0.26, 'below_knee'],
    [0.21, 'below_knee'],
    [0.201, 'below_knee'],
    [0.2, 'mid_calf'],
    [0.16, 'mid_calf'], // calf midpoint ≈ 0.16·H
    [0.121, 'mid_calf'],
    [0.12, 'ankle'],
    [0.05, 'ankle'],
    [0.031, 'ankle'],
    [0.03, 'floor'],
    [0, 'floor'],
    [-0.2, 'floor'], // dress longer than shoulder-to-floor
  ];
  it.each(cases)('r=%f → %s', (r, expected) => {
    expect(classifyHemRatio(r)).toBe(expected);
  });
});

describe('measured length — petite / average / tall × mini / midi / maxi', () => {
  // hand-computed: S = 0.82·H; hem = S − L; r = hem / H
  const table: Array<{
    height: number;
    length: number;
    position: HemPosition;
    hem: number;
  }> = [
    // petite 4'11" (59"): S = 48.38
    { height: PETITE, length: 33, position: 'knee', hem: 15.38 }, // r=0.2607
    { height: PETITE, length: 44, position: 'ankle', hem: 4.38 }, // r=0.0742 — "midi" wears near-ankle on petite
    { height: PETITE, length: 55, position: 'floor', hem: -6.62 }, // maxi drags
    // average 5'4" (64"): S = 52.48
    { height: AVERAGE, length: 33, position: 'knee', hem: 19.48 }, // r=0.3044
    { height: AVERAGE, length: 44, position: 'mid_calf', hem: 8.48 }, // r=0.1325
    { height: AVERAGE, length: 55, position: 'floor', hem: -2.52 },
    // tall 6'0" (72"): S = 59.04
    { height: TALL, length: 33, position: 'above_knee', hem: 26.04 }, // r=0.3617 — "mini" is decent
    { height: TALL, length: 44, position: 'below_knee', hem: 15.04 }, // r=0.2089 — "midi" shrinks
    { height: TALL, length: 55, position: 'ankle', hem: 4.04 }, // r=0.0561 — "maxi" becomes ankle
  ];

  it.each(table)(
    '$length″ dress on $height″ user → $position',
    ({ height, length, position, hem }) => {
      const result = hemForUser({ lengthInches: length, lengthClass: null }, height);
      expect(result.position).toBe(position);
      expect(result.hemAboveFloorInches).toBeCloseTo(hem, 2);
      expect(result.basis).toBe('measured_length');
      expect(result.confidence).toBe('high');
    },
  );

  it('the same 44″ dress classifies differently on 5\'2″ vs 5\'10″ (doc §5 demo)', () => {
    const petite = hemForUser({ lengthInches: 44, lengthClass: 'midi' }, 62);
    const tall = hemForUser({ lengthInches: 44, lengthClass: 'midi' }, 70);
    expect(petite.position).toBe('ankle'); // r = 6.84/62 ≈ 0.110 — near-ankle on petite
    expect(tall.position).toBe('mid_calf'); // r = 13.4/70 ≈ 0.191
    expect(petite.hemAboveFloorInches!).toBeLessThan(tall.hemAboveFloorInches!);
  });

  it('measured length wins over lengthClass when both present', () => {
    const result = hemForUser({ lengthInches: 33, lengthClass: 'maxi' }, PETITE);
    expect(result.basis).toBe('measured_length');
    expect(result.position).toBe('knee');
  });
});

describe('length_class prior fallback (5\'6″ reference body)', () => {
  const classes: LengthClass[] = [
    'micro',
    'mini',
    'above_knee',
    'knee',
    'midi',
    'mid_calf',
    'maxi',
    'floor',
  ];

  it('priors are the doc §5 canonical inches', () => {
    expect(LENGTH_CLASS_PRIOR_INCHES).toEqual({
      micro: 30,
      mini: 33,
      above_knee: 36,
      knee: 39,
      midi: 44,
      mid_calf: 47,
      maxi: 55,
      floor: 60,
    });
  });

  it.each(classes)('class %s → basis length_class_prior, confidence medium', (cls) => {
    const result = hemForUser({ lengthInches: null, lengthClass: cls }, AVERAGE);
    expect(result.basis).toBe('length_class_prior');
    expect(result.confidence).toBe('medium');
    expect(result.position).not.toBeNull();
    // must equal the measured computation for the prior length
    const viaMeasured = hemForUser(
      { lengthInches: LENGTH_CLASS_PRIOR_INCHES[cls], lengthClass: null },
      AVERAGE,
    );
    expect(result.position).toBe(viaMeasured.position);
    expect(result.hemAboveFloorInches).toBe(viaMeasured.hemAboveFloorInches);
  });

  const priorTable: Array<[number, LengthClass, HemPosition]> = [
    // petite: everything drops a band or two
    [PETITE, 'mini', 'knee'], // 33″ → r 0.2607
    [PETITE, 'knee', 'mid_calf'], // 39″ → r 0.1590 — labeled "knee" wears mid-calf
    [PETITE, 'midi', 'ankle'], // 44″ → r 0.0742
    [PETITE, 'maxi', 'floor'],
    // average
    [AVERAGE, 'micro', 'above_knee'], // 30″ → r 0.3513
    [AVERAGE, 'mini', 'knee'], // r 0.3044
    [AVERAGE, 'midi', 'mid_calf'], // r 0.1325
    [AVERAGE, 'maxi', 'floor'],
    // tall: everything rises
    [TALL, 'mini', 'above_knee'], // r 0.3617
    [TALL, 'midi', 'below_knee'], // r 0.2089
    [TALL, 'maxi', 'ankle'], // r 0.0561
    [TALL, 'floor', 'floor'], // 60″ → hem −0.96
  ];
  it.each(priorTable)('height %d″, class %s → %s on-body', (height, cls, expected) => {
    expect(hemForUser({ lengthInches: null, lengthClass: cls }, height).position).toBe(
      expected,
    );
  });
});

describe('heels (H_eff = H + heel × 0.85)', () => {
  it('exports the doc constants', () => {
    expect(HEEL_FACTOR).toBe(0.85);
    expect(HPS_TO_FLOOR_RATIO).toBe(0.82);
  });

  it('a 3″ heel lifts a 41″ dress from mid_calf to below_knee on 5\'4″', () => {
    const flat = hemForUser({ lengthInches: 41, lengthClass: null }, AVERAGE, 0);
    const heeled = hemForUser({ lengthInches: 41, lengthClass: null }, AVERAGE, 3);
    expect(flat.position).toBe('mid_calf'); // r = 11.48/64 ≈ 0.179
    expect(heeled.position).toBe('below_knee'); // H_eff 66.55, hem 13.571, r ≈ 0.204
    expect(heeled.hemAboveFloorInches).toBeCloseTo(13.57, 2);
  });

  it('a 2″ heel raises the hem by 0.82 × 2 × 0.85 ≈ 1.394″', () => {
    const flat = hemForUser({ lengthInches: 44, lengthClass: null }, AVERAGE, 0);
    const heeled = hemForUser({ lengthInches: 44, lengthClass: null }, AVERAGE, 2);
    expect(heeled.hemAboveFloorInches! - flat.hemAboveFloorInches!).toBeCloseTo(
      0.82 * 2 * 0.85,
      2,
    );
  });

  it('heel default is 0', () => {
    expect(hemForUser({ lengthInches: 44, lengthClass: null }, AVERAGE)).toEqual(
      hemForUser({ lengthInches: 44, lengthClass: null }, AVERAGE, 0),
    );
  });
});

describe('§5 edge cases', () => {
  it('waist-to-hem measurements use S = 0.62 × H_eff', () => {
    const result = computeHem({
      lengthInches: 24,
      lengthClass: null,
      heightInches: AVERAGE,
      measuredFrom: 'waist',
    });
    // S_waist = 39.68; hem = 15.68; r = 0.245
    expect(result.hemAboveFloorInches).toBeCloseTo(15.68, 2);
    expect(result.position).toBe('below_knee');
  });

  it('stretchy fabric drops the hem 1″ (can change band near a boundary)', () => {
    const rigid = computeHem({
      lengthInches: 44.6,
      lengthClass: null,
      heightInches: AVERAGE,
    });
    const knit = computeHem({
      lengthInches: 44.6,
      lengthClass: null,
      heightInches: AVERAGE,
      stretchy: true,
    });
    expect(rigid.position).toBe('mid_calf'); // r ≈ 0.1231
    expect(knit.position).toBe('ankle'); // r ≈ 0.1075
    expect(knit.hemAboveFloorInches).toBeCloseTo(rigid.hemAboveFloorInches! - 1, 2);
  });

  it('image-estimated lengths carry medium confidence', () => {
    const result = computeHem({
      lengthInches: 44,
      lengthClass: null,
      heightInches: AVERAGE,
      lengthSource: 'image_estimate',
    });
    expect(result.basis).toBe('measured_length');
    expect(result.confidence).toBe('medium');
  });

  it('nothing to compute from → null position, basis none, low confidence', () => {
    expect(hemForUser({ lengthInches: null, lengthClass: null }, AVERAGE)).toEqual({
      position: null,
      hemAboveFloorInches: null,
      basis: 'none',
      confidence: 'low',
    });
  });

  it('invalid heights are rejected safely', () => {
    for (const h of [0, -5, Number.NaN]) {
      expect(hemForUser({ lengthInches: 44, lengthClass: null }, h).position).toBeNull();
    }
  });

  it('petite extreme (4\'11″) and tall extreme (6\'0″) still classify (proportional bands)', () => {
    expect(hemForUser({ lengthInches: 36, lengthClass: null }, PETITE).position).toBe(
      'below_knee', // r = 12.38/59 ≈ 0.2098
    );
    expect(hemForUser({ lengthInches: 36, lengthClass: null }, TALL).position).toBe(
      'above_knee', // r = 23.04/72 = 0.32
    );
  });
});

describe('adjacentPositions (UI range copy at non-high confidence)', () => {
  it('interior band widens both ways', () => {
    expect(adjacentPositions('knee')).toEqual(['above_knee', 'knee', 'below_knee']);
  });
  it('edges widen one way', () => {
    expect(adjacentPositions('upper_thigh')).toEqual(['upper_thigh', 'above_knee']);
    expect(adjacentPositions('floor')).toEqual(['ankle', 'floor']);
  });
});

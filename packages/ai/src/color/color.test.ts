/**
 * Color-analysis determinism tests (doc §9.4: "selfie flow is unit-tested at
 * the sampling function"). Synthetic selfies are composed with sharp so the
 * pipeline runs end-to-end without a real photo, keyless (mock mode).
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ColorAnalysisResultSchema, type QuizAnswers } from '@hemline/contracts';
import { createAiClient } from '../client';
import { analyzeSelfie, classifyFromMeasured, classifyFromQuiz, sampleSelfie } from './index';
import { seasonFromAxes, SEASON_DATA } from './seasons';

const MOCK_ENV = {} as NodeJS.ProcessEnv;

/** Skin-colored canvas with a hair-colored strip across the top. */
async function syntheticSelfie(
  skin: { r: number; g: number; b: number },
  hair: { r: number; g: number; b: number },
  size: { width: number; height: number } = { width: 256, height: 320 },
): Promise<Buffer> {
  const hairStrip = await sharp({
    create: {
      width: size.width,
      height: Math.max(8, Math.round(size.height * 0.14)),
      channels: 3,
      background: hair,
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: size.width, height: size.height, channels: 3, background: skin },
  })
    .composite([{ input: hairStrip, top: 0, left: 0 }])
    .png()
    .toBuffer();
}

const WARM_LIGHT_SKIN = { r: 233, g: 189, b: 148 }; // golden-beige
const COOL_LIGHT_SKIN = { r: 231, g: 205, b: 210 }; // rosy-pink
const DEEP_SKIN = { r: 74, g: 47, b: 35 };
const DARK_BROWN_HAIR = { r: 62, g: 40, b: 24 };
const ASH_BLONDE_HAIR = { r: 205, g: 190, b: 165 };
const BLACK_HAIR = { r: 25, g: 20, b: 18 };

describe('sampleSelfie — deterministic pixel sampling', () => {
  it('same buffer → byte-identical MeasuredColors (deterministic)', async () => {
    const selfie = await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR);
    const a = await sampleSelfie(selfie);
    const b = await sampleSelfie(selfie);
    expect(a).toEqual(b);
  });

  it('separates skin and hair regions', async () => {
    const selfie = await syntheticSelfie(WARM_LIGHT_SKIN, BLACK_HAIR);
    const m = await sampleSelfie(selfie);
    expect(m.skin.L).toBeGreaterThan(60); // light skin
    expect(m.hair.L).toBeLessThan(20); // black hair
    expect(m.contrast).toBeGreaterThan(0.5);
  });

  it('warm skin measures warmer than cool skin', async () => {
    const warm = await sampleSelfie(await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR));
    const cool = await sampleSelfie(await syntheticSelfie(COOL_LIGHT_SKIN, DARK_BROWN_HAIR));
    expect(warm.warmth).toBeGreaterThan(cool.warmth);
    expect(warm.warmth).toBeGreaterThan(0);
  });

  it('eyes are null without tap points and sampled with them', async () => {
    const selfie = await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR);
    expect((await sampleSelfie(selfie)).eyes).toBeNull();
    const withEyes = await sampleSelfie(selfie, {
      eyePoints: [
        { x: 0.42, y: 0.42 },
        { x: 0.58, y: 0.42 },
      ],
    });
    expect(withEyes.eyes).not.toBeNull();
  });

  it('flags tiny images as poor quality', async () => {
    const tiny = await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR, {
      width: 60,
      height: 60,
    });
    expect((await sampleSelfie(tiny)).sampleQuality).toBe('poor');
  });

  it('flags hair-indistinct frames (bald canvas) as poor quality', async () => {
    const flat = await sharp({
      create: { width: 256, height: 320, channels: 3, background: WARM_LIGHT_SKIN },
    })
      .png()
      .toBuffer();
    expect((await sampleSelfie(flat)).sampleQuality).toBe('poor');
  });
});

describe('classifyFromMeasured — deterministic rule table', () => {
  it('classifies a warm light selfie into a warm season, deterministically', async () => {
    const selfie = await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR);
    const measured = await sampleSelfie(selfie);
    const a = classifyFromMeasured(measured);
    const b = classifyFromMeasured(measured);
    expect(a).toEqual(b);
    expect(() => ColorAnalysisResultSchema.parse(a)).not.toThrow();
    expect(['bright_spring', 'true_spring', 'light_spring', 'soft_autumn', 'true_autumn', 'dark_autumn']).toContain(a.season);
    expect(a.measured).toEqual(measured);
    expect(a.palette.length).toBeGreaterThanOrEqual(10);
    expect(a.palette.length).toBeLessThanOrEqual(14);
    expect(a.avoid.length).toBeGreaterThanOrEqual(5);
    expect(a.explanation).toMatch(/skin b\*/);
  });

  it('cool light selfie lands in a cool season', async () => {
    const measured = await sampleSelfie(await syntheticSelfie(COOL_LIGHT_SKIN, ASH_BLONDE_HAIR));
    const result = classifyFromMeasured(measured);
    expect([
      'light_summer',
      'true_summer',
      'soft_summer',
      'bright_winter',
      'true_winter',
      'dark_winter',
    ]).toContain(result.season);
  });

  it('deep skin (L* < 35) carries the doc §7.4 caveat suggesting the quiz', async () => {
    const measured = await sampleSelfie(await syntheticSelfie(DEEP_SKIN, BLACK_HAIR));
    expect(measured.skin.L).toBeLessThan(35);
    const result = classifyFromMeasured(measured);
    expect(result.caveat).toMatch(/quiz/i);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it('poor sample quality lowers confidence and sets a caveat', async () => {
    const measured = await sampleSelfie(
      await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR, { width: 60, height: 60 }),
    );
    const result = classifyFromMeasured(measured);
    expect(result.caveat).toMatch(/quiz/i);
    expect(result.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe('analyzeSelfie — end-to-end keyless', () => {
  it('runs the full pipeline in mock mode with the [MOCK] banner', async () => {
    const logs: string[] = [];
    const selfie = await syntheticSelfie(WARM_LIGHT_SKIN, DARK_BROWN_HAIR);
    const result = await analyzeSelfie(selfie, {
      client: createAiClient(MOCK_ENV),
      logger: (m) => logs.push(m),
    });
    expect(() => ColorAnalysisResultSchema.parse(result)).not.toThrow();
    expect(logs.some((l) => l.includes('[MOCK]'))).toBe(true);
  });
});

describe('classifyFromQuiz — manual fallback (pure, no LLM)', () => {
  const warmAnswers: QuizAnswers = {
    veinColor: 'green',
    jewelryMetal: 'gold',
    whiteVsCream: 'cream',
    sunReaction: 'tans_easily',
    naturalHair: 'auburn',
    eyeColor: 'hazel',
  };
  const coolAnswers: QuizAnswers = {
    veinColor: 'blue_purple',
    jewelryMetal: 'silver',
    whiteVsCream: 'white',
    sunReaction: 'burns_easily',
    naturalHair: 'blonde',
    eyeColor: 'blue',
  };

  it('is deterministic and contract-valid', () => {
    const a = classifyFromQuiz(warmAnswers);
    expect(a).toEqual(classifyFromQuiz({ ...warmAnswers }));
    expect(() => ColorAnalysisResultSchema.parse(a)).not.toThrow();
    expect(a.caveat).toBeNull();
  });

  it('warm answers → autumn/spring family; cool answers → summer/winter family', () => {
    expect(classifyFromQuiz(warmAnswers).season).toMatch(/autumn|spring/);
    expect(classifyFromQuiz(coolAnswers).season).toMatch(/summer|winter/);
  });

  it('deep coloring answers land in a dark season', () => {
    const deep: QuizAnswers = {
      veinColor: 'mixed_unsure',
      jewelryMetal: 'both',
      whiteVsCream: 'unsure',
      sunReaction: 'rarely_burns',
      naturalHair: 'black',
      eyeColor: 'dark_brown',
    };
    expect(classifyFromQuiz(deep).season).toMatch(/^dark_/);
  });
});

describe('season data tables', () => {
  it('every season has 10–14 palette colors and ≥5 avoids with valid hexes', () => {
    for (const [season, data] of Object.entries(SEASON_DATA)) {
      expect(data.palette.length, season).toBeGreaterThanOrEqual(10);
      expect(data.palette.length, season).toBeLessThanOrEqual(14);
      expect(data.avoid.length, season).toBeGreaterThanOrEqual(5);
      for (const c of [...data.palette, ...data.avoid]) {
        expect(c.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(c.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('rule table covers extremes', () => {
    expect(seasonFromAxes({ warmth: 0.5, depth: 20, chroma: 0.4, contrast: 0.4 })).toBe('dark_autumn');
    expect(seasonFromAxes({ warmth: -0.5, depth: 20, chroma: 0.4, contrast: 0.4 })).toBe('dark_winter');
    expect(seasonFromAxes({ warmth: 0.5, depth: 70, chroma: 0.4, contrast: 0.3 })).toBe('light_spring');
    expect(seasonFromAxes({ warmth: -0.5, depth: 70, chroma: 0.4, contrast: 0.3 })).toBe('light_summer');
    expect(seasonFromAxes({ warmth: 0.5, depth: 50, chroma: 0.7, contrast: 0.5 })).toBe('bright_spring');
    expect(seasonFromAxes({ warmth: -0.5, depth: 50, chroma: 0.7, contrast: 0.5 })).toBe('bright_winter');
    expect(seasonFromAxes({ warmth: 0.5, depth: 55, chroma: 0.2, contrast: 0.3 })).toBe('soft_autumn');
    expect(seasonFromAxes({ warmth: -0.5, depth: 55, chroma: 0.2, contrast: 0.3 })).toBe('soft_summer');
    expect(seasonFromAxes({ warmth: 0.5, depth: 42, chroma: 0.4, contrast: 0.4 })).toBe('true_spring');
    expect(seasonFromAxes({ warmth: 0.5, depth: 55, chroma: 0.4, contrast: 0.4 })).toBe('true_autumn');
    expect(seasonFromAxes({ warmth: -0.5, depth: 50, chroma: 0.4, contrast: 0.6 })).toBe('true_winter');
    expect(seasonFromAxes({ warmth: -0.5, depth: 50, chroma: 0.4, contrast: 0.3 })).toBe('true_summer');
  });
});

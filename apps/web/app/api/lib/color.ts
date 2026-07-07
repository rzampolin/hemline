/**
 * Stub-tolerant color analysis (ARCHITECTURE §7.4/§7.5).
 *
 * Tries @hemline/ai first (analyzeSelfie / classifyFromQuiz); when those throw
 * "not yet implemented" (or no ANTHROPIC_API_KEY), falls back to the
 * documented deterministic paths:
 *   - quiz: rule scoring table over warm/cool × depth × clarity axes (no LLM
 *     by design, §7.4 step 4)
 *   - selfie: deterministic season from a rule table keyed on a content hash
 *     of the uploaded bytes — same image ⇒ same season, so the flow demos.
 *     THE IMAGE BUFFER IS NEVER WRITTEN TO DISK OR DB.
 *
 * Integration: ai-eng's real implementations replace the fallbacks without
 * touching the routes.
 */
import { createHash } from 'node:crypto';
import type {
  ColorAnalysisResult,
  ColorSeason,
  MeasuredColors,
  PaletteColor,
  QuizAnswers,
} from '@hemline/contracts';

// ── 12-season palette table (10 recommended + 4 avoid each) ──────────────

interface SeasonSpec {
  palette: PaletteColor[];
  avoid: PaletteColor[];
  blurb: string;
}

const c = (hex: string, name: string): PaletteColor => ({ hex, name });

export const SEASON_TABLE: Record<ColorSeason, SeasonSpec> = {
  bright_winter: {
    palette: [
      c('#0F52BA', 'sapphire'), c('#E0115F', 'ruby'), c('#00A86B', 'jade'),
      c('#FF00FF', 'fuchsia'), c('#4B0082', 'indigo'), c('#00FFFF', 'ice cyan'),
      c('#FFFFFF', 'pure white'), c('#000000', 'true black'), c('#DC143C', 'crimson'),
      c('#7DF9FF', 'electric blue'),
    ],
    avoid: [c('#C08552', 'camel'), c('#808000', 'olive'), c('#D8C3A5', 'oat'), c('#E2725B', 'terracotta')],
    blurb: 'high contrast with cool undertones — clear, saturated jewel tones sing on you.',
  },
  true_winter: {
    palette: [
      c('#000080', 'navy'), c('#DC143C', 'true red'), c('#FFFFFF', 'pure white'),
      c('#000000', 'black'), c('#4169E1', 'royal blue'), c('#8F00FF', 'violet'),
      c('#FF69B4', 'shocking pink'), c('#008080', 'teal'), c('#50C878', 'emerald'),
      c('#C0C0C0', 'icy silver'),
    ],
    avoid: [c('#C9A66B', 'soft gold'), c('#A0522D', 'sienna'), c('#F5DEB3', 'wheat'), c('#808000', 'olive')],
    blurb: 'cool and deep — primary, icy, and jewel colors with real contrast.',
  },
  dark_winter: {
    palette: [
      c('#191970', 'midnight blue'), c('#722F37', 'wine'), c('#013220', 'forest'),
      c('#36013F', 'deep plum'), c('#8B0000', 'blood red'), c('#2F4F4F', 'dark teal'),
      c('#000000', 'black'), c('#FFFFFF', 'stark white'), c('#4B0082', 'indigo'),
      c('#800020', 'burgundy'),
    ],
    avoid: [c('#FFDAB9', 'peach'), c('#D8C3A5', 'oat'), c('#F0E68C', 'pale gold'), c('#FFB6C1', 'powder pink')],
    blurb: 'deep and cool-neutral — rich darks anchored by crisp white.',
  },
  bright_spring: {
    palette: [
      c('#FF4500', 'flame orange'), c('#00A86B', 'bright jade'), c('#FFD700', 'sun gold'),
      c('#FF69B4', 'warm pink'), c('#40E0D0', 'turquoise'), c('#7FFF00', 'lime'),
      c('#FF6347', 'coral red'), c('#1E90FF', 'clear blue'), c('#FFFF66', 'lemon'),
      c('#FFFFF0', 'ivory'),
    ],
    avoid: [c('#808080', 'gray'), c('#000000', 'black'), c('#9CAF88', 'sage'), c('#722F37', 'wine')],
    blurb: 'warm and vivid — clear, sunny brights with golden undertones.',
  },
  true_spring: {
    palette: [
      c('#FF7F50', 'coral'), c('#FFD700', 'golden yellow'), c('#32CD32', 'leaf green'),
      c('#40E0D0', 'turquoise'), c('#FF6347', 'tomato'), c('#FFA500', 'apricot'),
      c('#87CEEB', 'sky blue'), c('#FFFFF0', 'ivory'), c('#C46210', 'amber'),
      c('#98FB98', 'fresh mint'),
    ],
    avoid: [c('#000000', 'black'), c('#800020', 'burgundy'), c('#708090', 'slate'), c('#C0C0C0', 'silver')],
    blurb: 'golden and fresh — warm clear colors like coral, turquoise, and leaf green.',
  },
  light_spring: {
    palette: [
      c('#FFDAB9', 'peach'), c('#FFFACD', 'lemon chiffon'), c('#98FB98', 'mint'),
      c('#FFB6C1', 'shell pink'), c('#87CEEB', 'sky'), c('#F08080', 'soft coral'),
      c('#FFFFF0', 'ivory'), c('#E6E6FA', 'light aqua'), c('#F5DEB3', 'wheat'),
      c('#FFE4B5', 'buttercream'),
    ],
    avoid: [c('#000000', 'black'), c('#36013F', 'deep plum'), c('#8B0000', 'dark red'), c('#2F4F4F', 'dark teal')],
    blurb: 'light, warm, and delicate — sunlit pastels over anything heavy or dark.',
  },
  light_summer: {
    palette: [
      c('#B0E0E6', 'powder blue'), c('#E6E6FA', 'lavender'), c('#FFC0CB', 'rose pink'),
      c('#F5F5F5', 'soft white'), c('#AFEEEE', 'pale aqua'), c('#D8BFD8', 'thistle'),
      c('#C4AEAD', 'rose beige'), c('#93CCEA', 'cornflower'), c('#DCDCDC', 'dove gray'),
      c('#BDB5D5', 'wisteria'),
    ],
    avoid: [c('#FF4500', 'flame orange'), c('#000000', 'black'), c('#C46210', 'amber'), c('#808000', 'olive')],
    blurb: 'cool and light — misty blues, lavenders, and rose pinks.',
  },
  true_summer: {
    palette: [
      c('#4682B4', 'steel blue'), c('#C21E56', 'raspberry'), c('#708090', 'slate'),
      c('#B0C4DE', 'cloud blue'), c('#8E7CC3', 'soft violet'), c('#F5F5F5', 'soft white'),
      c('#5F8575', 'sea green'), c('#D87093', 'mauve rose'), c('#536878', 'denim'),
      c('#E0B0FF', 'lilac'),
    ],
    avoid: [c('#FF7F50', 'coral'), c('#FFD700', 'gold'), c('#C46210', 'amber'), c('#FF4500', 'orange')],
    blurb: 'cool and muted-soft — blue-based colors with gentle contrast.',
  },
  soft_summer: {
    palette: [
      c('#8C92AC', 'gray blue'), c('#C4AEAD', 'rose beige'), c('#9CAF88', 'eucalyptus'),
      c('#B784A7', 'dusty orchid'), c('#7A8B8B', 'pewter teal'), c('#AA98A9', 'heather'),
      c('#D8BFD8', 'faded lilac'), c('#A9A9A9', 'stone'), c('#BC8F8F', 'rosewood'),
      c('#778899', 'shadow blue'),
    ],
    avoid: [c('#FF4500', 'flame'), c('#FFFF00', 'bright yellow'), c('#000000', 'black'), c('#FF00FF', 'fuchsia')],
    blurb: 'muted and cool-neutral — misted, blended colors over anything neon.',
  },
  soft_autumn: {
    palette: [
      c('#B7410E', 'rust'), c('#C08552', 'camel'), c('#808000', 'olive'),
      c('#9CAF88', 'sage'), c('#E2725B', 'terracotta'), c('#C9A66B', 'soft gold'),
      c('#8E7CC3', 'dusty lilac'), c('#A0522D', 'sienna'), c('#D8C3A5', 'oat'),
      c('#6B4226', 'chocolate'),
    ],
    avoid: [c('#FF00FF', 'fuchsia'), c('#00FFFF', 'ice cyan'), c('#000000', 'true black'), c('#FFFFFF', 'stark white')],
    blurb: 'warm, muted, and earthy — spice and moss tones over icy brights.',
  },
  true_autumn: {
    palette: [
      c('#CC5500', 'burnt orange'), c('#808000', 'olive'), c('#B8860B', 'mustard gold'),
      c('#8B4513', 'saddle brown'), c('#C46210', 'amber'), c('#556B2F', 'moss'),
      c('#B7410E', 'rust'), c('#E97451', 'terracotta'), c('#FFFFF0', 'warm ivory'),
      c('#014421', 'pine'),
    ],
    avoid: [c('#FF69B4', 'pink'), c('#C0C0C0', 'silver'), c('#B0E0E6', 'powder blue'), c('#FF00FF', 'fuchsia')],
    blurb: 'richly warm — fire and harvest colors with golden undertones.',
  },
  dark_autumn: {
    palette: [
      c('#654321', 'espresso'), c('#800020', 'burgundy'), c('#556B2F', 'deep moss'),
      c('#B7410E', 'rust'), c('#8B4513', 'mahogany'), c('#013220', 'forest'),
      c('#B8860B', 'antique gold'), c('#4E1609', 'black coffee'), c('#C46210', 'amber'),
      c('#3B2F2F', 'dark taupe'),
    ],
    avoid: [c('#FFB6C1', 'powder pink'), c('#B0E0E6', 'powder blue'), c('#F5F5F5', 'soft white'), c('#E6E6FA', 'lavender')],
    blurb: 'deep and warm — burnished, smoldering darks over pale pastels.',
  },
};

const ALL_SEASONS = Object.keys(SEASON_TABLE) as ColorSeason[];

export function paletteForSeason(season: ColorSeason): PaletteColor[] {
  return SEASON_TABLE[season].palette;
}

// ── deterministic quiz classifier (§7.4 step 4 — no LLM by design) ──────

function quizAxes(a: QuizAnswers): { warmth: number; depth: number; clarity: number } {
  let warmth = 0;
  warmth += { blue_purple: -2, green: 2, mixed_unsure: 0 }[a.veinColor];
  warmth += { silver: -2, gold: 2, both: 0 }[a.jewelryMetal];
  warmth += { white: -1, cream: 1, unsure: 0 }[a.whiteVsCream];
  warmth += { burns_easily: -1, burns_then_tans: 0, tans_easily: 1, rarely_burns: 1 }[a.sunReaction];
  warmth += {
    black: -1, dark_brown: 0, medium_brown: 0, light_brown: 1, blonde: 1,
    strawberry_blonde: 2, red: 2, auburn: 2, gray_white: -1,
  }[a.naturalHair];

  let depth = 0;
  depth += { black: 2, dark_brown: 2, medium_brown: 1, light_brown: 0, blonde: -1,
    strawberry_blonde: -1, red: 0, auburn: 1, gray_white: -1 }[a.naturalHair];
  depth += { dark_brown: 2, brown: 1, hazel: 0, green: 0, blue: -1, gray: -1 }[a.eyeColor];

  // clarity: light bright eyes against dark hair reads high-contrast/clear
  let clarity = 0;
  clarity += { dark_brown: 0, brown: 0, hazel: 0, green: 1, blue: 1, gray: 0 }[a.eyeColor];
  clarity += { black: 1, dark_brown: 1, medium_brown: 0, light_brown: 0, blonde: 0,
    strawberry_blonde: 0, red: 1, auburn: 0, gray_white: 0 }[a.naturalHair];
  clarity += a.sunReaction === 'burns_easily' ? 1 : 0;

  return { warmth, depth, clarity };
}

/** Deterministic rule table: warm/cool × depth × clarity → 12 seasons. */
export function classifyQuizFallback(answers: QuizAnswers): ColorAnalysisResult {
  const { warmth, depth, clarity } = quizAxes(answers);
  const warm = warmth > 0;
  const cool = warmth < 0;
  const bright = clarity >= 2;

  let season: ColorSeason;
  if (cool) {
    if (depth >= 3) season = bright ? 'bright_winter' : 'dark_winter';
    else if (depth >= 1) season = bright ? 'true_winter' : 'true_summer';
    else if (depth <= -1) season = 'light_summer';
    else season = bright ? 'true_summer' : 'soft_summer';
  } else if (warm) {
    if (depth >= 3) season = bright ? 'bright_spring' : 'dark_autumn';
    else if (depth >= 1) season = bright ? 'true_spring' : 'true_autumn';
    else if (depth <= -1) season = 'light_spring';
    else season = bright ? 'true_spring' : 'soft_autumn';
  } else {
    // neutral leans soft; hair temperature breaks the tie
    const warmHair = ['light_brown', 'blonde', 'strawberry_blonde', 'red', 'auburn'].includes(
      answers.naturalHair,
    );
    season = warmHair ? 'soft_autumn' : 'soft_summer';
  }

  const spec = SEASON_TABLE[season];
  const measured = syntheticMeasured(season, `quiz:${JSON.stringify(answers)}`);
  return {
    season,
    confidence: 0.55,
    palette: spec.palette,
    avoid: spec.avoid,
    explanation:
      `Quiz result: your answers point ${warm ? 'warm' : cool ? 'cool' : 'neutral'} ` +
      `(warmth ${warmth}), ${depth >= 1 ? 'deep' : depth <= -1 ? 'light' : 'medium'} depth, ` +
      `${bright ? 'clear' : 'soft'} contrast → ${season.replace(/_/g, ' ')}: ${spec.blurb}`,
    measured,
    caveat:
      'Determined by the manual quiz scoring table (no photo analysis). ' +
      'You can adjust the season or palette before saving.',
  };
}

// ── deterministic selfie fallback (demo mode) ────────────────────────────

/** Plausible synthetic Lab measurements per season so the result inspects sanely. */
function syntheticMeasured(season: ColorSeason, seedKey: string): MeasuredColors {
  const seed = createHash('sha256').update(seedKey).digest();
  const jitter = (i: number, range: number) => ((seed[i] / 255) * 2 - 1) * range;
  const warm = /spring|autumn/.test(season);
  const deep = /dark/.test(season);
  const light = /light/.test(season);
  const skinL = deep ? 38 + jitter(0, 4) : light ? 68 + jitter(0, 4) : 55 + jitter(0, 5);
  const skinB = warm ? 18 + jitter(1, 3) : 8 + jitter(1, 3);
  const hairL = deep ? 15 + jitter(2, 4) : light ? 55 + jitter(2, 6) : 30 + jitter(2, 6);
  return {
    skin: { L: round1(skinL), a: round1(10 + jitter(3, 2)), b: round1(skinB), hex: warm ? '#C68863' : '#C4917E' },
    hair: { L: round1(hairL), a: round1(4 + jitter(4, 2)), b: round1(warm ? 12 : 2), hex: deep ? '#2A1B12' : '#6B4A2F' },
    eyes: null,
    contrast: round2(Math.min(1, Math.abs(hairL - skinL) / 100)),
    warmth: round2(Math.max(-1, Math.min(1, (skinB - 12) / 10))),
    chroma: round2(/bright/.test(season) ? 0.7 : /soft/.test(season) ? 0.3 : 0.5),
    sampleQuality: 'poor', // honest: demo fallback did not really sample pixels
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Deterministic season from a rule table over the image content hash — the
 * same selfie always maps to the same season. Demo-mode only (§7.5).
 */
export function selfieFallback(buffer: Buffer): ColorAnalysisResult {
  const digest = createHash('sha256').update(buffer).digest();
  const season = ALL_SEASONS[digest[0] % ALL_SEASONS.length];
  const spec = SEASON_TABLE[season];
  return {
    season,
    confidence: 0.3,
    palette: spec.palette,
    avoid: spec.avoid,
    explanation:
      `Demo-mode analysis → ${season.replace(/_/g, ' ')}: ${spec.blurb} ` +
      'Add ANTHROPIC_API_KEY for a real measurement-grounded analysis.',
    measured: syntheticMeasured(season, digest.toString('hex')),
    caveat:
      'AI color analysis is in demo mode (deterministic fallback). ' +
      'Try the quick quiz for a better manual result, or add ANTHROPIC_API_KEY.',
  };
}

// ── stub-tolerant entry points ───────────────────────────────────────────

export async function analyzeSelfieStubTolerant(buffer: Buffer): Promise<ColorAnalysisResult> {
  try {
    const ai = await import('@hemline/ai');
    return await ai.analyzeSelfie(buffer);
  } catch {
    return selfieFallback(buffer);
  }
}

export async function classifyQuizStubTolerant(answers: QuizAnswers): Promise<ColorAnalysisResult> {
  try {
    const ai = await import('@hemline/ai');
    return ai.classifyFromQuiz(answers);
  } catch {
    return classifyQuizFallback(answers);
  }
}

/**
 * 12-season color system — palettes, deterministic rule table, quiz scoring.
 * docs/ARCHITECTURE.md §7.4/§7.5.
 *
 * The deterministic classifier maps the measured Lab-derived axes
 * (value/depth, warmth, chroma, contrast) to a season. It is the keyless
 * fallback AND the rubric embedded in the Sonnet prompt, so live and mock
 * paths reason on the same axes.
 */
import type { ColorSeason, MeasuredColors, PaletteColor, QuizAnswers } from '@hemline/contracts';

export interface SeasonData {
  palette: PaletteColor[];
  avoid: PaletteColor[];
}

const p = (hex: string, name: string): PaletteColor => ({ hex, name });

/** 10–14 recommended dress colors + ~5 to de-prioritize, per season. */
export const SEASON_DATA: Record<ColorSeason, SeasonData> = {
  bright_winter: {
    palette: [
      p('#0047AB', 'cobalt'), p('#E0115F', 'ruby'), p('#FF00FF', 'magenta'),
      p('#000000', 'true black'), p('#FFFFFF', 'pure white'), p('#00A86B', 'jade'),
      p('#4B0082', 'indigo'), p('#DC143C', 'crimson'), p('#00CED1', 'turquoise'),
      p('#1034A6', 'royal blue'), p('#FF69B4', 'hot pink'), p('#50C878', 'emerald'),
    ],
    avoid: [
      p('#C19A6B', 'camel'), p('#808000', 'olive'), p('#E2725B', 'terracotta'),
      p('#DCAE96', 'dusty rose'), p('#F5F5DC', 'beige'),
    ],
  },
  true_winter: {
    palette: [
      p('#000080', 'navy'), p('#DC143C', 'true red'), p('#FFFFFF', 'pure white'),
      p('#000000', 'black'), p('#50C878', 'emerald'), p('#9932CC', 'violet'),
      p('#FF1493', 'fuchsia'), p('#4682B4', 'ice blue'), p('#800020', 'burgundy'),
      p('#36454F', 'charcoal'), p('#0047AB', 'cobalt'), p('#C8A2C8', 'icy lilac'),
    ],
    avoid: [
      p('#E1AD01', 'mustard'), p('#CC5500', 'burnt orange'), p('#C19A6B', 'camel'),
      p('#9CAF88', 'sage'), p('#FFFDD0', 'cream'),
    ],
  },
  dark_winter: {
    palette: [
      p('#000000', 'black'), p('#800020', 'burgundy'), p('#191970', 'midnight blue'),
      p('#014421', 'forest green'), p('#8E4585', 'plum'), p('#36454F', 'charcoal'),
      p('#B22222', 'brick red'), p('#4B0082', 'indigo'), p('#008080', 'deep teal'),
      p('#FFFFFF', 'white'), p('#D2042D', 'cherry red'), p('#563C5C', 'aubergine'),
    ],
    avoid: [
      p('#FFFD74', 'butter yellow'), p('#F4C2C2', 'blush'), p('#B0E0E6', 'powder blue'),
      p('#DCAE96', 'dusty rose'), p('#FFE5B4', 'peach'),
    ],
  },
  bright_spring: {
    palette: [
      p('#FF4500', 'poppy'), p('#00CED1', 'turquoise'), p('#FFD700', 'sunflower'),
      p('#32CD32', 'lime green'), p('#FF69B4', 'hot pink'), p('#FF7F50', 'coral'),
      p('#1E90FF', 'bright blue'), p('#50C878', 'emerald'), p('#FFA500', 'tangerine'),
      p('#FFFFF0', 'ivory'), p('#DC143C', 'crimson'), p('#7FFF00', 'chartreuse'),
    ],
    avoid: [
      p('#36454F', 'charcoal'), p('#DCAE96', 'dusty rose'), p('#808000', 'olive drab'),
      p('#C0C0C0', 'silver gray'), p('#000000', 'black'),
    ],
  },
  true_spring: {
    palette: [
      p('#FF7F50', 'coral'), p('#FFD700', 'golden yellow'), p('#40E0D0', 'turquoise'),
      p('#9ACD32', 'apple green'), p('#FF6347', 'tomato red'), p('#FFFFF0', 'ivory'),
      p('#FFA07A', 'salmon'), p('#00A86B', 'jade'), p('#DAA520', 'goldenrod'),
      p('#87CEEB', 'sky blue'), p('#E2725B', 'terracotta'), p('#FFE5B4', 'peach'),
    ],
    avoid: [
      p('#000000', 'black'), p('#800020', 'burgundy'), p('#36454F', 'charcoal'),
      p('#B0C4DE', 'icy blue'), p('#8E4585', 'plum'),
    ],
  },
  light_spring: {
    palette: [
      p('#FFE5B4', 'peach'), p('#FFFACD', 'lemon chiffon'), p('#98FB98', 'mint'),
      p('#F4C2C2', 'blush'), p('#87CEEB', 'sky blue'), p('#FFFDD0', 'cream'),
      p('#FFA07A', 'light coral'), p('#B0E0E6', 'powder blue'), p('#F0E68C', 'soft yellow'),
      p('#E6E6FA', 'lavender mist'), p('#FFDAB9', 'apricot'), p('#C1E1C1', 'celadon'),
    ],
    avoid: [
      p('#000000', 'black'), p('#800020', 'burgundy'), p('#4B0082', 'indigo'),
      p('#36454F', 'charcoal'), p('#B7410E', 'rust'),
    ],
  },
  light_summer: {
    palette: [
      p('#B0E0E6', 'powder blue'), p('#E6E6FA', 'lavender'), p('#F4C2C2', 'rose pink'),
      p('#AFEEEE', 'pale aqua'), p('#D8BFD8', 'thistle'), p('#F5F5F5', 'soft white'),
      p('#87CEEB', 'sky blue'), p('#C4AEAD', 'rose quartz'), p('#9FB6CD', 'slate blue'),
      p('#DCD0FF', 'periwinkle'), p('#C8A2C8', 'lilac'), p('#98BFB5', 'seafoam'),
    ],
    avoid: [
      p('#CC5500', 'burnt orange'), p('#E1AD01', 'mustard'), p('#000000', 'black'),
      p('#B7410E', 'rust'), p('#FF4500', 'bright orange'),
    ],
  },
  true_summer: {
    palette: [
      p('#4682B4', 'steel blue'), p('#C8A2C8', 'lilac'), p('#DCAE96', 'dusty rose'),
      p('#708090', 'slate gray'), p('#9FB6CD', 'cadet blue'), p('#FFFFFF', 'soft white'),
      p('#8E7CC3', 'wisteria'), p('#5F8A8B', 'teal gray'), p('#B784A7', 'mauve'),
      p('#A2ADD0', 'periwinkle'), p('#800080', 'soft plum'), p('#77DD77', 'sea green'),
    ],
    avoid: [
      p('#FF4500', 'orange red'), p('#E1AD01', 'mustard'), p('#CC5500', 'burnt orange'),
      p('#000000', 'black'), p('#D4AF37', 'gold'),
    ],
  },
  soft_summer: {
    palette: [
      p('#DCAE96', 'dusty rose'), p('#9CAF88', 'sage'), p('#708090', 'slate'),
      p('#B784A7', 'mauve'), p('#98BFB5', 'seafoam gray'), p('#C4AEAD', 'rose taupe'),
      p('#8E7CC3', 'dusty violet'), p('#5F8A8B', 'muted teal'), p('#A9A9A9', 'dove gray'),
      p('#BC8F8F', 'rosy brown'), p('#6E7F80', 'blue spruce'), p('#D3C4D1', 'orchid gray'),
    ],
    avoid: [
      p('#FF4500', 'bright orange'), p('#FF00FF', 'magenta'), p('#FFD700', 'bright gold'),
      p('#000000', 'black'), p('#7FFF00', 'chartreuse'),
    ],
  },
  soft_autumn: {
    palette: [
      p('#C19A6B', 'camel'), p('#9CAF88', 'sage'), p('#E2725B', 'terracotta'),
      p('#808000', 'olive'), p('#BC8F8F', 'rosy brown'), p('#F5F5DC', 'soft beige'),
      p('#B7410E', 'muted rust'), p('#8F9779', 'artichoke'), p('#D2B48C', 'tan'),
      p('#A0785A', 'toffee'), p('#DCAE96', 'dusty coral'), p('#6B8E23', 'moss'),
    ],
    avoid: [
      p('#FF00FF', 'magenta'), p('#0047AB', 'cobalt'), p('#000000', 'black'),
      p('#FFFFFF', 'pure white'), p('#FF69B4', 'hot pink'),
    ],
  },
  true_autumn: {
    palette: [
      p('#B7410E', 'rust'), p('#808000', 'olive'), p('#E1AD01', 'mustard'),
      p('#CC5500', 'burnt orange'), p('#C19A6B', 'camel'), p('#FFFDD0', 'cream'),
      p('#228B22', 'forest green'), p('#E2725B', 'terracotta'), p('#8B4513', 'saddle brown'),
      p('#DAA520', 'goldenrod'), p('#5D3A1A', 'chocolate'), p('#008080', 'deep teal'),
    ],
    avoid: [
      p('#FF69B4', 'hot pink'), p('#B0E0E6', 'powder blue'), p('#C8A2C8', 'icy lilac'),
      p('#FFFFFF', 'pure white'), p('#C0C0C0', 'silver'),
    ],
  },
  dark_autumn: {
    palette: [
      p('#5D3A1A', 'chocolate'), p('#800020', 'burgundy'), p('#556B2F', 'dark olive'),
      p('#B7410E', 'rust'), p('#8B4513', 'saddle brown'), p('#FFFDD0', 'cream'),
      p('#014421', 'forest green'), p('#CC5500', 'burnt orange'), p('#704214', 'sepia'),
      p('#9B111E', 'brick'), p('#E1AD01', 'mustard'), p('#36454F', 'deep charcoal'),
    ],
    avoid: [
      p('#F4C2C2', 'blush'), p('#B0E0E6', 'powder blue'), p('#FFFACD', 'pastel yellow'),
      p('#E6E6FA', 'lavender'), p('#FF69B4', 'hot pink'),
    ],
  },
};

// ── deterministic rule table over the measured axes ─────────────────────────

export const WARM_THRESHOLD = 0.15;
export const COOL_THRESHOLD = -0.15;

export interface SeasonAxes {
  /** −1..1: <COOL_THRESHOLD cool, >WARM_THRESHOLD warm, else neutral */
  warmth: number;
  /** 0..100 weighted value: 0.6·skinL + 0.4·hairL */
  depth: number;
  /** 0..1 */
  chroma: number;
  /** 0..1 */
  contrast: number;
}

export function axesFromMeasured(m: MeasuredColors): SeasonAxes {
  return {
    warmth: m.warmth,
    depth: 0.6 * m.skin.L + 0.4 * m.hair.L,
    chroma: m.chroma,
    contrast: m.contrast,
  };
}

/**
 * The 12-season decision rubric (value → chroma → warmth axes). Also embedded
 * verbatim (in prose) in the Sonnet prompt so the live path is grounded in the
 * same rules.
 */
export function seasonFromAxes(axes: SeasonAxes): ColorSeason {
  const warm = axes.warmth > WARM_THRESHOLD;
  const cool = axes.warmth < COOL_THRESHOLD;

  // 1. Depth dominates: deep coloring → dark seasons
  if (axes.depth <= 32) return warm ? 'dark_autumn' : 'dark_winter';
  // 2. Very light coloring → light seasons
  if (axes.depth >= 62) return warm ? 'light_spring' : 'light_summer';
  // 3. High clarity/contrast → bright seasons
  if (axes.chroma >= 0.55 || axes.contrast >= 0.65) {
    return warm ? 'bright_spring' : 'bright_winter';
  }
  // 4. Muted → soft seasons
  if (axes.chroma <= 0.3) return warm ? 'soft_autumn' : 'soft_summer';
  // 5. "True" seasons: warmth decides family; depth/contrast pick within it
  if (warm) return axes.depth < 48 ? 'true_spring' : 'true_autumn';
  if (cool) return axes.contrast >= 0.45 ? 'true_winter' : 'true_summer';
  // Neutral warmth mid-everything: contrast breaks the tie toward winter/summer
  return axes.contrast >= 0.45 ? 'true_winter' : 'soft_summer';
}

export function confidenceFromAxes(
  axes: SeasonAxes,
  sampleQuality: MeasuredColors['sampleQuality'],
): number {
  let confidence = 0.8;
  if (Math.abs(axes.warmth) < WARM_THRESHOLD) confidence -= 0.15; // neutral undertone
  if (sampleQuality === 'poor') confidence -= 0.25;
  if (axes.depth > 32 && axes.depth < 40) confidence -= 0.05; // near the deep boundary
  return Math.max(0.3, Math.min(0.9, Math.round(confidence * 100) / 100));
}

/**
 * §7.4 known-limits caveat: Lab warmth is less discriminative for deep and
 * olive skin (and consumer lighting worsens it) → suggest the quiz.
 */
export function caveatFor(measured: MeasuredColors): string | null {
  if (measured.sampleQuality === 'poor') {
    return 'Lighting or framing made this sample unreliable — try the quick quiz for a more confident result.';
  }
  if (measured.skin.L < 35) {
    return 'Automated undertone analysis is less reliable for deeper skin tones — the quick quiz can confirm your season.';
  }
  const oliveLean = measured.skin.a < 6 && measured.skin.b > 16;
  if (oliveLean) {
    return 'Olive undertones are hard to measure from a photo — the quick quiz can confirm your season.';
  }
  return null;
}

// ── manual quiz fallback (pure function, no LLM) ────────────────────────────

/**
 * Quiz answers → the same axes, via a deterministic scoring table
 * (doc §7.4 step 4: vein color, jewelry metal, white-vs-cream, sun reaction,
 * natural hair/eye combos).
 */
export function axesFromQuiz(answers: QuizAnswers): SeasonAxes {
  let warmth = 0;
  warmth += { blue_purple: -0.5, green: 0.5, mixed_unsure: 0 }[answers.veinColor];
  warmth += { silver: -0.35, gold: 0.35, both: 0 }[answers.jewelryMetal];
  warmth += { white: -0.15, cream: 0.15, unsure: 0 }[answers.whiteVsCream];
  warmth += {
    burns_easily: -0.1,
    burns_then_tans: 0,
    tans_easily: 0.1,
    rarely_burns: 0.1,
  }[answers.sunReaction];

  const hairDepth = {
    black: 10,
    dark_brown: 22,
    medium_brown: 38,
    light_brown: 50,
    blonde: 68,
    strawberry_blonde: 62,
    red: 45,
    auburn: 32,
    gray_white: 75,
  }[answers.naturalHair];
  const skinDepth = {
    burns_easily: 72,
    burns_then_tans: 62,
    tans_easily: 50,
    rarely_burns: 34,
  }[answers.sunReaction];
  const depth = 0.6 * skinDepth + 0.4 * hairDepth;

  const eyeChroma = {
    dark_brown: 0.35,
    brown: 0.4,
    hazel: 0.45,
    green: 0.55,
    blue: 0.5,
    gray: 0.25,
  }[answers.eyeColor];
  const hairChroma = {
    black: 0.35,
    dark_brown: 0.35,
    medium_brown: 0.35,
    light_brown: 0.35,
    blonde: 0.45,
    strawberry_blonde: 0.55,
    red: 0.7,
    auburn: 0.55,
    gray_white: 0.15,
  }[answers.naturalHair];
  const chroma = (eyeChroma + hairChroma) / 2;

  const warmHairBonus: Partial<Record<QuizAnswers['naturalHair'], number>> = {
    red: 0.25,
    auburn: 0.2,
    strawberry_blonde: 0.15,
  };
  const eyeWarmthLean: Partial<Record<QuizAnswers['eyeColor'], number>> = {
    green: 0.1,
    hazel: 0.1,
    blue: -0.1,
    gray: -0.1,
  };
  warmth += warmHairBonus[answers.naturalHair] ?? 0;
  warmth += eyeWarmthLean[answers.eyeColor] ?? 0;

  const contrast = Math.min(1, Math.abs(skinDepth - hairDepth) / 60);

  return {
    warmth: Math.max(-1, Math.min(1, warmth)),
    depth,
    chroma,
    contrast,
  };
}

/** Representative measured values synthesized from quiz axes (contract requires them). */
export function syntheticMeasuredFromAxes(axes: SeasonAxes): MeasuredColors {
  const skinL = Math.min(85, axes.depth + 12);
  const hairL = Math.max(5, axes.depth - 18);
  const b = WARMTH_B_NEUTRAL + axes.warmth * 10;
  return {
    skin: { L: round1(skinL), a: 10, b: round1(b), hex: '#000000' },
    hair: { L: round1(hairL), a: 6, b: round1(b * 0.8), hex: '#000000' },
    eyes: null,
    contrast: round3(axes.contrast),
    warmth: round3(axes.warmth),
    chroma: round3(axes.chroma),
    sampleQuality: 'good',
  };
}

const WARMTH_B_NEUTRAL = 14;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

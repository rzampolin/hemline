/**
 * Deterministic selfie pixel sampling — docs/ARCHITECTURE.md §7.4 step 2.
 *
 * sharp, in-memory only: the selfie buffer is sampled and DISCARDED — never
 * written to disk, DB, or any log. Fixed regions relative to the client's
 * oval face guide (pragmatic center-weighted sampling; no face-detection
 * dependency): cheek patches → skin, forehead-top strip extended upward →
 * hair, optional user-tapped eye points. Each region is median-filtered with
 * the top/bottom 20% luminance dropped (speculars/shadows), then converted
 * sRGB → CIE Lab (D65).
 */
import sharp from 'sharp';
import type { MeasuredColors } from '@hemline/contracts';

/** Normalized sampling canvas — inputs are resized (fill) to this geometry. */
const CANVAS_W = 256;
const CANVAS_H = 320;

interface Region {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Regions relative to the onboarding oval guide (centered, face ≈ middle). */
const SKIN_REGIONS: Region[] = [
  { cx: 0.38, cy: 0.52, rx: 0.05, ry: 0.045 }, // left cheek
  { cx: 0.62, cy: 0.52, rx: 0.05, ry: 0.045 }, // right cheek
  { cx: 0.5, cy: 0.33, rx: 0.05, ry: 0.035 }, // mid-forehead
];
/** Forehead-top strip extended upward, above the guide oval. */
const HAIR_REGION: Region = { cx: 0.5, cy: 0.07, rx: 0.2, ry: 0.055 };

export interface SampleSelfieOptions {
  /** Optional user-tapped eye points, normalized 0..1 image coords. */
  eyePoints?: Array<{ x: number; y: number }>;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export async function sampleSelfie(
  imageBuffer: Buffer,
  options: SampleSelfieOptions = {},
): Promise<MeasuredColors> {
  const image = sharp(imageBuffer).rotate(); // honor EXIF orientation
  const meta = await image.metadata();
  const tooSmall = (meta.width ?? 0) < 96 || (meta.height ?? 0) < 96;

  const { data } = await image
    .removeAlpha()
    .resize(CANVAS_W, CANVAS_H, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const skinPixels = SKIN_REGIONS.flatMap((r) => collectRegion(data, r));
  const hairPixels = collectRegion(data, HAIR_REGION);
  const eyeRegions = (options.eyePoints ?? []).map((p) => ({
    cx: p.x,
    cy: p.y,
    rx: 0.02,
    ry: 0.016,
  }));
  const eyePixels = eyeRegions.flatMap((r) => collectRegion(data, r));

  const skinRgb = robustMedianRgb(skinPixels);
  const hairRgb = robustMedianRgb(hairPixels);
  const eyeRgb = eyePixels.length > 0 ? robustMedianRgb(eyePixels) : null;

  const skin = srgbToLab(skinRgb);
  const hair = srgbToLab(hairRgb);
  const eyes = eyeRgb ? srgbToLab(eyeRgb) : null;

  const contrast = clamp(Math.abs(hair.L - skin.L) / 100, 0, 1);
  const warmth = clamp((skin.b - WARMTH_NEUTRAL_B) / WARMTH_SCALE, -1, 1);
  const chroma = clamp((labChroma(skin) + labChroma(hair)) / 2 / CHROMA_SCALE, 0, 1);

  // quality heuristics (doc §7.4: lighting/size)
  const overexposed = skin.L > 92;
  const underexposed = skin.L < 18;
  const clippedFraction = fractionClipped(skinPixels);
  const hairIndistinct =
    Math.abs(hair.L - skin.L) < 3 &&
    Math.abs(hair.a - skin.a) + Math.abs(hair.b - skin.b) < 4;
  const sampleQuality: MeasuredColors['sampleQuality'] =
    tooSmall || overexposed || underexposed || clippedFraction > 0.4 || hairIndistinct
      ? 'poor'
      : 'good';

  return {
    skin: { ...roundLab(skin), hex: rgbToHex(skinRgb) },
    hair: { ...roundLab(hair), hex: rgbToHex(hairRgb) },
    eyes: eyes && eyeRgb ? { ...roundLab(eyes), hex: rgbToHex(eyeRgb) } : null,
    contrast: round3(contrast),
    warmth: round3(warmth),
    chroma: round3(chroma),
    sampleQuality,
  };
}

/** Typical skin b* runs ~8..24; 14 ≈ neutral undertone. */
export const WARMTH_NEUTRAL_B = 14;
export const WARMTH_SCALE = 10;
/** Chroma normalizer: C* of ~60 ≈ fully saturated for skin/hair. */
export const CHROMA_SCALE = 60;

type Rgb = [number, number, number];

function collectRegion(data: Buffer, region: Region): Rgb[] {
  const x0 = Math.max(0, Math.floor((region.cx - region.rx) * CANVAS_W));
  const x1 = Math.min(CANVAS_W - 1, Math.ceil((region.cx + region.rx) * CANVAS_W));
  const y0 = Math.max(0, Math.floor((region.cy - region.ry) * CANVAS_H));
  const y1 = Math.min(CANVAS_H - 1, Math.ceil((region.cy + region.ry) * CANVAS_H));
  const pixels: Rgb[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * CANVAS_W + x) * 3;
      pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
  }
  return pixels;
}

/** Drop top/bottom 20% by luminance, then per-channel median. */
function robustMedianRgb(pixels: Rgb[]): Rgb {
  if (pixels.length === 0) return [128, 128, 128];
  const byLuma = [...pixels].sort((a, b) => luma(a) - luma(b));
  const lo = Math.floor(byLuma.length * 0.2);
  const hi = Math.ceil(byLuma.length * 0.8);
  const kept = byLuma.slice(lo, Math.max(lo + 1, hi));
  return [medianOf(kept, 0), medianOf(kept, 1), medianOf(kept, 2)];
}

function medianOf(pixels: Rgb[], channel: number): number {
  const values = pixels.map((p) => p[channel]).sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function luma([r, g, b]: Rgb): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function fractionClipped(pixels: Rgb[]): number {
  if (pixels.length === 0) return 0;
  const clipped = pixels.filter(([r, g, b]) => (r > 250 && g > 250 && b > 250) || (r < 5 && g < 5 && b < 5));
  return clipped.length / pixels.length;
}

// ── sRGB (D65) → CIE Lab ───────────────────────────────────────────────────

export function srgbToLab([r8, g8, b8]: Rgb): Lab {
  const [r, g, b] = [r8, g8, b8].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  // linear RGB → XYZ (D65)
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  // XYZ → Lab, D65 white point
  const xn = 0.95047;
  const yn = 1.0;
  const zn = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / xn);
  const fy = f(y / yn);
  const fz = f(z / zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labChroma(lab: Lab): number {
  return Math.sqrt(lab.a * lab.a + lab.b * lab.b);
}

function rgbToHex([r, g, b]: Rgb): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function roundLab(lab: Lab): Lab {
  return { L: round1(lab.L), a: round1(lab.a), b: round1(lab.b) };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

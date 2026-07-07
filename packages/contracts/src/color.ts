/**
 * Color analysis contracts — docs/ARCHITECTURE.md §4.6
 * Boundary: ai-eng ⇄ frontend-eng. FROZEN.
 */
import { z } from 'zod';
import { ColorSeasonSchema, PaletteColorSchema } from './profile';

const LabColorSchema = z.object({
  L: z.number(),
  a: z.number(),
  b: z.number(),
  hex: z.string(),
});

/** Deterministic pixel sampling output (Lab space). */
export const MeasuredColorsSchema = z.object({
  skin: LabColorSchema,
  hair: LabColorSchema,
  eyes: LabColorSchema.nullable(),
  /** |L_hair − L_skin| normalized 0..1 */
  contrast: z.number(),
  /** skin b* leaning, normalized −1..1 */
  warmth: z.number(),
  /** avg chroma, normalized 0..1 */
  chroma: z.number(),
  /** lighting/size heuristics */
  sampleQuality: z.enum(['good', 'poor']),
});
export type MeasuredColors = z.infer<typeof MeasuredColorsSchema>;

export const ColorAnalysisResultSchema = z.object({
  season: ColorSeasonSchema,
  confidence: z.number(),
  /** 10–14 recommended dress colors */
  palette: z.array(PaletteColorSchema),
  avoid: z.array(PaletteColorSchema),
  /** grounded in the measured values */
  explanation: z.string(),
  /** returned so the user can inspect/edit */
  measured: MeasuredColorsSchema,
  /** set when sampleQuality='poor' or deep/olive skin ranges → suggest quiz */
  caveat: z.string().nullable(),
  /**
   * Optional (additive): how the result was produced. 'quiz' results carry
   * SYNTHESIZED `measured` values (no selfie was sampled) — label them so the
   * UI can say so.
   */
  source: z.enum(['selfie', 'quiz']).optional(),
});
export type ColorAnalysisResult = z.infer<typeof ColorAnalysisResultSchema>;

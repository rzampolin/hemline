/**
 * User profile contracts — docs/ARCHITECTURE.md §4.5
 * Boundary: backend-eng ⇄ frontend-eng. FROZEN.
 */
import { z } from 'zod';
import { HemPositionSchema } from './matching';

export const ColorSeasonSchema = z.enum([
  'bright_winter',
  'true_winter',
  'dark_winter',
  'bright_spring',
  'true_spring',
  'light_spring',
  'light_summer',
  'true_summer',
  'soft_summer',
  'soft_autumn',
  'true_autumn',
  'dark_autumn',
]);
export type ColorSeason = z.infer<typeof ColorSeasonSchema>;

export const PaletteColorSchema = z.object({ hex: z.string(), name: z.string() });
export type PaletteColor = z.infer<typeof PaletteColorSchema>;

export const UserProfileSchema = z.object({
  id: z.string(),
  heightInches: z.number().nullable(),
  heelPrefInches: z.number(),
  sizesNormalized: z.array(z.number()),
  bodyMeasurements: z.object({
    bust: z.number().nullable(),
    waist: z.number().nullable(),
    hip: z.number().nullable(),
  }),
  brandSizes: z.array(z.object({ brand: z.string(), sizeLabel: z.string() })),
  lengthPrefs: z.array(HemPositionSchema),
  coveragePrefs: z.object({
    sleeves: z.boolean().optional(),
    highNeckline: z.boolean().optional(),
    backCoverage: z.boolean().optional(),
  }),
  budget: z.object({
    minCents: z.number().nullable(),
    maxCents: z.number().nullable(),
  }),
  colorSeason: ColorSeasonSchema.nullable(),
  palette: z.array(PaletteColorSchema),
  /** learned from swipes */
  styleTags: z.record(z.string(), z.number()),
  onboarded: z.boolean(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SwipeEventSchema = z.object({
  listingId: z.string(),
  verdict: z.enum(['like', 'dislike', 'save', 'skip']),
  context: z.enum(['calibration', 'feed', 'search']),
});
export type SwipeEvent = z.infer<typeof SwipeEventSchema>;

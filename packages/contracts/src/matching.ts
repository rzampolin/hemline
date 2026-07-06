/**
 * Matching & ranking contracts — docs/ARCHITECTURE.md §4.4
 * Boundary: ai-eng ⇄ backend-eng. FROZEN.
 */
import { z } from 'zod';
import { ConditionSchema, ListingSchema } from './listing';
import type { Listing } from './listing';

export const HemPositionSchema = z.enum([
  'upper_thigh',
  'above_knee',
  'knee',
  'below_knee',
  'mid_calf',
  'ankle',
  'floor',
]);
export type HemPosition = z.infer<typeof HemPositionSchema>;

export const HardFiltersSchema = z.object({
  sizesNormalized: z.array(z.number()).optional(),
  priceMinCents: z.number().int().nonnegative().optional(),
  priceMaxCents: z.number().int().nonnegative().optional(),
  /** "I want dresses that hit knee/midi ON ME" */
  lengthOnBody: z.array(HemPositionSchema).optional(),
  conditions: z.array(ConditionSchema).optional(),
  brands: z.array(z.string()).optional(),
  colorFamilies: z.array(z.string()).optional(),
  /** free-text (FTS over title/brand/desc) */
  query: z.string().optional(),
});
export type HardFilters = z.infer<typeof HardFiltersSchema>;

export const HemResultSchema = z.object({
  /** null when nothing to compute from */
  position: HemPositionSchema.nullable(),
  hemAboveFloorInches: z.number().nullable(),
  basis: z.enum(['measured_length', 'length_class_prior', 'none']),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type HemResult = z.infer<typeof HemResultSchema>;

export const RankRequestSchema = z.object({
  userId: z.string(),
  filters: HardFiltersSchema,
  /** page size, e.g. 24 */
  limit: z.number().int().positive(),
  cursor: z.string().optional(),
  /** false → pure deterministic scoring (no LLM), used for cheap pagination */
  personalize: z.boolean(),
});
export type RankRequest = z.infer<typeof RankRequestSchema>;

export const RankedListingSchema = z.object({
  listing: ListingSchema,
  /** computed for THIS user */
  hem: HemResultSchema,
  /** final blended score 0..1 */
  score: z.number(),
  /** one-liner from Haiku re-rank (top-N only) */
  whyItWorks: z.string().nullable(),
  /** 0..1 multiplier applied */
  freshnessDecay: z.number(),
});
export type RankedListing = z.infer<typeof RankedListingSchema>;

export const RankResponseSchema = z.object({
  items: z.array(RankedListingSchema),
  nextCursor: z.string().nullable(),
  totalMatched: z.number().int().nonnegative(),
  rerank: z.object({
    mode: z.enum(['llm', 'deterministic', 'cache']),
    costUsd: z.number().nullable(),
  }),
});
export type RankResponse = z.infer<typeof RankResponseSchema>;

export interface MatchingService {
  rank(req: RankRequest): Promise<RankResponse>;
  hemForUser(
    listing: Pick<Listing, 'lengthInches' | 'lengthClass'>,
    heightInches: number,
    heelInches?: number,
  ): HemResult;
}

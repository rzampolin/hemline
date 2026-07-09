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
  /**
   * Budget bounds are USD cents (spec §3: budgets are USD-only). Listings in
   * other currencies are compared via their static-FX USD equivalent
   * (contracts/fx.ts, 2026-07-08) — display stays native-currency.
   */
  priceMinCents: z.number().int().nonnegative().optional(),
  priceMaxCents: z.number().int().nonnegative().optional(),
  /** "I want dresses that hit knee/midi ON ME" */
  lengthOnBody: z.array(HemPositionSchema).optional(),
  conditions: z.array(ConditionSchema).optional(),
  brands: z.array(z.string()).optional(),
  colorFamilies: z.array(z.string()).optional(),
  /**
   * Source facet (additive, 2026-07-06 integration): source ids
   * ('fixture:ebay', 'shopify:staud.clothing', …) or the kind aliases
   * 'resale' | 'brand', which the backend expands (spec B3 source filter).
   */
  sources: z.array(z.string()).optional(),
  /** free-text (FTS over title/brand/desc) */
  query: z.string().optional(),
  /**
   * Additive (2026-07-09, hybrid search): query terms the user explicitly
   * un-chipped from the interpretation — these terms are NEVER mapped onto
   * structured/semantic signals and participate as plain lexical text only.
   * Ignored when `query` is absent.
   */
  lexicalTerms: z.array(z.string()).optional(),
});
export type HardFilters = z.infer<typeof HardFiltersSchema>;

// ── search interpretation (additive, 2026-07-09 hybrid free-text search) ──

/**
 * One signal the query interpreter extracted from free text. `hard: true`
 * signals became SQL hard filters (price/size/length/brand — things the user
 * explicitly constrained); `hard: false` signals are ranking boosts only
 * (occasion/color/fabric/silhouette/… — never filters, per the design rule
 * that vibe/mood language must not hard-filter).
 */
export const InterpretedSignalSchema = z.object({
  kind: z.enum([
    'occasion',
    'color',
    'length',
    'fabric',
    'silhouette',
    'neckline',
    'pattern',
    'brand',
    'price',
    'size',
  ]),
  /** the raw query text consumed (chip-removal key → HardFilters.lexicalTerms) */
  term: z.string(),
  /** canonical taxonomy value / display value (e.g. 'formal', 'pink', 'under $150') */
  value: z.string(),
  hard: z.boolean(),
});
export type InterpretedSignal = z.infer<typeof InterpretedSignalSchema>;

/** What the hybrid search understood — additive on RankResponse so the UI can
 * render removable chips. Absent on non-query requests. */
export const SearchInterpretationSchema = z.object({
  signals: z.array(InterpretedSignalSchema),
  /** residual/vibe terms feeding semantic + lexical matching ('summer', 'cottagecore') */
  vibe: z.array(z.string()),
  /** true when the semantic-embedding stage contributed to this response */
  semantic: z.boolean(),
  /** which parser produced the interpretation */
  parser: z.enum(['deterministic', 'llm', 'llm_cache']),
});
export type SearchInterpretation = z.infer<typeof SearchInterpretationSchema>;

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
  /**
   * Optional (additive): true when any listing color sits in the user's
   * saved palette — the backend computes it so the "in your palette" chip
   * needs no client-side color math.
   */
  paletteMatch: z.boolean().optional(),
});
export type RankedListing = z.infer<typeof RankedListingSchema>;

export const RankResponseSchema = z.object({
  items: z.array(RankedListingSchema),
  nextCursor: z.string().nullable(),
  totalMatched: z.number().int().nonnegative(),
  rerank: z.object({
    /**
     * 'pending' (additive, 2026-07-09): the page was served in deterministic
     * order and the LLM re-rank is warming the cache in the background —
     * clients MAY quietly refetch once after a few seconds to pick it up.
     */
    mode: z.enum(['llm', 'deterministic', 'cache', 'pending']),
    costUsd: z.number().nullable(),
  }),
  /**
   * Additive (2026-07-09): what the hybrid free-text interpreter extracted
   * from `filters.query` — present only on query searches, so the UI can show
   * removable interpretation chips. Explicit filter params never appear here.
   */
  interpreted: SearchInterpretationSchema.optional(),
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

// ── StyleSimilarity (promoted from packages/matching, 2026-07-06) ─────────
// The pluggable similarity backend behind §1's "StyleSimilarity interface".
// v1: sparse attribute-tag cosine (packages/matching attributeStyleSimilarity);
// upgrade path: FashionSigLIP embeddings + sqlite-vec behind the same seam.
// Additive promotion requested in decisions-ai-eng.md #6.

/** One swipe folded into the learned style vector. Verdict union mirrors
 * SwipeEvent.verdict (inlined here — profile.ts imports this file, so a
 * type-level import the other way would be a cycle). */
export interface SwipeSignal {
  verdict: 'like' | 'dislike' | 'save' | 'skip';
  /** The swiped listing's sparse attribute vector. */
  attributeVector: Record<string, number>;
}

/**
 * Model tag persisted with every dense embedding row (listing_embeddings.model)
 * — additive, 2026-07-07 (ml-eng). Single source of truth for TS; ml/embed.py
 * mirrors it as MODEL_TAG. Bump BOTH together when swapping the model, and old
 * vectors are simply re-embedded (rows are keyed (content_hash, model)).
 */
export const EMBEDDING_MODEL_TAG = 'marqo-fashionSigLIP';
/** FashionSigLIP output dimension (ViT-B-16-SigLIP tower). */
export const EMBEDDING_DIM = 768;

export interface StyleSimilarity {
  /** Implementation tag, persisted alongside vectors for future migrations. */
  readonly kind: string;
  /** Similarity of a user style vector vs a listing vector, mapped to 0..1. */
  score(
    userStyleTags: Record<string, number>,
    listingAttributeVector: Record<string, number>,
  ): number;
  /** Fold swipe like/dislike events into the user's profile style vector. */
  updateFromSwipes(
    current: Record<string, number>,
    events: SwipeSignal[],
  ): Record<string, number>;
}

/**
 * API surface contracts — docs/ARCHITECTURE.md §4.7
 * Route handlers live under apps/web/app/api (backend-eng); frontend-eng
 * consumes these shapes (or MSW mocks of them) from day 1. FROZEN.
 *
 * Every response is `{ ok: true, data } | { ok: false, error: { code, message } }`.
 */
import { z } from 'zod';
import { ListingSchema } from './listing';
import type { Listing } from './listing';
import { HemResultSchema } from './matching';
import { ColorSeasonSchema, SwipeEventSchema, UserProfileSchema } from './profile';

export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── PATCH /api/profile ────────────────────────────────────────────────────
/** Zod-pruned partial profile; `id` is cookie-derived and never patchable. */
export const ProfilePatchSchema = UserProfileSchema.omit({ id: true }).partial();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

// ── Bounded profile patch (additive, 2026-07-08, QA P1 #2) ───────────────
// Same wire shape as ProfilePatchSchema (which stays frozen), with sanity
// bounds on the numeric fields so PATCH /api/profile rejects junk
// (heightInches 0/999/−5, negative budgets, min>max) with the standard
// error envelope instead of silently storing it. The quiz UI ranges
// (height 4′0″–6′11″, sizes 0–18, budget $10–480) all sit inside these.

/** Sane adult human height, inches (4′0″–7′0″). */
export const HEIGHT_INCHES_MIN = 48;
export const HEIGHT_INCHES_MAX = 84;
/** Normalized US-numeric dress-size domain. */
export const SIZE_NORMALIZED_MIN = 0;
export const SIZE_NORMALIZED_MAX = 26;
/** Heel preference, inches (UI stepper caps at 4″; 8″ is the hard bound). */
export const HEEL_PREF_INCHES_MAX = 8;

export const BoundedBudgetSchema = z
  .object({
    minCents: z.number().int().nonnegative().nullable(),
    maxCents: z.number().int().nonnegative().nullable(),
  })
  .refine((b) => b.minCents == null || b.maxCents == null || b.minCents <= b.maxCents, {
    message: 'budget.minCents must be ≤ budget.maxCents',
  });

export const BoundedProfilePatchSchema = ProfilePatchSchema.extend({
  heightInches: z
    .number()
    .min(HEIGHT_INCHES_MIN, `height must be ≥ ${HEIGHT_INCHES_MIN} inches`)
    .max(HEIGHT_INCHES_MAX, `height must be ≤ ${HEIGHT_INCHES_MAX} inches`)
    .nullable()
    .optional(),
  heelPrefInches: z.number().min(0).max(HEEL_PREF_INCHES_MAX).optional(),
  sizesNormalized: z
    .array(z.number().min(SIZE_NORMALIZED_MIN).max(SIZE_NORMALIZED_MAX))
    .optional(),
  budget: BoundedBudgetSchema.optional(),
});
export type BoundedProfilePatch = z.infer<typeof BoundedProfilePatchSchema>;

// ── PUT /api/profile/brand-sizes ──────────────────────────────────────────
export const BrandSizesPutSchema = z.array(
  z.object({ brand: z.string(), sizeLabel: z.string() }),
);
export type BrandSizesPut = z.infer<typeof BrandSizesPutSchema>;

// ── POST /api/swipes ──────────────────────────────────────────────────────
export const SwipesPostSchema = z.array(SwipeEventSchema);
export type SwipesPost = z.infer<typeof SwipesPostSchema>;

export const SwipesPostResponseSchema = z.object({
  styleTags: z.record(z.string(), z.number()),
});
export type SwipesPostResponse = z.infer<typeof SwipesPostResponseSchema>;

// ── GET /api/listings/:id ─────────────────────────────────────────────────
export const ListingDetailResponseSchema = z.object({
  listing: ListingSchema,
  hem: HemResultSchema,
  similar: z.array(ListingSchema),
  /**
   * Optional (additive): server-composed "why it works for you" one-liner
   * (templated keyless, Haiku when live). Absent for guests / mock layers
   * that don't compute it.
   */
  whyItWorks: z.string().nullable().optional(),
});
export type ListingDetailResponse = {
  listing: Listing;
  hem: z.infer<typeof HemResultSchema>;
  similar: Listing[];
  whyItWorks?: string | null;
};

// ── POST /api/color-analysis/quiz ─────────────────────────────────────────
/**
 * Manual quiz fallback answers (doc §7.4: vein color, jewelry metal,
 * white-vs-cream, sun reaction, natural hair/eye combos). The doc references
 * `QuizAnswers` without defining it — minimal definition recorded in
 * docs/DECISIONS.md #5.
 */
export const QuizAnswersSchema = z.object({
  veinColor: z.enum(['blue_purple', 'green', 'mixed_unsure']),
  jewelryMetal: z.enum(['silver', 'gold', 'both']),
  whiteVsCream: z.enum(['white', 'cream', 'unsure']),
  sunReaction: z.enum(['burns_easily', 'burns_then_tans', 'tans_easily', 'rarely_burns']),
  naturalHair: z.enum([
    'black',
    'dark_brown',
    'medium_brown',
    'light_brown',
    'blonde',
    'strawberry_blonde',
    'red',
    'auburn',
    'gray_white',
  ]),
  eyeColor: z.enum(['dark_brown', 'brown', 'hazel', 'green', 'blue', 'gray']),
});
export type QuizAnswers = z.infer<typeof QuizAnswersSchema>;

export const ColorAnalysisQuizRequestSchema = z.object({ answers: QuizAnswersSchema });
export type ColorAnalysisQuizRequest = z.infer<typeof ColorAnalysisQuizRequestSchema>;

// ── PUT /api/color-analysis ───────────────────────────────────────────────
export const ColorAnalysisPutSchema = z.object({ season: ColorSeasonSchema });
export type ColorAnalysisPut = z.infer<typeof ColorAnalysisPutSchema>;

// ── GET /api/meta/filters ─────────────────────────────────────────────────
export const MetaFiltersResponseSchema = z.object({
  brands: z.array(z.string()),
  colorFamilies: z.array(z.string()),
  priceRange: z.tuple([z.number(), z.number()]),
});
export type MetaFiltersResponse = z.infer<typeof MetaFiltersResponseSchema>;

// ── POST /api/clickouts (spec G4 click/attribution log; additive 2026-07-08) ─
/**
 * Fired (sendBeacon / fire-and-forget fetch) when the user taps the outbound
 * "Shop on …" CTA. Guests are tolerated (user id nullable server-side); the
 * destination URL is stored only as a sha256 hash — no full-URL PII at rest.
 */
export const ClickoutPostSchema = z.object({ listingId: z.string().min(1) });
export type ClickoutPost = z.infer<typeof ClickoutPostSchema>;

export const ClickoutResponseSchema = z.object({ recorded: z.boolean() });
export type ClickoutResponse = z.infer<typeof ClickoutResponseSchema>;

// ── POST /api/admin/ingest ────────────────────────────────────────────────
export const AdminIngestRequestSchema = z.object({ sourceId: z.string().optional() });
export type AdminIngestRequest = z.infer<typeof AdminIngestRequestSchema>;

export const AdminIngestResponseSchema = z.object({ runId: z.number() });
export type AdminIngestResponse = z.infer<typeof AdminIngestResponseSchema>;

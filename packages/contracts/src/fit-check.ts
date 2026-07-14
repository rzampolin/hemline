/**
 * Paste-a-dress-link fit check — additive contracts (2026-07-13).
 *
 * POST /api/fit-check { url }: the user pastes ANY dress PDP URL; the server
 * fetches the page (SSRF-guarded), extracts the garment, computes the hem
 * verdict against HER profile, and returns similar in-catalog alternatives.
 * The pasted product is EPHEMERAL — never stored as a listing; only the
 * parsed page is cached by URL hash (~24h) so repeat pastes are free.
 */
import { z } from 'zod';
import { LengthBasisSchema, LengthClassSchema } from './listing';
import { HemResultSchema, RankedListingSchema } from './matching';

/** Hard cap on a pasted URL (share-sheet URLs can carry long tracking tails). */
export const FIT_CHECK_URL_MAX_LEN = 2048;

// ── POST /api/fit-check ────────────────────────────────────────────────────
export const FitCheckRequestSchema = z.object({
  url: z.string().min(1).max(FIT_CHECK_URL_MAX_LEN),
});
export type FitCheckRequest = z.infer<typeof FitCheckRequestSchema>;

/**
 * What happened to the pasted page:
 * - 'ok'             — a garment was read; product + fit fields are present.
 * - 'not_a_dress'    — the page parsed but the product isn't a dress.
 * - 'child_audience' — the product reads as a kids item (we say so gracefully).
 * - 'unreadable'     — bot-blocked / no structured data / fetch failed;
 *                      `keywords` offers a slug-derived catalog search instead.
 * - 'blocked_url'    — the URL itself was rejected (non-https, private host…).
 */
export const FitCheckOutcomeSchema = z.enum([
  'ok',
  'not_a_dress',
  'child_audience',
  'unreadable',
  'blocked_url',
]);
export type FitCheckOutcome = z.infer<typeof FitCheckOutcomeSchema>;

/** The external product as read from the pasted page (never stored as a listing). */
export const FitCheckProductSchema = z.object({
  url: z.string(),
  /** provenance host, e.g. "thereformation.com" — "we don't sell it, just read it" */
  domain: z.string(),
  title: z.string(),
  brand: z.string().nullable(),
  /** null when the page states no machine-readable price */
  priceCents: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  imageUrl: z.string().nullable(),
  sizeLabels: z.array(z.string()),
  /** size label → in stock (only when the page carried per-size signals) */
  availability: z.record(z.string(), z.boolean()),
  /** which parser tier read the page */
  via: z.enum(['shopify_js', 'jsonld', 'microdata', 'og']),
});
export type FitCheckProduct = z.infer<typeof FitCheckProductSchema>;

/** Her sizes vs the page's size labels (normalized-US comparison). */
export const FitCheckSizeMatchSchema = z.enum([
  'in_your_size', // at least one of her sizes is listed and in stock
  'listed_sold_out', // her size is listed but explicitly out of stock
  'not_listed', // sizes parsed, none of hers among them
  'unknown', // no size data on the page, or no sizes in her profile
]);
export type FitCheckSizeMatch = z.infer<typeof FitCheckSizeMatchSchema>;

export const FitCheckResponseSchema = z.object({
  outcome: FitCheckOutcomeSchema,
  product: FitCheckProductSchema.nullable(),
  /** hem verdict for HER (basis 'none' when she has no height yet) */
  hem: HemResultSchema.nullable(),
  lengthClass: LengthClassSchema.nullable(),
  lengthInches: z.number().nullable(),
  /** provenance of lengthInches — estimates must never render as "Measured" */
  lengthBasis: LengthBasisSchema.nullable(),
  /** stated model height parsed from the page copy, when present (inches) */
  modelHeightInches: z.number().nullable(),
  sizeMatch: FitCheckSizeMatchSchema,
  /** honest extractor mode: deterministic rule engine when keyless */
  extractionMode: z.enum(['live', 'mock']),
  /** which similarity backend ranked `similar` ('none' when empty) */
  matchBasis: z.enum(['embedding', 'attributes', 'none']),
  /** in-catalog alternatives in her size/budget (≤8) */
  similar: z.array(RankedListingSchema),
  /** true when the pasted URL matches a listing already in the catalog */
  inCatalog: z.boolean(),
  /** slug-derived search terms offered when the page is unreadable */
  keywords: z.array(z.string()),
  /** page parse served from the ~24h URL-hash cache (repeat paste) */
  cached: z.boolean(),
});
export type FitCheckResponse = z.infer<typeof FitCheckResponseSchema>;

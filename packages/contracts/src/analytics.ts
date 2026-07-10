/**
 * First-party product analytics contracts (additive, 2026-07-09).
 *
 * Design constraints (docs/decisions-analytics.md):
 * - CLOSED whitelist: every event type + its props are enumerated here with a
 *   strict per-type schema. Unknown types and unknown/extra props are rejected
 *   at the API boundary — there is no open-ended `track(anything)` channel.
 * - No PII in props. The single deliberate exception is the raw search query
 *   (`search_submitted.query`) — zero-result queries are the catalog-gap
 *   signal this system exists to surface.
 * - Batched + sendBeacon-compatible: the client queues events and flushes an
 *   AnalyticsBatch as a plain-text JSON body (like clickouts). Batch size is
 *   capped so inserts stay cheap.
 */
import { z } from 'zod';

/** Max events accepted per POST /api/events batch. */
export const ANALYTICS_MAX_BATCH = 25;
/** Max stored length of a search query (chars); longer queries are rejected. */
export const ANALYTICS_QUERY_MAX_LEN = 120;
/** Max raw request-body size for POST /api/events (bytes, pre-parse guard). */
export const ANALYTICS_MAX_BODY_BYTES = 32 * 1024;

/** Client-minted per-browsing-session anon id (uuid or similar opaque token). */
export const AnonIdSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'anonId must be url-safe');

const verdict = z.enum(['like', 'dislike', 'save']);
const swipeContext = z.enum(['calibration', 'feed', 'search']);
const colorMethod = z.enum(['selfie', 'quiz']);

/** Filter facets a user can touch in the feed filter sheet. */
export const FilterKindSchema = z.enum([
  'size',
  'price',
  'length',
  'color',
  'brand',
  'source',
  'condition',
]);
export type FilterKind = z.infer<typeof FilterKindSchema>;

/**
 * The event whitelist — one strict schema per type. `props` is small,
 * enum/number-shaped, and never free text (except the search query).
 */
export const AnalyticsEventSchema = z.discriminatedUnion('type', [
  // ── onboarding funnel (spec §5: quiz completion rate, per-screen drop-off)
  z.object({ type: z.literal('quiz_started'), props: z.object({}).strict() }).strict(),
  z
    .object({
      type: z.literal('quiz_step_completed'),
      props: z.object({ step: z.number().int().min(1).max(20) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('quiz_completed'),
      // durationMs capped at 2h — beyond that it's a stale tab, not a signal
      props: z.object({ durationMs: z.number().int().min(0).max(7_200_000) }).strict(),
    })
    .strict(),

  // ── swipe calibration (spec §5: ≥10 swipes median)
  z
    .object({
      type: z.literal('deck_swipe'),
      props: z
        .object({
          verdict,
          index: z.number().int().min(0).max(99),
          /** additive (2026-07-10, adaptive deck): 0-based extension batch */
          batch: z.number().int().min(0).max(9).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('deck_completed'),
      // all props additive (2026-07-10, adaptive deck) — old empty payloads stay valid
      props: z
        .object({
          likes: z.number().int().min(0).max(99).optional(),
          cardsSeen: z.number().int().min(0).max(99).optional(),
          reason: z.enum(['target', 'cap', 'skip', 'exhausted']).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      /**
       * A deck card image failed to load (network error or ~5s stall) and the
       * client fell back to the listing's next image / a spare card. `position`
       * is the image's index within the listing's gallery — position-0 failures
       * mean the primary CDN entry is dead, higher positions mean the fallback
       * chain is being exercised. Additive, 2026-07-10.
       */
      type: z.literal('deck_image_error'),
      props: z.object({ position: z.number().int().min(0).max(19) }).strict(),
    })
    .strict(),

  // ── feed / search / filters
  z
    .object({
      type: z.literal('feed_viewed'),
      props: z.object({ page: z.number().int().min(0).max(999) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('search_submitted'),
      props: z
        .object({
          /** the one deliberate free-text prop (catalog-gap goldmine) */
          query: z.string().min(1).max(ANALYTICS_QUERY_MAX_LEN),
          /** true when the hybrid parser produced an interpretation */
          interpreted: z.boolean(),
          /** totalMatched for the query → zero-result flag in aggregates */
          resultCount: z.number().int().min(0),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('filter_applied'),
      props: z.object({ kind: FilterKindSchema }).strict(),
    })
    .strict(),

  // ── listings & rack
  z
    .object({
      type: z.literal('listing_viewed'),
      /** source = catalog source id of the listing (resale vs brand mix) */
      props: z.object({ source: z.string().min(1).max(64) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('listing_saved'),
      props: z.object({ context: swipeContext }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('listing_unsaved'), props: z.object({}).strict() }).strict(),

  // ── color analysis (spec §5: opt-in rate)
  z
    .object({
      type: z.literal('color_analysis_started'),
      props: z.object({ method: colorMethod }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('color_analysis_completed'),
      props: z.object({ method: colorMethod }).strict(),
    })
    .strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export type AnalyticsEventType = AnalyticsEvent['type'];

/** All whitelisted event type names (admin display, tests). */
export const ANALYTICS_EVENT_TYPES = AnalyticsEventSchema.options.map(
  (o) => o.shape.type.value,
) as AnalyticsEventType[];

// ── POST /api/events ──────────────────────────────────────────────────────
export const AnalyticsBatchSchema = z
  .object({
    anonId: AnonIdSchema,
    events: z.array(AnalyticsEventSchema).min(1).max(ANALYTICS_MAX_BATCH),
  })
  .strict();
export type AnalyticsBatch = z.infer<typeof AnalyticsBatchSchema>;

// ── GET /api/admin/analytics ──────────────────────────────────────────────
export interface AnalyticsFunnel {
  /** distinct actors (user_id ?? anon_id) who fired quiz_started */
  quizStarted: number;
  quizCompleted: number;
  /** completed / started; null when nobody started */
  quizCompletionRate: number | null;
  medianQuizDurationMs: number | null;
  /** distinct actors per quiz step (drop-off curve) */
  quizStepActors: Record<string, number>;
  deckCompleted: number;
  feedViewers: number;
}

export interface AnalyticsSearchRow {
  query: string;
  count: number;
  /** submissions of this query that matched nothing */
  zeroResultCount: number;
  /** true when the query NEVER returned results in the window (catalog gap) */
  alwaysZeroResults: boolean;
  lastResultCount: number;
}

export interface AnalyticsSwipeStats {
  total: number;
  byVerdict: Record<string, number>;
  /** like / total (saves count as likes for taste purposes); null when no swipes */
  likeRate: number | null;
}

export interface AnalyticsWindowSummary {
  /** raw event counts by type */
  eventCounts: Record<string, number>;
  funnel: AnalyticsFunnel;
  topSearches: AnalyticsSearchRow[];
  filterUsage: Record<string, number>;
  swipes: AnalyticsSwipeStats;
}

export interface AdminAnalyticsResponse {
  generatedAt: number;
  windows: {
    '24h': AnalyticsWindowSummary;
    '7d': AnalyticsWindowSummary;
  };
}

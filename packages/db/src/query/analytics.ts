/**
 * First-party product analytics repository (additive, 2026-07-09).
 *
 * Writes: `insertAnalyticsEvents` — one multi-row INSERT per accepted batch
 * (cheap; the API caps batch size). Props are already whitelist-validated at
 * the boundary; this layer just serializes them.
 *
 * Reads: `analyticsWindowSummary` — plain SQL aggregates over a time window
 * for GET /api/admin/analytics: onboarding funnel (distinct-actor dedup via
 * COALESCE(user_id, anon_id)), median quiz duration, top search queries with
 * zero-result flags, filter-usage histogram, swipe like-rate.
 */
import { and, gte, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { analyticsEvents } from '../schema';

export interface AnalyticsEventInsert {
  userId: string | null;
  anonId: string;
  eventType: string;
  props: Record<string, unknown>;
}

/** Insert a validated batch. Server-assigned timestamps. Returns row count. */
export function insertAnalyticsEvents(
  db: Db,
  events: AnalyticsEventInsert[],
  now = Date.now(),
): number {
  if (events.length === 0) return 0;
  db.insert(analyticsEvents)
    .values(
      events.map((e) => ({
        userId: e.userId,
        anonId: e.anonId,
        eventType: e.eventType,
        propsJson: JSON.stringify(e.props),
        createdAt: now,
      })),
    )
    .run();
  return events.length;
}

/* ── aggregates ─────────────────────────────────────────────────────────── */

export interface FunnelSummary {
  quizStarted: number;
  quizCompleted: number;
  quizCompletionRate: number | null;
  medianQuizDurationMs: number | null;
  quizStepActors: Record<string, number>;
  deckCompleted: number;
  feedViewers: number;
}

export interface SearchSummaryRow {
  query: string;
  count: number;
  zeroResultCount: number;
  alwaysZeroResults: boolean;
  lastResultCount: number;
}

export interface SwipeSummary {
  total: number;
  byVerdict: Record<string, number>;
  likeRate: number | null;
}

export interface WindowSummary {
  eventCounts: Record<string, number>;
  funnel: FunnelSummary;
  topSearches: SearchSummaryRow[];
  filterUsage: Record<string, number>;
  swipes: SwipeSummary;
}

/** COUNT(DISTINCT actor) for one event type in the window. */
function distinctActors(db: Db, eventType: string, since: number): number {
  return (
    db
      .select({ n: sql<number>`count(distinct coalesce(user_id, anon_id))` })
      .from(analyticsEvents)
      .where(and(sql`event_type = ${eventType}`, gte(analyticsEvents.createdAt, since)))
      .get()?.n ?? 0
  );
}

/** Aggregate everything the admin dashboard needs for one time window. */
export function analyticsWindowSummary(db: Db, since: number): WindowSummary {
  // raw event counts by type
  const countRows = db
    .select({ eventType: analyticsEvents.eventType, n: sql<number>`count(*)` })
    .from(analyticsEvents)
    .where(gte(analyticsEvents.createdAt, since))
    .groupBy(analyticsEvents.eventType)
    .all();
  const eventCounts = Object.fromEntries(countRows.map((r) => [r.eventType, r.n]));

  // funnel: distinct-actor counts (a user retrying the quiz counts once)
  const quizStarted = distinctActors(db, 'quiz_started', since);
  const quizCompleted = distinctActors(db, 'quiz_completed', since);

  const stepRows = db
    .select({
      step: sql<number>`cast(json_extract(props_json, '$.step') as integer)`,
      n: sql<number>`count(distinct coalesce(user_id, anon_id))`,
    })
    .from(analyticsEvents)
    .where(and(sql`event_type = 'quiz_step_completed'`, gte(analyticsEvents.createdAt, since)))
    .groupBy(sql`json_extract(props_json, '$.step')`)
    .all();
  const quizStepActors = Object.fromEntries(stepRows.map((r) => [String(r.step), r.n]));

  // median quiz duration — pull the ordered list (bounded by window volume)
  const durations = db
    .select({ d: sql<number>`cast(json_extract(props_json, '$.durationMs') as integer)` })
    .from(analyticsEvents)
    .where(and(sql`event_type = 'quiz_completed'`, gte(analyticsEvents.createdAt, since)))
    .orderBy(sql`cast(json_extract(props_json, '$.durationMs') as integer)`)
    .all()
    .map((r) => r.d)
    .filter((d) => Number.isFinite(d));
  let medianQuizDurationMs: number | null = null;
  if (durations.length > 0) {
    const mid = Math.floor(durations.length / 2);
    medianQuizDurationMs =
      durations.length % 2 === 1 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
  }

  const funnel: FunnelSummary = {
    quizStarted,
    quizCompleted,
    quizCompletionRate: quizStarted > 0 ? quizCompleted / quizStarted : null,
    medianQuizDurationMs,
    quizStepActors,
    deckCompleted: distinctActors(db, 'deck_completed', since),
    feedViewers: distinctActors(db, 'feed_viewed', since),
  };

  // top searches (normalized to lower/trimmed) + zero-result flags
  const searchRows = db
    .select({
      query: sql<string>`lower(trim(json_extract(props_json, '$.query')))`,
      count: sql<number>`count(*)`,
      zeroResultCount: sql<number>`sum(case when json_extract(props_json, '$.resultCount') = 0 then 1 else 0 end)`,
      maxResults: sql<number>`max(cast(json_extract(props_json, '$.resultCount') as integer))`,
      lastResultCount: sql<number>`cast((select json_extract(e2.props_json, '$.resultCount') from analytics_events e2
        where e2.event_type = 'search_submitted' and e2.created_at >= ${since}
          and lower(trim(json_extract(e2.props_json, '$.query'))) = lower(trim(json_extract(analytics_events.props_json, '$.query')))
        order by e2.created_at desc, e2.id desc limit 1) as integer)`,
    })
    .from(analyticsEvents)
    .where(and(sql`event_type = 'search_submitted'`, gte(analyticsEvents.createdAt, since)))
    .groupBy(sql`lower(trim(json_extract(props_json, '$.query')))`)
    .orderBy(sql`count(*) desc`)
    .limit(20)
    .all();
  const topSearches: SearchSummaryRow[] = searchRows
    .filter((r) => r.query != null && r.query !== '')
    .map((r) => ({
      query: r.query,
      count: r.count,
      zeroResultCount: r.zeroResultCount ?? 0,
      alwaysZeroResults: (r.maxResults ?? 0) === 0,
      lastResultCount: r.lastResultCount ?? 0,
    }));

  // filter-usage histogram
  const filterRows = db
    .select({
      kind: sql<string>`json_extract(props_json, '$.kind')`,
      n: sql<number>`count(*)`,
    })
    .from(analyticsEvents)
    .where(and(sql`event_type = 'filter_applied'`, gte(analyticsEvents.createdAt, since)))
    .groupBy(sql`json_extract(props_json, '$.kind')`)
    .all();
  const filterUsage = Object.fromEntries(
    filterRows.filter((r) => r.kind != null).map((r) => [r.kind, r.n]),
  );

  // swipe like-rate (saves count as likes — both are positive taste signals)
  const verdictRows = db
    .select({
      verdict: sql<string>`json_extract(props_json, '$.verdict')`,
      n: sql<number>`count(*)`,
    })
    .from(analyticsEvents)
    .where(and(sql`event_type = 'deck_swipe'`, gte(analyticsEvents.createdAt, since)))
    .groupBy(sql`json_extract(props_json, '$.verdict')`)
    .all();
  const byVerdict = Object.fromEntries(
    verdictRows.filter((r) => r.verdict != null).map((r) => [r.verdict, r.n]),
  );
  const total = Object.values(byVerdict).reduce((a, b) => a + b, 0);
  const positive = (byVerdict['like'] ?? 0) + (byVerdict['save'] ?? 0);
  const swipes: SwipeSummary = {
    total,
    byVerdict,
    likeRate: total > 0 ? positive / total : null,
  };

  return { eventCounts, funnel, topSearches, filterUsage, swipes };
}

/**
 * POST /api/rank — RankRequest → RankResponse. Feed + search both use this
 * (§4.7). userId comes from the cookie; the body's userId is ignored when a
 * session exists (contract keeps the field, so it stays accepted).
 *
 * Pipeline (§6) via the real MatchingService (packages/matching) with the
 * real re-ranker (packages/ai — LLM when keyed, deterministic keyless):
 * profile hard filters (silent defaults: her sizes + budget, spec B1) ∩
 * request filters → SQL candidates capped 500 newest-first → per-user hem +
 * score₀ → optional re-rank → page.
 */
import { RankRequestSchema } from '@hemline/contracts';
import { getUserProfile } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { expandSourceFilter, rankForUser } from '../lib/matching';
import { resolveUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const db = getDb();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = RankRequestSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const request = parsed.data;

    const userId = resolveUserId(req) ?? request.userId;
    const profile = getUserProfile(db, userId);
    if (!profile) return fail('no_session', 'Unknown user — call GET /api/session first', 401);

    const f = request.filters;
    // profile hard filters applied silently unless the request overrides (spec B1)
    const sizes =
      f.sizesNormalized ?? (profile.sizesNormalized.length > 0 ? profile.sizesNormalized : undefined);
    const priceMin = f.priceMinCents ?? profile.budget.minCents ?? undefined;
    const priceMax = f.priceMaxCents ?? profile.budget.maxCents ?? undefined;

    const response = await rankForUser(
      db,
      profile,
      {
        sizesNormalized: sizes,
        priceMinCents: priceMin,
        priceMaxCents: priceMax,
        conditions: f.conditions,
        brands: f.brands,
        colorFamilies: f.colorFamilies,
        sourceIds: expandSourceFilter(db, f.sources),
        query: f.query,
      },
      { lengthOnBody: f.lengthOnBody },
      {
        limit: Math.min(request.limit, 100),
        cursor: request.cursor,
        personalize: request.personalize,
      },
    );
    return ok(response);
  } catch (err) {
    return serverError('rank', err);
  }
}

/**
 * GET /api/admin/analytics — product analytics aggregates (additive,
 * 2026-07-09). Basic-auth like every /api/admin/* route.
 *
 * Returns both 24h and 7d windows in one payload (AdminAnalyticsResponse):
 * onboarding funnel (distinct-actor quiz started→completed rate, per-step
 * drop-off, median quiz duration), top 20 search queries with result counts
 * and zero-result flags (catalog-gap signal), filter-usage histogram, and
 * swipe like-rate. Plain SQL aggregates — no chart lib, the /admin UI
 * consumes this defensively.
 */
import type { AdminAnalyticsResponse } from '@hemline/contracts';
import { analyticsWindowSummary } from '@hemline/db';
import { checkAdminAuth } from '../../lib/admin-auth';
import { getDb } from '../../lib/db';
import { fail, ok, serverError } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 3_600_000;

export async function GET(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const db = getDb();
    const now = Date.now();
    const payload: AdminAnalyticsResponse = {
      generatedAt: now,
      windows: {
        '24h': analyticsWindowSummary(db, now - DAY_MS),
        '7d': analyticsWindowSummary(db, now - 7 * DAY_MS),
      },
    };
    return ok(payload);
  } catch (err) {
    return serverError('admin/analytics', err);
  }
}

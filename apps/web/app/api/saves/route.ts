/**
 * Saves / "My Rack" (spec F1). Additive routes (not in the frozen §4.7 table;
 * card shapes reuse the frozen RankedListing).
 *
 * GET  /api/saves → { items: RankedListing[], staleIds: string[] }
 *   — saved cards with per-user hem + freshness; staleIds = "possibly sold"
 *     (last_seen_at older than its source freshness window).
 * POST /api/saves { listingId, context? } → { saved: true }
 * (unsave: DELETE /api/saves/:listingId)
 */
import { z } from 'zod';
import type { RankedListing } from '@hemline/contracts';
import {
  DEFAULT_FRESHNESS_HOURS,
  FRESHNESS_HOURS_BY_KIND,
  getListingsByIds,
  getUserProfile,
  saveListing,
  savedListingIds,
} from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { toRankedListings } from '../lib/matching';
import { requireUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SavePostSchema = z.object({
  listingId: z.string().min(1),
  context: z.enum(['calibration', 'feed', 'search']).default('feed'),
});

export async function GET(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    const profile = getUserProfile(db, userId);
    if (!profile) return fail('not_found', 'profile not found', 404);

    const ids = savedListingIds(db, userId);
    const candidates = getListingsByIds(db, ids);
    const items: RankedListing[] = toRankedListings(profile, candidates);

    const now = Date.now();
    const staleIds = candidates
      .filter((c) => {
        // soft-removed = verified sold/gone (or crawl-pruned) — last_seen_at
        // may still be FRESH when the verification worker caught it between
        // crawls, so removal must flag independently of staleness.
        if (c.removedAt != null) return true;
        const windowH = FRESHNESS_HOURS_BY_KIND[c.sourceKind] ?? DEFAULT_FRESHNESS_HOURS;
        return now - c.listing.lastSeenAt > windowH * 3_600_000;
      })
      .map((c) => c.listing.id);

    return ok({ items, staleIds });
  } catch (err) {
    return serverError('saves', err);
  }
}

export async function POST(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = SavePostSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const saved = saveListing(db, userId, parsed.data.listingId, parsed.data.context);
    if (!saved) return fail('not_found', `listing ${parsed.data.listingId} not found`, 404);
    return ok({ saved: true });
  } catch (err) {
    return serverError('saves', err);
  }
}

/**
 * GET /api/listings/:id → { listing, hem, similar, whyItWorks? }
 * (ListingDetailResponse; whyItWorks is the additive contract field — the
 * server composes the one-liner so the client stops recomputing it).
 * Full hydration: images, extraction attributes, per-user hem result,
 * freshness (lastSeenAt) and affiliate/source URLs ride on the Listing shape.
 * `similar`: top attribute-vector cosine matches among fresh listings,
 * falling back to same silhouette/length class ordered by recency.
 */
import type { ListingDetailResponse } from '@hemline/contracts';
import { getListingById, getUserProfile, queryCandidates } from '@hemline/db';
import { cosineSimilarity } from '@hemline/matching';
import { getDb } from '../../lib/db';
import { fail, ok, serverError } from '../../lib/envelope';
import { hemForUser, templatedWhy } from '../../lib/matching';
import { resolveUserId } from '../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIMILAR_COUNT = 12;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const db = getDb();
    const { id } = await ctx.params;
    const decodedId = decodeURIComponent(id);
    const found = getListingById(db, decodedId);
    if (!found) return fail('not_found', `listing ${decodedId} not found`, 404);

    const userId = resolveUserId(req);
    const profile = userId ? getUserProfile(db, userId) : null;
    const hem = hemForUser(
      found.listing,
      profile?.heightInches ?? null,
      profile?.heelPrefInches ?? 0,
    );

    // similar: cosine over the REAL sparse attribute vectors, newest 500 pool
    const pool = queryCandidates(db, { excludeListingIds: [decodedId] });
    const withScores = pool
      .map((cand) => ({ cand, sim: cosineSimilarity(found.attributeVector, cand.attributeVector) }))
      .sort((a, b) => b.sim - a.sim || b.cand.listing.lastSeenAt - a.cand.listing.lastSeenAt);
    let similar = withScores
      .filter((s) => s.sim > 0)
      .slice(0, SIMILAR_COUNT)
      .map((s) => s.cand.listing);
    if (similar.length === 0) {
      // fallback: attribute filters — same silhouette or length class, newest first
      similar = pool
        .filter(
          (cand) =>
            (found.listing.silhouette != null && cand.listing.silhouette === found.listing.silhouette) ||
            (found.listing.lengthClass != null && cand.listing.lengthClass === found.listing.lengthClass),
        )
        .slice(0, SIMILAR_COUNT)
        .map((cand) => cand.listing);
    }

    const whyItWorks = profile
      ? templatedWhy(profile, {
          listing: found.listing,
          hem,
          score: 0,
          whyItWorks: null,
          freshnessDecay: 1,
        })
      : null;

    const data: ListingDetailResponse = { listing: found.listing, hem, similar, whyItWorks };
    return ok(data);
  } catch (err) {
    return serverError('listings/:id', err);
  }
}

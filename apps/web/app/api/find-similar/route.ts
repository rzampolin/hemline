/**
 * POST /api/find-similar — "Find dresses like this" (spec B4).
 * Body: multipart (`photo` file) | JSON { imageBase64?, imageUrl?, hint? }.
 *
 * Two-tier pipeline (2026-07-07 ml-eng):
 *  1. VISUAL (when `npm run ml:setup` + `npm run embed` have run): the probe
 *     (photo bytes / image url / free text — SigLIP is a dual encoder) is
 *     embedded by the Marqo-FashionSigLIP sidecar and ranked by cosine against
 *     the stored catalog vectors. `matchBasis: 'embedding'`.
 *  2. FALLBACK (no ml setup, no vectors, or sidecar failure): the original
 *     path, unchanged — attribute extraction via @hemline/ai (Haiku live,
 *     deterministic rule engine keyless, §7.5) → sparse-vector cosine →
 *     "nearest" fallback. `matchBasis: 'attributes'`.
 *
 * Uploaded bytes are analyzed in memory and discarded — never persisted
 * (the embedding sidecar receives them over stdin, also never persisted).
 * `extractionMode` reports the extractor's honest mode: 'live' | 'mock' —
 * or 'skipped' when the visual path answered without any extraction.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RankedListing } from '@hemline/contracts';
import { createExtractionService } from '@hemline/ai';
import {
  getListingsByIds,
  getUserProfile,
  queryCandidates,
  type CandidateListing,
} from '@hemline/db';
import { cosineSimilarity } from '@hemline/matching';
import type { EmbedRequest } from '@hemline/matching/embedder';
import { getDb } from '../lib/db';
import { findSimilarByEmbedding } from '../lib/embeddings';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { getAiClient, hemForUser, paletteMatches } from '../lib/matching';
import { checkRateLimit } from '../lib/rate-limit';
import { requireUserId } from '../lib/session';

/** Reject absurd uploads before base64-ing them for the sidecar. */
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JsonBodySchema = z
  .object({
    imageBase64: z.string().optional(),
    imageUrl: z.string().url().optional(),
    /** optional free-text description of the dress in the photo */
    hint: z.string().max(500).optional(),
    limit: z.number().int().positive().max(60).default(24),
  })
  .refine((v) => v.imageBase64 || v.imageUrl || v.hint, {
    message: 'provide imageBase64, imageUrl, or hint',
  });

/**
 * Extract an attribute vector from the probe text/image. The ad-hoc content
 * hash never matches a listings row, so the Drizzle cache store would skip
 * persisting it — an in-memory default cache (inside the service) is fine.
 */
async function extractProbeVector(
  text: string,
  imageUrl: string | null,
): Promise<{ vector: Record<string, number>; mode: 'live' | 'mock' }> {
  const service = createExtractionService({ client: getAiClient() });
  const contentHash = createHash('sha256')
    .update(`find-similar|${text}|${imageUrl ?? ''}`)
    .digest('hex');
  const result = await service.extractBatch([
    {
      contentHash,
      title: text || 'user-uploaded dress photo',
      description: null,
      brand: null,
      primaryImageUrl: imageUrl,
      attributeHints: null,
      sizeLabels: [],
    },
  ]);
  return { vector: result.get(contentHash)?.attributeVector ?? {}, mode: service.mode };
}

export async function POST(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);
    // AI-spending endpoint (Haiku extraction fallback) — prod rate limit, 10/min/user
    if (!checkRateLimit('find-similar', userId, 10))
      return fail('rate_limited', 'Too many similarity searches — try again in a minute', 429);

    let imageUrl: string | null = null;
    let imageBase64: string | null = null;
    let text = '';
    let limit = 24;
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('photo');
      if (!(file instanceof Blob)) return fail('invalid_request', 'multipart field `photo` (file) is required', 400);
      // bytes read in-memory and discarded (embedding probe only); keyless
      // extraction keys off the filename/hint text (live mode would need a
      // fetchable URL for vision)
      const bytes = await file.arrayBuffer();
      if (bytes.byteLength > MAX_PHOTO_BYTES) {
        return fail('invalid_request', 'photo too large (max 8 MB)', 400);
      }
      if (bytes.byteLength > 0) imageBase64 = Buffer.from(bytes).toString('base64');
      text = [form.get('hint'), file instanceof File ? file.name : '']
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
    } else {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return fail('invalid_request', 'body must be JSON or multipart/form-data', 400);
      }
      const parsed = JsonBodySchema.safeParse(raw);
      if (!parsed.success) return zodFail(parsed.error);
      imageUrl = parsed.data.imageUrl ?? null;
      imageBase64 = parsed.data.imageBase64 ?? null;
      text = [parsed.data.hint, parsed.data.imageUrl].filter(Boolean).join(' ');
      limit = parsed.data.limit;
    }

    const profile = getUserProfile(db, userId);

    // ── tier 1: real visual similarity (FashionSigLIP), when available ────
    const probe: EmbedRequest | null = imageBase64
      ? { imageBase64 }
      : imageUrl
        ? { imageUrl }
        : text.trim()
          ? { op: 'text', text: text.trim() }
          : null;
    if (probe) {
      const matches = await findSimilarByEmbedding(db, probe, limit);
      if (matches && matches.length > 0) {
        const byId = new Map(matches.map((m) => [m.listingId, m.score]));
        const items: RankedListing[] = getListingsByIds(db, matches.map((m) => m.listingId)).map(
          (c) => ({
            listing: c.listing,
            hem: hemForUser(c.listing, profile?.heightInches ?? null, profile?.heelPrefInches ?? 0),
            score: Math.max(0, Math.min(1, byId.get(c.listing.id) ?? 0)),
            whyItWorks: null,
            freshnessDecay: 1,
            paletteMatch: profile ? paletteMatches(profile, c.listing) : undefined,
          }),
        );
        return ok({
          attributes: {},
          extractionMode: 'skipped', // visual path — no attribute extraction ran
          matchBasis: 'embedding',
          fallback: 'none',
          items,
          totalMatched: items.length,
        });
      }
    }

    // ── tier 2: attribute-vector path (unchanged; works with zero ml setup) ─
    const { vector, mode } = await extractProbeVector(text, imageUrl);
    const pool = queryCandidates(db, {});

    let matched = pool
      .map((c: CandidateListing) => ({ c, sim: cosineSimilarity(vector, c.attributeVector) }))
      .filter((s) => s.sim > 0)
      .sort((a, b) => b.sim - a.sim || b.c.listing.lastSeenAt - a.c.listing.lastSeenAt);

    let fallback: 'none' | 'nearest' = 'none';
    if (matched.length === 0) {
      // graceful "no close matches — here's the nearest": newest well-extracted items
      fallback = 'nearest';
      matched = pool
        .filter((c) => c.listing.extractionConfidence >= 0.5)
        .slice(0, limit)
        .map((c) => ({ c, sim: 0 }));
    }

    const items: RankedListing[] = matched.slice(0, limit).map(({ c, sim }) => ({
      listing: c.listing,
      hem: hemForUser(c.listing, profile?.heightInches ?? null, profile?.heelPrefInches ?? 0),
      score: Math.max(0, Math.min(1, sim)),
      whyItWorks: null,
      freshnessDecay: 1,
      paletteMatch: profile ? paletteMatches(profile, c.listing) : undefined,
    }));

    return ok({
      attributes: vector,
      extractionMode: mode, // 'live' | 'mock' — the ai package's honest mode
      matchBasis: 'attributes',
      fallback,
      items,
      totalMatched: matched.length,
    });
  } catch (err) {
    return serverError('find-similar', err);
  }
}

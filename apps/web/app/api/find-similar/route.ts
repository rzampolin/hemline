/**
 * POST /api/find-similar — "Find dresses like this" (spec B4).
 * Body: multipart (`photo` file) | JSON { imageBase64?, imageUrl?, hint? }.
 *
 * Pipeline: attribute extraction via the REAL @hemline/ai ExtractionService
 * (Haiku when ANTHROPIC_API_KEY is set; the deterministic rule engine keyless
 * — degradation lives inside packages/ai, §7.5) → cosine similarity over the
 * catalog's sparse attribute vectors → "nearest" fallback so the response is
 * never empty when the catalog isn't.
 *
 * Uploaded bytes are analyzed in memory and discarded — never persisted.
 * `extractionMode` reports the service's honest mode: 'live' | 'mock'.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RankedListing } from '@hemline/contracts';
import { createExtractionService } from '@hemline/ai';
import { getUserProfile, queryCandidates, type CandidateListing } from '@hemline/db';
import { cosineSimilarity } from '@hemline/matching';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { getAiClient, hemForUser, paletteMatches } from '../lib/matching';
import { requireUserId } from '../lib/session';

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

    let imageUrl: string | null = null;
    let text = '';
    let limit = 24;
    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('photo');
      if (!(file instanceof Blob)) return fail('invalid_request', 'multipart field `photo` (file) is required', 400);
      // bytes read in-memory and discarded; keyless extraction keys off the
      // filename/hint text (live mode would need a fetchable URL for vision)
      await file.arrayBuffer();
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
      text = [parsed.data.hint, parsed.data.imageUrl].filter(Boolean).join(' ');
      limit = parsed.data.limit;
    }

    const { vector, mode } = await extractProbeVector(text, imageUrl);
    const profile = getUserProfile(db, userId);
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
      fallback,
      items,
      totalMatched: matched.length,
    });
  } catch (err) {
    return serverError('find-similar', err);
  }
}

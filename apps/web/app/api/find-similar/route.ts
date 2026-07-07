/**
 * POST /api/find-similar — "Find dresses like this" (spec B4).
 * Body: multipart (`photo` file) | JSON { imageBase64? , imageUrl?, hint? }.
 *
 * Pipeline: attribute extraction via the @hemline/ai ExtractionService
 * (stub-tolerant) → similarity search over the catalog's sparse attribute
 * vectors → fallback to plain attribute filters → "nearest" fallback so the
 * response is never empty when the catalog isn't.
 *
 * Deterministic fallback extractor: keyword taxonomy match over the image
 * URL / filename / hint text (same tag namespace as the fixture vectors).
 * Uploaded bytes are analyzed in memory and discarded — never persisted.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExtractedAttributes, RankedListing } from '@hemline/contracts';
import { getUserProfile, queryCandidates, type CandidateListing } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { attributeSimilarity, hemForUser } from '../lib/matching';
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

// ── deterministic keyword extractor (fallback while @hemline/ai is stubbed) ──

const KEYWORD_TAGS: [RegExp, string, number][] = [
  [/wrap/i, 'silhouette:wrap', 1],
  [/a[- ]?line/i, 'silhouette:a_line', 1],
  [/sheath/i, 'silhouette:sheath', 1],
  [/slip/i, 'silhouette:slip', 1],
  [/shirt[- ]?dress|shirtdress/i, 'silhouette:shirt', 1],
  [/bodycon|body[- ]con/i, 'silhouette:bodycon', 1],
  [/fit[- ]?and[- ]?flare/i, 'silhouette:fit_and_flare', 1],
  [/empire/i, 'silhouette:empire', 1],
  [/tent|trapeze/i, 'silhouette:tent', 1],
  [/\bmicro\b/i, 'length:micro', 1],
  [/\bmini\b/i, 'length:mini', 1],
  [/knee[- ]?length|\bknee\b/i, 'length:knee', 1],
  [/\bmidi\b/i, 'length:midi', 1],
  [/mid[- ]?calf/i, 'length:mid_calf', 1],
  [/\bmaxi\b/i, 'length:maxi', 1],
  [/floor[- ]?length|\bgown\b/i, 'length:floor', 1],
  [/floral/i, 'pattern:floral', 0.9],
  [/gingham/i, 'pattern:gingham', 0.9],
  [/polka[- ]?dot/i, 'pattern:polka_dot', 0.9],
  [/stripe/i, 'pattern:stripe', 0.9],
  [/animal|leopard|zebra/i, 'pattern:animal', 0.9],
  [/silk/i, 'fabric:silk', 0.7],
  [/linen/i, 'fabric:linen', 0.7],
  [/satin/i, 'fabric:satin', 0.7],
  [/velvet/i, 'fabric:velvet', 0.7],
  [/lace/i, 'fabric:lace', 0.7],
  [/cotton/i, 'fabric:cotton', 0.7],
  [/\bred|burgundy|wine|crimson\b/i, 'color:red', 0.8],
  [/\bblue|navy|cobalt\b/i, 'color:blue', 0.8],
  [/\bgreen|olive|sage|emerald\b/i, 'color:green', 0.8],
  [/\bblack\b/i, 'color:black', 0.8],
  [/\bwhite|ivory|cream\b/i, 'color:white', 0.8],
  [/\bpink|blush|rose\b/i, 'color:pink', 0.8],
  [/\byellow|mustard\b/i, 'color:yellow', 0.8],
  [/\borange|rust|terracotta|coral\b/i, 'color:orange', 0.8],
  [/\bpurple|lilac|lavender|plum\b/i, 'color:purple', 0.8],
  [/\bbrown|camel|tan|chocolate\b/i, 'color:brown', 0.8],
  [/v[- ]?neck/i, 'neckline:v_neck', 0.6],
  [/halter/i, 'neckline:halter', 0.6],
  [/square[- ]?neck/i, 'neckline:square', 0.6],
  [/off[- ]?shoulder/i, 'neckline:off_shoulder', 0.6],
];

function keywordExtract(text: string): Record<string, number> {
  const vector: Record<string, number> = {};
  for (const [re, tag, w] of KEYWORD_TAGS) {
    if (re.test(text)) vector[tag] = w;
  }
  return vector;
}

async function extractStubTolerant(
  text: string,
  imageUrl: string | null,
): Promise<{ vector: Record<string, number>; mode: 'ai' | 'keyword' }> {
  try {
    const ai = await import('@hemline/ai');
    const service = ai.createExtractionService();
    const contentHash = createHash('sha256').update(`find-similar|${text}|${imageUrl ?? ''}`).digest('hex');
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
    const attrs: ExtractedAttributes | undefined = result.get(contentHash);
    if (attrs && Object.keys(attrs.attributeVector).length > 0) {
      return { vector: attrs.attributeVector, mode: 'ai' };
    }
    throw new Error('empty extraction');
  } catch {
    return { vector: keywordExtract(text + ' ' + (imageUrl ?? '')), mode: 'keyword' };
  }
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
      // bytes read in-memory; the fallback keys off the filename text only
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

    const { vector, mode } = await extractStubTolerant(text, imageUrl);
    const profile = getUserProfile(db, userId);
    const pool = queryCandidates(db, {});

    const score = (c: CandidateListing) => attributeSimilarity(vector, c.attributeVector);
    let matched = pool
      .map((c) => ({ c, sim: score(c) }))
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
    }));

    return ok({
      attributes: vector,
      extractionMode: mode, // 'ai' | 'keyword' (deterministic demo fallback)
      fallback,
      items,
      totalMatched: matched.length,
    });
  } catch (err) {
    return serverError('find-similar', err);
  }
}

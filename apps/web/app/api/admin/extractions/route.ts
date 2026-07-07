/**
 * GET /api/admin/extractions — extraction QA list (spec G2).
 * Query params: maxConfidence (default 0.6), missingLength=true, limit, offset.
 * Returns raw source text side-by-side with extracted attributes so low
 * confidence / missing-length rows can be eyeballed before demos.
 */
import { z } from 'zod';
import { listExtractionsForQa } from '@hemline/db';
import { checkAdminAuth } from '../../lib/admin-auth';
import { getDb } from '../../lib/db';
import { fail, ok, serverError, zodFail } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  maxConfidence: z.coerce.number().min(0).max(1).default(0.6),
  missingLength: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export async function GET(req: Request) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return zodFail(parsed.error);
    const { maxConfidence, missingLength, limit, offset } = parsed.data;
    return ok(listExtractionsForQa(getDb(), { maxConfidence, missingLength, limit, offset }));
  } catch (err) {
    return serverError('admin/extractions', err);
  }
}

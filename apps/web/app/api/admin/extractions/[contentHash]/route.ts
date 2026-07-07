/**
 * PATCH /api/admin/extractions/:contentHash — manual correction (spec G2).
 * Corrections update the extraction row (model → 'manual' so re-ingest can
 * skip it — integration note for data-eng) and append to the
 * extraction_corrections log for prompt-tuning.
 */
import { z } from 'zod';
import {
  ColorTagSchema,
  LengthClassSchema,
  SilhouetteSchema,
} from '@hemline/contracts';
import { applyExtractionCorrection } from '@hemline/db';
import { checkAdminAuth } from '../../../lib/admin-auth';
import { getDb } from '../../../lib/db';
import { fail, ok, serverError, zodFail } from '../../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CorrectionSchema = z
  .object({
    lengthClass: LengthClassSchema.nullable().optional(),
    lengthInches: z.number().positive().max(90).nullable().optional(),
    measurements: z
      .object({
        bust: z.number().positive().max(80).nullable().optional(),
        waist: z.number().positive().max(80).nullable().optional(),
        hip: z.number().positive().max(80).nullable().optional(),
        length: z.number().positive().max(90).nullable().optional(),
      })
      .optional(),
    colors: z.array(ColorTagSchema).optional(),
    fabric: z.string().nullable().optional(),
    neckline: z.string().nullable().optional(),
    silhouette: SilhouetteSchema.nullable().optional(),
    sleeve: z.string().nullable().optional(),
    pattern: z.string().nullable().optional(),
    occasions: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty correction' });

export async function PATCH(req: Request, ctx: { params: Promise<{ contentHash: string }> }) {
  try {
    if (!checkAdminAuth(req)) return fail('unauthorized', 'admin basic auth required', 401);
    const db = getDb();
    const { contentHash } = await ctx.params;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return fail('invalid_request', 'body must be JSON', 400);
    }
    const parsed = CorrectionSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const updated = applyExtractionCorrection(db, decodeURIComponent(contentHash), parsed.data);
    if (!updated) return fail('not_found', `extraction ${contentHash} not found`, 404);
    return ok(updated);
  } catch (err) {
    return serverError('admin/extractions/:contentHash', err);
  }
}

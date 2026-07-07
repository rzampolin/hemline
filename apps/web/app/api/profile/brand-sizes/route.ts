/**
 * PUT /api/profile/brand-sizes — replace the reference-brand size set
 * (`{brand,sizeLabel}[]`, BrandSizesPutSchema) → UserProfile.
 */
import { BrandSizesPutSchema } from '@hemline/contracts';
import { putBrandSizes } from '@hemline/db';
import { getDb } from '../../lib/db';
import { fail, ok, serverError, zodFail } from '../../lib/envelope';
import { requireUserId } from '../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
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
    const parsed = BrandSizesPutSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    return ok(putBrandSizes(db, userId, parsed.data));
  } catch (err) {
    return serverError('profile/brand-sizes', err);
  }
}

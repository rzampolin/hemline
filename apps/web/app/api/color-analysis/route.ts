/**
 * POST /api/color-analysis — selfie → ColorAnalysisResult (§4.7, §7.4).
 *   Accepts multipart/form-data (field `selfie`) or JSON `{ imageBase64 }`.
 *   Wired to the REAL @hemline/ai pipeline: sharp Lab sampling in memory →
 *   Sonnet classification when keyed, deterministic rule table keyless (the
 *   degradation lives inside packages/ai, §7.5). The image is processed IN
 *   MEMORY ONLY — never written to disk or db — and the result is NOT
 *   auto-saved to the profile (user confirms via PUT).
 * PUT /api/color-analysis — { season } → UserProfile. User accepts/overrides
 *   the season; the season's curated palette is stored alongside (only
 *   season + palette ever persist — spec D1).
 */
import { ColorAnalysisPutSchema } from '@hemline/contracts';
import { analyzeSelfie, SEASON_DATA } from '@hemline/ai';
import { setColorSeason } from '@hemline/db';
import { getDb } from '../lib/db';
import { fail, ok, serverError, zodFail } from '../lib/envelope';
import { getAiClient } from '../lib/matching';
import { requireUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

async function readImageBuffer(req: Request): Promise<Buffer | { error: string }> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('selfie');
    if (!(file instanceof Blob)) return { error: 'multipart field `selfie` (file) is required' };
    if (file.size === 0) return { error: 'selfie file is empty' };
    if (file.size > MAX_IMAGE_BYTES) return { error: 'selfie exceeds 10MB limit' };
    return Buffer.from(await file.arrayBuffer());
  }
  if (contentType.includes('application/json')) {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return { error: 'body must be JSON' };
    }
    const b64 = (body as { imageBase64?: unknown }).imageBase64;
    if (typeof b64 !== 'string' || b64.length === 0)
      return { error: '`imageBase64` (string) is required' };
    const stripped = b64.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(stripped, 'base64');
    if (buf.length === 0) return { error: 'imageBase64 did not decode to any bytes' };
    if (buf.length > MAX_IMAGE_BYTES) return { error: 'image exceeds 10MB limit' };
    return buf;
  }
  return { error: 'send multipart/form-data with `selfie` or JSON { imageBase64 }' };
}

export async function POST(req: Request) {
  try {
    const db = getDb();
    const userId = requireUserId(req, db);
    if (!userId) return fail('no_session', 'No session — call GET /api/session first', 401);

    const image = await readImageBuffer(req);
    if (!Buffer.isBuffer(image)) return fail('invalid_request', image.error, 400);

    // In-memory only: sampled, classified, returned, discarded. Never persisted.
    try {
      const result = await analyzeSelfie(image, { client: getAiClient() });
      return ok(result);
    } catch {
      // sharp couldn't decode the bytes — not an image we can sample
      return fail('invalid_image', 'Could not read that image — try a JPEG or PNG selfie.', 400);
    }
  } catch (err) {
    return serverError('color-analysis', err);
  }
}

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
    const parsed = ColorAnalysisPutSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);
    const { season } = parsed.data;
    return ok(setColorSeason(db, userId, season, SEASON_DATA[season].palette));
  } catch (err) {
    return serverError('color-analysis', err);
  }
}

/**
 * POST /api/color-analysis/quiz — { answers: QuizAnswers } →
 * ColorAnalysisResult (§4.7 manual fallback path; deterministic scoring
 * table, no LLM — §7.4 step 4).
 *
 * QuizAnswers → profile: the resulting season + palette are persisted to the
 * caller's profile immediately (idempotent; PUT /api/color-analysis can
 * override afterwards).
 */
import { ColorAnalysisQuizRequestSchema } from '@hemline/contracts';
import { classifyFromQuiz } from '@hemline/ai';
import { setColorSeason } from '@hemline/db';
import { getDb } from '../../lib/db';
import { fail, ok, serverError, zodFail } from '../../lib/envelope';
import { requireUserId } from '../../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    const parsed = ColorAnalysisQuizRequestSchema.safeParse(body);
    if (!parsed.success) return zodFail(parsed.error);

    // Pure scoring table in packages/ai — deterministic, no LLM (§7.4 step 4).
    // Result carries source:'quiz' (additive contract field): its `measured`
    // values are synthesized, not sampled.
    const result = classifyFromQuiz(parsed.data.answers);
    setColorSeason(db, userId, result.season, result.palette);
    return ok(result);
  } catch (err) {
    return serverError('color-analysis/quiz', err);
  }
}

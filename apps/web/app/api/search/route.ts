/**
 * GET /api/search — explicit-filter search over the catalog → RankResponse.
 *
 * Query params (all optional; csv where plural):
 *   q, sizes, priceMinCents, priceMaxCents, lengthClass (garment label),
 *   lengthOnBody (EFFECTIVE band for HER height), colors (families), brands,
 *   sources (source ids), conditions, freshnessHours, limit, cursor,
 *   personalize (default false — search is the cheap deterministic path).
 *
 * Not in the frozen §4.7 table — additive route so filter state can live in
 * the URL (spec B3); shapes reuse the frozen RankResponse. Unlike /api/rank,
 * profile size/budget are NOT silently applied: explicit filters only.
 */
import { z } from 'zod';
import {
  ConditionSchema,
  HemPositionSchema,
  LengthClassSchema,
  type UserProfile,
} from '@hemline/contracts';
import { getUserProfile } from '@hemline/db';
import { getDb } from '../lib/db';
import { ok, serverError, zodFail } from '../lib/envelope';
import { expandSourceFilter, rankForUser } from '../lib/matching';
import { resolveUserId } from '../lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const csv = (s: string) => s.split(',').map((v) => v.trim()).filter(Boolean);

const SearchParamsSchema = z.object({
  q: z.string().optional(),
  sizes: z
    .string()
    .transform(csv)
    .pipe(z.array(z.coerce.number()))
    .optional(),
  priceMinCents: z.coerce.number().int().nonnegative().optional(),
  priceMaxCents: z.coerce.number().int().nonnegative().optional(),
  lengthClass: z.string().transform(csv).pipe(z.array(LengthClassSchema)).optional(),
  lengthOnBody: z.string().transform(csv).pipe(z.array(HemPositionSchema)).optional(),
  colors: z.string().transform(csv).optional(),
  brands: z.string().transform(csv).optional(),
  sources: z.string().transform(csv).optional(),
  conditions: z.string().transform(csv).pipe(z.array(ConditionSchema)).optional(),
  freshnessHours: z.coerce.number().positive().max(720).optional(),
  limit: z.coerce.number().int().positive().max(100).default(24),
  cursor: z.string().optional(),
  personalize: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default('false'),
});

/** Anonymous browse (no session yet) still gets deterministic results. */
const GUEST_PROFILE: UserProfile = {
  id: 'guest',
  heightInches: null,
  heelPrefInches: 0,
  sizesNormalized: [],
  bodyMeasurements: { bust: null, waist: null, hip: null },
  brandSizes: [],
  lengthPrefs: [],
  coveragePrefs: {},
  budget: { minCents: null, maxCents: null },
  colorSeason: null,
  palette: [],
  styleTags: {},
  onboarded: false,
};

export async function GET(req: Request) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const parsed = SearchParamsSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return zodFail(parsed.error);
    const p = parsed.data;

    const userId = resolveUserId(req);
    const profile = (userId ? getUserProfile(db, userId) : null) ?? GUEST_PROFILE;

    const response = await rankForUser(
      db,
      profile,
      {
        query: p.q,
        sizesNormalized: p.sizes,
        priceMinCents: p.priceMinCents,
        priceMaxCents: p.priceMaxCents,
        lengthClasses: p.lengthClass,
        colorFamilies: p.colors,
        brands: p.brands,
        sourceIds: expandSourceFilter(db, p.sources),
        conditions: p.conditions,
        freshnessHours: p.freshnessHours,
      },
      { lengthOnBody: p.lengthOnBody },
      { limit: p.limit, cursor: p.cursor, personalize: p.personalize },
    );
    return ok(response);
  } catch (err) {
    return serverError('search', err);
  }
}

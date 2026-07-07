/**
 * GET /api/meta/filters → { brands, colorFamilies, priceRange } (§4.7).
 * Populates the filter UI from live catalog aggregates.
 */
import type { MetaFiltersResponse } from '@hemline/contracts';
import { metaFilters } from '@hemline/db';
import { getDb } from '../../lib/db';
import { ok, serverError } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data: MetaFiltersResponse = metaFilters(getDb());
    return ok(data);
  } catch (err) {
    return serverError('meta/filters', err);
  }
}

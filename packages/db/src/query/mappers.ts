/**
 * Row → contract-shape mappers. JSON TEXT columns are parsed defensively
 * (bad JSON → sane empty value) and the result matches the frozen Zod shapes
 * in @hemline/contracts structurally; routes re-validate at the boundary.
 */
import type {
  ColorTag,
  Condition,
  LengthClass,
  Listing,
  Measurements,
  Silhouette,
  UserProfile,
} from '@hemline/contracts';
import type { extractions, listings, users } from '../schema';

export type ListingRow = typeof listings.$inferSelect;
export type ExtractionRow = typeof extractions.$inferSelect;
export type UserRow = typeof users.$inferSelect;

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const EMPTY_MEASUREMENTS: Measurements = { bust: null, waist: null, hip: null, length: null };

function normalizeMeasurements(raw: Partial<Measurements> | null | undefined): Measurements {
  return {
    bust: raw?.bust ?? null,
    waist: raw?.waist ?? null,
    hip: raw?.hip ?? null,
    length: raw?.length ?? null,
  };
}

/** listings row + (optional) extraction row + image urls → contract Listing */
export function rowToListing(
  row: ListingRow,
  extraction: ExtractionRow | null,
  images: string[],
): Listing {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceUrl: row.sourceUrl,
    affiliateUrl: row.affiliateUrl ?? null,
    title: row.title,
    brand: row.brand ?? null,
    priceCents: row.priceCents,
    currency: row.currency,
    images,
    sizeLabels: parseJson<string[]>(row.sizeLabelsJson, []),
    sizeNormalized: parseJson<number[]>(row.sizeNormalizedJson, []),
    availability: parseJson<Record<string, boolean>>(row.availabilityJson, {}),
    condition: row.condition as Condition,
    isVintage: row.isVintage,
    era: row.era ?? null,
    colors: extraction ? parseJson<ColorTag[]>(extraction.colorsJson, []) : [],
    lengthClass: (extraction?.lengthClass ?? null) as LengthClass | null,
    lengthInches: extraction?.lengthInches ?? null,
    lengthBasis: (extraction?.lengthBasis ?? null) as Listing['lengthBasis'],
    measurements: extraction
      ? normalizeMeasurements(parseJson<Partial<Measurements>>(extraction.measurementsJson, EMPTY_MEASUREMENTS))
      : EMPTY_MEASUREMENTS,
    fabric: extraction?.fabric ?? null,
    neckline: extraction?.neckline ?? null,
    silhouette: (extraction?.silhouette ?? null) as Silhouette | null,
    extractionConfidence: extraction?.extractionConfidence ?? 0,
    lastSeenAt: row.lastSeenAt,
    firstSeenAt: row.firstSeenAt,
  };
}

/** users row + brand-size rows → contract UserProfile */
export function rowToUserProfile(
  row: UserRow,
  brandSizes: { brand: string; sizeLabel: string }[],
): UserProfile {
  const meas = parseJson<{ bust?: number | null; waist?: number | null; hip?: number | null }>(
    row.measurementsJson,
    {},
  );
  return {
    id: row.id,
    heightInches: row.heightInches ?? null,
    heelPrefInches: row.heelPrefInches,
    sizesNormalized: parseJson<number[]>(row.sizesJson, []),
    bodyMeasurements: {
      bust: meas.bust ?? null,
      waist: meas.waist ?? null,
      hip: meas.hip ?? null,
    },
    brandSizes,
    lengthPrefs: parseJson(row.lengthPrefsJson, []),
    coveragePrefs: parseJson(row.coveragePrefsJson, {}),
    budget: { minCents: row.budgetMinCents ?? null, maxCents: row.budgetMaxCents ?? null },
    colorSeason: (row.colorSeason ?? null) as UserProfile['colorSeason'],
    palette: parseJson(row.paletteJson, []),
    // NULL (never set) = enabled — the pre-toggle behavior (QA P1 #1).
    paletteBoostEnabled: row.paletteBoostEnabled ?? true,
    styleTags: parseJson(row.styleTagsJson, {}),
    onboarded: row.onboardedAt != null,
  };
}

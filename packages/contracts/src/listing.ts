/**
 * Listing domain contracts — docs/ARCHITECTURE.md §4.1
 *
 * FROZEN. Zod schemas are the source of truth; the exported types are inferred
 * from them and match the architecture doc's interfaces exactly.
 *
 * NOTE: `ExtractedAttributes` (doc §4.3) is *defined* here rather than in
 * `extraction.ts` because `RawListing.attributeHints` references it — defining
 * it in extraction.ts would create a Zod module-evaluation cycle
 * (listing ⇄ extraction). See docs/DECISIONS.md #1. Import it from the package
 * root (`@hemline/contracts`) as usual.
 */
import { z } from 'zod';

export const ConditionSchema = z.enum(['new', 'like_new', 'good', 'fair', 'unknown']);
export type Condition = z.infer<typeof ConditionSchema>;

export const LengthClassSchema = z.enum([
  'micro',
  'mini',
  'above_knee',
  'knee',
  'midi',
  'mid_calf',
  'maxi',
  'floor',
]);
export type LengthClass = z.infer<typeof LengthClassSchema>;

export const SilhouetteSchema = z.enum([
  'a_line',
  'sheath',
  'wrap',
  'fit_and_flare',
  'slip',
  'shirt',
  'bodycon',
  'tent',
  'empire',
  'other',
]);
export type Silhouette = z.infer<typeof SilhouetteSchema>;

/** Inches, garment flat measurements. */
export const MeasurementsSchema = z.object({
  /** pit-to-pit × 2 when sourced that way */
  bust: z.number().nullable(),
  waist: z.number().nullable(),
  hip: z.number().nullable(),
  /** HPS (high point shoulder) to hem */
  length: z.number().nullable(),
});
export type Measurements = z.infer<typeof MeasurementsSchema>;

export const ColorTagSchema = z.object({
  name: z.string(),
  family: z.string(),
  hex: z.string().nullable(),
});
export type ColorTag = z.infer<typeof ColorTagSchema>;

/**
 * Provenance of `lengthInches` (additive, 2026-07-07 ai-eng):
 * 'stated' — parsed/extracted from seller text (§5 fallback 1 → confidence 'high');
 * 'image_estimate' — Haiku vision estimate from the product photo
 * (§5 fallback 1 → confidence 'medium'; UI must style as estimated, never "Measured");
 * 'not_estimable' — the vision pass was attempted but produced no trustworthy
 * inches (clamped against the class prior, or not estimable from the photo).
 * `lengthInches` is ALWAYS null with this basis — 'image_estimate' now always
 * implies inches present. (Additive enum value, length-estimation v2.)
 * Absent/null is treated as 'stated' for backward compatibility.
 */
export const LengthBasisSchema = z.enum(['stated', 'image_estimate', 'not_estimable']);
export type LengthBasis = z.infer<typeof LengthBasisSchema>;

/**
 * Who the garment is FOR (additive, 2026-07-09 data-eng — kids-in-catalog
 * founder bug). 'child' listings are excluded from feed/search candidates;
 * null is treated as adult (never nuke coverage on an unknown).
 */
export const AudienceSchema = z.enum(['adult', 'child']);
export type Audience = z.infer<typeof AudienceSchema>;

/** Output of the AI extraction pipeline (doc §4.3). Also used as `attributeHints`. */
export const ExtractedAttributesSchema = z.object({
  lengthClass: LengthClassSchema.nullable(),
  lengthInches: z.number().nullable(),
  /** optional additive: where lengthInches came from (see LengthBasisSchema) */
  lengthBasis: LengthBasisSchema.nullable().optional(),
  measurements: MeasurementsSchema,
  colors: z.array(ColorTagSchema),
  fabric: z.string().nullable(),
  neckline: z.string().nullable(),
  silhouette: SilhouetteSchema.nullable(),
  sleeve: z.string().nullable(),
  pattern: z.string().nullable(),
  occasions: z.array(z.string()),
  /** optional additive: who the garment is for (null = unknown, treated as adult) */
  audience: AudienceSchema.nullable().optional(),
  /** sparse tag→weight vector used for style similarity (v1) */
  attributeVector: z.record(z.string(), z.number()),
  /** 0..1 */
  confidence: z.number().min(0).max(1),
});
export type ExtractedAttributes = z.infer<typeof ExtractedAttributesSchema>;

/** What a connector emits. Deliberately loose — normalization happens downstream. */
export const RawListingSchema = z.object({
  /** 'ebay' | 'shopify:staud.clothing' | 'fixtures' */
  sourceId: z.string(),
  sourceListingId: z.string(),
  sourceUrl: z.string(),
  affiliateUrl: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  brand: z.string().optional(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  imageUrls: z.array(z.string()),
  /** raw, as-seen: ["M", "EU 38", "8"] */
  sizeLabels: z.array(z.string()),
  /** sizeLabel -> in stock */
  availability: z.record(z.string(), z.boolean()).optional(),
  condition: ConditionSchema.optional(),
  isVintage: z.boolean().optional(),
  era: z.string().optional(),
  /** connector may pre-fill structured hints (eBay aspects, Shopify tags) */
  attributeHints: ExtractedAttributesSchema.partial().optional(),
  /** epoch ms */
  seenAt: z.number(),
});
export type RawListing = z.infer<typeof RawListingSchema>;

/** Unified, enriched listing — the shape the API serves and matching consumes. */
export const ListingSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceUrl: z.string(),
  affiliateUrl: z.string().nullable(),
  title: z.string(),
  brand: z.string().nullable(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string(),
  images: z.array(z.string()),
  sizeLabels: z.array(z.string()),
  /** US numeric sizes */
  sizeNormalized: z.array(z.number()),
  availability: z.record(z.string(), z.boolean()),
  condition: ConditionSchema,
  isVintage: z.boolean(),
  era: z.string().nullable(),
  colors: z.array(ColorTagSchema),
  lengthClass: LengthClassSchema.nullable(),
  lengthInches: z.number().nullable(),
  /** optional additive: provenance of lengthInches ('stated' | 'image_estimate') */
  lengthBasis: LengthBasisSchema.nullable().optional(),
  measurements: MeasurementsSchema,
  fabric: z.string().nullable(),
  neckline: z.string().nullable(),
  silhouette: SilhouetteSchema.nullable(),
  /** optional additive: extraction-level audience ('child' is filtered out upstream;
   * matching treats null as adult) */
  audience: AudienceSchema.nullable().optional(),
  /** 0..1 */
  extractionConfidence: z.number().min(0).max(1),
  lastSeenAt: z.number(),
  firstSeenAt: z.number(),
});
export type Listing = z.infer<typeof ListingSchema>;

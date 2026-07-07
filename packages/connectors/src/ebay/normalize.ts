/**
 * eBay Browse API itemSummary → RawListing normalization (pure functions).
 * docs/ARCHITECTURE.md §8. localizedAspects (Size / Color / Brand / Dress
 * Length / Decade) become size labels + attributeHints.
 */
import type {
  ColorTag,
  Condition,
  ExtractedAttributes,
  LengthClass,
  RawListing,
} from '@hemline/contracts';

export interface EbayItemSummary {
  itemId: string;
  title: string;
  leafCategoryIds?: string[];
  image?: { imageUrl?: string };
  additionalImages?: { imageUrl?: string }[];
  price?: { value?: string; currency?: string };
  itemWebUrl?: string;
  itemAffiliateWebUrl?: string;
  condition?: string;
  conditionId?: string;
  localizedAspects?: { type?: string; name: string; value: string }[];
  legacyItemId?: string;
}

/** eBay clothing conditionIds → our Condition enum. */
export function mapEbayCondition(conditionId?: string, conditionText?: string): Condition {
  const id = Number(conditionId);
  if (Number.isFinite(id)) {
    if (id >= 1000 && id < 2000) return 'new'; // new / new with(out) tags / with defects
    if (id >= 2000 && id < 3000) return 'like_new';
    if (id === 3000) return 'good'; // pre-owned
    if (id > 3000 && id < 6000) return 'fair';
  }
  const txt = (conditionText ?? '').toLowerCase();
  if (/new/.test(txt)) return 'new';
  if (/like new|excellent/.test(txt)) return 'like_new';
  if (/pre-owned|used|good/.test(txt)) return 'good';
  return 'unknown';
}

const DRESS_LENGTH_MAP: Record<string, LengthClass> = {
  micro: 'micro',
  mini: 'mini',
  short: 'mini',
  'above knee': 'above_knee',
  'above knee, mini': 'above_knee',
  knee: 'knee',
  'knee length': 'knee',
  midi: 'midi',
  'mid-calf': 'mid_calf',
  maxi: 'maxi',
  long: 'maxi',
  'floor length': 'floor',
  'full-length': 'floor',
};

export function mapEbayDressLength(value: string): LengthClass | null {
  return DRESS_LENGTH_MAP[value.trim().toLowerCase()] ?? null;
}

const COLOR_FAMILIES: [RegExp, string][] = [
  [/black|onyx|charcoal/i, 'black'],
  [/white|ivory|cream|ecru/i, 'white'],
  [/red|crimson|scarlet|burgundy|maroon|wine/i, 'red'],
  [/pink|blush|rose|fuchsia|magenta/i, 'pink'],
  [/orange|rust|terracotta|coral|peach|apricot/i, 'orange'],
  [/yellow|gold|mustard|lemon/i, 'yellow'],
  [/green|olive|sage|emerald|mint|forest/i, 'green'],
  [/blue|navy|cobalt|azure|denim|teal/i, 'blue'],
  [/purple|violet|lavender|lilac|plum|mauve/i, 'purple'],
  [/brown|tan|camel|chocolate|taupe|beige|khaki|leopard/i, 'brown'],
  [/gr[ae]y|silver/i, 'gray'],
];

export function colorFamily(name: string): string {
  for (const [re, family] of COLOR_FAMILIES) if (re.test(name)) return family;
  return 'multi';
}

const VINTAGE_TITLE_RE = /\bv(in)?t(a)?g\b|\bvintage\b/i;
const ERA_RE = /\b(19[2-9]0)'?s\b/i;

export interface NormalizeEbayOptions {
  /** EPN campaign id; used to build an affiliate URL when the API didn't return one */
  affiliateCampaignId?: string;
  seenAt: number;
}

/** EPN rover parameters (network 711 = EPN, standard toolid). */
export function buildEpnAffiliateUrl(itemWebUrl: string, campaignId: string): string {
  const url = new URL(itemWebUrl);
  url.searchParams.set('mkcid', '1');
  url.searchParams.set('mkrid', '711-53200-19255-0');
  url.searchParams.set('campid', campaignId);
  url.searchParams.set('toolid', '10001');
  url.searchParams.set('mkevt', '1');
  return url.toString();
}

export function normalizeEbayItem(
  item: EbayItemSummary,
  opts: NormalizeEbayOptions,
): RawListing | null {
  const priceValue = Number.parseFloat(item.price?.value ?? '');
  if (!item.itemWebUrl || !Number.isFinite(priceValue)) return null;

  const aspects = new Map<string, string[]>();
  for (const a of item.localizedAspects ?? []) {
    const key = a.name.trim().toLowerCase();
    aspects.set(key, [...(aspects.get(key) ?? []), a.value]);
  }

  const sizeLabels = (aspects.get('size') ?? []).map((s) => s.trim()).filter(Boolean);
  const brand = aspects.get('brand')?.[0];
  const decade = aspects.get('decade')?.[0];
  const styleValues = (aspects.get('style') ?? []).join(' ');

  const hints: Partial<ExtractedAttributes> = {};
  const colors: ColorTag[] = (aspects.get('color') ?? []).map((c) => ({
    name: c.toLowerCase(),
    family: colorFamily(c),
    hex: null,
  }));
  if (colors.length > 0) hints.colors = colors;
  const dressLength = aspects.get('dress length')?.[0];
  if (dressLength) {
    const cls = mapEbayDressLength(dressLength);
    if (cls) hints.lengthClass = cls;
  }

  const imageUrls = [item.image?.imageUrl, ...(item.additionalImages ?? []).map((i) => i.imageUrl)]
    .filter((u): u is string => Boolean(u))
    .filter((u, i, arr) => arr.indexOf(u) === i);

  const isVintage =
    Boolean(decade) || VINTAGE_TITLE_RE.test(item.title) || /vintage/i.test(styleValues);
  const era = decade ?? item.title.match(ERA_RE)?.[0]?.replace(/'/g, '').toLowerCase();

  const affiliateUrl =
    item.itemAffiliateWebUrl ??
    (opts.affiliateCampaignId
      ? buildEpnAffiliateUrl(item.itemWebUrl, opts.affiliateCampaignId)
      : undefined);

  return {
    sourceId: 'ebay',
    sourceListingId: item.itemId,
    sourceUrl: item.itemWebUrl,
    ...(affiliateUrl ? { affiliateUrl } : {}),
    title: item.title,
    ...(brand ? { brand } : {}),
    priceCents: Math.round(priceValue * 100),
    currency: item.price?.currency ?? 'USD',
    imageUrls,
    sizeLabels,
    // resale: a live listing means that size is buyable
    availability: Object.fromEntries(sizeLabels.map((s) => [s, true])),
    condition: mapEbayCondition(item.conditionId, item.condition),
    isVintage,
    ...(era ? { era } : {}),
    ...(Object.keys(hints).length > 0 ? { attributeHints: hints } : {}),
    seenAt: opts.seenAt,
  };
}

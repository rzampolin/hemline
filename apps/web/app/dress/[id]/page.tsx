'use client';

/**
 * Product detail (PRODUCT_SPEC C1–C3, §4.5): gallery → price/brand/sizes →
 * effective-length module (body diagram) → fit signal → attributes →
 * freshness → sticky affiliate CTA. Heart in header. Similar grid below.
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { ListingDetailResponse } from '@hemline/contracts';
import {
  Button,
  ButtonLink,
  ConfidenceTag,
  ErrorState,
  FreshnessBadge,
  HeartButton,
  HemIndicator,
  ProgressDots,
  Skeleton,
  SourceBadge,
  formatAgo,
  formatPrice,
  hemDetailLine,
  isStale,
  lengthClassLabel,
  sourceLabel,
} from '@hemline/ui';
import { api } from '../../../lib/api';
import { track } from '../../../lib/analytics';
import { useProfile } from '../../../lib/profile-store';
import { resolveImage } from '../../../lib/img';
import { DEFAULT_HEIGHT_INCHES, hemForUser } from '../../../lib/hem';
import { SEASONS } from '../../../lib/seasons';
import { hexToFamily } from '../../../lib/mock/data';
import { ListingGrid } from '../../components/grid';

export default function DressDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { profile, isSaved, toggleSave } = useProfile();
  const [data, setData] = useState<ListingDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [galleryIndex, setGalleryIndex] = useState(0);

  const listingId = decodeURIComponent(id);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    api
      .getListing(listingId)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // analytics: one detail view per successful load (source = catalog
        // source id — resale vs brand mix, denominator for outbound CTR)
        track({ type: 'listing_viewed', props: { source: d.listing.sourceId.slice(0, 64) } });
      })
      .catch((e: Error) => !cancelled && setError(e.message || 'Could not load this dress.'));
    return () => {
      cancelled = true;
    };
  }, [listingId]);

  const whyItWorks = useMemo(() => {
    if (!data || !profile) return null;
    // Prefer the server-composed line (additive ListingDetailResponse field —
    // templated keyless, Haiku when live). Client fallback covers mock mode.
    if (data.whyItWorks !== undefined) {
      return data.whyItWorks ? `Why it works for you: ${data.whyItWorks}` : null;
    }
    const bits: string[] = [];
    if (data.hem.position && profile.lengthPrefs.includes(data.hem.position)) {
      bits.push(`it lands ${data.hem.position.replace('_', ' ')} on you — a length you asked for`);
    }
    const paletteFams = new Set(profile.palette.map((c) => hexToFamily(c.hex)));
    if (paletteFams.size && data.listing.colors.some((c) => paletteFams.has(c.family)) && profile.colorSeason) {
      bits.push(`its colors sit in your ${SEASONS[profile.colorSeason].label} palette`);
    }
    const brandSize = profile.brandSizes.find((b) => b.brand === data.listing.brand);
    if (brandSize) bits.push(`you already know you’re a ${brandSize.sizeLabel} in ${brandSize.brand}`);
    if (bits.length === 0) return null;
    const line = bits.slice(0, 2).join(', and ');
    return `Why it works for you: ${line}.`;
  }, [data, profile]);

  if (error) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <ErrorState title="This dress slipped away">
          {error}
          <div className="mt-3">
            <Button onClick={() => router.push('/feed')}>Back to your rack</Button>
          </div>
        </ErrorState>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 px-4 pt-4 pb-24">
        <Skeleton className="aspect-[3/4] w-full rounded-3xl" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </main>
    );
  }

  const { listing, hem, similar } = data;
  const m = listing.measurements;
  const hasMeasurements = m.bust != null || m.waist != null || m.hip != null || m.length != null;
  const heightInches = profile?.heightInches ?? DEFAULT_HEIGHT_INCHES;
  const outboundUrl = listing.affiliateUrl ?? listing.sourceUrl;
  const shopLabel = sourceLabel(listing.sourceId, listing.brand);
  const sizesInStock = listing.sizeLabels.filter((s) => listing.availability[s] !== false);

  return (
    <main className="mx-auto max-w-2xl pb-28 lg:max-w-5xl">
      {/* header */}
      <div className="sticky top-0 z-30 flex items-center justify-between bg-cream/95 px-3 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back"
          className="flex size-10 items-center justify-center rounded-full bg-card shadow-card"
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M10 2 4 8l6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <HeartButton saved={isSaved(listing.id)} onToggle={() => toggleSave(listing.id, 'feed')} />
      </div>

      <div className="lg:grid lg:grid-cols-2 lg:gap-8 lg:px-4">
        {/* gallery */}
        <section aria-label="Photos" className="-mt-14 lg:mt-0">
          <div
            className="no-scrollbar flex snap-x snap-mandatory overflow-x-auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              setGalleryIndex(Math.round(el.scrollLeft / el.clientWidth));
            }}
          >
            {listing.images.map((img, i) => (
              <img
                key={i}
                src={resolveImage(img)}
                alt={`${listing.title} — photo ${i + 1} of ${listing.images.length}`}
                className="aspect-[3/4] w-full shrink-0 snap-center object-cover lg:rounded-3xl"
              />
            ))}
          </div>
          {listing.images.length > 1 && (
            <ProgressDots count={listing.images.length} active={galleryIndex} className="mt-2" />
          )}
        </section>

        <div className="px-4 lg:px-0">
          {/* title block */}
          <section className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <SourceBadge sourceId={listing.sourceId} brand={listing.brand} />
              {listing.isVintage && (
                <span className="rounded-full bg-parchment px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase">
                  vintage{listing.era ? ` · ${listing.era}` : ''}
                </span>
              )}
              <FreshnessBadge lastSeenAt={listing.lastSeenAt} />
            </div>
            <h1 className="mt-2 font-display text-2xl leading-snug text-ink">{listing.title}</h1>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="font-display text-2xl text-ink">{formatPrice(listing.priceCents, listing.currency)}</span>
              {listing.brand && <span className="text-sm text-ink-soft">{listing.brand}</span>}
            </div>
            {isStale(listing.lastSeenAt) && (
              <p className="mt-1 text-xs text-accent">
                Possibly sold — last seen {formatAgo(listing.lastSeenAt)}. Check the listing.
              </p>
            )}
          </section>

          {/* sizes */}
          <section className="mt-4" aria-label="Sizes">
            <p className="text-xs font-semibold tracking-wide text-ink-soft uppercase">Sizes in stock</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {listing.sizeLabels.map((s) => {
                const inStock = listing.availability[s] !== false;
                return (
                  <span
                    key={s}
                    className={`inline-flex min-w-9 items-center justify-center rounded-full border px-2.5 py-1 text-sm ${
                      inStock ? 'border-ink/30 text-ink' : 'border-line text-ink-faint line-through'
                    }`}
                  >
                    {s}
                  </span>
                );
              })}
              {sizesInStock.length === 0 && <span className="text-sm text-ink-faint">None right now</span>}
            </div>
          </section>

          {/* THE effective-length module (C2) */}
          <section
            data-testid="hem-module"
            className="mt-6 rounded-3xl border border-line bg-card p-5"
            aria-label="Where the hem hits on you"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg text-ink">On your body</h2>
              <ConfidenceTag hem={hem} />
            </div>
            <p className="mt-1 text-sm text-ink-soft" data-testid="hem-detail-line">
              {hemDetailLine(hem, listing.lengthClass)}
              {hem.basis === 'length_class_prior' && ' — estimated from its length class.'}
              {hem.basis === 'measured_length' &&
                hem.confidence === 'high' &&
                listing.lengthInches != null && (
                  <> — from the seller’s {listing.lengthInches}″ measurement.</>
                )}
              {hem.basis === 'measured_length' &&
                hem.confidence !== 'high' &&
                listing.lengthInches != null && (
                  <> — estimated ≈{listing.lengthInches}″ from the listing photo.</>
                )}
            </p>
            <HemIndicator heightInches={heightInches} hem={hem} className="mt-4" />
            {!profile?.heightInches && (
              <p className="mt-2 text-xs text-ink-faint">
                Shown for 5′5″.{' '}
                <Link href="/onboarding" className="text-accent underline">
                  Add your height
                </Link>{' '}
                for your exact hem line.
              </p>
            )}
          </section>

          {whyItWorks && (
            <p className="mt-4 rounded-2xl bg-moss-soft px-4 py-3 text-sm text-moss">{whyItWorks}</p>
          )}

          {/* fit signal (C3) */}
          <section className="mt-6" aria-label="Fit">
            <h2 className="font-display text-lg text-ink">Fit</h2>
            {hasMeasurements ? (
              <>
                <table className="mt-2 w-full text-sm">
                  <tbody>
                    {(
                      [
                        ['Bust', m.bust],
                        ['Waist', m.waist],
                        ['Hip', m.hip],
                        ['Length (shoulder to hem)', m.length],
                      ] as const
                    )
                      .filter(([, v]) => v != null)
                      .map(([label, v]) => (
                        <tr key={label} className="border-b border-line/60">
                          <td className="py-1.5 text-ink-soft">{label}</td>
                          <td className="py-1.5 text-right font-medium text-ink">{v}″</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-ink-faint">
                  Garment measured flat. Verify against a dress that fits you well before buying.
                </p>
              </>
            ) : listing.isVintage ? (
              <p className="mt-2 rounded-2xl bg-parchment px-4 py-3 text-sm text-ink-soft">
                Vintage sizing often runs 3–4 sizes small and this seller listed no measurements —
                ask for bust/waist/length before buying.
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-soft">
                No garment measurements listed. Check {shopLabel}’s size chart for your usual size.
              </p>
            )}
          </section>

          {/* attributes */}
          <section className="mt-6" aria-label="Details">
            <h2 className="font-display text-lg text-ink">Details</h2>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              {listing.lengthClass && <Attr label="Label length" value={lengthClassLabel[listing.lengthClass]} />}
              {listing.silhouette && <Attr label="Silhouette" value={listing.silhouette.replace(/_/g, ' ')} />}
              {listing.neckline && <Attr label="Neckline" value={listing.neckline.replace(/_/g, ' ')} />}
              {listing.fabric && <Attr label="Fabric" value={listing.fabric} />}
              {listing.colors.length > 0 && (
                <Attr label="Colors" value={listing.colors.map((c) => c.name).join(', ')} />
              )}
              <Attr label="Condition" value={listing.condition.replace(/_/g, ' ')} />
            </dl>
            <p className="mt-3 text-xs text-ink-faint">
              Last seen in stock {formatAgo(listing.lastSeenAt)} · attributes extracted automatically
              {listing.extractionConfidence > 0 && ` (${Math.round(listing.extractionConfidence * 100)}% confidence)`}
            </p>
          </section>

          {/* similar */}
          {similar.length > 0 && (
            <section className="mt-8" aria-label="Similar dresses">
              <h2 className="font-display text-lg text-ink">More like this</h2>
              <div className="mt-3">
                <ListingGrid
                  items={similar.slice(0, 4).map((l) => ({
                    listing: l,
                    hem: hemForUser(l, heightInches, profile?.heelPrefInches ?? 0),
                    score: 0,
                    whyItWorks: null,
                    freshnessDecay: 1,
                  }))}
                  context="feed"
                  showPaletteChips={false}
                />
              </div>
            </section>
          )}
        </div>
      </div>

      {/* sticky outbound CTA (C1: primary, new tab, affiliate) */}
      <div className="fixed right-0 bottom-0 left-0 z-40 border-t border-line bg-cream/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <ButtonLink
            href={outboundUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            variant="accent"
            size="lg"
            full
            data-testid="shop-cta"
            // G4 click/attribution log — non-blocking beacon, never delays the tab
            onClick={() => api.recordClickout(listing.id)}
          >
            Shop on {shopLabel} ↗
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}

function Attr({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card px-3 py-2 ring-1 ring-line/60">
      <dt className="text-[10px] tracking-wide text-ink-faint uppercase">{label}</dt>
      <dd className="text-sm text-ink capitalize">{value}</dd>
    </div>
  );
}

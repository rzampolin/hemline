'use client';

/**
 * The feed — "Your Rack" home (PRODUCT_SPEC B1–B3, §4.4). Two-column grid,
 * sticky bar with search / camera / filters, URL-reflected filter state,
 * infinite scroll, hem badge on every card, palette boost chips, color invite.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { HemPosition, MetaFiltersResponse, RankedListing, SearchInterpretation } from '@hemline/contracts';
import {
  Button,
  CardSkeleton,
  Chip,
  DualRange,
  EmptyState,
  ErrorState,
  RemovableChip,
  Sheet,
  Spinner,
  hemShort,
} from '@hemline/ui';
import type { FilterKind } from '@hemline/contracts';
import { api, type FeedFilters, type SourceKindFilter } from '../../../lib/api';
import { track } from '../../../lib/analytics';
import { useProfile } from '../../../lib/profile-store';
import { ListingGrid } from '../../components/grid';
import { KEYS, readLocal, writeLocal } from '../../../lib/local';

const PAGE_SIZE = 24;
/**
 * When /api/rank answers rerank.mode 'pending' (deterministic page served,
 * personalized order warming in the background), refetch ONCE, quietly, after
 * this delay. The swap happens as a plain state update on the settled grid —
 * no skeleton flash, no spinner — and is skipped entirely if the user changed
 * filters or paginated in the meantime (requestSeq guard).
 */
const PENDING_RERANK_REFETCH_MS = 8_000;
const HEM_OPTIONS: HemPosition[] = ['upper_thigh', 'above_knee', 'knee', 'below_knee', 'mid_calf', 'ankle', 'floor'];

/* ── URL <-> filter state (B3: shareable/back-button safe) ───────────────── */

interface FeedState {
  q: string;
  /** un-chipped interpretation terms (kept lexical-only, B3 URL-reflected) */
  lex: string[];
  sizes: number[];
  pmin: number | null;
  pmax: number | null;
  lens: HemPosition[];
  colors: string[];
  brands: string[];
  sources: SourceKindFilter[];
  cond: 'new' | 'preowned' | null;
}

function parseState(sp: URLSearchParams): FeedState {
  const csv = (k: string) => sp.get(k)?.split(',').filter(Boolean) ?? [];
  return {
    q: sp.get('q') ?? '',
    lex: csv('lex'),
    sizes: csv('sizes').map(Number).filter(Number.isFinite),
    pmin: sp.get('pmin') ? Number(sp.get('pmin')) : null,
    pmax: sp.get('pmax') ? Number(sp.get('pmax')) : null,
    lens: csv('len') as HemPosition[],
    colors: csv('colors'),
    brands: csv('brands'),
    sources: csv('src') as SourceKindFilter[],
    cond: (sp.get('cond') as FeedState['cond']) ?? null,
  };
}

function stateToQuery(s: FeedState): string {
  const sp = new URLSearchParams();
  if (s.q) sp.set('q', s.q);
  if (s.lex.length) sp.set('lex', s.lex.join(','));
  if (s.sizes.length) sp.set('sizes', s.sizes.join(','));
  if (s.pmin != null) sp.set('pmin', String(s.pmin));
  if (s.pmax != null) sp.set('pmax', String(s.pmax));
  if (s.lens.length) sp.set('len', s.lens.join(','));
  if (s.colors.length) sp.set('colors', s.colors.join(','));
  if (s.brands.length) sp.set('brands', s.brands.join(','));
  if (s.sources.length) sp.set('src', s.sources.join(','));
  if (s.cond) sp.set('cond', s.cond);
  const q = sp.toString();
  return q ? `?${q}` : '';
}

/** Which filter facets changed between two states (analytics: filter_applied). */
function changedFilterKinds(prev: FeedState, next: FeedState): FilterKind[] {
  const csvDiff = (a: unknown[], b: unknown[]) =>
    a.length !== b.length || a.some((v, i) => v !== b[i]);
  const kinds: FilterKind[] = [];
  if (csvDiff(prev.sizes, next.sizes)) kinds.push('size');
  if (prev.pmin !== next.pmin || prev.pmax !== next.pmax) kinds.push('price');
  if (csvDiff(prev.lens, next.lens)) kinds.push('length');
  if (csvDiff(prev.colors, next.colors)) kinds.push('color');
  if (csvDiff(prev.brands, next.brands)) kinds.push('brand');
  if (csvDiff(prev.sources, next.sources)) kinds.push('source');
  if (prev.cond !== next.cond) kinds.push('condition');
  return kinds;
}

export default function FeedPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center">
          <Spinner label="Loading your rack" />
        </main>
      }
    >
      <FeedInner />
    </Suspense>
  );
}

function FeedInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { profile, loading: profileLoading, paletteBoost, setPaletteBoost } = useProfile();

  const state = useMemo(() => parseState(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [items, setItems] = useState<RankedListing[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [meta, setMeta] = useState<MetaFiltersResponse | null>(null);
  const [searchDraft, setSearchDraft] = useState(state.q);
  const [interpreted, setInterpreted] = useState<SearchInterpretation | null>(null);
  const [inviteDismissed, setInviteDismissed] = useState(true);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);
  const pageRef = useRef(0);
  const lastTrackedQuery = useRef('');

  useEffect(() => {
    setInviteDismissed(readLocal<boolean>(KEYS.colorInviteDismissed, false));
    api.getMetaFilters().then(setMeta).catch(() => {});
  }, []);

  useEffect(() => setSearchDraft(state.q), [state.q]);

  /** Silent hard filters from the profile (B1) + explicit overrides from the URL. */
  const buildFilters = useCallback((): FeedFilters => {
    const p = profile;
    return {
      query: state.q || undefined,
      lexicalTerms: state.q && state.lex.length ? state.lex : undefined,
      sizesNormalized: state.sizes.length
        ? state.sizes
        : p?.sizesNormalized.length
          ? p.sizesNormalized
          : undefined,
      priceMinCents: state.pmin != null ? state.pmin * 100 : (p?.budget.minCents ?? undefined),
      priceMaxCents: state.pmax != null ? state.pmax * 100 : (p?.budget.maxCents ?? undefined),
      lengthOnBody: state.lens.length
        ? state.lens
        : p && p.lengthPrefs.length > 0 && p.lengthPrefs.length < HEM_OPTIONS.length
          ? p.lengthPrefs
          : undefined,
      colorFamilies: state.colors.length ? state.colors : undefined,
      brands: state.brands.length ? state.brands : undefined,
      sources: state.sources.length ? state.sources : undefined,
      conditions:
        state.cond === 'new'
          ? ['new']
          : state.cond === 'preowned'
            ? ['like_new', 'good', 'fair', 'unknown']
            : undefined,
    };
  }, [profile, state]);

  const load = useCallback(
    async (append: boolean, cur?: string, quiet = false) => {
      if (!profile) return;
      const seq = ++requestSeq.current;
      if (!append && !quiet) {
        setLoading(true);
        setError(false);
      } else if (append) {
        setLoadingMore(true);
      }
      try {
        const res = await api.rank({
          userId: profile.id,
          filters: buildFilters(),
          limit: PAGE_SIZE,
          cursor: cur,
          personalize: true,
        });
        if (seq !== requestSeq.current) return;
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
        setTotal(res.totalMatched);
        if (!append) setInterpreted(res.interpreted ?? null);
        // analytics (fire-and-forget): page views + search submissions with
        // their result counts (zero-result queries = catalog-gap signal).
        // Quiet rerank refetches re-render the same page — not a new view.
        if (!quiet) {
          pageRef.current = append ? pageRef.current + 1 : 0;
          track({ type: 'feed_viewed', props: { page: Math.min(pageRef.current, 999) } });
        }
        if (!append && !quiet) {
          if (state.q && state.q !== lastTrackedQuery.current) {
            lastTrackedQuery.current = state.q;
            track({
              type: 'search_submitted',
              props: {
                query: state.q.slice(0, 120),
                interpreted: res.interpreted != null,
                resultCount: res.totalMatched,
              },
            });
          } else if (!state.q) {
            lastTrackedQuery.current = '';
          }
        }
        // Personalized order lands asynchronously: one quiet refetch after the
        // background rerank has had time to warm the cache. Quiet loads never
        // re-schedule (refetch-once), and any interaction that bumps
        // requestSeq (filters, pagination) cancels the swap.
        if (!append && !quiet && res.rerank.mode === 'pending') {
          setTimeout(() => {
            if (seq === requestSeq.current) void load(false, undefined, true);
          }, PENDING_RERANK_REFETCH_MS);
        }
      } catch {
        if (seq === requestSeq.current && !append && !quiet) setError(true);
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [profile, buildFilters, state.q],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  /* infinite scroll */
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor == null) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMore && !loading) void load(true, cursor);
      },
      { rootMargin: '600px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [cursor, load, loading, loadingMore]);

  const apply = (next: FeedState) => router.replace(`${pathname}${stateToQuery(next)}`, { scroll: false });

  const activeFilterCount =
    (state.sizes.length ? 1 : 0) +
    (state.pmin != null || state.pmax != null ? 1 : 0) +
    (state.lens.length ? 1 : 0) +
    (state.colors.length ? 1 : 0) +
    (state.brands.length ? 1 : 0) +
    (state.sources.length ? 1 : 0) +
    (state.cond ? 1 : 0);

  const needsOnboarding = !profileLoading && profile != null && !profile.onboarded;

  return (
    <main className="px-4 pt-3">
      {/* sticky top bar */}
      <div className="sticky top-0 z-30 -mx-4 border-b border-line/70 bg-cream/95 px-4 pt-2 pb-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Link href="/feed" className="pr-1 font-display text-lg text-accent">
            Soline
          </Link>
          <form
            role="search"
            className="relative flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              apply({ ...state, q: searchDraft.trim(), lex: [] });
            }}
          >
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Search dresses…"
              aria-label="Search dresses"
              className="h-10 w-full rounded-full border border-line bg-card pr-3 pl-9 text-sm placeholder:text-ink-faint focus:border-ink/40 focus:outline-none"
            />
            <svg viewBox="0 0 20 20" className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint" aria-hidden="true">
              <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="m13.5 13.5 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </form>
          <Link
            href="/check"
            aria-label="Paste a dress link to fit-check it"
            className="flex size-10 items-center justify-center rounded-full border border-line bg-card text-ink-soft hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
              <path d="M8.5 11.5 11.5 8.5M7 13l-1.8 1.8a2.5 2.5 0 0 1-3.5-3.5L4.5 8.5a2.5 2.5 0 0 1 3.5 0M13 7l1.8-1.8a2.5 2.5 0 0 1 3.5 3.5L15.5 11.5a2.5 2.5 0 0 1-3.5 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <Link
            href="/similar"
            aria-label="Find dresses like a photo"
            className="flex size-10 items-center justify-center rounded-full border border-line bg-card text-ink-soft hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h1.2L7.5 3h5L14 5h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="10" cy="10.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </Link>
          <button
            type="button"
            data-testid="open-filters"
            onClick={() => setFiltersOpen(true)}
            aria-label={`Filters${activeFilterCount ? ` (${activeFilterCount} active)` : ''}`}
            className="relative flex size-10 items-center justify-center rounded-full border border-line bg-card text-ink-soft hover:text-ink"
          >
            <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
              <path d="M3 5h14M6 10h8M8.5 15h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            {activeFilterCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-cream">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* active palette boost chip (D2: soft + visible + removable) */}
        {profile && profile.palette.length > 0 && paletteBoost && (
          <div className="mt-2 flex items-center gap-2">
            <RemovableChip onRemove={() => setPaletteBoost(false)} removeLabel="Turn off palette boost">
              boosting your palette
            </RemovableChip>
            {total != null && <span className="text-[11px] text-ink-faint">{total} dresses</span>}
          </div>
        )}
      </div>

      {/* hybrid-search interpretation chips (removable — un-chipping forces
          that term back to plain lexical matching via the `lex` URL param) */}
      {state.q && !loading && interpreted && (interpreted.signals.length > 0 || interpreted.vibe.length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="interpreted-chips">
          <span className="text-[11px] text-ink-faint">Searching for</span>
          {interpreted.signals.map((sig) => (
            <RemovableChip
              key={`${sig.kind}:${sig.value}`}
              onRemove={() => apply({ ...state, lex: [...state.lex, sig.term] })}
              removeLabel={`Search "${sig.term}" as plain text instead`}
            >
              {sig.value}
            </RemovableChip>
          ))}
          {interpreted.vibe.map((term) => (
            <RemovableChip
              key={`vibe:${term}`}
              className="bg-accent-soft text-accent"
              onRemove={() => apply({ ...state, lex: [...state.lex, term] })}
              removeLabel={`Search "${term}" as plain text instead`}
            >
              {interpreted.semantic ? `~${term}` : term}
            </RemovableChip>
          ))}
        </div>
      )}

      {needsOnboarding && (
        <div className="mt-4 rounded-2xl border border-accent/25 bg-accent-soft p-4">
          <p className="font-display text-lg text-ink">First: 90 seconds about you</p>
          <p className="mt-1 text-sm text-ink-soft">
            Height and size power the hem math. No account needed.
          </p>
          <Link href="/onboarding" className="mt-3 inline-flex min-h-10 items-center rounded-full bg-ink px-5 text-sm font-medium text-cream">
            Start the quiz →
          </Link>
        </div>
      )}

      {/* color analysis invite (D1: post-first-value, dismissible, never onboarding) */}
      {profile && profile.onboarded && !profile.colorSeason && !inviteDismissed && (
        <div className="relative mt-4 rounded-2xl border border-line bg-card p-4">
          <button
            type="button"
            aria-label="Dismiss color analysis invite"
            onClick={() => {
              writeLocal(KEYS.colorInviteDismissed, true);
              setInviteDismissed(true);
            }}
            className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-full text-ink-faint hover:bg-ink/5"
          >
            <svg viewBox="0 0 12 12" className="size-3" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <div className="flex items-center gap-3">
            <span className="flex -space-x-1.5" aria-hidden="true">
              {['#8A9A5B', '#B5651D', '#C4A484', '#9C8AA5'].map((c) => (
                <span key={c} className="size-6 rounded-full ring-2 ring-card" style={{ backgroundColor: c }} />
              ))}
            </span>
            <div>
              <p className="font-display text-[17px] text-ink">Want colors that love you back?</p>
              <p className="text-xs text-ink-soft">One selfie → your color season. We analyze, then delete it.</p>
            </div>
          </div>
          <Link href="/color-analysis" className="mt-3 inline-flex min-h-10 items-center rounded-full border border-ink/25 px-5 text-sm font-medium text-ink hover:border-ink/50">
            Find my colors
          </Link>
        </div>
      )}

      {/* results */}
      <div className="mt-4">
        {loading || profileLoading ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 lg:grid-cols-3 xl:grid-cols-4" data-testid="feed-loading">
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : error ? (
          <ErrorState title="Your rack got stuck">
            We couldn’t load dresses just now.
            <div className="mt-3">
              <Button onClick={() => load(false)}>Try again</Button>
            </div>
          </ErrorState>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing matches — yet"
            action={
              <Button variant="outline" onClick={() => apply({ q: '', lex: [], sizes: [], pmin: null, pmax: null, lens: [], colors: [], brands: [], sources: [], cond: null })}>
                Clear filters
              </Button>
            }
          >
            Try widening the price range or clearing a filter — new listings land daily.
          </EmptyState>
        ) : (
          <>
            <ListingGrid items={items} context="feed" />
            <div ref={sentinelRef} className="flex justify-center py-8">
              {loadingMore ? (
                <Spinner label="Loading more dresses" />
              ) : cursor == null ? (
                <p className="text-xs text-ink-faint">
                  That’s all {total} — check back tomorrow for fresh listings.
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        state={state}
        meta={meta}
        onApply={(next) => {
          setFiltersOpen(false);
          for (const kind of changedFilterKinds(state, next)) {
            track({ type: 'filter_applied', props: { kind } });
          }
          apply(next);
        }}
      />
    </main>
  );
}

/* ── filter sheet (B3) ───────────────────────────────────────────────────── */

function FilterSheet({
  open,
  onClose,
  state,
  meta,
  onApply,
}: {
  open: boolean;
  onClose: () => void;
  state: FeedState;
  meta: MetaFiltersResponse | null;
  onApply: (s: FeedState) => void;
}) {
  const [draft, setDraft] = useState<FeedState>(state);
  useEffect(() => {
    if (open) setDraft(state);
  }, [open, state]);

  const priceMin = meta ? Math.floor(meta.priceRange[0] / 100 / 10) * 10 : 10;
  const priceMax = meta ? Math.ceil(meta.priceRange[1] / 100 / 10) * 10 : 480;

  const toggle = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={() => setDraft({ q: draft.q, lex: draft.lex, sizes: [], pmin: null, pmax: null, lens: [], colors: [], brands: [], sources: [], cond: null })}
          >
            Reset
          </Button>
          <Button full onClick={() => onApply(draft)} data-testid="apply-filters">
            Show dresses
          </Button>
        </div>
      }
    >
      <div className="space-y-6 pb-2">
        <FilterGroup label="Size (US)">
          {[0, 2, 4, 6, 8, 10, 12, 14, 16].map((n) => (
            <Chip key={n} selected={draft.sizes.includes(n)} onClick={() => setDraft({ ...draft, sizes: toggle(draft.sizes, n) })} className="min-w-12">
              {n}
            </Chip>
          ))}
        </FilterGroup>

        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-ink-soft uppercase">Price</p>
          <DualRange
            min={priceMin}
            max={priceMax}
            step={10}
            value={[draft.pmin ?? priceMin, draft.pmax ?? priceMax]}
            onChange={([lo, hi]) => setDraft({ ...draft, pmin: lo, pmax: hi })}
            format={(v) => `$${v}`}
            label="Price"
          />
        </div>

        <FilterGroup label="Length — on you, not the label">
          {HEM_OPTIONS.map((p) => (
            <Chip key={p} selected={draft.lens.includes(p)} onClick={() => setDraft({ ...draft, lens: toggle(draft.lens, p) })}>
              {hemShort(p)}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Color">
          {(meta?.colorFamilies ?? []).map((c) => (
            <Chip key={c} selected={draft.colors.includes(c)} onClick={() => setDraft({ ...draft, colors: toggle(draft.colors, c) })}>
              {c}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Brand">
          {(meta?.brands ?? []).map((b) => (
            <Chip key={b} selected={draft.brands.includes(b)} onClick={() => setDraft({ ...draft, brands: toggle(draft.brands, b) })}>
              {b}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Source">
          {(
            [
              ['resale', 'Resale (eBay)'],
              ['brand', 'Brand sites'],
            ] as const
          ).map(([v, label]) => (
            <Chip key={v} selected={draft.sources.includes(v)} onClick={() => setDraft({ ...draft, sources: toggle(draft.sources, v) })}>
              {label}
            </Chip>
          ))}
        </FilterGroup>

        <FilterGroup label="Condition">
          {(
            [
              ['new', 'New'],
              ['preowned', 'Pre-owned'],
            ] as const
          ).map(([v, label]) => (
            <Chip key={v} selected={draft.cond === v} onClick={() => setDraft({ ...draft, cond: draft.cond === v ? null : v })}>
              {label}
            </Chip>
          ))}
        </FilterGroup>
      </div>
    </Sheet>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-soft uppercase">{label}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

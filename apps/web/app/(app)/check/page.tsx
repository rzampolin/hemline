'use client';

/**
 * Paste-a-dress-link fit check (the flagship "Dupe.com hook", 2026-07-13).
 * Paste ANY dress product URL — from any store, in our racks or not — and get
 * HER hem verdict, a size note, and similar in-catalog alternatives. Handles
 * iOS share-sheet arrival via ?url= (prefill + auto-run). Mobile-first.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { FitCheckResponse } from '@hemline/contracts';
import {
  Button,
  ButtonLink,
  ConfidenceTag,
  EmptyState,
  HemIndicator,
  Spinner,
  formatPrice,
  hemDetailLine,
} from '@hemline/ui';
import { api } from '../../../lib/api';
import { track } from '../../../lib/analytics';
import { DEFAULT_HEIGHT_INCHES } from '../../../lib/hem';
import { useProfile } from '../../../lib/profile-store';
import { ListingGrid } from '../../components/grid';

type Phase = 'idle' | 'analyzing' | 'done' | 'error';

export default function CheckPage() {
  return (
    <Suspense fallback={null}>
      <FitCheck />
    </Suspense>
  );
}

function FitCheck() {
  const searchParams = useSearchParams();
  const { profile } = useProfile();
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<FitCheckResponse | null>(null);
  const autoRan = useRef(false);

  const run = async (pasted: string) => {
    const trimmed = pasted.trim();
    if (!trimmed) return;
    setPhase('analyzing');
    setResult(null);
    try {
      const res = await api.fitCheck(trimmed);
      setResult(res);
      setPhase('done');
      track({
        type: 'fit_check_submitted',
        props: { parsed: res.outcome === 'ok', inCatalog: res.inCatalog },
      });
    } catch {
      setPhase('error');
    }
  };

  // iOS share-sheet / deep-link arrival: ?url= prefills and auto-runs once.
  useEffect(() => {
    const shared = searchParams.get('url');
    if (shared && !autoRan.current) {
      autoRan.current = true;
      setUrl(shared);
      void run(shared);
    }
    // deliberately not depending on `run` — this effect fires once per arrival
  }, [searchParams]);

  return (
    <main className="px-4 pt-4">
      <h1 className="font-display text-2xl text-ink">Check any dress link</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Paste a product link from any store — we’ll read the page and tell you where that hem
        actually lands on you, plus close matches from our racks.
      </p>

      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(url);
        }}
      >
        <input
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://store.com/products/that-dress"
          aria-label="Dress product URL"
          data-testid="fit-check-url"
          className="h-12 flex-1 rounded-full border border-line bg-card px-4 text-sm placeholder:text-ink-faint focus:border-ink/40 focus:outline-none"
        />
        <Button type="submit" disabled={!url.trim() || phase === 'analyzing'}>
          Check
        </Button>
      </form>

      {phase === 'idle' && (
        <p className="mt-4 text-xs text-ink-faint">
          Works with Reformation, Shopify boutiques, resale listings — anywhere with a product
          page. We read it once; nothing gets stored.
        </p>
      )}

      {phase === 'analyzing' && (
        <div className="mt-10 flex flex-col items-center gap-4 text-center">
          <Spinner label="Reading that page" />
          <p className="font-display text-lg text-ink">Reading the listing…</p>
          <p className="max-w-xs text-xs text-ink-faint">
            Length, sizes, price — then your hem math and everything close in our racks.
          </p>
        </div>
      )}

      {phase === 'error' && (
        <EmptyState
          title="That didn’t take"
          action={<Button variant="outline" onClick={() => setPhase('idle')}>Try again</Button>}
        >
          Something went wrong on our side — the link is probably fine.
        </EmptyState>
      )}

      {phase === 'done' && result && <FitCheckResult result={result} heightInches={profile?.heightInches ?? null} hasProfileHeight={Boolean(profile?.heightInches)} onReset={() => { setPhase('idle'); setResult(null); setUrl(''); }} />}
    </main>
  );
}

function FitCheckResult({
  result,
  heightInches,
  hasProfileHeight,
  onReset,
}: {
  result: FitCheckResponse;
  heightInches: number | null;
  hasProfileHeight: boolean;
  onReset: () => void;
}) {
  const searchHref =
    result.keywords.length > 0 ? `/feed?q=${encodeURIComponent(result.keywords.join(' '))}` : '/feed';

  if (result.outcome !== 'ok' || !result.product) {
    const copy: Record<string, { title: string; body: string }> = {
      unreadable: {
        title: 'We couldn’t read that page',
        body: 'The store may be blocking robots, or the page has no product data we can parse. We’re honest about that — but we can search our racks for it instead.',
      },
      blocked_url: {
        title: 'That link won’t work',
        body: 'We can only check public https product pages — no local or private addresses.',
      },
      not_a_dress: {
        title: 'That doesn’t look like a dress',
        body: 'We read the page, but the product doesn’t parse as a dress — Soline only does dress math.',
      },
      child_audience: {
        title: 'That looks like a kids’ item',
        body: 'We read the page, but this looks like children’s clothing — Soline only carries and checks adult dresses.',
      },
    };
    const c = copy[result.outcome] ?? copy.unreadable;
    return (
      <div className="mt-8" data-testid="fit-check-miss">
        <EmptyState
          title={c.title}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {(result.outcome === 'unreadable' || result.outcome === 'blocked_url') &&
                result.keywords.length > 0 && (
                  <ButtonLink href={searchHref} variant="accent">
                    Search “{result.keywords.slice(0, 3).join(' ')}” in our racks
                  </ButtonLink>
                )}
              <Button variant="outline" onClick={onReset}>
                Try another link
              </Button>
            </div>
          }
        >
          {c.body}
        </EmptyState>
      </div>
    );
  }

  const p = result.product;
  const inStock = p.sizeLabels.filter((s) => p.availability[s] !== false);
  const sizeNote: Record<FitCheckResponse['sizeMatch'], string | null> = {
    in_your_size: 'Listed in your size.',
    listed_sold_out: 'Your size is listed — but sold out right now.',
    not_listed: 'Heads up: your size isn’t among the listed sizes.',
    unknown: null,
  };

  return (
    <div className="mt-6" data-testid="fit-check-result">
      {/* the external dress */}
      <section className="overflow-hidden rounded-3xl border border-line bg-card">
        <div className="flex gap-4 p-4">
          {p.imageUrl && (
            // external image, shown from the source CDN — never rehosted
            <img
              src={p.imageUrl}
              alt={p.title}
              className="aspect-[3/4] w-28 shrink-0 rounded-2xl object-cover"
            />
          )}
          <div className="min-w-0">
            <p className="text-[10px] font-semibold tracking-wide text-ink-faint uppercase">
              from {p.domain}
            </p>
            <h2 className="mt-1 font-display text-lg leading-snug text-ink">{p.title}</h2>
            <div className="mt-1 flex items-baseline gap-2">
              {p.priceCents != null && (
                <span className="font-display text-lg text-ink">
                  {formatPrice(p.priceCents, p.currency ?? 'USD')}
                </span>
              )}
              {p.brand && <span className="truncate text-xs text-ink-soft">{p.brand}</span>}
            </div>
            {inStock.length > 0 && (
              <p className="mt-1 truncate text-xs text-ink-faint">
                Sizes: {inStock.slice(0, 8).join(' · ')}
              </p>
            )}
          </div>
        </div>

        {/* HER hem verdict */}
        <div className="border-t border-line/70 p-4" data-testid="fit-check-hem">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base text-ink">On your body</h3>
            {result.hem && <ConfidenceTag hem={result.hem} />}
          </div>
          {result.hem && hasProfileHeight ? (
            <>
              <p className="mt-1 text-sm text-ink-soft">
                {hemDetailLine(result.hem, result.lengthClass)}
                {result.hem.basis === 'length_class_prior' && ' — estimated from its length class.'}
                {result.hem.basis === 'measured_length' && result.lengthInches != null && (
                  <> — from the stated {result.lengthInches}″ length.</>
                )}
                {result.modelHeightInches != null && (
                  <>
                    {' '}
                    (Their model is {Math.floor(result.modelHeightInches / 12)}′
                    {Math.round(result.modelHeightInches % 12)}″ — you’re not their model.)
                  </>
                )}
              </p>
              <HemIndicator
                heightInches={heightInches ?? DEFAULT_HEIGHT_INCHES}
                hem={result.hem}
                className="mt-3"
              />
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Add your height and we’ll tell you exactly where this hem lands on you.{' '}
              <Link href="/onboarding" className="text-accent underline">
                Add your height
              </Link>
            </p>
          )}
          {sizeNote[result.sizeMatch] && (
            <p className="mt-2 text-xs text-ink-soft" data-testid="fit-check-size-note">
              {sizeNote[result.sizeMatch]}
            </p>
          )}
        </div>

        {/* honest provenance */}
        <p className="border-t border-line/70 bg-parchment/60 px-4 py-2.5 text-[11px] text-ink-faint">
          Read from {p.domain} — we don’t sell it, we just read the page.
          {result.inCatalog && ' (It’s also in our racks.)'}
          {result.cached && ' Checked recently — served from cache.'}
        </p>
      </section>

      {/* similar in-catalog */}
      {result.similar.length > 0 ? (
        <section className="mt-8" aria-label="Similar dresses in our racks">
          <h3 className="font-display text-lg text-ink">Similar, in your size, in our racks</h3>
          <p className="mt-0.5 text-xs text-ink-faint">
            {result.matchBasis === 'embedding'
              ? 'Matched visually against everything in stock.'
              : 'Matched on silhouette, length and color.'}
          </p>
          <div
            className="mt-3"
            // analytics: a tap anywhere into a result card counts as one click
            onClickCapture={(e) => {
              if ((e.target as HTMLElement).closest('a')) {
                track({ type: 'fit_check_result_clicked', props: {} });
              }
            }}
          >
            <ListingGrid items={result.similar} context="search" />
          </div>
        </section>
      ) : (
        <EmptyState title="Nothing close in our racks yet">
          New dresses land daily — save your profile and check back.
        </EmptyState>
      )}

      <div className="my-8 text-center">
        <Button variant="outline" onClick={onReset}>
          Check another link
        </Button>
      </div>
    </div>
  );
}

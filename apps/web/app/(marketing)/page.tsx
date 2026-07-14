/**
 * Landing (PRODUCT_SPEC §4.1): value prop, live proof strip of real cards with
 * effective-length lines, single CTA. No nav clutter, no signup.
 *
 * Marketing polish (2026-07-13): hero sharpened around the hem hook, stats
 * band (live catalog numbers — keep in sync with /about), icon'd how-it-works
 * strip, privacy one-liner → /about#privacy, shared footer. Every claim here
 * is verified against code/docs — see docs/decisions-marketing.md before
 * editing numbers or promises.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingFooter } from './footer';
import { LandingStrip } from './strip';

export const metadata: Metadata = {
  // title inherits the root default ('Soline — dresses that actually fit');
  // the root template would double the brand if set as a string here.
  description:
    'That maxi? It’s a midi on you. Soline re-measures 12,800+ dresses from eBay and 35 boutiques for your exact height — no account, no trackers.',
  openGraph: {
    title: 'Soline — dresses that actually fit',
    description:
      'That maxi? It’s a midi on you. 12,800+ dresses re-measured for your exact height.',
    url: '/',
  },
};

const STATS = [
  { value: '12,800+', label: 'dresses in stock' },
  { value: '35', label: 'boutiques & brands' },
  { value: 'Daily', label: 'catalog refresh' },
];

const STEPS = [
  {
    n: '01',
    title: 'Tell us your numbers',
    body: 'Height, usual size, and your size in two or three brands you already wear. That’s the whole quiz — 90 seconds, no account.',
    icon: (
      // measuring tape / ruler
      <path
        d="M4 14 14 4l6 6L10 20H4v-6Zm4-2 1.5 1.5M11 9l1.5 1.5M14 6l1.5 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    n: '02',
    title: 'Swipe a dozen dresses',
    body: 'Real, in-stock dresses in your size and budget. Ten swipes teach us your taste — no forms, no follow counts.',
    icon: (
      // card with a swipe arrow
      <path
        d="M6 4h8a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 14 17H6a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 6 4Zm12.5 6.5H22m0 0-2.5-2.5M22 10.5 19.5 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    n: '03',
    title: 'Shop with hem truth',
    body: 'Every card says where the hem lands on your body — measured from real garment measurements when sellers list them, honestly estimated when they don’t.',
    icon: (
      // hanging dress with a marked hemline
      <path
        d="M12 3v2m0 0c-3.5 3.5-7 5-7 8.5a7 7 0 0 0 14 0C19 10 15.5 8.5 12 5Zm-6.5 11h13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

export default function LandingPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-6 pt-10 pb-10 md:pt-16">
      <div className="flex items-baseline justify-between">
        <p className="font-display text-lg tracking-wide text-accent">Soline</p>
        <Link
          href="/about"
          className="text-sm text-ink-soft underline decoration-line underline-offset-4 transition-colors hover:text-ink"
        >
          How it works
        </Link>
      </div>

      <section className="mt-10 md:mt-16 md:grid md:grid-cols-2 md:items-center md:gap-16">
        <header className="max-w-xl">
          <h1 className="font-display text-[2.6rem] leading-[1.05] font-medium text-ink md:text-6xl">
            Dresses that actually fit&nbsp;
            <em className="text-accent not-italic underline decoration-accent/30 decoration-2 underline-offset-8">
              you
            </em>
            .
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-ink-soft">
            Length labels describe a fit model, not you. Soline re-measures every dress for your
            exact height — one feed across resale and the brands you love, with the hem truth on
            every card.
          </p>
          <blockquote className="mt-6 border-l-2 border-accent/40 pl-4 font-display text-xl text-ink italic">
            “That maxi? It’s a midi on you.”
          </blockquote>
          <div className="mt-8 flex flex-col items-start gap-3">
            <Link
              href="/onboarding"
              data-testid="cta-start"
              className="inline-flex min-h-13 items-center justify-center rounded-full bg-ink px-8 text-base font-medium text-cream transition-colors hover:bg-ink/90"
            >
              Find my dresses →
            </Link>
            <p className="text-xs text-ink-faint">90 seconds, no account, no email. Ever.</p>
          </div>
        </header>

        <div className="mt-12 md:mt-0">
          <LandingStrip />
        </div>
      </section>

      {/* stats band — numbers verified against the live catalog; update via decisions-marketing.md */}
      <section
        aria-label="Catalog stats"
        data-testid="stats-band"
        className="mt-16 border-y border-line py-6 md:mt-24"
      >
        <dl className="grid grid-cols-3 gap-4 text-center">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col">
              <dt className="order-last mt-1 text-[11px] tracking-widest text-ink-soft uppercase md:text-xs">
                {s.label}
              </dt>
              <dd className="font-display text-2xl text-ink md:text-4xl">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="how-it-works" className="mt-16 md:mt-24">
        <h2 className="font-display text-2xl text-ink md:text-3xl">How it works</h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-2xl border border-line bg-card p-5">
              <div className="flex items-center justify-between">
                <svg viewBox="0 0 24 24" className="size-7 text-accent" aria-hidden="true">
                  {s.icon}
                </svg>
                <span className="font-display text-sm text-ink-faint">{s.n}</span>
              </div>
              <h3 className="mt-3 font-display text-lg text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-ink-soft">
          Curious about the math?{' '}
          <Link
            href="/about#hem-math"
            className="text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
          >
            Here’s exactly how the hem line is computed.
          </Link>
        </p>
      </section>

      {/* privacy one-liner */}
      <section
        data-testid="privacy-line"
        className="mt-16 rounded-2xl border border-line bg-parchment/60 p-5 md:mt-24 md:p-6"
      >
        <p className="text-sm leading-relaxed text-ink">
          <span className="font-display text-base">Private by default.</span>{' '}
          <span className="text-ink-soft">
            No account, no email, no ad trackers. If you try color analysis, your selfie is
            analyzed in memory and immediately discarded — only the palette is kept.
          </span>{' '}
          <Link
            href="/about#privacy"
            className="text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-accent"
          >
            The full story →
          </Link>
        </p>
      </section>

      <MarketingFooter />
    </main>
  );
}

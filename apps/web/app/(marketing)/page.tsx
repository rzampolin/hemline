/**
 * Landing page placeholder — frontend-eng owns this (PRODUCT_SPEC §4.1:
 * value prop headline, live strip of real cards with effective-length lines,
 * single CTA "Find my dresses →", loads <2s on 4G).
 */
import { PlaceholderCard } from '@hemline/ui';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-rose-700">Hemline</p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight">
          Dresses that actually fit — your size, your height, your colors.
        </h1>
        <p className="text-stone-600">
          One feed across resale and your favorite brands, with honest hem predictions:
          we tell you where every dress ends <em>on you</em>.
        </p>
      </header>

      <div className="space-y-3">
        <PlaceholderCard title="“This midi hits mid-calf on you”">
          Placeholder product strip — frontend-eng: real cards with effective-length lines land
          here (PRODUCT_SPEC B2).
        </PlaceholderCard>
        <PlaceholderCard title="Scaffold status">
          Seeded demo data: 150 dresses across fixture:shopify + fixture:ebay. Run{' '}
          <code className="rounded bg-stone-100 px-1">npm run seed</code> if you haven&apos;t.
        </PlaceholderCard>
      </div>

      <a
        href="/onboarding"
        className="rounded-full bg-stone-900 px-6 py-3 text-center text-base font-semibold text-white"
      >
        Find my dresses →
      </a>
      <p className="text-center text-xs text-stone-400">
        No account needed. AI features run in demo mode without an ANTHROPIC_API_KEY.
      </p>
    </main>
  );
}

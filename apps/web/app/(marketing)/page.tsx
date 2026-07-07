/**
 * Landing (PRODUCT_SPEC §4.1): value prop, live proof strip of real cards with
 * effective-length lines, single CTA. No nav clutter, no signup.
 */
import Link from 'next/link';
import { LandingStrip } from './strip';

export default function LandingPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-6 pt-10 pb-16 md:pt-16">
      <p className="font-display text-lg tracking-wide text-accent">Hemline</p>

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
            Your size. Your height. Your colors. One feed across resale and the brands you love —
            with honest hem math for your exact height.
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
            <p className="text-xs text-ink-faint">
              90 seconds, no account, no email. Ever.
            </p>
          </div>
        </header>

        <div className="mt-12 md:mt-0">
          <LandingStrip />
        </div>
      </section>

      <section id="how-it-works" className="mt-20 md:mt-28">
        <h2 className="font-display text-2xl text-ink md:text-3xl">How it works</h2>
        <ol className="mt-6 grid gap-6 md:grid-cols-3">
          {[
            {
              n: '01',
              title: 'Tell us your numbers',
              body: 'Height, usual size, and your size in two or three brands you already wear. That’s the whole quiz.',
            },
            {
              n: '02',
              title: 'Swipe a dozen dresses',
              body: 'Real, in-stock dresses in your size and budget. Ten swipes teach us your taste.',
            },
            {
              n: '03',
              title: 'Shop with hem truth',
              body: 'Every card says where the hem lands on your body — measured from real garment measurements when sellers list them.',
            },
          ].map((s) => (
            <li key={s.n} className="rounded-2xl border border-line bg-card p-5">
              <span className="font-display text-sm text-accent">{s.n}</span>
              <h3 className="mt-2 font-display text-lg text-ink">{s.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mt-20 border-t border-line pt-6 text-xs text-ink-faint">
        <p>
          Hemline links you out to eBay and brand sites to buy — we never own checkout. Photos you
          upload for color analysis are analyzed, then deleted.
        </p>
      </footer>
    </main>
  );
}

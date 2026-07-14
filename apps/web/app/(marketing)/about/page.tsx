/**
 * /about — "How Soline works": the fit problem, the hem math in plain
 * language, optional color analysis, where the catalog comes from, and the
 * privacy promises. Every claim on this page is verified against code/docs
 * (see docs/decisions-marketing.md — claims table) — edit with the same care.
 * Static server component; anchors (#hem-math, #colors, #catalog, #privacy)
 * are linked from the landing page and footer.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { MarketingFooter } from '../footer';

export const metadata: Metadata = {
  title: 'How Soline works',
  description:
    'Where each hem actually falls on you, computed from garment measurements and your height. How the catalog is gathered, what happens to your selfie, and what we do and don’t record.',
  openGraph: {
    title: 'How Soline works',
    description:
      'The hem math in plain language, where 12,800+ dresses come from, and privacy promises we can keep.',
    url: '/about',
  },
};

function Section({
  id,
  kicker,
  title,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-14 scroll-mt-8 md:mt-20">
      <p className="text-xs font-medium tracking-widest text-accent uppercase">{kicker}</p>
      <h2 className="mt-2 font-display text-2xl text-ink md:text-3xl">{title}</h2>
      <div className="mt-4 max-w-2xl space-y-4 leading-relaxed text-ink-soft">{children}</div>
    </section>
  );
}

export default function AboutPage() {
  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-6 pt-10 pb-10 md:pt-16">
      <div className="flex items-baseline justify-between">
        <Link href="/" className="font-display text-lg tracking-wide text-accent">
          Soline
        </Link>
        <Link
          href="/onboarding"
          className="text-sm text-ink-soft underline decoration-line underline-offset-4 transition-colors hover:text-ink"
        >
          Find my dresses →
        </Link>
      </div>

      <header className="mt-10 md:mt-14">
        <h1 className="font-display text-4xl leading-[1.08] font-medium text-ink md:text-5xl">
          How Soline works
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-soft">
          Dresses are the worst-fitting thing you can buy online, and the length label is most of
          the reason. Here’s what we do differently — and exactly what happens to your data while
          we do it.
        </p>
      </header>

      <Section id="fit-problem" kicker="The problem" title="“Midi” is not a length">
        <p>
          A dress label describes a fit model, not you. The same “midi” tag gets sewn onto a 39″
          dress and a 47″ one — roughly eight inches apart, nearly a full hand-span of leg. On a
          5′2″ frame the long end of that range is an ankle-grazing maxi; on a 5′10″ frame the
          short end barely clears the knee. Both say midi.
        </p>
        <p>
          That’s why dresses get returned more than anything else you buy online: the one
          measurement that decides whether a dress works — where the hem actually lands on your
          body — isn’t on the tag. So we compute it.
        </p>
      </Section>

      <Section id="hem-math" kicker="The moat" title="The hem math, in plain language">
        <p>
          Two numbers decide where a hem falls: how long the garment is, and how tall you are.
          Sellers often list the garment length — shoulder to hem, in inches. From your height we
          know your shoulder-to-floor distance (it’s a remarkably consistent fraction of height,
          about 82%). Subtract one from the other and you know where the hem lands: knee,
          mid-calf, ankle — on <em className="not-italic text-ink">you</em>, not on a size-8 fit
          model.
        </p>
        <p>
          We’re honest about how we know. When a listing includes real garment measurements, the
          hem line is tagged <span className="text-ink">“Measured.”</span> When it doesn’t, we
          estimate from the stated length class and typical garment lengths, and tag it{' '}
          <span className="text-ink">“Estimated.”</span> When we can’t tell at all, the card says{' '}
          <span className="text-ink">“Length unverified”</span> — never a guess dressed up as a
          fact. Today about 92% of the catalog carries a hem line.
        </p>
        <p>
          You’ll see it everywhere: on every card in your feed (“Hits mid-calf on you”), and on
          every detail page with a body diagram and the measured/estimated tag.
        </p>
      </Section>

      <Section id="colors" kicker="Optional" title="Colors, if you want them">
        <p>
          After your first feed, you can optionally get a color-season analysis — the palette that
          flatters your skin, hair, and eye contrast. Upload a selfie and it’s analyzed{' '}
          <span className="text-ink">in memory and immediately discarded</span>: never written to
          disk, never stored, never used for anything else. Only the result — a season and its
          palette — is saved, and you can edit or delete it in settings.
        </p>
        <p>
          Prefer not to share a photo at all? There’s a short quiz that gets you a season with no
          camera involved. Either way, your palette is a gentle ranking boost with a visible,
          removable chip — it never hides dresses from you.
        </p>
      </Section>

      <Section id="catalog" kicker="The catalog" title="Where the dresses come from">
        <p>
          Soline reads public listings — the same pages you could open yourself — from eBay and
          about 35 boutique and brand sites, over 12,800 in-stock dresses at last count. Brand
          catalogs are re-crawled daily and eBay every few hours, and a dress that stops appearing
          in a seller’s listings gets flagged as possibly sold and pulled from your feed, so
          you’re not falling for something that’s already gone.
        </p>
        <p>
          We never sell you anything. Every dress links out to the seller — eBay or the brand’s
          own site — and checkout happens entirely with them. Some of those links are affiliate
          links, which means the seller may pay us a small commission if you buy; the price you
          pay is exactly the same either way.
        </p>
      </Section>

      <Section id="privacy" kicker="Privacy" title="Privacy, plainly">
        <p>Promises we can actually keep, because of how the thing is built:</p>
        <ul className="list-none space-y-3">
          {[
            {
              head: 'No account, no email, no name.',
              body: 'Your profile is a random ID your browser holds. There is no signup, no password, no login wall anywhere — we couldn’t attach your quiz answers to your identity because we never learn it.',
            },
            {
              head: 'Your selfie is discarded, immediately.',
              body: 'Color-analysis photos are processed in memory and never written to disk or stored anywhere. Only the resulting season and palette are kept, and you can delete those in settings.',
            },
            {
              head: 'No ad trackers, no third-party analytics.',
              body: 'No Google Analytics, no Meta pixel, no Segment — nothing on the page phones home to anyone but us. The measurement we do (which quiz steps people finish, what gets searched) is first-party and stays on our own server.',
            },
            {
              head: 'What we do record, honestly.',
              body: 'Quiz answers, swipes, saves, and searches, tied to that anonymous ID — that’s what builds your feed, and zero-result searches tell us which dresses to go find. No IP addresses, no device fingerprints, no page-by-page browsing trails.',
            },
            {
              head: 'Nothing about you is hidden from you.',
              body: 'Everything Soline knows — height, sizes, budget, palette, taste — fits on one settings screen, and you can view, change, or clear any of it there whenever you like.',
            },
          ].map((item) => (
            <li key={item.head} className="rounded-2xl border border-line bg-card p-4">
              <span className="font-display text-ink">{item.head}</span>{' '}
              <span className="text-sm">{item.body}</span>
            </li>
          ))}
        </ul>
      </Section>

      <section className="mt-16 rounded-2xl bg-parchment p-6 text-center md:p-8">
        <p className="font-display text-xl text-ink md:text-2xl">
          Ninety seconds from here to a feed that knows your hem.
        </p>
        <Link
          href="/onboarding"
          className="mt-5 inline-flex min-h-13 items-center justify-center rounded-full bg-ink px-8 text-base font-medium text-cream transition-colors hover:bg-ink/90"
        >
          Find my dresses →
        </Link>
      </section>

      <MarketingFooter />
    </main>
  );
}

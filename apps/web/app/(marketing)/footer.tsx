/**
 * Marketing footer — shared by the landing page and /about. Keeps the honest
 * one-liner (we link out, photos deleted) and links the full story. Server
 * component; no state, no fetches.
 */
import Link from 'next/link';

export function MarketingFooter() {
  return (
    <footer className="mt-20 border-t border-line pt-6 pb-2 text-xs text-ink-faint">
      <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
        <Link href="/about" className="transition-colors hover:text-ink">
          How Hemline works
        </Link>
        <Link href="/about#privacy" className="transition-colors hover:text-ink">
          Privacy, plainly
        </Link>
        <Link href="/about#catalog" className="transition-colors hover:text-ink">
          Where dresses come from
        </Link>
        <Link href="/onboarding" className="transition-colors hover:text-ink">
          Find my dresses
        </Link>
      </nav>
      <p className="mt-4 max-w-xl leading-relaxed">
        Hemline links you out to eBay and brand sites to buy — we never own checkout. Photos you
        upload for color analysis are analyzed in memory, then discarded.
      </p>
    </footer>
  );
}

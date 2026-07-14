'use client';

/**
 * Shared color-analysis result UI (PRODUCT_SPEC D1 §4.6 ④–⑤):
 * season + palette card, "Does this look right?" confirm/adjust, then the
 * shareable palette card with canvas download and a CTA back to the feed.
 */
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import type { ColorAnalysisResult, ColorSeason } from '@hemline/contracts';
import { Button, Sheet, Swatch } from '@hemline/ui';
import { useProfile } from '../../lib/profile-store';
import { SEASONS, SEASON_LIST } from '../../lib/seasons';

export function ResultView({ result, onRetake, retakeLabel }: { result: ColorAnalysisResult; onRetake: () => void; retakeLabel: string }) {
  const { setSeason } = useProfile();
  const [season, setSeasonLocal] = useState<ColorSeason>(result.season);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const info = SEASONS[season];
  const palette = season === result.season ? result.palette : info.palette;
  const avoid = season === result.season ? result.avoid : info.avoid;

  const confirm = useCallback(async () => {
    setSaving(true);
    try {
      await setSeason(season);
      setConfirmed(true);
      // render the shareable card
      requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const W = 1080;
        const H = 1350;
        canvas.width = W;
        canvas.height = H;
        ctx.fillStyle = '#faf6ef';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#8a3033';
        ctx.font = 'italic 44px Georgia, serif';
        ctx.textAlign = 'center';
        ctx.fillText('Soline', W / 2, 110);
        ctx.fillStyle = '#221d18';
        ctx.font = '500 92px Georgia, serif';
        ctx.fillText(info.label, W / 2, 240);
        ctx.fillStyle = '#6f6659';
        ctx.font = '36px Georgia, serif';
        ctx.fillText(info.tagline, W / 2, 305);
        // swatch grid 5 x 2
        const cols = 5;
        const size = 150;
        const gap = 34;
        const startX = (W - (cols * size + (cols - 1) * gap)) / 2 + size / 2;
        palette.slice(0, 10).forEach((c, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          const x = startX + col * (size + gap);
          const y = 470 + row * (size + gap + 40);
          ctx.beginPath();
          ctx.arc(x, y, size / 2, 0, Math.PI * 2);
          ctx.fillStyle = c.hex;
          ctx.fill();
          ctx.strokeStyle = 'rgba(34,29,24,0.12)';
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = '#6f6659';
          ctx.font = '26px Georgia, serif';
          ctx.fillText(c.name, x, y + size / 2 + 42);
        });
        ctx.fillStyle = '#a39987';
        ctx.font = '30px Georgia, serif';
        ctx.fillText('my colors, by hemline — dresses that actually fit', W / 2, H - 90);
        setDownloadUrl(canvas.toDataURL('image/png'));
      });
    } finally {
      setSaving(false);
    }
  }, [season, setSeason, info, palette]);

  if (confirmed) {
    return (
      <div className="flex flex-col items-center px-6 pb-10 text-center animate-rise">
        <p className="mt-2 text-xs font-semibold tracking-widest text-accent uppercase">Saved to your profile</p>
        <div className="mt-4 w-full max-w-sm rounded-3xl border border-line bg-card p-6 shadow-lift">
          <p className="font-display text-lg text-accent italic">Soline</p>
          <h2 className="mt-1 font-display text-3xl text-ink">{info.label}</h2>
          <p className="mt-1 text-sm text-ink-soft">{info.tagline}</p>
          <div className="mt-5 grid grid-cols-5 gap-3">
            {palette.slice(0, 10).map((c) => (
              <Swatch key={c.hex} hex={c.hex} name={c.name} size="lg" className="w-full" />
            ))}
          </div>
          <p className="mt-4 text-[11px] text-ink-faint">my colors, by hemline</p>
        </div>
        <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
        <div className="mt-6 flex w-full max-w-sm flex-col gap-2">
          {downloadUrl && (
            <a
              href={downloadUrl}
              download={`hemline-${season}.png`}
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-ink/25 px-5 text-sm font-medium text-ink hover:border-ink/50"
            >
              Download my palette card
            </a>
          )}
          <Link
            href="/feed"
            data-testid="palette-to-feed"
            className="inline-flex min-h-13 items-center justify-center rounded-full bg-accent px-6 text-base font-medium text-cream hover:bg-accent-deep"
          >
            See dresses in your palette →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 pb-10 animate-rise">
      <p className="text-xs font-semibold tracking-widest text-accent uppercase">Your season</p>
      <h2 className="mt-1 font-display text-4xl text-ink" data-testid="season-name">
        {info.label}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">{info.tagline}</p>

      <p className="mt-4 text-sm leading-relaxed text-ink-soft">{result.explanation}</p>
      {result.caveat && (
        <p className="mt-3 rounded-2xl bg-accent-soft px-4 py-3 text-sm text-accent-deep">
          {result.caveat}{' '}
          <Link href="/color-analysis/quiz" className="underline">
            Take the quiz
          </Link>
        </p>
      )}

      <h3 className="mt-6 text-xs font-semibold tracking-wide text-ink-soft uppercase">Wear more of</h3>
      <div className="mt-2 flex flex-wrap gap-2.5">
        {palette.map((c) => (
          <Swatch key={c.hex} hex={c.hex} name={c.name} />
        ))}
      </div>

      <h3 className="mt-5 text-xs font-semibold tracking-wide text-ink-soft uppercase">De-prioritize</h3>
      <div className="mt-2 flex flex-wrap gap-2.5 opacity-70">
        {avoid.map((c) => (
          <Swatch key={c.hex} hex={c.hex} name={c.name} size="sm" />
        ))}
      </div>

      <div className="mt-8">
        <p className="font-display text-lg text-ink">Does this look right?</p>
        <p className="mt-1 text-xs text-ink-faint">
          Confidence {Math.round(result.confidence * 100)}% — you know your mirror best.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <Button variant="accent" size="lg" full onClick={confirm} disabled={saving} data-testid="confirm-season">
            {saving ? 'Saving…' : 'Yes — save my colors'}
          </Button>
          <Button variant="outline" full onClick={() => setAdjustOpen(true)}>
            Adjust my season
          </Button>
          <Button variant="ghost" full onClick={onRetake}>
            {retakeLabel}
          </Button>
        </div>
      </div>

      <Sheet open={adjustOpen} onClose={() => setAdjustOpen(false)} title="Adjust your season">
        <ul className="grid gap-2 pb-2">
          {SEASON_LIST.map((s) => (
            <li key={s.season}>
              <button
                type="button"
                aria-pressed={season === s.season}
                onClick={() => {
                  setSeasonLocal(s.season);
                  setAdjustOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3 text-left ${
                  season === s.season ? 'border-ink bg-card' : 'border-line bg-card/60'
                }`}
              >
                <div>
                  <span className="font-display text-[15px] text-ink">{s.label}</span>
                  <span className="block text-xs text-ink-faint">{s.tagline}</span>
                </div>
                <span className="flex -space-x-1" aria-hidden="true">
                  {s.palette.slice(0, 5).map((c) => (
                    <span key={c.hex} className="size-5 rounded-full ring-2 ring-card" style={{ backgroundColor: c.hex }} />
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}

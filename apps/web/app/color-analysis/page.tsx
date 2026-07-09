'use client';

/**
 * Color analysis moment (PRODUCT_SPEC D1, §4.6): explainer + privacy note →
 * camera/upload with capture guidance → analyzing → result (confirm/adjust)
 * → shareable card. Optional, post-first-value, never mandatory.
 */
import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColorAnalysisResult } from '@hemline/contracts';
import { Button, ErrorState, Spinner } from '@hemline/ui';
import { api } from '../../lib/api';
import { track } from '../../lib/analytics';
import { ResultView } from './result-view';

type Phase = 'intro' | 'analyzing' | 'result' | 'error';

export default function ColorAnalysisPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('intro');
  const [result, setResult] = useState<ColorAnalysisResult | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const analyze = async (file: File) => {
    setPreview(URL.createObjectURL(file));
    setPhase('analyzing');
    track({ type: 'color_analysis_started', props: { method: 'selfie' } });
    try {
      const res = await api.colorAnalysis(file);
      setResult(res);
      setPhase('result');
      track({ type: 'color_analysis_completed', props: { method: 'selfie' } });
    } catch {
      setPhase('error');
    }
  };

  return (
    <main className="mx-auto min-h-dvh max-w-md">
      <div className="flex items-center px-3 py-2">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Back"
          className="flex size-10 items-center justify-center rounded-full text-ink-soft hover:bg-ink/5"
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M10 2 4 8l6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="font-display text-lg text-ink">My colors</span>
      </div>

      {phase === 'intro' && (
        <div className="px-6 pb-10 animate-rise">
          <div className="mx-auto mt-4 flex w-fit -space-x-2" aria-hidden="true">
            {['#8A9A5B', '#B5651D', '#C4A484', '#9C8AA5', '#5B7F95'].map((c) => (
              <span key={c} className="size-10 rounded-full ring-4 ring-cream" style={{ backgroundColor: c }} />
            ))}
          </div>
          <h1 className="mt-6 text-center font-display text-3xl leading-tight text-ink">
            Find the colors that love you back
          </h1>
          <p className="mt-3 text-center text-sm leading-relaxed text-ink-soft">
            One selfie. We read your skin’s undertone, hair and eye contrast, and place you in one of
            twelve color seasons — then quietly boost dresses in your palette.
          </p>

          <ul className="mt-8 space-y-3 rounded-3xl border border-line bg-card p-5 text-sm text-ink-soft">
            <li className="flex gap-3">
              <span aria-hidden="true">☀️</span> Natural light, facing a window — no lamps behind you.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true">🧼</span> Bare face works best; pull hair off your face.
            </li>
            <li className="flex gap-3">
              <span aria-hidden="true">📷</span> Fill the frame with your face and shoulders.
            </li>
          </ul>

          <p className="mt-4 text-center text-xs text-ink-faint">
            Your photo is analyzed, then deleted. Only the palette is saved.
          </p>

          <input
            ref={fileInput}
            id="selfie-input"
            type="file"
            accept="image/*"
            capture="user"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void analyze(f);
            }}
          />
          <div className="mt-6 flex flex-col gap-2">
            <Button size="lg" variant="accent" full onClick={() => fileInput.current?.click()}>
              Take or upload a selfie
            </Button>
            <Link
              href="/color-analysis/quiz"
              data-testid="quiz-fallback"
              className="inline-flex min-h-11 items-center justify-center rounded-full text-sm font-medium text-ink-soft hover:text-ink"
            >
              No camera handy? Take the 60-second quiz
            </Link>
          </div>
        </div>
      )}

      {phase === 'analyzing' && (
        <div className="flex flex-col items-center gap-4 px-6 pt-16 text-center">
          {preview && (
            <div className="relative">
              <img src={preview} alt="Your selfie" className="size-40 rounded-full object-cover shadow-lift" />
              <span className="absolute inset-0 animate-pulse rounded-full ring-4 ring-accent/40" aria-hidden="true" />
            </div>
          )}
          <Spinner label="Analyzing your coloring" />
          <p className="font-display text-xl text-ink">Reading your undertones…</p>
          <p className="max-w-xs text-xs text-ink-faint">
            Skin warmth, hair depth, eye contrast → your season. The photo is deleted right after.
          </p>
        </div>
      )}

      {phase === 'result' && result && (
        <ResultView
          result={result}
          onRetake={() => {
            setResult(null);
            setPhase('intro');
          }}
          retakeLabel="Retake the photo"
        />
      )}

      {phase === 'error' && (
        <ErrorState title="That photo didn’t work">
          Try again in brighter light, or take the quiz instead.
          <div className="mt-3 flex flex-col gap-2">
            <Button onClick={() => setPhase('intro')}>Try again</Button>
            <Link href="/color-analysis/quiz" className="text-sm text-accent underline">
              Take the quiz
            </Link>
          </div>
        </ErrorState>
      )}
    </main>
  );
}

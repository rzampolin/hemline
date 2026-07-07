'use client';

/**
 * "Find dresses like this" (PRODUCT_SPEC B4): standing photo/URL upload
 * reachable from the feed camera icon. Photo → attribute match → card grid.
 * Uploads are analyzed, never stored.
 */
import { useRef, useState } from 'react';
import { Button, EmptyState, ErrorState, Spinner } from '@hemline/ui';
import { api, type SimilarSearchResult } from '../../../lib/api';
import { ListingGrid } from '../../components/grid';

type Phase = 'idle' | 'analyzing' | 'done' | 'error';

export default function SimilarPage() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<SimilarSearchResult | null>(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async (input: { file?: File; fileName?: string; url?: string }) => {
    setPhase('analyzing');
    try {
      const res = await api.similarSearch(input);
      setResult(res);
      setPhase('done');
    } catch {
      setPhase('error');
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setPreview(URL.createObjectURL(f));
    // live mode uploads the bytes (analyzed then discarded); mock keys off the name
    void run({ file: f, fileName: f.name });
  };

  return (
    <main className="px-4 pt-4">
      <h1 className="font-display text-2xl text-ink">Find dresses like this</h1>
      <p className="mt-1 text-sm text-ink-soft">
        A screenshot, a street photo, a product link — we’ll match the silhouette, length and color
        against everything in stock.
      </p>

      {phase === 'idle' || phase === 'error' ? (
        <div className="mt-6 space-y-4">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="sr-only"
            id="similar-file"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <label
            htmlFor="similar-file"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-3xl border-2 border-dashed border-line bg-card/60 px-6 py-12 text-center hover:border-ink/40"
          >
            <svg viewBox="0 0 24 24" className="size-8 text-ink-faint" aria-hidden="true">
              <path d="M4 8a2 2 0 0 1 2-2h1.5L9 4h6l1.5 2H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <circle cx="12" cy="12" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span className="font-display text-lg text-ink">Upload a dress photo</span>
            <span className="text-xs text-ink-faint">Analyzed then discarded — never stored.</span>
          </label>

          <div className="flex items-center gap-3 text-xs text-ink-faint">
            <span className="h-px flex-1 bg-line" /> or paste a link <span className="h-px flex-1 bg-line" />
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) void run({ url: url.trim() });
            }}
          >
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
              aria-label="Dress URL"
              className="h-12 flex-1 rounded-full border border-line bg-card px-4 text-sm placeholder:text-ink-faint focus:border-ink/40 focus:outline-none"
            />
            <Button type="submit" disabled={!url.trim()}>
              Match
            </Button>
          </form>

          {phase === 'error' && (
            <ErrorState title="That didn’t take">We couldn’t analyze that — try another photo or link.</ErrorState>
          )}
        </div>
      ) : phase === 'analyzing' ? (
        <div className="mt-10 flex flex-col items-center gap-4 text-center">
          {preview && (
            <img src={preview} alt="Your upload" className="size-32 rounded-2xl object-cover shadow-card" />
          )}
          <Spinner label="Analyzing your photo" />
          <p className="font-display text-lg text-ink">Reading the silhouette…</p>
          <p className="max-w-xs text-xs text-ink-faint">
            Length, neckline, color, pattern — then we search every in-stock dress.
          </p>
        </div>
      ) : result && result.results.items.length > 0 ? (
        <div className="mt-6">
          <p className="text-sm text-ink-soft">
            We saw <span className="font-medium text-ink">{result.inferred.descriptor}</span> —{' '}
            {result.results.totalMatched} close matches, nearest first.
          </p>
          <div className="mt-4">
            <ListingGrid items={result.results.items} context="search" />
          </div>
          <div className="my-6 text-center">
            <Button variant="outline" onClick={() => { setPhase('idle'); setResult(null); setPreview(null); setUrl(''); }}>
              Try another photo
            </Button>
          </div>
        </div>
      ) : (
        <EmptyState
          title="No close matches"
          action={<Button variant="outline" onClick={() => setPhase('idle')}>Try another photo</Button>}
        >
          Nothing in stock is close enough right now — new listings land daily.
        </EmptyState>
      )}
    </main>
  );
}

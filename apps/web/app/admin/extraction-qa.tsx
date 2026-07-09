'use client';

/**
 * Extraction QA panel — low-confidence extraction list (GET
 * /api/admin/extractions) with inline corrections (existing PATCH
 * /api/admin/extractions/:contentHash). Paginated; thumbnail + title + the
 * attributes that matter for matching (length, colors, silhouette).
 */
import { useCallback, useEffect, useState } from 'react';
import type { ExtractionQaRow } from '@hemline/db';
import { LengthClassSchema, SilhouetteSchema } from '@hemline/contracts';
import { Button, cn, Spinner } from '@hemline/ui';
import { apiGet, apiPatch, fmtInt } from './lib';
import { Panel } from './dashboard';

const PAGE_SIZE = 20;
const CONFIDENCE_CHOICES = [0.4, 0.6, 0.8, 1] as const;

interface QaPage {
  items: ExtractionQaRow[];
  total: number;
}

export function ExtractionQaPanel() {
  const [maxConfidence, setMaxConfidence] = useState<number>(0.6);
  const [missingLength, setMissingLength] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<QaPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openHash, setOpenHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        maxConfidence: String(maxConfidence),
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      if (missingLength) params.set('missingLength', 'true');
      setPage(await apiGet<QaPage>(`/api/admin/extractions?${params}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [maxConfidence, missingLength, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCorrected = (updated: ExtractionQaRow) => {
    setPage((p) =>
      p
        ? { ...p, items: p.items.map((r) => (r.contentHash === updated.contentHash ? updated : r)) }
        : p,
    );
    setOpenHash(null);
  };

  const from = page && page.total > 0 ? offset + 1 : 0;
  const to = page ? Math.min(offset + PAGE_SIZE, page.total) : 0;

  return (
    <Panel
      title="Extraction QA"
      subtitle="Low-confidence extractions — click a row to correct; corrections are stamped model=manual and logged"
      actions={
        <div className="flex items-center gap-3 text-sm">
          {loading && <Spinner className="[&_svg]:size-4" label="Loading extractions" />}
          <label className="flex items-center gap-1.5 text-ink-soft">
            confidence ≤
            <select
              value={maxConfidence}
              onChange={(e) => {
                setOffset(0);
                setMaxConfidence(Number(e.target.value));
              }}
              className="rounded-lg border border-line bg-card px-2 py-1 text-sm"
            >
              {CONFIDENCE_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-ink-soft">
            <input
              type="checkbox"
              checked={missingLength}
              onChange={(e) => {
                setOffset(0);
                setMissingLength(e.target.checked);
              }}
              className="accent-accent"
            />
            missing length
          </label>
        </div>
      }
    >
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-deep">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-line">
              {['Listing', 'Length', 'Colors', 'Silhouette', 'Model', 'Confidence'].map((h) => (
                <th
                  key={h}
                  className="px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-ink-faint uppercase"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.items.map((row) => (
              <QaRow
                key={row.contentHash}
                row={row}
                open={openHash === row.contentHash}
                onToggle={() => setOpenHash(openHash === row.contentHash ? null : row.contentHash)}
                onCorrected={onCorrected}
              />
            ))}
            {page && page.items.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-sm text-ink-faint" colSpan={6}>
                  Nothing needs review at this threshold.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-center justify-between text-sm text-ink-soft">
        <span>
          {page ? `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(page.total)}` : '…'}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!page || offset + PAGE_SIZE >= page.total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ColorDots({ colors }: { colors: unknown[] }) {
  const tags = colors.filter(
    (c): c is { name: string; hex: string | null } =>
      !!c && typeof c === 'object' && 'name' in c,
  );
  if (tags.length === 0) return <span className="text-ink-faint">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {tags.slice(0, 4).map((c, i) => (
        <span key={i} className="flex items-center gap-1 text-xs text-ink-soft">
          <span
            className="inline-block size-3 rounded-full ring-1 ring-line"
            style={{ background: c.hex ?? 'transparent' }}
            aria-hidden="true"
          />
          {c.name}
        </span>
      ))}
      {tags.length > 4 && <span className="text-xs text-ink-faint">+{tags.length - 4}</span>}
    </span>
  );
}

function QaRow({
  row,
  open,
  onToggle,
  onCorrected,
}: {
  row: ExtractionQaRow;
  open: boolean;
  onToggle: () => void;
  onCorrected: (r: ExtractionQaRow) => void;
}) {
  const td = 'px-2 py-2 align-middle text-sm text-ink';
  return (
    <>
      <tr
        className={cn('cursor-pointer border-b border-line/60 hover:bg-parchment/60', open && 'bg-parchment/60')}
        onClick={onToggle}
      >
        <td className={td}>
          <div className="flex items-center gap-2.5">
            {row.imageUrl ? (
              /* plain <img>: remote admin thumbnails, next/image optimization
                 pointless for an internal tool with arbitrary remote hosts */
              <img
                src={row.imageUrl}
                alt=""
                loading="lazy"
                className="size-12 shrink-0 rounded-lg bg-parchment object-cover"
              />
            ) : (
              <span className="size-12 shrink-0 rounded-lg bg-parchment" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <div className="max-w-72 truncate font-medium" title={row.listingTitle}>
                {row.listingTitle}
              </div>
              <div className="text-[11px] text-ink-faint">{row.sourceId}</div>
            </div>
          </div>
        </td>
        <td className={cn(td, 'whitespace-nowrap')}>
          {row.lengthClass ?? <span className="text-ink-faint">—</span>}
          {row.lengthInches != null && (
            <span className="text-ink-soft"> · {row.lengthInches}&Prime;</span>
          )}
        </td>
        <td className={td}>
          <ColorDots colors={row.colors} />
        </td>
        <td className={td}>{row.silhouette ?? <span className="text-ink-faint">—</span>}</td>
        <td className={cn(td, 'text-xs text-ink-soft')}>{row.model}</td>
        <td className={cn(td, 'tabular-nums')}>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-semibold',
              row.confidence < 0.4 ? 'bg-accent-soft text-accent-deep' : 'bg-parchment text-ink-soft',
            )}
          >
            {row.confidence.toFixed(2)}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line/60 bg-parchment/40">
          <td colSpan={6} className="px-2 py-3">
            <CorrectionForm row={row} onCorrected={onCorrected} />
          </td>
        </tr>
      )}
    </>
  );
}

const UNSET = '';

function CorrectionForm({
  row,
  onCorrected,
}: {
  row: ExtractionQaRow;
  onCorrected: (r: ExtractionQaRow) => void;
}) {
  const [lengthClass, setLengthClass] = useState(row.lengthClass ?? UNSET);
  const [lengthInches, setLengthInches] = useState(row.lengthInches?.toString() ?? '');
  const [silhouette, setSilhouette] = useState(row.silhouette ?? UNSET);
  const [fabric, setFabric] = useState(row.fabric ?? '');
  const [neckline, setNeckline] = useState(row.neckline ?? '');
  const [confidence, setConfidence] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    // send only changed fields; null clears a value
    const patch: Record<string, unknown> = {};
    const norm = (v: string) => (v === UNSET ? null : v);
    if (norm(lengthClass) !== row.lengthClass) patch.lengthClass = norm(lengthClass);
    const inches = lengthInches.trim() === '' ? null : Number(lengthInches);
    if (inches !== row.lengthInches) {
      if (inches != null && (!Number.isFinite(inches) || inches <= 0 || inches > 90)) {
        setError('length inches must be between 0 and 90');
        return;
      }
      patch.lengthInches = inches;
    }
    if (norm(silhouette) !== row.silhouette) patch.silhouette = norm(silhouette);
    if ((fabric.trim() || null) !== row.fabric) patch.fabric = fabric.trim() || null;
    if ((neckline.trim() || null) !== row.neckline) patch.neckline = neckline.trim() || null;
    const conf = Number(confidence);
    if (Number.isFinite(conf) && conf !== row.confidence) patch.confidence = Math.min(1, Math.max(0, conf));
    if (Object.keys(patch).length === 0) {
      setError('nothing changed');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await apiPatch<ExtractionQaRow>(
        `/api/admin/extractions/${encodeURIComponent(row.contentHash)}`,
        patch,
      );
      onCorrected(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const field = 'rounded-lg border border-line bg-card px-2 py-1 text-sm';
  const label = 'flex flex-col gap-1 text-xs font-medium text-ink-soft';

  return (
    <div className="space-y-3">
      {row.rawDescription && (
        <p className="max-w-3xl text-xs text-ink-soft" title={row.rawDescription}>
          <span className="font-semibold text-ink-faint uppercase">Raw text: </span>
          {row.rawDescription.slice(0, 280)}
          {row.rawDescription.length > 280 && '…'}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className={label}>
          length class
          <select value={lengthClass} onChange={(e) => setLengthClass(e.target.value)} className={field}>
            <option value={UNSET}>— none —</option>
            {LengthClassSchema.options.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          length (in)
          <input
            type="number"
            step="0.5"
            min="0"
            max="90"
            value={lengthInches}
            onChange={(e) => setLengthInches(e.target.value)}
            className={cn(field, 'w-20')}
          />
        </label>
        <label className={label}>
          silhouette
          <select value={silhouette} onChange={(e) => setSilhouette(e.target.value)} className={field}>
            <option value={UNSET}>— none —</option>
            {SilhouetteSchema.options.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          fabric
          <input value={fabric} onChange={(e) => setFabric(e.target.value)} className={cn(field, 'w-28')} />
        </label>
        <label className={label}>
          neckline
          <input value={neckline} onChange={(e) => setNeckline(e.target.value)} className={cn(field, 'w-28')} />
        </label>
        <label className={label}>
          confidence
          <input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
            className={cn(field, 'w-20')}
          />
        </label>
        <Button size="sm" variant="accent" onClick={() => void submit()} disabled={saving}>
          {saving ? 'Saving…' : 'Save correction'}
        </Button>
        <a
          href={row.sourceUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-accent underline underline-offset-2"
        >
          open source listing ↗
        </a>
      </div>
      {error && (
        <p role="alert" className="text-xs text-accent-deep">
          {error}
        </p>
      )}
    </div>
  );
}

'use client';

/**
 * Admin dashboard (2026-07-09) — crawler health, catalog overview, extraction
 * QA, clickouts, and an optional events panel. Dense/utilitarian on purpose:
 * internal tool, desktop-first. Polls /api/admin/ingest every 60s.
 *
 * The "Events" panel probes GET /api/admin/analytics at runtime and hides
 * silently on 404 — a parallel workstream may ship that endpoint; we render
 * it opportunistically rather than owning it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppErrorGroup, AppErrorStats, SourceHealth } from '@hemline/db';
import { Button, cn, ErrorState, formatAgo, Skeleton, Spinner, Toggle } from '@hemline/ui';
import { apiGet, fmtInt, fmtPct, NotFoundError, type AdminIngestPayload } from './lib';
import { ExtractionQaPanel } from './extraction-qa';

const REFRESH_MS = 60_000;

export function AdminDashboard() {
  const [payload, setPayload] = useState<AdminIngestPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // undefined = not probed yet, null = 404 (hide panel), value = render
  const [events, setEvents] = useState<unknown | null | undefined>(undefined);
  const eventsGone = useRef(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await apiGet<AdminIngestPayload>('/api/admin/ingest');
      setPayload(data);
      setError(null);
      setRefreshedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
    if (!eventsGone.current) {
      try {
        setEvents(await apiGet<unknown>('/api/admin/analytics'));
      } catch (e) {
        // 404 → endpoint not deployed: hide forever this session. Other
        // errors (auth blip, 500) also hide the panel but re-probe next tick.
        if (e instanceof NotFoundError) eventsGone.current = true;
        setEvents(null);
      }
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <main className="mx-auto min-h-dvh max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl text-ink">Hemline Ops</h1>
          <p className="text-sm text-ink-soft">
            Crawlers, catalog, extraction QA, clickouts · refreshes every 60s
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-faint">
          {refreshing && <Spinner className="[&_svg]:size-4" label="Refreshing" />}
          {refreshedAt && <span>updated {formatAgo(refreshedAt)}</span>}
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={refreshing}>
            Refresh
          </Button>
        </div>
      </header>

      {error && !payload && (
        <ErrorState title="Admin API unreachable">
          {error}
          <div className="mt-2 text-xs">
            If you just authenticated, reload the page so the browser re-sends credentials.
          </div>
        </ErrorState>
      )}
      {error && payload && (
        <p role="alert" className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent-deep">
          Last refresh failed: {error} — showing previous data.
        </p>
      )}

      {!payload && !error && <DashboardSkeleton />}

      {payload && (
        <div className="space-y-8">
          <CatalogHeader payload={payload} />
          <CrawlerHealthPanel sources={payload.sources} />
          <ErrorsPanel />
          <ExtractionQaPanel />
          <ClickoutsPanel clickouts={payload.clickouts} sources={payload.sources} />
          {events != null && <EventsPanel data={events} />}
        </div>
      )}
    </main>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
      <Skeleton className="h-64" />
    </div>
  );
}

/* ── shared panel chrome ────────────────────────────────────────────── */

export function Panel({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg text-ink">{title}</h2>
          {subtitle && <p className="text-xs text-ink-faint">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

const TH = 'px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-ink-faint uppercase';
const TD = 'px-2 py-2 align-middle text-sm text-ink';

/* ── catalog overview header ────────────────────────────────────────── */

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card px-4 py-3 shadow-card">
      <div className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">{label}</div>
      <div className="font-display text-2xl text-ink">{value}</div>
      {detail && <div className="text-xs text-ink-soft">{detail}</div>}
    </div>
  );
}

function CatalogHeader({ payload }: { payload: AdminIngestPayload }) {
  const c = payload.catalog;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <StatCard
        label="Active listings"
        value={fmtInt(c.listings.active)}
        detail={`${fmtInt(c.listings.total)} total incl. removed`}
      />
      <StatCard
        label="Vectors"
        value={fmtInt(c.vectors.embeddedListings)}
        detail={`${fmtInt(c.vectors.rows)} embedding rows`}
      />
      <StatCard
        label="Extracted"
        value={fmtInt(c.extraction.extractedListings)}
        detail="active listings w/ extraction"
      />
      <StatCard label="Length class" value={fmtPct(c.extraction.lengthClassPct)} detail="coverage" />
      <StatCard label="Length inches" value={fmtPct(c.extraction.lengthInchesPct)} detail="coverage" />
      <StatCard label="Colors" value={fmtPct(c.extraction.colorsPct)} detail="coverage" />
    </div>
  );
}

/* ── crawler health ─────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string | null }) {
  const cls =
    status === 'ok'
      ? 'bg-moss-soft text-moss'
      : status === 'error'
        ? 'bg-accent-soft text-accent-deep'
        : 'bg-parchment text-ink-soft';
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold', cls)}>
      {status ?? 'never ran'}
    </span>
  );
}

/** 24h / 24–48h / stale share of active listings as a tiny stacked bar. */
function FreshnessGauge({ counts }: { counts: SourceHealth['listingCounts'] }) {
  const { active, fresh24h, fresh48h, staleOver48h } = counts;
  if (active === 0) return <span className="text-xs text-ink-faint">no active listings</span>;
  const mid = Math.max(0, fresh48h - fresh24h);
  const w = (n: number) => `${Math.max(0, (n / active) * 100)}%`;
  return (
    <div title={`24h: ${fresh24h} · 24–48h: ${mid} · stale: ${staleOver48h}`}>
      <div className="flex h-2 w-32 overflow-hidden rounded-full bg-parchment">
        <div className="bg-moss" style={{ width: w(fresh24h) }} />
        <div className="bg-moss/45" style={{ width: w(mid) }} />
        <div className="bg-accent" style={{ width: w(staleOver48h) }} />
      </div>
      <div className="mt-0.5 text-[11px] text-ink-faint">
        {fresh24h} · {mid} · <span className={staleOver48h > 0 ? 'text-accent' : ''}>{staleOver48h} stale</span>
      </div>
    </div>
  );
}

function statNum(stats: Record<string, unknown> | undefined, key: string): string {
  const v = stats?.[key];
  return typeof v === 'number' ? fmtInt(v) : '—';
}

function CrawlerHealthPanel({ sources }: { sources: SourceHealth[] }) {
  return (
    <Panel
      title="Crawler health"
      subtitle="Per-source ingest runs and listing freshness. Enable/disable is managed in the sources table (no admin write endpoint yet) — shown read-only."
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-line">
              <th className={TH}>Source</th>
              <th className={TH}>Enabled</th>
              <th className={TH}>Last run</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, 'text-right')}>New</th>
              <th className={cn(TH, 'text-right')}>Unchanged</th>
              <th className={cn(TH, 'text-right')}>Errors</th>
              <th className={cn(TH, 'text-right')}>Active</th>
              <th className={TH}>Freshness</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              const unhealthy =
                s.lastRun?.status === 'error' ||
                s.errorRunCount > 0 ||
                s.listingCounts.staleOver48h > 0;
              const lastAt = s.lastRun?.startedAt ?? s.lastRunAt;
              return (
                <tr
                  key={s.id}
                  className={cn('border-b border-line/60', unhealthy && 'bg-accent-soft/50')}
                >
                  <td className={TD}>
                    <div className="font-medium">{s.displayName}</div>
                    <div className="text-[11px] text-ink-faint">
                      {s.id} · {s.kind} · {s.cadenceCron}
                    </div>
                  </td>
                  <td className={TD}>
                    <Toggle
                      checked={s.enabled}
                      onChange={() => {}}
                      disabled
                      label={`${s.displayName} enabled (read-only)`}
                      className="scale-75"
                    />
                  </td>
                  <td className={TD}>
                    {lastAt ? (
                      <span title={new Date(lastAt).toLocaleString()}>{formatAgo(lastAt)}</span>
                    ) : (
                      <span className="text-ink-faint">never</span>
                    )}
                  </td>
                  <td className={TD}>
                    <StatusBadge status={s.lastRun?.status ?? null} />
                    {s.errorRunCount > 0 && (
                      <div className="text-[11px] text-accent">{s.errorRunCount} error runs</div>
                    )}
                    {s.lastRun?.error && (
                      <div className="max-w-52 truncate text-[11px] text-accent" title={s.lastRun.error}>
                        {s.lastRun.error}
                      </div>
                    )}
                  </td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{statNum(s.lastRun?.stats, 'new')}</td>
                  <td className={cn(TD, 'text-right tabular-nums')}>
                    {statNum(s.lastRun?.stats, 'unchanged')}
                  </td>
                  <td className={cn(TD, 'text-right tabular-nums')}>
                    {statNum(s.lastRun?.stats, 'errors')}
                  </td>
                  <td className={cn(TD, 'text-right tabular-nums')}>{fmtInt(s.listingCounts.active)}</td>
                  <td className={TD}>
                    <FreshnessGauge counts={s.listingCounts} />
                  </td>
                </tr>
              );
            })}
            {sources.length === 0 && (
              <tr>
                <td className={cn(TD, 'text-ink-faint')} colSpan={9}>
                  No sources configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ── clickouts ──────────────────────────────────────────────────────── */

function ClickoutsPanel({
  clickouts,
  sources,
}: {
  clickouts: AdminIngestPayload['clickouts'];
  sources: SourceHealth[];
}) {
  const names = new Map(sources.map((s) => [s.id, s.displayName]));
  const rows = Object.entries(clickouts.bySource).sort((a, b) => b[1] - a[1]);
  return (
    <Panel title="Clickouts" subtitle="Outbound affiliate link-outs (revenue attribution)">
      <div className="flex flex-wrap gap-6">
        <div>
          <div className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Total</div>
          <div className="font-display text-2xl tabular-nums">{fmtInt(clickouts.total)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Last 24h</div>
          <div className="font-display text-2xl tabular-nums">{fmtInt(clickouts.last24h)}</div>
        </div>
        <table className="ml-auto border-collapse self-start">
          <tbody>
            {rows.map(([sourceId, n]) => (
              <tr key={sourceId} className="border-b border-line/60 last:border-0">
                <td className="py-1 pr-6 text-sm text-ink-soft">{names.get(sourceId) ?? sourceId}</td>
                <td className="py-1 text-right text-sm tabular-nums">{fmtInt(n)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="py-1 text-sm text-ink-faint">No clickouts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ── server errors panel (ops, 2026-07-13) ──────────────────────────── */

interface AdminErrorsPayload {
  errors: AppErrorGroup[];
  stats: AppErrorStats;
}

/**
 * Deduped server-error groups from GET /api/admin/errors (`app_errors`
 * table). Self-fetching on the same 60s cadence as the main payload; click a
 * row to expand the latest stack.
 */
function ErrorsPanel() {
  const [payload, setPayload] = useState<AdminErrorsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHash, setOpenHash] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setPayload(await apiGet<AdminErrorsPayload>('/api/admin/errors?limit=50'));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  const rows = payload?.errors ?? [];
  return (
    <Panel
      title="Errors"
      subtitle="Server-side errors, deduped by stack (route catch paths + uncaught request errors). Bounded table — pruned to 500 groups / 30 days."
      actions={
        payload && (
          <span className="text-xs text-ink-faint">
            {fmtInt(payload.stats.groups)} groups · ~{fmtInt(payload.stats.lastHour)} in the last hour
          </span>
        )
      }
    >
      {error && <p className="text-sm text-accent">Failed to load errors: {error}</p>}
      {!error && rows.length === 0 && (
        <p className="text-sm text-ink-faint">No server errors recorded. Quiet is good.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={TH}>Route</th>
                <th className={TH}>Message</th>
                <th className={cn(TH, 'text-right')}>Count</th>
                <th className={TH}>First seen</th>
                <th className={TH}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <React.Fragment key={r.stackHash}>
                  <tr
                    className="cursor-pointer border-b border-line/60 hover:bg-parchment/60"
                    onClick={() => setOpenHash(openHash === r.stackHash ? null : r.stackHash)}
                  >
                    <td className={cn(TD, 'whitespace-nowrap font-medium')}>{r.route}</td>
                    <td className={TD}>
                      <span className="line-clamp-2 max-w-96 break-words" title={r.message}>
                        {r.message}
                      </span>
                    </td>
                    <td className={cn(TD, 'text-right tabular-nums')}>{fmtInt(r.count)}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-ink-soft')}>
                      <span title={new Date(r.firstSeenAt).toLocaleString()}>{formatAgo(r.firstSeenAt)}</span>
                    </td>
                    <td className={cn(TD, 'whitespace-nowrap text-ink-soft')}>
                      <span title={new Date(r.lastSeenAt).toLocaleString()}>{formatAgo(r.lastSeenAt)}</span>
                    </td>
                  </tr>
                  {openHash === r.stackHash && r.stack && (
                    <tr className="border-b border-line/60">
                      <td colSpan={5} className="px-2 py-2">
                        <pre className="max-h-56 overflow-auto rounded-lg bg-parchment p-3 text-xs text-ink-soft">
                          {r.stack}
                        </pre>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ── optional events (analytics) panel ──────────────────────────────── */

/**
 * Shape-agnostic renderer: the analytics endpoint is owned elsewhere and may
 * not exist. Top-level numbers become stat tiles; everything else renders as
 * compact JSON so whatever ships is at least visible.
 */
function EventsPanel({ data }: { data: unknown }) {
  const record = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
  const numbers = record
    ? Object.entries(record).filter((e): e is [string, number] => typeof e[1] === 'number')
    : [];
  const rest = record ? Object.entries(record).filter(([, v]) => typeof v !== 'number') : [];
  return (
    <Panel title="Events" subtitle="GET /api/admin/analytics (optional endpoint)">
      {numbers.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-6">
          {numbers.map(([k, v]) => (
            <div key={k}>
              <div className="text-[11px] font-semibold tracking-wide text-ink-faint uppercase">{k}</div>
              <div className="font-display text-2xl tabular-nums">{fmtInt(v)}</div>
            </div>
          ))}
        </div>
      )}
      {(rest.length > 0 || !record) && (
        <pre className="max-h-72 overflow-auto rounded-lg bg-parchment p-3 text-xs text-ink-soft">
          {JSON.stringify(record ? Object.fromEntries(rest) : data, null, 2)}
        </pre>
      )}
    </Panel>
  );
}

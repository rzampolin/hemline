/**
 * Admin dashboard client helpers — envelope unwrap + tiny formatters.
 * Types come from @hemline/db (type-only imports, erased at build).
 */
import type { CatalogOverview, ClickoutStats, SourceHealth } from '@hemline/db';

export interface AdminIngestPayload {
  sources: SourceHealth[];
  clickouts: ClickoutStats;
  catalog: CatalogOverview;
}

/** Thrown on HTTP 404 so optional panels (analytics) can hide silently. */
export class NotFoundError extends Error {
  constructor(url: string) {
    super(`404: ${url}`);
    this.name = 'NotFoundError';
  }
}

/** GET a `{ ok, data | error }` envelope endpoint; throws on failure. */
export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) throw new NotFoundError(url);
  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;
  if (!body) throw new Error(`bad response (${res.status}) from ${url}`);
  if (!body.ok) throw new Error(body.error?.message ?? `request failed (${res.status})`);
  return body.data;
}

export async function apiPatch<T>(url: string, patch: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;
  if (!body?.ok) {
    throw new Error(
      (body && !body.ok && body.error?.message) || `PATCH failed (${res.status})`,
    );
  }
  return body.data;
}

export function fmtInt(x: number): string {
  return x.toLocaleString('en-US');
}

export function fmtPct(x: number): string {
  return `${x.toFixed(1).replace(/\.0$/, '')}%`;
}

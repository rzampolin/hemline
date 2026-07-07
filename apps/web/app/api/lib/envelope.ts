/**
 * ApiResponse<T> envelope helpers — every route returns
 * `{ ok: true, data } | { ok: false, error: { code, message } }` (§4.7).
 */
import { NextResponse } from 'next/server';
import type { ZodError } from 'zod';
import type { ApiResponse } from '@hemline/contracts';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  const body: ApiResponse<T> = { ok: true, data };
  return NextResponse.json(body, init);
}

export function fail(code: string, message: string, status = 400): NextResponse {
  const body: ApiResponse<never> = { ok: false, error: { code, message } };
  return NextResponse.json(body, { status });
}

export function zodFail(err: ZodError): NextResponse {
  const first = err.issues[0];
  const where = first?.path?.join('.') ?? '';
  return fail('invalid_request', `${where ? `${where}: ` : ''}${first?.message ?? 'invalid body'}`, 400);
}

/** Uniform catch-all: log server-side, return a stable envelope. */
export function serverError(route: string, err: unknown): NextResponse {
  console.error(`[api:${route}]`, err);
  return fail('internal_error', err instanceof Error ? err.message : 'unexpected error', 500);
}

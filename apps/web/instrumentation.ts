/**
 * Next 15 instrumentation hook. Since the /admin middleware exists
 * (2026-07-09) this file is compiled for BOTH the Node and Edge runtimes, so
 * it must contain no Node-only imports at reachable positions. The
 * `if (NEXT_RUNTIME === 'nodejs')` block is constant-folded by webpack
 * (DefinePlugin), which skips the dead branch in the Edge build — the
 * documented Next pattern for runtime-specific instrumentation.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node');
    await mod.register();
  }
}

/**
 * Next 15 server-error hook (ops, 2026-07-13): uncaught errors from route
 * handlers / RSC renders / server actions land here and are recorded into
 * the `app_errors` tracking table (deduped, bounded — packages/db
 * query/app-errors). Complements — never double-counts — the
 * envelope.serverError capture: routes that catch their own errors never
 * reach this hook. Same Edge/Node split as register(): the Node-only body
 * lives in instrumentation-node.ts behind the constant-folded runtime check
 * (docs/decisions-admin-ui.md §2), so the Edge build stays clean.
 */
export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const mod = await import('./instrumentation-node');
    mod.captureRequestError(err, request, context);
  }
}

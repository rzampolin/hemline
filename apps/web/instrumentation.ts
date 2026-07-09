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

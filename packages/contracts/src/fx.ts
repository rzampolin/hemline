/**
 * Static FX table → USD (additive, 2026-07-08, QA P1 #3 "currency mixing").
 *
 * Multi-currency sources (Sister Jane, RIXO… list in GBP pence) must not be
 * compared 1:1 against USD budgets. All budget/price filtering and price-facet
 * aggregation happen in USD-cent equivalents computed with this table; DISPLAY
 * always shows the native currency (packages/ui formatPrice).
 *
 * ⚠️ Rates are APPROXIMATE mid-market snapshots (July 2026) and intentionally
 * STATIC — no network dependency, deterministic tests, and a ±few-% error is
 * immaterial for a budget slider with $10 steps. Revisit with a real FX feed
 * when currency-mixed sources grow (see docs/decisions-qa-p1.md).
 */
export const FX_TO_USD: Record<string, number> = {
  USD: 1,
  GBP: 1.27,
  EUR: 1.08,
  AUD: 0.66,
  CAD: 0.73,
};

/**
 * Native cents → USD-cent equivalent. Unknown currencies pass through 1:1
 * (same permissive behavior as before this table existed — never hides).
 */
export function toUsdCents(cents: number, currency: string): number {
  return Math.round(cents * (FX_TO_USD[currency] ?? 1));
}

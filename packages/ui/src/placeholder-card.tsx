/**
 * Placeholder component proving the ui → web transpile chain works.
 * frontend-eng: replace with the real component kit (Card, SwipeDeck,
 * HemIndicator, …) — see OWNER.md.
 */
import type { ReactNode } from 'react';

export function PlaceholderCard({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-stone-900">{title}</h3>
      {children ? <div className="mt-1 text-sm text-stone-600">{children}</div> : null}
    </div>
  );
}

'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/** Tap-first selectable chip (quiz answers, filters). Big touch target. */
export function Chip({
  selected = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors select-none',
        selected
          ? 'border-ink bg-ink text-cream'
          : 'border-line bg-card text-ink hover:border-ink/40',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Informational chip with a remove affordance — e.g. "in your palette". */
export function RemovableChip({
  onRemove,
  removeLabel,
  className,
  children,
}: {
  onRemove: () => void;
  removeLabel: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-moss-soft py-1 pr-1 pl-2.5 text-xs font-medium text-moss',
        className,
      )}
    >
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onRemove();
        }}
        className="flex size-5 items-center justify-center rounded-full text-moss/70 hover:bg-moss/15 hover:text-moss"
      >
        <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </span>
  );
}

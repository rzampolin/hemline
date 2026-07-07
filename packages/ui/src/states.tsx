import type { ReactNode } from 'react';
import { cn } from './cn';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-label={label} className={cn('inline-block', className)}>
      <svg viewBox="0 0 24 24" className="size-6 animate-spin text-accent" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.2" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** Shimmering placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-shimmer rounded-xl', className)}
      style={{
        background:
          'linear-gradient(90deg, var(--color-parchment) 25%, var(--color-line) 50%, var(--color-parchment) 75%)',
        backgroundSize: '200% 100%',
      }}
    />
  );
}

/** Product-card-shaped skeleton for grids. */
export function CardSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      <Skeleton className="aspect-[3/4] w-full rounded-2xl" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-5 w-3/4 rounded-full" />
    </div>
  );
}

function DressGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 64" className={cn('size-14 text-ink-faint', className)} aria-hidden="true">
      <path
        d="M17 4c0 5 2 8 7 8s7-3 7-8M17 4l-3 14 4 5-6 33c4 2 8 3 12 3s8-1 12-3l-6-33 4-5-3-14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-8 py-14 text-center', className)}>
      <DressGlyph />
      <h2 className="font-display text-xl text-ink">{title}</h2>
      {children && <div className="max-w-xs text-sm text-ink-soft">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something snagged',
  children,
  action,
  className,
}: {
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn('flex flex-col items-center gap-3 px-8 py-14 text-center', className)}>
      <DressGlyph className="text-accent/50" />
      <h2 className="font-display text-xl text-ink">{title}</h2>
      {children && <div className="max-w-xs text-sm text-ink-soft">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

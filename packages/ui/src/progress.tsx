import { cn } from './cn';

/** "2 of 8" progress indicator for the onboarding quiz. */
export function ProgressBar({
  step,
  total,
  className,
}: {
  step: number;
  total: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={total}
        aria-valuenow={step}
        aria-label={`Step ${step} of ${total}`}
        className="h-1 flex-1 overflow-hidden rounded-full bg-line"
      >
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${(step / total) * 100}%` }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums text-ink-soft">
        {step} of {total}
      </span>
    </div>
  );
}

/**
 * Likes-toward-target progress for the calibration deck (2026-07-10):
 * hearts fill as positive signal accumulates — progress is what we LEARNED,
 * not how many cards were dealt.
 */
export function HeartsProgress({
  filled,
  total,
  className,
}: {
  filled: number;
  total: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(filled, total));
  return (
    <div
      className={cn('flex items-center justify-center gap-2', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={clamped}
      aria-label={`${clamped} of ${total} likes`}
      data-testid="hearts-progress"
    >
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <svg
            key={i}
            viewBox="0 0 24 24"
            className={cn(
              'size-4 transition-colors duration-300',
              i < clamped ? 'text-accent' : 'text-line',
            )}
            aria-hidden="true"
          >
            <path
              d="M12 20.3 4.8 13a4.6 4.6 0 0 1 0-6.6 4.7 4.7 0 0 1 6.6 0l.6.6.6-.6a4.7 4.7 0 0 1 6.6 0 4.6 4.6 0 0 1 0 6.6L12 20.3Z"
              fill={i < clamped ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={i < clamped ? 0 : 1.8}
            />
          </svg>
        ))}
      </div>
      <span className="text-xs font-medium tabular-nums text-ink-soft">
        {clamped} of {total}
      </span>
    </div>
  );
}

/** Dots for the swipe deck / galleries. */
export function ProgressDots({
  count,
  active,
  className,
}: {
  count: number;
  active: number;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-center gap-1.5', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            'rounded-full transition-all duration-300',
            i === active ? 'h-1.5 w-5 bg-ink' : i < active ? 'size-1.5 bg-accent' : 'size-1.5 bg-line',
          )}
        />
      ))}
    </div>
  );
}

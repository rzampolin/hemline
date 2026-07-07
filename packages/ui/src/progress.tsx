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

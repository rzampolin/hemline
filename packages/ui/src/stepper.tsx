'use client';

import { cn } from './cn';

/** Big-touch-target value stepper (brand sizes, heel height…). */
export function Stepper({
  value,
  onPrev,
  onNext,
  prevDisabled = false,
  nextDisabled = false,
  label,
  className,
}: {
  value: string;
  onPrev: () => void;
  onNext: () => void;
  prevDisabled?: boolean;
  nextDisabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex items-center gap-1 rounded-full border border-line bg-card', className)}>
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={prevDisabled}
        onClick={onPrev}
        className="flex size-11 items-center justify-center rounded-full text-lg text-ink hover:bg-ink/5 disabled:opacity-30"
      >
        −
      </button>
      <span className="min-w-10 text-center text-sm font-semibold text-ink" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={nextDisabled}
        onClick={onNext}
        className="flex size-11 items-center justify-center rounded-full text-lg text-ink hover:bg-ink/5 disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}

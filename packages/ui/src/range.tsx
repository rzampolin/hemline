'use client';

import { cn } from './cn';

/** Dual-handle range slider (budget). Two native inputs stacked — a11y for free. */
export function DualRange({
  min,
  max,
  step = 1,
  value,
  onChange,
  format,
  label,
  className,
}: {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onChange: (v: [number, number]) => void;
  format: (v: number) => string;
  label: string;
  className?: string;
}) {
  const [lo, hi] = value;
  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex items-baseline justify-between">
        <span className="font-display text-xl text-ink">
          {format(lo)} – {format(hi)}
        </span>
      </div>
      <div className="relative h-7">
        <div className="absolute top-1/2 right-0 left-0 h-1 -translate-y-1/2 rounded-full bg-line" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${pct(lo)}%`, right: `${100 - pct(hi)}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={lo}
          aria-label={`${label} minimum`}
          onChange={(e) => onChange([Math.min(Number(e.target.value), hi - step), hi])}
          className="range-thumb absolute inset-0 w-full"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={hi}
          aria-label={`${label} maximum`}
          onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo + step)])}
          className="range-thumb absolute inset-0 w-full"
        />
      </div>
      <div className="flex justify-between text-xs text-ink-faint">
        <span>{format(min)}</span>
        <span>{format(max)}+</span>
      </div>
    </div>
  );
}

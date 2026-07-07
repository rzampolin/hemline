import { cn } from './cn';

/** A single palette color dot, optionally labeled. */
export function Swatch({
  hex,
  name,
  size = 'md',
  className,
}: {
  hex: string;
  name?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dot = size === 'sm' ? 'size-5' : size === 'lg' ? 'size-12' : 'size-8';
  return (
    <span className={cn('inline-flex flex-col items-center gap-1', className)}>
      <span
        className={cn(dot, 'rounded-full ring-1 ring-ink/15')}
        style={{ backgroundColor: hex }}
        role="img"
        aria-label={name ?? hex}
      />
      {name && <span className="max-w-14 truncate text-[10px] text-ink-soft">{name}</span>}
    </span>
  );
}

/** Compact overlapping strip of swatches (profile summary, cards). */
export function SwatchStrip({
  colors,
  max = 8,
  className,
}: {
  colors: { hex: string; name: string }[];
  max?: number;
  className?: string;
}) {
  const shown = colors.slice(0, max);
  return (
    <span className={cn('inline-flex items-center', className)}>
      {shown.map((c, i) => (
        <span
          key={`${c.hex}-${i}`}
          className="-ml-1.5 size-5 rounded-full ring-2 ring-cream first:ml-0"
          style={{ backgroundColor: c.hex }}
          role="img"
          aria-label={c.name}
        />
      ))}
      {colors.length > max && (
        <span className="ml-1 text-[10px] text-ink-faint">+{colors.length - max}</span>
      )}
    </span>
  );
}

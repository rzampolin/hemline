import type { ButtonHTMLAttributes, AnchorHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

type Variant = 'primary' | 'accent' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variantClasses: Record<Variant, string> = {
  primary: 'bg-ink text-cream hover:bg-ink/90 active:bg-ink/80',
  accent: 'bg-accent text-cream hover:bg-accent-deep active:bg-accent-deep',
  outline: 'border border-ink/25 bg-transparent text-ink hover:border-ink/50 active:bg-ink/5',
  ghost: 'bg-transparent text-ink-soft hover:bg-ink/5 active:bg-ink/10',
  danger: 'border border-accent/40 bg-transparent text-accent hover:bg-accent-soft',
};

const sizeClasses: Record<Size, string> = {
  sm: 'min-h-9 px-3.5 text-sm gap-1.5',
  md: 'min-h-11 px-5 text-[15px] gap-2',
  lg: 'min-h-13 px-7 text-base gap-2',
};

const baseClasses =
  'inline-flex items-center justify-center rounded-full font-medium tracking-tight transition-colors select-none disabled:opacity-40 disabled:pointer-events-none';

export function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  className,
  type,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  full?: boolean;
}) {
  return (
    <button
      type={type ?? 'button'}
      className={cn(baseClasses, variantClasses[variant], sizeClasses[size], full && 'w-full', className)}
      {...rest}
    />
  );
}

/** Anchor styled as a button — for link-out CTAs and internal navigation. */
export function ButtonLink({
  variant = 'primary',
  size = 'md',
  full = false,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: Variant;
  size?: Size;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      className={cn(baseClasses, variantClasses[variant], sizeClasses[size], full && 'w-full', className)}
      {...rest}
    >
      {children}
    </a>
  );
}

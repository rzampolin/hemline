'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from './cn';

/** Mobile-first bottom sheet (filters, pickers). Escape + backdrop close, scroll lock. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        aria-label="Close"
        className="absolute inset-0 bg-ink/40 animate-fade"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[88dvh] w-full flex-col rounded-t-3xl bg-cream shadow-lift outline-none animate-rise',
          'sm:max-w-lg sm:rounded-3xl',
          className,
        )}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <span aria-hidden="true" className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-line sm:hidden" />
          <h2 className="font-display text-lg text-ink">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-9 items-center justify-center rounded-full text-ink-soft hover:bg-ink/5"
          >
            <svg viewBox="0 0 14 14" className="size-3.5" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="border-t border-line bg-cream px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

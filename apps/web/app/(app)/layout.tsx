'use client';

/** App shell: bottom nav Rack / Saved / Profile (PRODUCT_SPEC §4.4). */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@hemline/ui';

const TABS = [
  {
    href: '/feed',
    label: 'Rack',
    icon: (
      <path d="M3 5h14M10 5v2m0 0c-3 3-6 4-6 7a6 6 0 0 0 12 0c0-3-3-4-6-7Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    ),
  },
  {
    href: '/saved',
    label: 'Saved',
    icon: (
      <path d="M10 16.7 4.6 11a3.8 3.8 0 0 1 0-5.4 3.9 3.9 0 0 1 5.4 0 3.9 3.9 0 0 1 5.4 0 3.8 3.8 0 0 1 0 5.4L10 16.7Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    ),
  },
  {
    href: '/profile',
    label: 'Profile',
    icon: (
      <path d="M10 9a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 10 9Zm-6 8a6 6 0 0 1 12 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    ),
  },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto min-h-dvh max-w-2xl lg:max-w-5xl">
      <div className="pb-20">{children}</div>
      <nav
        aria-label="Main"
        className="fixed right-0 bottom-0 left-0 z-40 border-t border-line bg-cream/95 backdrop-blur pb-[env(safe-area-inset-bottom)]"
      >
        <div className="mx-auto flex max-w-md items-stretch justify-around">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-w-20 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium',
                  active ? 'text-accent' : 'text-ink-soft hover:text-ink',
                )}
              >
                <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
                  {t.icon}
                </svg>
                {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

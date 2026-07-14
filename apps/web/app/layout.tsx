import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import { APP_URL } from '../lib/app-url';
import { ProfileProvider } from '../lib/profile-store';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  // canonical origin for OG/social absolute URLs — env-driven via the
  // app-url helper, never a hardcoded hostname (custom-domain prep,
  // docs/DOMAIN.md)
  metadataBase: new URL(APP_URL),
  title: {
    default: 'Hemline — dresses that actually fit',
    template: '%s · Hemline',
  },
  description:
    'Dresses that actually fit — your size, your height, your colors. Resale + brand sites, with honest hem predictions for your body.',
  openGraph: {
    siteName: 'Hemline',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'Hemline — that maxi? It’s a midi on you.' }],
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#faf6ef',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body className="min-h-dvh bg-cream font-sans text-ink antialiased">
        <ProfileProvider>{children}</ProfileProvider>
      </body>
    </html>
  );
}

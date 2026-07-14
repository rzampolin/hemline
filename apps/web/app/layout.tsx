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
  // canonical origin for OG/social absolute URLs — env-driven, never a
  // hardcoded hostname (custom-domain prep, docs/DOMAIN.md)
  metadataBase: new URL(APP_URL),
  title: 'Hemline — dresses that actually fit',
  description:
    'Dresses that actually fit — your size, your height, your colors. Resale + brand sites, with honest hem predictions for your body.',
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

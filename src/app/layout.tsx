import type { Metadata } from 'next';
import { Figtree } from 'next/font/google';
import './globals.css';
import { Navbar } from '@/components/navigation/navbar';

// "Organic" design-system typography (imported design: RemoteMatch.dc.html) —
// self-hosted via next/font so there's no external request or layout shift.
// The source design's Caprasimo display face read as too bold/bulky in
// practice, so every heading uses this body font at a bold weight instead
// (see globals.css) — Figtree is the only face actually loaded.
const figtree = Figtree({ subsets: ['latin'], display: 'swap', variable: '--font-body' });

export const metadata: Metadata = {
  metadataBase: new URL('https://remotematch.com'),
  title: {
    default: 'RemoteMatch — Find Remote Jobs Worth Applying To | Know Your Chances',
    template: '%s | RemoteMatch',
  },
  alternates: {
    canonical: 'https://remotematch.com',
  },
  description:
    'RemoteMatch is a remote job search platform that helps professionals discover remote jobs matched to their experience and preferences, understand why a job fits, identify what may be missing, and track applications from application to offer.',
  keywords: [
    'remote jobs',
    'remote job search',
    'work from home',
    'remote software engineer jobs',
    'remote product manager jobs',
    'job match analysis',
    'remote careers',
    'application tracker',
  ],
  authors: [{ name: 'RemoteMatch' }],
  creator: 'RemoteMatch',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://remotematch.com',
    siteName: 'RemoteMatch',
    title: 'RemoteMatch — Find remote jobs worth applying to.',
    description:
      'See remote jobs that fit your experience, understand why they match, and apply with more confidence. Know your chances before you apply.',
    images: [
      {
        url: 'https://remotematch.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'RemoteMatch — Know your chances before you apply.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'RemoteMatch — Find remote jobs worth applying to.',
    description:
      'See remote jobs that fit your experience, understand why they match, and apply with more confidence. Know your chances before you apply.',
    images: ['https://remotematch.com/og-image.png'],
    creator: '@remotematch',
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
};

const jsonLdOrganization = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'RemoteMatch',
  url: 'https://remotematch.com',
  logo: 'https://remotematch.com/logo.png',
  description:
    'RemoteMatch is a remote job search platform that helps professionals discover remote jobs matched to their experience and preferences, understand why a job fits, identify what may be missing, and track applications from application to offer.',
};

const jsonLdWebSite = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'RemoteMatch',
  url: 'https://remotematch.com',
  description: 'Find remote jobs worth applying to. Know your chances before you apply.',
  potentialAction: {
    '@type': 'SearchAction',
    target: {
      '@type': 'EntryPoint',
      urlTemplate: 'https://remotematch.com/remote-jobs?q={search_term_string}',
    },
    'query-input': 'required name=search_term_string',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={figtree.variable}>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdOrganization) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLdWebSite) }}
        />
      </head>
      <body className="bg-[var(--bg)] text-[var(--ink)] antialiased min-h-screen flex flex-col selection:bg-[var(--red-soft-border)] selection:text-[var(--ink)]">
        <Navbar />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}

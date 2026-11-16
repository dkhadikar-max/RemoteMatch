import { notFound } from 'next/navigation';
import { PreviewDemoProvider } from '@/components/preview-demo/preview-demo-provider';

// Without this, Next statically prerenders any child page that doesn't
// itself force dynamic rendering (e.g. the dashboard/job-form/onboarding
// pages here have no dynamic segment) — baking this layout's env-var check
// into the HTML at BUILD time, so it would never re-evaluate at request
// time no matter what the running environment's process.env says. Forcing
// the whole subtree dynamic makes every request re-run the check below.
export const dynamic = 'force-dynamic';

// Visual-review-only route tree, reviewing PR #137's redesigned
// authenticated screens with static mock data instead of a real session.
// Renders the real page components from src/app/employer/** and
// src/app/onboarding/page.tsx unmodified; only the data layer is swapped
// (see src/lib/preview-demo/mock-fetch.ts). No auth, API route, or
// middleware code is touched by anything under this directory.
//
// Belt-and-suspenders: even if this ever reached a production build by
// mistake, it stays 404 there unless this flag is explicitly set, and it is
// set only on the Railway preview service for this PR, never on production.
//
// Deliberately NOT a NEXT_PUBLIC_ variable: those are inlined into the
// client bundle at BUILD time, so toggling one at runtime (e.g. per
// environment, without rebuilding) would silently do nothing. This is a
// server-only variable, read fresh on every request in this Server
// Component, so the same build artifact 404s or serves this tree purely
// based on which environment's process.env it's actually running in.
export default function PreviewDemoLayout({ children }: { children: React.ReactNode }) {
  if (process.env.PREVIEW_DEMO_ENABLED !== 'true') {
    notFound();
  }

  return (
    <PreviewDemoProvider>
      <div className="sticky top-0 z-50 bg-amber-400 px-4 py-2 text-center text-xs font-semibold text-amber-950">
        PREVIEW DEMO — static mock data, not connected to any live backend or database.
      </div>
      {children}
    </PreviewDemoProvider>
  );
}

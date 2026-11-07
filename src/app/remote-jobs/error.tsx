'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Defense-in-depth only: searchTimedOut (src/app/remote-jobs/page.tsx) already handles the one
 * known failure mode without throwing. This boundary catches anything else uncaught in this route
 * so a visitor never sees Next's bare default error page. Renders inside the root layout
 * (src/app/layout.tsx), so the site nav and global styles stay present around this fallback.
 */
export default function RemoteJobsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[remote-jobs] route error:', error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="soft-card p-8 text-center space-y-3 max-w-md">
        <p className="text-sm font-semibold text-[var(--ink)]">Something went wrong loading this page.</p>
        <p className="text-sm text-[var(--muted)]">This has been logged. You can try again, or go back to browsing.</p>
        <div className="pt-2 flex items-center justify-center gap-2">
          <button type="button" onClick={() => reset()} className="soft-button primary text-sm">
            Try again
          </button>
          <Link href="/remote-jobs" className="soft-button secondary text-sm">
            View all active jobs
          </Link>
        </div>
      </div>
    </div>
  );
}

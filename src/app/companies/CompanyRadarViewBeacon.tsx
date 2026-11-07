'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { recordFunnelEventClient, trackApplyClick } from '@/lib/funnel/client';
import { getOrCreateAnonymousId } from '@/lib/funnel/anonymous-id';

/**
 * Company Radar validation period (migration 035) — fires `company_radar_viewed`
 * once per mount, from a server-rendered page (src/app/companies/page.tsx,
 * src/app/companies/view/[company]/page.tsx). A tiny client component rather
 * than converting either page to a client component: a server component
 * cannot host a `useEffect` directly, and this is the established pattern
 * already used for every other view-type funnel event (job_viewed,
 * feed_viewed, match_analyzed) in pages that already happen to be client
 * components — here that isn't the case, so this exists as its own file.
 * Renders nothing. No new tracking mechanism: reuses the exact same
 * anonymous-id and client-write functions every other funnel event already
 * uses.
 */
export default function CompanyRadarViewBeacon() {
  useEffect(() => {
    const anonymousId = getOrCreateAnonymousId();
    if (!anonymousId) return; // storage unavailable — skip, never fabricate an id
    void recordFunnelEventClient('company_radar_viewed', { anonymous_id: anonymousId });
    // Fires once per mount (refresh = a new mount = a new row) — raw-views-vs-
    // unique-visitors is a reporting-time distinction, not deduplicated here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

/**
 * An Apply link from a company profile page, attributed with
 * surface: 'company_profile' (migration 035) — deliberately NOT a reuse of
 * src/components/seo/tracked-apply-link.tsx's TrackedApplyLink, which
 * hardcodes 'job_page' internally for its one existing caller (the job
 * detail page); changing that shared component's signature to accept a
 * surface prop would be a second, unrelated edit to already-reviewed code
 * for no benefit over this small, self-contained alternative. Same
 * fire-and-forget `trackApplyClick` call, same target/rel convention.
 */
export function CompanyProfileApplyLink({
  href,
  canonicalId,
  className,
  children,
}: {
  href: string;
  canonicalId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackApplyClick(canonicalId, 'company_profile')}
      className={className}
    >
      {children}
    </a>
  );
}

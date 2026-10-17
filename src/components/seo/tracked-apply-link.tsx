'use client';

import type { ReactNode } from 'react';
import { trackApplyClick } from '@/lib/funnel/client';

/**
 * An Apply link to the employer's site that records `apply_clicked` on the
 * way out. A client component only so the server-rendered public job page
 * can attach the click handler; the link itself renders exactly as before.
 * Signed-out visitors' clicks are not recorded (the event needs a session).
 */
export function TrackedApplyLink({
  href,
  opportunityId,
  className,
  children,
}: {
  href: string;
  opportunityId: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={() => trackApplyClick(opportunityId, 'job_page')}
      className={className}
    >
      {children}
    </a>
  );
}

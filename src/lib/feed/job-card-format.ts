import type { CanonicalOpportunity } from '@/types/byn';

/**
 * Presentation helpers for the job card + details modal (H — Job Discovery UX).
 * Pure and deterministic so they can be unit-tested and shared.
 *
 * Freshness note: `postedAt` is the posting date available to RemoteMatch —
 * the provider's publication date where one was supplied, otherwise the time we
 * first ingested the listing. It is stamped once (insert-only in catalog-sync)
 * and never bumped by later syncs, so the age is stable. We do NOT currently
 * distinguish provider-supplied dates from ingestion-time fallbacks, so the age
 * is "recorded posting date", not a guaranteed employer-original posting date.
 */

/** "Posted today" | "Posted 3d ago" | "Posted 30d+ ago"; `null` when the date
 *  is missing or unparseable (render nothing rather than invent a date). */
export function formatPostedAge(postedAt: string | undefined | null): string | null {
  if (!postedAt) return null;
  const t = new Date(postedAt).getTime();
  if (Number.isNaN(t)) return null;
  const ageDays = Math.floor((Date.now() - t) / 86_400_000);
  if (ageDays <= 0) return 'Posted today';
  if (ageDays >= 30) return 'Posted 30d+ ago';
  return `Posted ${ageDays}d ago`;
}

/** Real salary range when the source gave one, else "Salary not listed".
 *  Never fabricates a band. */
export function formatSalary(
  opp: Pick<CanonicalOpportunity, 'salaryMin' | 'salaryMax'>,
): string {
  const min = typeof opp.salaryMin === 'number' && opp.salaryMin > 0 ? opp.salaryMin : undefined;
  const max = typeof opp.salaryMax === 'number' && opp.salaryMax > 0 ? opp.salaryMax : undefined;
  if (min === undefined && max === undefined) return 'Salary not listed';
  const k = (n: number) => `$${Math.round(n / 1000)}k`;
  if (min !== undefined && max !== undefined && max !== min) return `${k(min)} – ${k(max)}`;
  return k((min ?? max) as number);
}

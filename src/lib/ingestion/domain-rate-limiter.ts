/**
 * Supply Discovery gate C5 — domain-level rate limiter
 * (docs/c5-implementation-plan.md §4b)
 * ==============================================================================
 * Genuinely new — C3's three ATS APIs never needed this (no observed rate
 * limits). Arbitrary company websites are a materially different risk:
 * bot protection, CDN challenges, aggressive throttling.
 *
 * Deliberately simple: at 5-10 employers this is a sequential-with-delay
 * pattern, not a queue/worker system — sized to the initial cohort, not
 * over-built for a scale C5 doesn't operate at (per the C4-1 constraint,
 * C5 runs on its own low-frequency cadence, not C3's shared cron).
 */

const lastFetchByDomain = new Map<string, number>();

export async function waitForDomainSlot(domain: string, minDelayMs = 3000): Promise<void> {
  const last = lastFetchByDomain.get(domain);
  const now = Date.now();
  if (last !== undefined) {
    const elapsed = now - last;
    const remaining = minDelayMs - elapsed;
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
  lastFetchByDomain.set(domain, Date.now());
}

/** Test-only: reset all tracked domain timestamps between test cases. */
export function resetDomainRateLimiter(): void {
  lastFetchByDomain.clear();
}

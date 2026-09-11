import type { CanonicalOpportunity } from '@/types/byn';

/**
 * Job Trust Layer (ticket M) — presentation helpers only.
 *
 * Every fact rendered here is already computed and persisted upstream by
 * Phase A (Live Supply Activation), C1 (source registry), and the P1
 * Job-Quality Intelligence scoping pass — this module adds ZERO new
 * computation, ZERO new classification, and reads no field engine.ts does
 * not already ignore. It exists to keep the honesty rules for each fact in
 * one pure, unit-testable place rather than inline in two components.
 *
 * Deliberately separate from `job-card-format.ts`: those helpers are shared
 * with `job-card.tsx`. Per M8, the swipe/feed card stays exactly as H left
 * it — nothing in this file is ever imported by job-card.tsx.
 */

/** Human-readable acquisition-platform name. `source` is a low-cardinality
 *  platform slug (see source-slug.ts), never a per-employer value. An
 *  unmapped slug (future C1-registry addition) is Title-cased rather than
 *  shown as a raw slug or as "unknown" — it is a real fact we simply don't
 *  have a hand-authored display name for yet. */
const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  curated: 'Curated by RemoteMatch',
  remotive: 'Remotive',
  arbeitnow: 'Arbeitnow',
  jobicy: 'Jobicy',
};

export function sourceDisplayName(source: string): string {
  const known = SOURCE_DISPLAY_NAMES[source];
  if (known) return known;
  if (!source) return 'Unknown';
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * M4 — `explicitRemoteScope` is a SEPARATE classifier from `remoteType`
 * (matching/eligibility, frozen): it answers "did the listing actually
 * state a scope" rather than "what scope does matching use" (which
 * defaults unmatched input to 'Worldwide'). `undefined` (a row from before
 * this attribute existed, or a source with no signal) is treated exactly
 * like 'unknown' — both mean "we don't have an explicit statement", never
 * a claim either way. Per M4's explicit wording constraint: `unknown` is
 * phrased as an absence of information, never as "not worldwide" or any
 * other negative claim.
 */
export function remoteScopeCaveat(scope: CanonicalOpportunity['explicitRemoteScope']): string {
  if (scope === 'explicit_worldwide') return 'This posting explicitly states worldwide remote work.';
  if (scope === 'explicit_restricted') return 'This posting explicitly states a geographic restriction.';
  return "This posting doesn't clearly state its remote geographic scope.";
}

/**
 * M3 — `salaryQuality` distinguishes a provider-confirmed number
 * ('verified') from one parsed out of free text ('estimated'). Only ever
 * attached when `formatSalary()` (job-card-format.ts) is ALSO going to
 * render a real number — never next to "Salary not listed".
 *
 * This matters because 'estimated' does not guarantee a numeric
 * salaryMin/salaryMax exists: per normalizeOpportunity()'s own logic
 * (pipeline.ts), 'estimated' fires whenever the provider supplied a
 * free-text salaryString, whether or not that string was ever parsed into
 * a number. A job can genuinely have `salaryQuality: 'estimated'` with
 * both salaryMin/salaryMax null — in that case formatSalary() correctly
 * shows "Salary not listed", and attaching an "Estimated" qualifier next
 * to that would be a self-contradicting label. The numeric check below
 * mirrors formatSalary()'s own condition exactly, so "a qualifier renders"
 * and "a real number renders" are always the same event.
 */
export function salaryQualifierLabel(
  opp: Pick<CanonicalOpportunity, 'salaryQuality' | 'salaryMin' | 'salaryMax'>,
): 'Reported' | 'Estimated' | null {
  const hasNumber =
    (typeof opp.salaryMin === 'number' && opp.salaryMin > 0) ||
    (typeof opp.salaryMax === 'number' && opp.salaryMax > 0);
  if (!hasNumber) return null;
  if (opp.salaryQuality === 'verified') return 'Reported';
  if (opp.salaryQuality === 'estimated') return 'Estimated';
  return null;
}

/** M1 — `linkCheckedAt` is, per its own type-level doc comment, "the one
 *  genuinely real freshness fact" available. Never invents a date when the
 *  link has not actually been checked yet (undefined/null -> null), same
 *  rule as `formatPostedAge()` and the public SEO page's existing
 *  identical note. */
export function linkVerifiedLabel(linkCheckedAt: string | undefined | null): string | null {
  if (!linkCheckedAt) return null;
  const t = new Date(linkCheckedAt).getTime();
  if (Number.isNaN(t)) return null;
  return `Link verified ${new Date(linkCheckedAt).toLocaleDateString()}`;
}

/**
 * M9/M10.1 — "Apply directly through the employer" is only asserted when
 * the data actually establishes it. For the built-in aggregator sources
 * (remotive/arbeitnow/jobicy), `officialUrl` is set to the exact same value
 * the aggregator's own API returned (`job.url`) — there is no domain
 * verification step, so it is NOT evidence the link goes to the employer's
 * own site rather than back through the aggregator. Only `curated` has
 * hand-authored, distinct sourceUrl/officialUrl pairs that were verified
 * against the real employer's own domain at authoring time.
 *
 * The C1 employer-domain allowlist (`allowlist_employers`) could someday
 * provide this evidence for other sources — it is created empty in
 * migration 012 and seeded only by C3, which has not shipped. This
 * function deliberately does NOT anticipate C3; it returns null for every
 * source but 'curated' today, and will only change when a future ticket
 * gives it real evidence to check.
 */
export function employerDirectApplyLabel(source: string): string | null {
  return source === 'curated' ? 'Apply directly through the employer' : null;
}

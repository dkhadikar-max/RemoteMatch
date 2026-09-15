import type { DescriptionConfidence, LinkedInJobProvenance } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — attribution/confidence presentation helpers
 * (plan §25). A NEW, PARALLEL module to src/lib/feed/trust-signals.ts —
 * deliberately not a modification of that file, since its existing
 * helpers assume Phase A/C1/P1-computed facts about persisted `opportunities`
 * rows that a LinkedIn result never has (plan §25's own reasoning).
 *
 * Every result from this feature must render the badges below — no
 * catalog-earned badge (48h-fresh, verified-remote, linkVerifiedLabel-style
 * copy) may ever be shown next to a LinkedIn Job Finder result; those are
 * earned only by src/lib/ingestion/*'s acquisition pipeline.
 */

export function linkedInBadgeLabel(): string {
  return 'LinkedIn';
}

export function provenanceBadgeLabel(provenance: LinkedInJobProvenance): string {
  return provenance === 'vendor_search' ? 'Found via job search' : 'You pasted this job';
}

/** Fixed microcopy pattern mirroring sourceDisplayName()'s naming
 *  convention (src/lib/feed/trust-signals.ts) with a dedicated entry for
 *  this feature, rather than a generic Title-cased fallback. */
export function attributionLine(): string {
  return 'From LinkedIn · Analysis by RemoteMatch';
}

/** Plan §25 point 4 — a truncated/excerpt-only description must prompt the
 *  user toward the higher-confidence paste path rather than silently
 *  presenting a coarse match as equivalent to a full-text one. */
export function confidenceLabel(confidence: DescriptionConfidence): string | null {
  if (confidence === 'full') return null;
  return 'Match based on a summary · Paste the full posting for a precise match';
}

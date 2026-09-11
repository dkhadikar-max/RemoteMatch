import type { CanonicalOpportunity } from '@/types/byn';
import { normalizeDemandPattern, demandPatternKey, type DemandPatternInput } from '@/lib/demand/pattern';

/**
 * Behavioral Feed Personalization (ticket N) — a bounded, post-processing
 * ORDERING layer only. Never touches eligibility, the opportunity set, or
 * fitScore/fitBadge themselves; never imports or modifies engine.ts.
 *
 * Contract (frozen per the N1–N11 review):
 *   - Server `swipes` is the only authoritative source of "what has this
 *     user decided" — never the client-side localStore cache.
 *   - A raw swipe event log is collapsed into the user's CURRENT,
 *     non-superseded decision per opportunity (`deriveEffectiveDecisions`).
 *     `rewind` is not itself a preference signal — it only modifies which
 *     prior decision is still in effect.
 *   - Only `'interested'` decisions contribute positive preference
 *     evidence. `'passed'` contributes ZERO — not a negative signal, an
 *     absence of one (N11). There is no penalty path in this module.
 *   - Personalization only activates once the user has
 *     MIN_DECISIONS_FOR_PERSONALIZATION effective decisions (any action).
 *     Below that, `applyBehavioralPersonalization` returns its input
 *     completely unchanged — same array, same order.
 *   - The nudge is capped at NUDGE_CAP points on the same 0-100 scale as
 *     fitScore, and is NEVER negative: `0 <= nudge <= NUDGE_CAP`. Final
 *     sort key = `fitScore + nudge`. Because both candidates in any
 *     comparison can receive up to NUDGE_CAP, the maximum possible
 *     BEHAVIORAL ADVANTAGE one candidate can hold over another is
 *     NUDGE_CAP points (the case where the lower-fit candidate is
 *     saturated at NUDGE_CAP and the higher-fit candidate gets 0) — so
 *     personalization can only change relative order when a candidate's
 *     real fitScore is behind by NUDGE_CAP points or less. A real
 *     fitScore gap greater than NUDGE_CAP can never be overcome.
 *   - Exclusion of already-decided opportunities (N3) is unconditional —
 *     it does not depend on the personalization threshold above.
 *   - Reuses `normalizeDemandPattern()`/`demandPatternKey()` (C2,
 *     pattern.ts) as the ONLY pattern representation — never a second
 *     interpretation of a job's pattern. `pattern.ts` itself is read-only
 *     here, never modified.
 *   - No cross-user signal of any kind: every function here operates on
 *     exactly one user's own effective decisions.
 */

export const MIN_DECISIONS_FOR_PERSONALIZATION = 5;
/** Points, same 0-100 scale as fitScore. See the bound proof above. */
export const NUDGE_CAP = 3;

export type SwipeAction = 'interested' | 'passed' | 'rewind';

export interface SwipeRow {
  id: string;
  opportunity_id: string;
  action: SwipeAction;
  created_at: string;
  rewound_decision_id: string | null;
}

export interface EffectiveDecision {
  opportunityId: string;
  action: 'interested' | 'passed';
}

/**
 * Collapses the append-only swipe event log into the user's CURRENT,
 * non-superseded decision per opportunity. A row referenced by a later
 * `'rewind'` row (via `rewound_decision_id`) contributed nothing — exactly
 * as if that decision never happened, regardless of how many raw events
 * exist. Current state, not raw event count, determines both exclusion
 * and preference:
 *   interested(A), rewind(A)                -> no effective decision for A
 *   interested(A), rewind(A), interested(A)  -> effective: interested(A)
 *   passed(A), rewind(A), interested(A)      -> effective: interested(A)
 *     (the passed row contributes nothing — not even a phantom negative)
 *
 * If more than one non-superseded decision still exists for the same
 * opportunity (only possible from data recorded before this ticket's
 * server-side exclusion fix), the most recent one wins.
 */
export function deriveEffectiveDecisions(rows: SwipeRow[]): Map<string, EffectiveDecision> {
  const rewoundIds = new Set(
    rows.filter((r) => r.action === 'rewind' && r.rewound_decision_id).map((r) => r.rewound_decision_id as string),
  );
  const survivors = rows
    .filter((r): r is SwipeRow & { action: 'interested' | 'passed' } => r.action !== 'rewind' && !rewoundIds.has(r.id))
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const byOpportunity = new Map<string, EffectiveDecision>();
  for (const r of survivors) {
    byOpportunity.set(r.opportunity_id, { opportunityId: r.opportunity_id, action: r.action });
  }
  return byOpportunity;
}

/**
 * N3 — unconditional, independent of the personalization threshold below.
 * A job the user has an effective decision on (either action) must never
 * appear in the deck again.
 */
export function excludeDecidedOpportunities<T extends { id: string }>(
  catalog: T[],
  effectiveDecisions: Map<string, EffectiveDecision>,
): T[] {
  if (effectiveDecisions.size === 0) return catalog;
  return catalog.filter((opp) => !effectiveDecisions.has(opp.id));
}

/**
 * The liked-pattern feature counts, derived ONLY from `'interested'`
 * effective decisions, and ONLY from opportunities still present in the
 * current active-catalog fetch (no new DB query, no admin-client use). An
 * expired liked job simply stops contributing an observation this cycle —
 * a documented, deliberate simplification, never a wrong signal (it can
 * only under-count, and the nudge is boost-only and capped regardless).
 */
export function computeLikedPatternCounts<T extends { id: string } & DemandPatternInput>(
  effectiveDecisions: Map<string, EffectiveDecision>,
  catalog: T[],
): Map<string, number> {
  const byId = new Map(catalog.map((o) => [o.id, o]));
  const counts = new Map<string, number>();
  for (const decision of Array.from(effectiveDecisions.values())) {
    if (decision.action !== 'interested') continue;
    const opp = byId.get(decision.opportunityId);
    if (!opp) continue;
    const key = demandPatternKey(normalizeDemandPattern(opp));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Boost-only (N11): `min(NUDGE_CAP, count)`, never negative. */
export function behavioralNudgeFor(
  opp: DemandPatternInput,
  likedPatternCounts: Map<string, number>,
): number {
  const key = demandPatternKey(normalizeDemandPattern(opp));
  const count = likedPatternCounts.get(key) ?? 0;
  return Math.min(NUDGE_CAP, Math.max(0, count));
}

/**
 * The full pipeline: exclude already-decided jobs (unconditional), then —
 * only once MIN_DECISIONS_FOR_PERSONALIZATION effective decisions exist —
 * reorder by `fitScore + nudge`. On a combined-score TIE (e.g. a gap of
 * exactly NUDGE_CAP points), the real, frozen `fitScore` wins the
 * tie-break — the softer behavioral signal only ever settles ties in
 * favor of the matcher, never against it. A genuine reorder (not just a
 * tie) only happens when the nudge closes MORE than the real gap, i.e. a
 * real gap strictly less than NUDGE_CAP. Below the personalization
 * threshold (or with zero decisions), the excluded-filtered list's order
 * is left completely untouched — byte-identical to calling
 * `scoreOpportunitiesForFeed` alone. `fitScore`/`fitBadge`/every other
 * field on each object is never mutated, only array position changes.
 */
export function applyBehavioralPersonalization<
  T extends CanonicalOpportunity & { fitScore: number } & DemandPatternInput,
>(scored: T[], effectiveDecisions: Map<string, EffectiveDecision>): T[] {
  const withoutDecided = excludeDecidedOpportunities(scored, effectiveDecisions);

  if (effectiveDecisions.size < MIN_DECISIONS_FOR_PERSONALIZATION) {
    return withoutDecided;
  }

  // IMPORTANT: pattern counts are derived from `scored` (the full,
  // pre-exclusion catalog), never from `withoutDecided`. A liked job is BY
  // DEFINITION excluded from the output pool below — if its pattern were
  // looked up against the already-excluded list, no liked job's pattern
  // could ever be found, and the nudge would always be zero. `scored` is
  // "this cycle's active-catalog fetch", the same source
  // computeLikedPatternCounts's own contract already describes.
  const likedPatternCounts = computeLikedPatternCounts(effectiveDecisions, scored);
  if (likedPatternCounts.size === 0) {
    // No liked-pattern signal available this cycle (e.g. every liked job
    // has since left the active catalog) — nothing to nudge toward.
    return withoutDecided;
  }

  return withoutDecided
    .map((opp, index) => ({ opp, index, nudge: behavioralNudgeFor(opp, likedPatternCounts) }))
    .sort((a, b) => {
      const rankA = a.opp.fitScore + a.nudge;
      const rankB = b.opp.fitScore + b.nudge;
      if (rankB !== rankA) return rankB - rankA;
      if (b.opp.fitScore !== a.opp.fitScore) return b.opp.fitScore - a.opp.fitScore;
      return a.index - b.index; // stable: preserve original relative order on a full tie
    })
    .map((w) => w.opp);
}

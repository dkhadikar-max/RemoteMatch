# Main Feed Retrieval: Correctness-First Design

## Status

Phase 1 characterization and observability are implemented: the feed route records opt-in stage timings, the matcher’s stable tie ordering is explicit, and CI runs a golden characterization suite plus a reproducible synthetic benchmark. Candidate retrieval and API pagination remain design proposals; no candidate filtering or feed pagination has shipped.

## Problem

`POST /api/opportunities/feed` obtains the complete fresh, translation-safe catalogue through `getFeedCatalog()`, removes superseded rows, scores every remaining opportunity with `scoreOpportunitiesForFeed()`, applies the Pro career-transition explanation layer and the user's effective swipe decisions, then returns the complete ranked list. The feed page stores that full list and applies its filters and deck behaviour client-side.

The process-local TTL cache reduces repeated database reads per warm runtime, but it does not reduce the first read's row count, the memory footprint, the per-profile scoring work, or cross-instance cache duplication.

## Non-negotiable behavioural invariants

1. Keep `computeScreeningFit`, `checkHardEligibility`, `skillMatches`, and the score weights unchanged.
2. Preserve the exact 48-hour freshness boundary and translation-safe visibility rules.
3. Preserve cross-provider supersession exclusion on the scored path only.
4. Preserve server-authoritative Pro/change-fields gating and effective swipe exclusion/personalization.
5. Preserve stable ranking for equal scores. The current implementation preserves stable JavaScript sort semantics by explicitly using original catalogue order as the equal-score tie-breaker; a paginated design must preserve and test this ordering.
6. Do not silently omit opportunities that the current matcher could rank. A database candidate query must be proven to be a superset of the legacy input set for the supported profile shape, or the request must use the legacy path.
7. Do not introduce a hard candidate LIMIT before proving top-K equivalence. A LIMIT can return a plausible but incomplete feed.

## Why a simple SQL filter is incorrect

The matcher contains fuzzy/alias skill matching via `skillMatches()`, target-role substring matching over title and required-skill text, generic-role fallback based on skill overlap, and profile-dependent eligibility. A SQL predicate over raw profile skill strings or exact title terms is not equivalent. In addition, the existing API returns all rows, including low-fit/ineligible rows, and the UI uses the complete set for counts, filters, and empty states. Replacing it with a limited result would be an API and UX contract change, not a transparent query optimization.

## Proposed staged implementation

### Phase 1 — Characterization and observability

- Implemented golden matcher characterization for ordered IDs/scores, equal-score ties, skill aliases/case normalization, ambiguous-title taxonomy collisions, all declared remote scopes, employment mismatch, null/default defaults, supersession ownership, and generic/specific role combinations.
- Record legacy ordered IDs and scores as the reference output (initial golden corpus implemented).
- Implemented opt-in stage timings/counters for catalogue, scoring, personalization, response bytes, and process memory. Cache hit/miss detail remains outstanding.
- A synthetic matcher-only benchmark runs at 25k/50k/100k rows and reports p50/p95; production-shaped data and end-to-end feed retrieval/HTTP baselines remain outstanding.

### Phase 2 — Retrieval projection, not lossy filtering

- Define a dedicated, transactionally maintained retrieval projection with normalized searchable tokens/aliases and the exact dimensions needed by candidate retrieval.
- Reuse existing PostgreSQL indexes where suitable; add indexes only after EXPLAIN (ANALYZE, BUFFERS) demonstrates the intended access path.
- Keep full opportunity payload retrieval separate from the narrow candidate-ID/score-input read.
- Design candidate generation as a conservative superset. If a profile cannot be represented safely by the projection, fall back to the legacy full-catalogue path.
- Do not add Redis or an external search engine until measured cross-instance cache duplication or query latency justifies it.

### Phase 3 — API and UI pagination

- Introduce a versioned feed API contract with opaque, stable cursors and bounded page sizes.
- The server must preserve global ranking semantics. Cursor pagination over a partially scored candidate set is not acceptable unless the retrieval layer can prove that no unseen candidate can outrank the returned page.
- Move filter/count/empty-state semantics deliberately; do not pretend page-local counts are global counts.
- Preserve swipe exclusions and behavioral personalization consistently across pages. Define how a new swipe changes cursor validity.
- Keep the legacy endpoint available behind a server-side rollout flag until parity and performance gates pass.

### Phase 4 — Shadow parity and rollout

- Run old and new retrieval in shadow mode for representative profiles.
- Compare candidate-set inclusion, ordered top-K IDs, scores, eligibility, transition annotations, and effective-decision exclusions.
- Require zero false negatives in the legacy eligible/top-K reference set across the golden corpus and sampled shadow traffic.
- Compare p50/p95 latency, database buffers, rows transferred, response bytes, and memory. Roll out only when correctness is exact and the measured improvement is material.
- Retain an immediate server-side rollback to the legacy path.

## Acceptance gates

- No regression in the existing feed, freshness, scoring, career-transition, personalization, swipe, and filter suites.
- Golden-corpus parity: exact ordered IDs and scores for the legacy response, or an explicitly approved and separately tested UX contract change.
- Candidate-superset property tests: every legacy candidate that can appear in the returned top-K is present in the new candidate set.
- Stable cursor tests: no duplicates or gaps across page boundaries under a fixed catalogue snapshot.
- Query-plan evidence: intended indexes used; bounded rows/bytes returned; no accidental sequential full-catalogue scan.
- Shadow benchmark reports p50/p95 and resource deltas against the same dataset and profile corpus.

## Scope exclusions

- No scoring-weight changes.
- No fuzzy matcher changes.
- No production schema/data changes in this proposal.
- No Redis dependency.
- No deployment or merge authorization implied by this document.

## Current implementation facts

- `catalog-cache.ts` caches the shared feed catalogue per runtime and reapplies freshness in memory.
- `catalog-read.ts:getActiveOpportunities()` fetches all qualifying rows in 1,000-row PostgREST ranges.
- `feed/route.ts` scores the full array and returns the complete result.
- `feed/page.tsx` stores the full result and applies filters client-side.
- The existing feed egress and profile-scoring suites provide useful baseline protections; they do not yet prove candidate retrieval parity.

# AI Phase 2A — Post-Deployment Production Audit (Measurement & Integrity)

**Status: Measurement audit + one verified, narrowly-scoped fix.** Findings below come from live queries against the real production Supabase tables (`ai_quota_ledger`, `ai_quota_employer_ledger`, `ai_call_events`, `ai_spend_ledger`, `opportunities`), 8 bounded free-tier Gemini calls made in the course of investigating the flagged finding (§1 — 3 synthetic-content reproductions that did not explain it; 1 direct diagnostic call against Coalition Technologies' real live content that did; and 4 real calls consumed by one confirmatory re-run of `career-page-provider-suite.ts` against the real employer cohort), and one real, root-caused, verified code fix (§1's "Fix applied and verified" — `discoverJobPostingLinks()`'s self-reference exclusion, in `src/lib/providers/career-page.ts`). No OpenAI calls were made at any point in this audit. No migration was written. **The fix is committed but not yet pushed/deployed** — push/deploy remain their own separate authorization gates, unchanged from every prior phase's discipline.

**Context this audit must be read against**: both AI phases deployed only hours before this audit (Phase 1A `d32cc33`, Phase 1B `8e6cc86`). Railway's C5 cron has never been configured (a separately-tracked, pre-existing gap — not part of either AI phase, **still not configured as of this update**). **Correction to this document's initial version**: the 16 (now 20) real Gemini extraction failures were originally attributed to `career-page-provider-suite.ts`'s own synthetic test-fixture employers. That attribution was wrong and has been corrected below — the real source is the **actual C5 validation cohort** (virtual7 GmbH, Coalition Technologies, Axiom Law, Canonical), a set of real, human-approved employers registered in production hours before this session's AI work began. `career-page-provider-suite.ts`'s real-infra section queries `allowlist_employers` unscoped by test-run identity, so every run of that suite also exercises these real employers' real, live career pages — not just its own synthetic fixtures. This is corrected here rather than left standing, per standing project discipline against leaving an inaccurate record in place once the real explanation is known.

---

## 1. Gemini

| Metric | Measured value | Assessment |
|---|---|---|
| Requests/day vs. free-tier capacity | **20 used / 20 limit** (`ai_quota_ledger`, `gemini-3.5-flash-lite`/`c5_extraction`, 2026-09-14) — 100% of the provisional evidence-based limit, exhausted for the rest of the UTC day by this audit's own investigation work (the original 16 plus 4 more from the confirmation re-run below) | Ledger tracking itself is correct; the *consumption* is 100% this session's own testing/regression-suite activity against real employer pages, not independent end-user or cron traffic |
| Reservation → consume/refund correctness | ✅ Correct — `requests_reserved: 0` on the live row (no stuck reservations); every real attempt has a matching `ai_call_events` row | Matches the `ai-quota-ledger-suite.ts` (10/10) and `ai-ledger-failsafe-suite.ts` (5/5) regression evidence already established pre-deploy |
| Employer soft-cap behavior | 4 distinct `employer_id`s recorded — **all 4 are the real, human-approved C5 validation cohort** (virtual7 GmbH, Coalition Technologies, Axiom Law, Canonical; registered 2026-09-14 11:34, hours before this session's AI work), **not synthetic test fixtures** (corrected from this document's original version — see the note at the top). Coinbase, the 5th cohort member, shows zero activity (independently confirmed 403-blocked from Railway egress, a pre-existing, unrelated finding from earlier this session) | Soft-cap mechanics themselves are sound; no employer has hit its cap ceiling |
| Cache hit/miss rate | 1 hit / 20 misses in `ai_call_events`, and the 1 hit is a test artifact (`gemini-cache-suite.ts` seeds and hits a synthetic cache entry as part of its own assertions) | **0% real cache utilization** so far — expected, zero real repeat-posting traffic has occurred yet |
| 429/403/5xx rates | 0 occurrences of `quota_exceeded_429`, `service_unavailable_503` in Gemini events | No rate-limit or availability pressure observed |
| Successful extraction rate | 1 of 21 events = `success` (the test-artifact cache hit). **0 of 20 fresh extraction attempts against real employer pages succeeded.** | **Root-caused below — see "Confirmed root cause" and "Fix applied."** |
| Evidence-validation rejection rate | Not measurable from `ai_call_events` alone (runs downstream in `career-page.ts`, after a *successful* extraction — never reached with zero successful fresh extractions) | N/A this cycle |

### Investigation: 20/20 fresh Gemini extraction attempts recorded `outcome: 'malformed_response'`

**Stage 1 — 3 synthetic-content reproduction attempts (did not explain it)**: a clean realistic career-page text, a deliberately messy boilerplate-heavy text, and the exact `NON_JOBPOSTING_LD_PAGE` fixture from `career-page-provider-suite.ts` itself — all 3 succeeded cleanly against the real deployed model (`gemini-3.5-flash-lite`), ruling out "the model is broadly broken on this content shape" but not identifying the real cause.

**Stage 2 — corrected attribution**: a ledger-delta comparison (before/after re-running `career-page-provider-suite.ts` once more, live) showed the exact same 4 employer UUIDs from the original 16 incrementing again — not fresh synthetic UUIDs. Querying `allowlist_employers` directly for those 4 IDs returned the **real C5 validation cohort** (virtual7, Coalition Technologies, Axiom Law, Canonical), confirming `career-page-provider-suite.ts`'s real-infra section queries the real `allowlist_employers` table unscoped, so it always also exercises these real, already-approved employers alongside its own synthetic fixtures — and always has, independent of either AI phase.

**Stage 3 — confirmed root cause, using real production content**: fetched Coalition Technologies' actual live page (`coalitiontechnologies.com/jobs`) and ran it through the real pipeline functions directly:
- The page is a genuine **28-job index listing** ("Total Jobs Found: 28"), not a single posting.
- A raw Gemini call with this real content (bypassing the ledger, since quota was already near its limit) returned **valid, well-formed JSON with every field correctly set to `null`** — Gemini followed its own prompt instruction exactly ("do not look for or invent any other posting... leave null rather than guess") given content that doesn't isolate to one posting. **This is the anti-fabrication safeguard working as designed, not a Gemini defect.** The shape guard then correctly rejected the all-null response (`title` must be a non-empty string) as `malformed_response` — also working as designed.
- The real defect is one layer upstream: `discoverJobPostingLinks(html, url)` on Coalition's real page returned exactly one "discovered" link — **the page's own URL**, `https://coalitiontechnologies.com/jobs` — a self-referencing nav/anchor link that passed every existing filter (job-shaped path, same-origin, not a static asset) because nothing excluded the origin page's own URL from its own candidate set. That self-reference then gets "discovered," re-fetched (identical 28-job content), and routed into single-posting extraction as if it were an isolated sub-page.

### Fix applied and verified: `discoverJobPostingLinks()` self-reference exclusion

**Change** (`src/lib/providers/career-page.ts`): the function's Pass 1 now excludes any resolved candidate URL that equals the origin page's own URL (fragment-stripped, matching the existing dedup convention). One added comparison, no change to any other filter, dedup, or locale-collapse rule already in the function.

**Verification, no further Gemini calls used** (quota was already exhausted; verified via the real, unmodified `discoverJobPostingLinks()`/`detectPageKind()` functions run directly against freshly-fetched real HTML — zero API cost):
- Coalition Technologies: **0 links** discovered post-fix (down from 1 self-reference) — correctly stops routing the 28-job listing into single-posting extraction.
- virtual7 GmbH: **10 real, distinct sub-links** still discovered, unchanged — confirms the fix does not regress legitimate discovery.
- Axiom Law: **6 real, distinct sub-links** still discovered, unchanged.
- Canonical: **10 real, distinct sub-links** still discovered, unchanged.
- Full regression: `career-page-provider-suite.ts` re-run in full — **54 passed, 0 failed, 1 skipped**, identical count to before the fix. `career-page-dedup-suite.ts` — **9/9**, unaffected. `tsc --noEmit` and `npm run build` both clean.

**This fix resolves Coalition Technologies' specific case only.** It does not claim to explain all 20 failures — see the separate finding below.

### Separate, unfixed finding: discovered sub-links are never re-classified before single-posting extraction

Investigating virtual7's real discovered sub-links (all real, distinct URLs, not self-references, so unaffected by the fix above) surfaced a second, architecturally distinct gap: one of virtual7's legitimately-discovered links, `https://virtual7.de/unternehmen/jobs/`, is **itself another index/listing page**, not a single posting — confirmed via `detectPageKind()` on its real fetched content. `detectPageKind()` is only ever called once, on the *root* career page, to decide whether to enter discovery at all; it is never re-run on each *discovered* sub-link before that sub-link is committed to single-posting Gemini extraction. This is a different failure shape from the self-reference bug (different URL, same domain, genuinely "discovered") and likely explains at least part of virtual7's and Axiom Law's remaining failures, though this was not exhaustively traced to every one of their individual events.

**This finding is explicitly recorded, not fixed.** It requires its own separate scoping and authorization — C5 needs page-kind classification at both the root *and* discovered-link levels, and that second-layer change should not be bundled into the narrowly-scoped self-reference fix above.

**Current state, preserved as of this update**: Gemini quota remains at 20/20 for 2026-09-14 (no further calls made since Stage 3). **C5 cron remains unconfigured — this audit does not recommend enabling it**, both because the self-reference fix is not yet deployed and because the separate discovered-sub-link finding remains open.

---

## 2. OpenAI

| Metric | Measured value | Assessment |
|---|---|---|
| Calls/day and estimated actual spend | 2 calls, $0.0029 total (both from the explicitly-authorized live verification, not independent traffic) | Exactly matches the reported verification — no unaccounted-for spend |
| Daily/monthly cap utilization | $0.0029 / $5.00 daily (0.06%), $0.0029 / $50.00 monthly (0.006%) | Enormous headroom; caps are correctly far from being tested by real volume yet |
| Reservation estimate vs. reconciled actual cost | Both real calls: reservation estimate $0.0042 each; reconciled actual $0.0015/$0.0014 (~$0.0029 total) — confirms the estimate is conservative (never under-reserves) and the Fix 2 hardening (reconciled cost now correctly flows to `ai_call_events`, verified live post-deploy) | Working exactly as designed |
| Successful vs. rejected generations | 2/2 `outcome: 'success'` at the API level; **0/2 passed the anti-fabrication check** — both fell back to the deterministic template | Anti-fabrication is doing real work, not a rubber stamp (see below) |
| Anti-fabrication rejection rate | 2/2 (100%) in this small sample — both rejections traced to the same real, pre-existing prompt characteristic: `materials.ts`'s prompt lists ALL claimed skills (verified or not) in "Core Skills," and the model naturally referenced an unverified one ("Go"), correctly caught by `isGeneratedKitSupported()` | **Provider-agnostic, pre-existing behavior** — this exact prompt/safeguard interaction predates Phase 1B and would reject the same way under Gemini; not a regression |
| Token usage by workload | `o3_o4_materials`: 2291 tokens across 2 calls. `resume_parsing` / `resume_intelligence`: **zero events** — expected, since O5 (`resume.ts`/`resume-intelligence.ts`) remains structurally unreachable in production (the pre-existing, separately-tracked client/server bug, untouched by either AI phase) | Matches the known, documented O5 HELD status exactly — not a gap in this audit |

**Worth flagging as its own small observation, not urgent**: the 100%-rejection sample is only 2 calls — not enough to say whether this specific prompt (which lists unverified skills without evidence-filtering) will reject at a similarly high rate under real, varied candidate/job pairings, or whether Marcus-Vance-style "claimed skill absent from resume" cases are unusually common in the real candidate pool. Worth re-measuring once real user-triggered `o3_o4_materials` volume exists — not a code issue, a data question.

---

## 3. Cross-cutting

| Check | Result |
|---|---|
| `ai_call_events` completeness/consistency | ✅ Every real Gemini/OpenAI call this session has a matching event row; no orphaned reservations (`requests_reserved`/`reserved_cost_usd` both at 0 on the live rows) |
| No secrets/full user content in telemetry | ✅ Verified by reading every row directly, not just trusting the schema: only the 10 designed columns present, no unexpected columns, no string value over 200 chars anywhere (the schema structurally can't hold a prompt or generated document — confirmed empirically, not just by design) |
| No cross-user data contamination | ✅ By construction — none of the 4 new tables carry any user-identifying column at all (no `profile_id`/`user_id`/email anywhere in `ai_quota_ledger`/`ai_quota_employer_ledger`/`ai_call_events`/`ai_spend_ledger`'s schemas); confirmed against the actual migration DDL, not assumed |
| Provider failures fail closed | ✅ Confirmed twice over: by code inspection (every reservation/consume path degrades to "not allowed"/deterministic fallback on any error) and by the real, live-reproduced synchronous-throw regression test (`ai-ledger-failsafe-suite.ts`, 5/5) that specifically proves this rather than assuming it |
| No unintended Gemini calls from the 3 OpenAI-routed workloads | ✅ **0** Gemini events carry a feature other than `c5_extraction` (direct query, not inferred) |
| No unintended OpenAI calls from C5 | ✅ **0** OpenAI events carry a feature outside `{o3_o4_materials, resume_parsing, resume_intelligence}` (direct query) |

---

## 4. Production integrity

| Check | Result |
|---|---|
| `/api/health` remains `8e6cc86` | ✅ Confirmed live, re-checked at time of this audit (`2026-09-14T17:06:03Z`) |
| Existing C3/C5 ingestion behavior unchanged | ✅ Structurally — no C3-owned code/table touched by either AI phase or by the §1 fix (`discoverJobPostingLinks()` is C5-owned, added during C5's own original implementation, not C3). C5 has published **zero** `careerpage`-sourced opportunities in production to date — consistent with the §1 findings and with C5 cron never having been configured; not a regression, but also not yet a proven end-to-end real-content success (the self-reference fix removes one confirmed cause of that; the separate discovered-sub-link finding remains open) |
| Existing application flow unchanged | ✅ `gate3-ai-factuality.ts`'s real live-call run exercised the actual O3/O4 swipe-triggered code path end-to-end (29/29) with no change to `reserve_proposal()` or any existing quota mechanism |
| No quota/spend ledger anomalies | ✅ Every number reconciles: Gemini `requests_used` (20) matches the sum of real (non-cache-hit) `ai_call_events` Gemini rows exactly; OpenAI ledger total ($0.0029) matches the sum of both real `ai_call_events` reconciled costs exactly |

---

## Decision gate

This audit does not produce one blanket verdict — the provider paths, and now the two distinct Gemini-side findings, measure differently and collapsing them into one word would hide real distinctions.

- **OpenAI path (ledger, caps, reconciliation, anti-fabrication, no cross-contamination): PASS.** Freeze and observe.
- **Cross-cutting/production integrity (telemetry hygiene, fail-closed behavior, no cross-provider leakage, deploy integrity): PASS.** Freeze and observe.
- **Gemini ledger/cache/soft-cap infrastructure: PASS.** Confirmed sound both by pre-deploy regression evidence (10/10, 5/5, 6/6) and by this audit's live reconciliation — not the source of any finding here.
- **C5 self-reference discovery bug: RESOLVED, root-caused against real production content, fixed, and regression-verified (54/54, 9/9, clean build).** Committed. **Not yet pushed or deployed** — that remains its own separate authorization gate, and the fix has accordingly not been production-tested yet.
- **Second finding (discovered sub-links not re-classified before extraction): BLOCK, open, unfixed, not yet scoped.** Requires its own separate audit/authorization cycle before any change is made — explicitly not bundled into the self-reference fix.
- **C5 Railway cron: BLOCK — still not recommended.** Two independent reasons now, not one: the self-reference fix (however well-verified) hasn't reached production yet, and the second, separate finding remains completely open. Do not enable cron until both are resolved and the self-reference fix has been observed working correctly against real deployed traffic.

**Explicitly not recommended, per your framing, still true after this update**: no Redis, queue, RAG, LangGraph, retry/backoff expansion, or additional provider complexity. Both Gemini-side findings are page-classification/discovery-logic questions, not infrastructure or scale questions.

## Next steps (in order, per the agreed sequence)

1. ~~Update this document~~ — done, this revision.
2. Documentation/static validation only, no further Gemini calls — done (`tsc`/`build`/existing suites re-verified as part of the fix's own verification above; no new calls needed for the doc update itself).
3. Commit the self-reference fix together with this document update, as one unit — the audit is documenting a verified defect and its remediation together, not two unrelated changes.
4. Push/deploy: separate authorization gates, not covered by the commit authorization.
5. Scoping the second (discovered-sub-link) finding: explicitly deferred until after step 3 is committed and, per your instruction, until the first correction has been production-tested — not started in this document.

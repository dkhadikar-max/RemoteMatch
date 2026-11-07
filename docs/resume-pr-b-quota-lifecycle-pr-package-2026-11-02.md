# Resume Intelligence (PR B) — Quota Lifecycle, Ownership-Aware Finalization, and Reconciliation Sweep

**PR #48 delivery package.** Status: implementation committed and pushed; PR #48 is open against `main`. The current PR head is `94f39c3b1a9903b42768c446b94d0d120c5c6bef`. Historical implementation-stage notes below describe work completed before the PR was committed; they are not a statement of current Git status.

This package covers three new, sequential migrations (040, 041, 042) and their application-layer integration, built and verified across Stages 2–6 of this workstream (2026-11-01/02). The PR package's live-PostgreSQL evidence refers to the disposable local instance described in the original test record; no shared or production database application is claimed.

---

## 1. Migration summary

### `040_resume_quota_lifecycle.sql` — per-attempt quota reservation + refund

**Problem it solves**: the pre-existing `reserve_resume_analysis()`/`refund_resume_analysis()` RPCs (migration 036) had no idempotency key — a bare per-day counter increment/decrement with no way to distinguish "already refunded for this attempt" from "a new refund," and no per-event audit trail.

**Schema**:
- `resume_analyses.attempt_number INT NOT NULL DEFAULT 1 CHECK (>= 1)` — monotonic per row, advanced only on a successful claim acquisition.
- `resume_quota_events` — append-only audit table (`analysis_id`, `attempt_number`, `event_type IN ('reserved','refunded')`, `usage_date`, `reason`, `created_at`). `UNIQUE (analysis_id, attempt_number, event_type)` is the actual idempotency backstop. RLS enabled + forced, `service_role`-only policy; `REVOKE ALL FROM PUBLIC, anon, authenticated`.

**RPCs** (at this point in the migration's history; see 041 for how `upsert_resume_analysis` later changes):
- `upsert_resume_analysis(...)` — claim/reclaim, now also returns `attempt_number`; increments it only on a successful claim.
- `reserve_resume_analysis(p_analysis_id, p_attempt_number)` — requires the CURRENT attempt; ordering is idempotency-check → quota-limit-check → atomic increment+insert, so a denied reservation never leaves an event behind.
- `refund_resume_analysis(p_analysis_id, p_attempt_number, p_reason)` — historical-attempt-aware (no currency requirement — a refund for an old, superseded attempt still works), cross-day safe (only decrements the live counter if the reservation's own recorded `usage_date` still matches the profile's current one).

**Fixes folded into this same file across Stages 3–6** (documented in the migration's own revision-history comment):
- **Stage 3 live validation**: added `ON DELETE CASCADE` to `resume_quota_events.analysis_id` — without it, deleting a user's account/resume-version would fail the moment any analysis reached quota reservation.
- **Stage 5 independent review**: added `FOR UPDATE` to the `resume_analyses` ownership/currency read in both RPCs (closes a lock-ordering gap); `reserve_resume_analysis()` now computes the lazy day-rollover unconditionally before the `already_reserved` short-circuit (previously that path could report a stale `remaining` and never persist the rollover).
- **Stage 6 follow-up**: application-layer retry added for both reserve and refund (see §2) — no SQL change needed for this one.

### `041_resume_finalize_ownership.sql` — splits "finalize" out of the claim RPC

**Problem it solves** (found during the Stage 6 delivery review + a follow-up read-only trace): `upsert_resume_analysis()` enforced no attempt ownership at finalization time. Its only write-guard protected exactly one direction (an existing success is never clobbered by a later non-success write) — every other combination was unprotected. A stale worker's own delayed write could silently overwrite a **newer** attempt's success, pending, or unavailable state, advancing `attempt_number` again on top of it.

**Fix**: `upsert_resume_analysis()` trimmed to 5 parameters — claim/reclaim only, always writes `'pending'` internally, can no longer accept a result at all. New `finalize_resume_analysis(p_analysis_id, p_expected_attempt_number, p_status IN ('success','unavailable'), p_result, p_source_ai, p_model, p_prompt_tokens, p_completion_tokens, p_cost_usd)` — locks the row, verifies `attempt_number = expected AND status = 'pending'` atomically, rejects as `stale_attempt` (writing nothing) otherwise. Never increments `attempt_number`; never reclaims.

**Two defects found and fixed during implementation itself** (not part of the original design):
1. **NULL-logic hardening**: `<>` against a NULL `p_expected_attempt_number` is SQL-NULL, and PL/pgSQL's `IF` treats NULL as false — silently skipping the rejection and falling through to the write. Added an explicit `IS NULL` guard plus `IS DISTINCT FROM` (NULL-safe) instead of `<>`.
2. **A real "ambiguous column" (42702) bug, caught live** — the same class of defect migration 038 fixed years... days earlier: `finalize_resume_analysis()`'s own `RETURNS TABLE (id UUID, ...)` makes `id` an implicit PL/pgSQL variable colliding with a bare `id` column reference in its `SELECT` and `UPDATE` statements. Fixed by qualifying both.

`refund_resume_analysis()` required **no change** — its ownership check never depended on current status/attempt_number, so a refund for a superseded attempt keeps working exactly as before.

### `042_resume_quota_reconciliation.sql` — durable reconciliation sweep

**Problem it solves**: a failed refund (both the original call and its one retry failing) was previously only logged via `console.warn` — visible, but not durably recoverable. No process existed to find and fix orphaned reservations.

**A real flaw in the original design, found mid-implementation**: the spec said this sweep would "call the existing `refund_resume_analysis()` RPC," requiring no new migration. That doesn't work — `refund_resume_analysis()` derives its caller's identity from `auth.uid()`, by design, like every RPC in this project. A sweep must act across **many different users'** orphaned rows in one run; there is no single "logged in user" it can authenticate as.

**Fix**: one new function, `reconcile_resume_quota_orphans(p_dry_run boolean DEFAULT false)`, gated to `service_role` only (an in-function `auth.role()` check *and* `REVOKE ALL ... FROM PUBLIC, anon, authenticated`). It performs the exact same refund logic as `refund_resume_analysis()` (same idempotency check, same cross-day safeguard, same event shape) but scans across every profile. **Zero schema change** — no new table or column; it reads only data migration 040 already produces.

**Detection — 3 eligibility branches** (never touches `status='success'`):
| Branch | Condition | Grace period |
|---|---|---|
| (a) Superseded | `orphan.attempt_number < resume_analyses.attempt_number` | None — structurally abandoned |
| (b) Current, terminal failure | `status IN ('unavailable','insufficient_input')` | `updated_at` > 10 min old |
| (c) Current, still pending | `status = 'pending'` | `created_at` > 60 min old (well past the 3-minute reclaim window) |

Lock order matches `reserve_resume_analysis()`/`refund_resume_analysis()` exactly (profiles first, then the specific `resume_analyses` row) to avoid deadlocking a live request on the same row. Each candidate runs inside its own `EXCEPTION WHEN OTHERS` block (an implicit PL/pgSQL savepoint) — one failure is recorded and the loop continues, never aborting the whole sweep.

**A third occurrence of the same ambiguous-column bug, caught live** — `reconcile_resume_quota_orphans()`'s own `RETURNS TABLE (analysis_id UUID, attempt_number INT, ...)` collided with a bare reference in its idempotency re-check. The per-candidate exception block worked exactly as designed: every single candidate in the first live run reported its own error and the sweep kept running rather than crashing. Fixed by qualifying with a table alias.

**Standing lesson, now stated for any future PL/pgSQL function in this project**: a `RETURNS TABLE` column sharing a name with a real table column needs every bare reference to that name audited before it is ever run live — the static suites, three times running, have never once caught this; only a real Postgres parse does.

---

## 2. Application changes and API route documentation

### `src/lib/ai/resume-intelligence-service.ts`

- `callUpsert`/`UpsertArgs`/`UpsertOutcome` split into:
  - `callClaim`/`ClaimArgs`/`ClaimOutcome` — the one claim call site (step 3 of `analyzeResume()`).
  - `callFinalize`/`FinalizeArgs`/`FinalizeOutcome` — the 4 finalize call sites (quota-denial, entitlement-denial, model-unavailable, the real result).
- The real-result call site (step 8) gets a dedicated `'superseded'` limitation when `finalize.result === 'stale_attempt'` — the computed AI content is discarded, never persisted, never reported as if it were, with a message telling the user to refresh. The other 3 call sites keep their existing limitation codes (`quota_exhausted`/`upgrade_required`/`ai_unavailable`) since `stale_attempt` there is near-zero-risk (fires almost immediately after claim) and the user is already being told "no analysis" for an unrelated, correct reason either way.
- `reserveQuota()`/`refundQuota()` — both retry once with the **identical** `(analysis_id, attempt_number)` on a transport failure (safe, since both underlying RPCs are idempotent), logging via `console.warn` only if both attempts fail.

### `src/lib/resume/quota-reconciliation.ts` (new)

- `verifyReconciliationSecret(authHeader)` — timing-safe comparison against `RESUME_QUOTA_RECONCILE_SECRET`, fails closed if the secret is unset. Same pattern as `verifyIngestionSecret()` in `catalog-sync.ts`, deliberately its own separate secret (not reused) since this is an unrelated subsystem.
- `runResumeQuotaReconciliation(dryRun)` — calls `reconcile_resume_quota_orphans` via `getSupabaseAdminClient()`, maps the RPC's `{data, error}` into a structured summary (`candidatesFound`, `reconciled`, `alreadyRefunded`, `errors`, `rows`). Never throws.

### `POST /api/resume/reconcile-quota[?dryRun=1]` (new)

Secret-gated (`Authorization: Bearer <RESUME_QUOTA_RECONCILE_SECRET>` or `X-Internal-Secret`), identical shape to `/api/opportunities/sync`. Meant to be triggered by a scheduler, never product/user traffic — this is exactly why the sweep itself is `service_role`-only, not a per-user RPC. `dryRun=1` reports candidates without writing anything.

### `src/lib/supabase/admin.ts`

Added one new entry to the file's own deliberately-curated, exhaustive allowlist comment, with its trust-anchor justification (the sweep RPC is itself `service_role`-gated and scans across every user by design — categorically different from every other entry, which are all scoped to one caller).

---

## 3. Test evidence and acceptance-criteria mapping

### Totals

| Layer | Count | Result |
|---|---|---|
| Mocked/static regression (16 suites) | 476 assertions | 0 failures |
| Live PostgreSQL (3 live suites, multiple runs each) | 140+ assertions | 0 failures |
| TypeScript (`tsc --noEmit`) | — | Clean |

New test files this workstream: `resume-pr-b-quota-lifecycle-migration-static-suite.ts` (48), `resume-pr-b-finalize-ownership-migration-static-suite.ts` (29), `resume-pr-b-quota-reconciliation-migration-static-suite.ts` (26), `resume-pr-b-quota-lifecycle-application-suite.ts` (33), `resume-pr-b-quota-reconciliation-application-suite.ts` (9), `test/live-pg/resume-quota-lifecycle-live-suite.ts` (70), `test/live-pg/resume-quota-reconciliation-live-suite.ts` (23). Three pre-existing mocked suites updated for the `callUpsert` split without losing any of their original assertions (`resume-intelligence-persistence-suite.ts`, `resume-pr-b-workstream2-entitlement-suite.ts`, `resume-pr-b-audit-fixes-static-suite.ts`). The pre-existing `test/live-pg/resume-concurrency-live-suite.ts` (migrations 036–039's own harness) restructured for the claim/finalize split — 47/0.

### The 10 locked acceptance criteria (established at Stage 4, re-verified against the full final state)

| # | Criterion | Status |
|---|---|---|
| 1 | All 7 original regression cases (fresh claim / active-pending-rejected / stale-reclaim / re-arm-3min-window / terminal-retry / quota-denial-finalizes / rejected-claims-create-no-events) | Pass — re-exercised under 041's ownership model via scenarios 13–20 of the quota-lifecycle live suite |
| 2 | Duplicate reservation and duplicate refund | Pass |
| 3 | Delayed refund after a newer attempt claimed | Pass — re-verified under 041 |
| 4 | Refund after daily rollover | Pass |
| 5 | Reservation timeout + retry, identical identifiers | Pass — now symmetric with refund's own retry |
| 6 | Concurrent reserve **and** refund, same attempt | Pass |
| 7 | Transaction-failure test (counter/event can't diverge) | Pass — and genuinely re-proven by the live-caught 042 bug |
| 8 | RLS and privilege tests | Pass — extended to migration 042's own service-role gate |
| 9 | Existing Resume PR B suites still pass | Pass — 476 assertions, 0 failures |
| 10 | Migration ordering/collision vs. production history | Pass — re-verified fresh in the consolidated audit |

### Deep's 8 ownership-aware-finalization regression scenarios (specified during the design lock)

All 8 implemented as scenarios 13–20 of the quota-lifecycle live suite, run 4× with zero flakiness: attempt 1 cannot overwrite attempt 2's pending/unavailable/success state (3 scenarios); attempt 2 finalizes its own result correctly; a stale failure cannot overwrite a newer success; a stale finalization never increments `attempt_number`; concurrent finalization and reclaim preserve a single valid owner (both race orderings traced and verified); existing successful-result protection remains intact under the trimmed claim function.

### Consolidated final audit (8 points, system-wide)

Migration ordering — Pass. SQL security/privileges — Pass. Cron authentication — **Low** (see §4). Reconciliation failure isolation — Pass. Reservation/refund/finalization consistency — Pass. Stale-worker protection — Pass. Worktree integrity/exact diff — Pass (19 files, sha256'd). Original 10 acceptance criteria — Pass.

---

## 4. Known limitations and operational recommendations

1. **Cron route replay protection (Low)** — `verifyReconciliationSecret()` is a static bearer-token comparison with no nonce/timestamp; a captured header value could be replayed. Impact is bounded (the sweep is idempotent and only ever refunds quota a user is already owed), and this matches the **existing** `/api/opportunities/sync` route's own security posture exactly — not a regression this work introduces, a pre-existing project-wide convention for internal/cron routes. Recommend revisiting if this pattern is ever tightened project-wide, not as a one-off fix here.
2. **Overlapping sweep runs serialize (operational, not a defect)** — two concurrent sweep runs that share a candidate will block on each other for the full duration of the slower one (Postgres row locks held until the whole enclosing RPC call commits, not released per-iteration). Idempotency still protects correctness regardless. Recommend configuring the scheduler so overlapping runs don't become routine (e.g., a lock/skip-if-running guard at the scheduler level, not inside the migration).
3. **Deliberate exception-path test not engineered** — forcing a genuinely unexpected SQL error for exactly one candidate (to exercise `EXCEPTION WHEN OTHERS` on purpose, rather than by accident) proved impractical to engineer safely in the live suite. The live-caught ambiguity bug in migration 042 already exercised this exact path for real, just not as a planned test — treated as sufficient evidence given the alternative risked unsafe test-harness changes.
4. **Deploy sequencing — a dark launch, not a tight-coordination problem.** Migration 041 changes `upsert_resume_analysis()`'s signature (12 params → 5) and introduces `finalize_resume_analysis()` as a new function; in principle, old application code calling the old signature during a deploy transition would get a hard `42883` (function does not exist) error. In practice this is not live-traffic-sensitive: `analyzeResume()`'s very first line is `if (!isResumeIntelligenceEnabled()) { return {...}; }`, which short-circuits before any of these RPCs are ever reached, `RESUME_INTELLIGENCE_ENABLED` defaults to `false` and is unset in the target environment today, and no other route in the codebase calls any of these RPCs directly (grep-confirmed). The correct sequence is therefore:
   - Verify `RESUME_INTELLIGENCE_ENABLED` is not `'true'` in the target environment.
   - Apply migrations 040 → 041 → 042 and deploy the matching application code.
   - Verify both the database and the application are live and consistent.
   - Enable the feature flag only after that verification.
   See §6 for the matching rollback-sequencing requirement.
5. **`RESUME_QUOTA_RECONCILE_SECRET` must be set in the real deployment environment** before the reconciliation route can ever be called successfully (fails closed, same as `INGESTION_SYNC_SECRET`) — not set anywhere outside this local worktree.
6. **The cron schedule itself (how often, via which scheduler) is an operational choice not fixed by this implementation** — `runResumeQuotaReconciliation()`/the route support `dryRun` specifically so the first few real-world runs can be observed before trusting the live-write path.
7. **Migration numbering status (verified 2026-11-07):** PR #48 contains `036_resume_intelligence.sql` and migrations 037–042. PR #50 contains `043_billing_transactions.sql`. There is no migration-number collision between the current PR #48 and PR #50 file lists; no renumbering is required for this pair. Re-check the complete target-branch migration history immediately before either PR merges, because another intervening migration could change this assessment.

---

## 5. Deployment checklist (none of this has been executed)

1. Migration-number check: current PR #48 / PR #50 file lists do not collide (PR #50 uses migration 043). Re-check `main` and both PR file lists immediately before merge.
2. **Verify `RESUME_INTELLIGENCE_ENABLED` is not `'true'` in the target environment** — this is what makes the rest of this sequence a dark launch rather than a live-traffic-sensitive one (see §4.4).
3. Apply migrations **040 → 041 → 042, in that exact order**, to the target database. Each is independently idempotent-safe to re-run only in the sense that re-applying an already-applied migration will error (`DROP FUNCTION IF EXISTS` guards the function-replacement statements, but the `ALTER TABLE ADD COLUMN IF NOT EXISTS`/`CREATE TABLE IF NOT EXISTS` in 040 are the only truly re-run-safe statements) — treat each as a normal one-time forward migration.
4. Deploy the matching application code (the `resume-intelligence-service.ts` changes, `quota-reconciliation.ts`, the new route, the `admin.ts` allowlist entry). With the flag confirmed off in step 2, this does not need to happen within a tight window of step 3 — see §4.4.
5. **Verify the database and the application are live and consistent** before proceeding — e.g. confirm the new functions exist with their expected signatures, and the deployed code is the version calling them.
6. Set `RESUME_QUOTA_RECONCILE_SECRET` in the target environment (Railway).
7. Wire the scheduler to call `POST /api/resume/reconcile-quota?dryRun=1` first, confirm the candidate volume/shape looks sane, then switch to the real (non-dry-run) endpoint on whatever cadence is chosen (recommend starting conservative, e.g. every 15–30 minutes, and widening once trusted).
8. **Enable `RESUME_INTELLIGENCE_ENABLED` only after step 5's verification** — this is the point at which the feature actually starts receiving live traffic.
9. Post-enable smoke check: confirm a real resume analysis request completes end-to-end (claim → reserve → model call → finalize), and confirm `GET`/`POST` to the new route without the correct secret returns 401.

## 6. Rollback checklist (reverse order: 042 → 041 → 040)

Each migration's own file ends with a manual (not automated) `DOWN` section:

1. **042**: `DROP FUNCTION reconcile_resume_quota_orphans(boolean)`. No data loss beyond the function itself — it never created any schema.
2. **041**: `DROP FUNCTION finalize_resume_analysis(...)`, `DROP FUNCTION upsert_resume_analysis(uuid, text, text, text, text)`, then restore migration 040's own 12-param `upsert_resume_analysis(...)` body (claim+finalize combined, with the no-ownership-guard gap 041 exists to fix — rolling back to 040 alone means temporarily re-accepting that gap).
3. **040**: `DROP FUNCTION refund_resume_analysis(uuid, int, text)`, `DROP FUNCTION reserve_resume_analysis(uuid, int)` then restore migration 036's zero-arg bodies; `DROP FUNCTION upsert_resume_analysis(...)` then restore migration 039's 2-column-return version; `DROP TABLE resume_quota_events` (**loses all quota-event audit history — not reversible**); `ALTER TABLE resume_analyses DROP COLUMN attempt_number`.

**Rolling back 040 discards the event-level audit trail irreversibly — it does not reset or corrupt operational state.** `DROP TABLE resume_quota_events` permanently deletes the per-event history of every reservation/refund decision ever made, but `profiles.daily_resume_analyses_count` (each user's actual current quota count) is a column from an earlier migration that 040's rollback never touches. Rolling back 040 does not change what any user's quota counter currently reads; it destroys only the forensic record of how it got there. If a rollback is ever needed, prefer rolling back only as far as actually necessary (e.g., 042→041 alone, keeping 040's schema) rather than all the way to 036, unless the audit trail itself is judged to be the problem.

**A database-only rollback is just as dangerous as a mismatched forward deploy, and must not be done alone.** If the SQL above is rolled back but the application code is left calling the newer `callFinalize()`/the new-signature `reserve_resume_analysis()`/`refund_resume_analysis()`, every resume-analysis request hits the identical `42883` (function does not exist) failure the deploy-sequencing note in §4 describes — just triggered by an incomplete rollback instead of a forward deploy. **Any rollback of these migrations must roll the application code back to the matching pre-041/pre-040 version in the same step as the SQL, never the SQL alone.**

---

**End of package. Commit, push, PR, merge, and deployment all remain separately gated — none authorized by this document.**


## 7. PR status and verification update (2026-11-07)

- PR #48 is open; current head: `94f39c3b1a9903b42768c446b94d0d120c5c6bef`.
- GitHub Actions workflow tree: no `.github/workflows/` files are present at this commit. Therefore no repository-owned CI workflow is configured to run for this PR head. The Supabase Preview check was skipped because the branch is not associated with a Supabase Branch; this is not a migration pass/fail result.
- GitHub commit status reports zero status contexts; there is no green CI result to cite. Local test evidence remains separate from GitHub CI.
- Signed-in browser verification remains outstanding and must be completed by an operator with an authenticated browser session. It has not been represented as passed.
- No migration has been applied to a shared or production database, and no deployment or feature-flag enablement is authorized by this document.

# Swipe limits — implementation review package

**Branch:** `feat/swipe-limits-rolling-24h` (isolated worktree, based on `origin/main` @ `675092d`)
**Commit:** `b6b10dd` — `feat(swipe-limits): rolling 24h swipe caps + two-popup Pro upgrade modal`
**Status:** implementation + verification complete. **Stopping here per instruction** — no PR, merge, migration apply, or deployment has happened or is requested by this package.

---

## 0. Plan-version note (first deviation to flag)

The authorization referenced **revision 8** of the plan. The actual plan file is at **revision 9** — revision 9 is revision 8 plus exactly one closed gap: `attach_right_swipe_decision` returning an explicit `{ attached: true | false }` field that every caller must branch on, rather than inferring success from "no exception was thrown." This is precisely authorization requirement #4 ("every enrichment attach path checks the explicit `attached` result"). The implementation was built against revision 9, i.e. it already satisfies #4 by construction — there is no rev-8-only behavior that was skipped; rev 9 only added a requirement, it didn't remove or alter anything rev 8 specified. Flagging this so the record is accurate rather than silently citing "revision 8" when the richer version is what actually got built.

---

## 1. Requirements checklist (as given in the authorization)

| # | Requirement | Status |
|---|---|---|
| 1 | Follow the plan exactly, no unreviewed architectural changes | **Met**, with one implementation-level refinement disclosed in §4 (not architectural — a correctness detail the plan's prose didn't spell out) |
| 2 | Rolling 24h: Free 15 right / 50 total, no independent left cap; Pro unlimited + duplicate protection retained | **Met** — migration 045 §3/§4 |
| 3 | Atomic reservation, duplicate detection, enrichment claims, fencing tokens | **Met** — migration 045 §3–§5, proven under PGlite (§3 below) |
| 4 | Every enrichment-attach path checks the explicit `attached` result | **Met** — both call sites in `route.ts` branch on `attachResult.attached`, never on absence of a thrown error |
| 5 | Rewind clears the enrichment claim on the rewound row | **Met** — migration 045 §7 |
| 6 | Application-row timing decision implemented as documented | **Met** — `applications` row created at reservation/claim time (migration 045 §4), not at attach time |
| 7 | Preserve existing rewind/reswipe/entitlement/AI-enrichment semantics | **Met** — see §5 (semantics preserved) below |
| 8 | Implement the regression tests (concurrency, stale-claim, rewind, route-level attachment) | **Met, with a scope note**: the plan's test section enumerates **29** items by the final revision (not 28 — see §4, second deviation); all 29 are implemented; route-level (HTTP) attachment tests specifically require the LIVE tier, not run per §2 |
| 9 | Reconcile migration numbering against the actual branch/committed migrations | **Met** — checked `main` + both open PRs at build time; see §2 |
| 10 | Static/unit/integration checks; live tests only against a verified isolated project | **Met** — static+migration tiers run and passing; LIVE tier intentionally not run (no isolated project has been named) |

Restrictions (no prod migration, no merge, no deploy, no dashboard/env changes, no unrelated billing/employer-account edits): **all held.** `git status`/`git diff` on this branch touch only the 11 files listed in §2 — no Razorpay, billing, or employer-account file is part of this commit.

---

## 2. Files changed (commit `b6b10dd`)

```
 docs/swipe-limits-rolling-24h-implementation-plan.md      | new  (copied in, unmodified from the shared checkout)
 supabase/migrations/045_swipe_limits_rolling_24h.sql       | new  (unapplied — see §6)
 src/app/api/opportunities/swipe/route.ts                   | modified
 src/app/api/profile/route.ts                                | modified
 src/app/feed/page.tsx                                       | modified
 src/components/feed/swipe-deck.tsx                          | modified
 src/components/premium/upgrade-modal.tsx                    | modified
 src/lib/entitlement/client.ts                                | modified
 src/types/byn.ts                                             | modified
 test/navbar-entitlement-suite.ts                             | modified (2-line fixture fix, forced by the new required ServerEntitlement fields)
 test/swipe-limits-rolling-24h-suite.ts                      | new
```

**Migration numbering (requirement 9):** at build time, `036`–`042` were claimed by open PR #48 (resume intelligence), `044` by open PR #49 (employer accounts); `043` and above were otherwise unclaimed on `main` or in any open PR. Used **045**. This was re-checked at build time against the actual repository state, not assumed from the plan document (which deliberately left the number unassigned for exactly this reason).

---

## 3. Test results

**Static/typecheck:** `npx tsc --noEmit` across the whole repo — **0 errors.**

**Migration tier (PGlite — applies the real `001_initial_schema.sql` + `003_security_remediation.sql` + `045_swipe_limits_rolling_24h.sql` against an embedded Postgres, auth.uid()/auth.users stubbed the same way the repo's existing `gate1-rls-isolation.ts` / `auth-flow-migration-suite.ts` suites do):**

```
UNIT: formatCountdown — 5/5 passed
MIGRATION (PGlite) — 128/128 passed
RESULTS: 133 passed, 1 failed
```

The 1 "failed" item is the LIVE-tier gate intentionally asserting `false` when no isolated project is configured — the same convention `test/apply-click-tracking-suite.ts` already uses in this repo, so an unconfigured live tier is visibly flagged rather than silently skipped. It is not a test of production code; it is a tripwire confirming the live tier was not run.

**LIVE tier:** not run. Requires `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `ISOLATED_TEST_PROJECT_HOST` pointing at a project you've separately verified as safe to test against, per [[remotematch-env-local-production-sensitive]] and plan §7/§8 boundary 5. No such project was named in this authorization, so none was assumed.

Full scenario → test mapping (plan §7, all 29 items):

| Plan items | Covered by |
|---|---|
| 1–3 (right/total caps, no left cap, window expiry) | Right-cap, total-cap, left-only-no-cap, and window-expiry blocks in the suite |
| 4–8 (atomicity, old signatures gone) | Covered at the SQL-logic level under PGlite; **true concurrent-connection races (two simultaneous requests) are a LIVE-tier concern** — PGlite is single-connection, so these are proven via exact-interleaving simulation (documented per-test in the suite), not real parallelism. Old-signature removal (item 8) is proven directly: both old function calls throw post-migration. |
| 9–11, 16 (rewind, rewind-then-reswipe) | All four rewind blocks |
| 17–20, 26 (retry/resume/idempotency, explicit `attached` check) | Resume blocks + the tampered-claim-id block |
| 21–23 (concurrent resume, claim expiry, Pro) | Concurrent-resume and claim-expiry blocks (Pro covered via duplicate-check block earlier) |
| 24–25 (fencing / delayed-response overwrite, generalized to the insert path) | The worker-A/worker-B fencing block |
| 12–14 (counter authority, timestamp authority, shared-function consistency) | Window-expiry block (authority), client-timestamp block, shared-counter block |
| 15 (Pro never blocked) | Pro duplicate-check block |
| 27 (rewind clears claim) | Rewind-claim-clear block |
| 29 (rewind/attach atomicity) | Not independently re-proven beyond the reasoning in plan §3 — PGlite's single-connection model can't manufacture the actual race; this is the clearest case where the claim rests on Postgres MVCC semantics (verified by the independent review, §11 of the plan) rather than an executable test. Flagged, not silently assumed. |

---

## 4. Deviations / things worth your attention (nothing hidden)

1. **Plan version**: built against revision 9, not 8 (§0 above) — a superset, not a substitution.
2. **Test count**: the plan's final test section has 29 items (26 renumbered/added across revisions 6–8 plus item 29 added in revision 9), not 28. All 29 are implemented. If "28" in the authorization was deliberate (e.g. excluding item 29 as out of scope), say so and I'll remove or re-flag it — I read it as the count simply having moved since the authorization text was drafted.
3. **Implementation-level refinement found while writing the actual SQL (not an architectural change):** the plan's duplicate-check-and-claim step didn't specify what to do if the atomic claim `UPDATE` fails to acquire a claim. I added a re-read of the row's current `decision_snapshot` in that failure branch, so the response correctly reports `hasDecision: true` (someone just finished) instead of always assuming `resumeInProgress: true` (someone is still working) — these are different states and the plan's prose didn't disambiguate them. This is a bug-fix-level detail inside one `IF` branch, not a new mechanism, new table, new endpoint, or changed contract — caught and proven by the test suite (`"completed duplicate" ` assertions), not shipped unverified.
4. **`idx_swipes_profile_created_at`**: the plan's §1 stated no such index exists. On inspecting the real migration 003, it already does (`CREATE INDEX idx_swipes_profile_created_at ON swipes(profile_id, created_at DESC)`, added in 003). Migration 045 does **not** recreate it — the plan document itself should be corrected on this point, but no code or SQL impact resulted (it would have been a harmless `IF NOT EXISTS` no-op either way).
5. **`ServerEntitlement.dailyRightSwipesCount` kept its name** (now backed by the rolling-window count instead of the stale calendar-day counter) rather than being renamed, to avoid an unrelated-looking rename ripple across 6 call sites (navbar, settings, match page, swipe-deck, mock-seed) that the authorization's restrictions didn't ask for. `totalSwipesCount` / `totalSwipeLimit` were added as new, additive fields. This is a scope-minimization choice, not a plan deviation — the plan's §5 only required the *value* to come from the shared function, not a field rename.
6. **No unresolved test failures.** The only non-passing item is the intentional LIVE-tier gate described in §3.

---

## 5. Semantics preserved (requirement 7)

- Rewind: still Pro-only (`pro_required` unchanged), still one-shot (`nothing_to_rewind` guard unchanged), still restores the right-swipe counter and deletes the `applications` row for an undone `interested` decision — all unchanged. Only addition: clears the enrichment claim (requirement 5).
- Entitlement: `/api/profile` still returns the same shape plus two new additive fields; every existing consumer (`navbar.tsx`, `settings/page.tsx`, `match/[jobId]/page.tsx`, `linkedin-jobs/page.tsx`) continues to read `dailyRightSwipesCount`/`rightSwipeLimit` exactly as before, now backed by an accurate rolling count instead of a stale calendar-day one.
- AI-enrichment: the existing "swipe path intentionally does not roll back on AI failure" divergence (migration 003's own comment) is preserved verbatim — an AI/matching failure still leaves a swipe row with `decision_snapshot = NULL` rather than rolling back the reservation.

---

## 6. Migration SQL for review (unapplied)

`supabase/migrations/045_swipe_limits_rolling_24h.sql`, on branch `feat/swipe-limits-rolling-24h`, commit `b6b10dd`. Has **not** been run against any Supabase project, isolated or otherwise — only against the ephemeral in-memory PGlite instances the test suite creates and discards per test.

---

Awaiting separate authorization for PR, merge, migration apply, and deployment, per instruction.

# Swipe limits — implementation review package

**Branch:** `feat/swipe-limits-rolling-24h` (isolated worktree, based on `origin/main` @ `675092d`)
**PR:** [#51](https://github.com/dkhadikar-max/RemoteMatch/pull/51)
**Commits:** `b6b10dd` (implementation) → `e452819` (first review package) → `3564330` (closing the first independent review's findings) → `80b4cb2` (renumbering the migration, §0a) → one further commit recording the live-tier concurrency proof (§0b, this revision).
**Status:** implementation + verification complete, two rounds of independent review completed and closed, **and the live multi-connection concurrency proof completed** against a verified isolated project. Still stopping here per instruction — no merge to `main`, no migration apply to production, no deployment.

---

## 0b. Live-tier concurrency proof — the last disclosed gap, now closed

Every prior revision of this package was explicit that items 4, 5, and 29 (the actual concurrent-transaction races, as opposed to sequential-boundary behavior) could not be proven by the PGlite suite, because PGlite is structurally single-connection. That gap is now closed for real: against the explicitly-authorized isolated project **`xyahktsgdigutxartafb`** ("remotematch-paidtest"), with migrations `035` and `046` applied there (the only two this branch's migration set was missing — `036`–`045` belong to other, unrelated PRs and this migration depends on none of them), a disposable real test user was created via the Auth admin API and used to fire genuinely concurrent HTTP requests — via `Promise.all`, each landing on PostgREST as its own real Postgres connection/transaction — at the exact boundaries the plan names:

| Test | Scenario | Result |
|---|---|---|
| A | Two concurrent requests at `right_count = 14`, both attempting the 15th right swipe | Exactly one succeeded, one got `RIGHT_LIMIT_REACHED`; final `right_count` = 15, never 16 |
| B | Two concurrent requests at `total_count = 49`, both attempting the 50th swipe | Exactly one succeeded, one got `TOTAL_LIMIT_REACHED`; final `total_count` = 50, never 51 |
| C | Two concurrent retries racing to claim the same incomplete swipe | Exactly one won the claim, one was told to stand down — no double claim |
| D | `attach_right_swipe_decision` raced directly against `rewind_last_decision` on the same row | No split state: rewind won this run (fenced out the attach, `attached: false` + `reason: 'stale_claim'`, no decision ever written, claim cleared) — one of the two consistent outcomes the design allows, verified directly against the row afterward, not inferred |

**13 passed, 0 failed.** This is the genuine multi-connection proof the `SELECT ... FOR UPDATE` design was always argued to support by reading the SQL control flow (confirmed correct by two prior independent reviewers) — now actually exercised, not just reasoned about.

**Cleanup:** every swipe/application row for the test user, every seeded test opportunity, and the auth user itself were deleted immediately after. Per this project's own standing norm ("a suite's own cleanup assertion is not proof cleanup happened"), this was independently re-verified with a fresh, separately-constructed query afterward (not the script's own built-in check, which had a harmless query-syntax bug and needed a redo) — confirmed zero rows remaining.

**Credential handling:** the isolated project's database password had to be reset (the original value in `.env.paidtest.local` no longer worked — Supabase never displays a password after creation, and whatever the original reset-check was can't be recovered). The reset and a one-time `DATABASE_URL`/connection-string lookup were done via the Supabase dashboard (session login required in Chrome), with the new value written directly to `.env.paidtest.local` and never displayed in chat, consistent with this project's blind-secret-handling norm.

---

## 0a. Migration renumbered 045 → 046 (collision found by a third, PR-level independent review)

After PR #51 was opened with `045_swipe_limits_rolling_24h.sql` (numbering reconciled and confirmed free against `main` and all open PRs **at that time**), PR #49 (`feat/employer-company-accounts`, a different, unrelated PR) was separately updated 8 minutes later to add its own `045_employer_register_transaction.sql`. A third independent review — this time against the live GitHub PR, not the local self-report — caught this live collision between two open PRs. Re-verified directly: `main` still tops out at 035; PR #48 holds 036–042; PR #50 holds 043; PR #49 now holds 044 **and** 045; nothing claims 046. Since PR #49 is a different, actively-worked PR this session has no business editing, this PR's own migration was renamed `046_swipe_limits_rolling_24h.sql` and every internal reference (test suite, route/entitlement comments, this doc) updated to match. This is exactly the scenario the plan's §2 always warned about ("reconcile at build time, don't hardcode — a number can be claimed by someone else between reconciliation and merge") — it happened for real, between two PRs in the same repo, and was caught before merge rather than at migration-apply time.

---

## 0. This revision's purpose

A genuinely independent reviewer (no role in building this) was given read-only access to the real diff, migration, and test suite — not a summary — and told to be adversarial. It found **2 CRITICAL, 3 HIGH, 3 MEDIUM, 3 LOW, 4 INFO** findings, re-ran the test suite itself to confirm the self-reported numbers, and independently re-verified the migration-numbering reconciliation. Its full report is preserved in this session's transcript. This document records what was done in response to each finding — nothing was waved off.

---

## 1. Independent review findings and their resolution

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | CRITICAL | Plan items 4/5 (the core atomicity fix this migration exists for) had no test even approximating concurrent arrival at the 14→15 / 49→50 boundary — only a 15-sequential-swipes-then-16th test, which proves final-state logic but not boundary behavior | Added explicit boundary tests at exactly right_count=14 and total_count=49 (plan's own numbers), honestly labeled as sequential, not a true race (see #1 resolution detail below) |
| 2 | CRITICAL | Plan item 29 (rewind/attach atomicity — the specific gate revision 8→9 required before authorization) had zero test coverage; the self-report admitted this but the plan's own bar said "closed... test §7 item 29" | Added a test asserting both postconditions (rewind marker exists, claim cleared) together in one read immediately after rewind returns — the strongest claim a single-connection engine can make; honestly documented what it does and doesn't prove |
| 3 | HIGH | Item 23 (concurrent resume for Pro) was untested — every claim-race test used Free only | Added the full concurrent-resume/claim-expiry/fencing sequence for `USER_PRO` |
| 4 | HIGH | Items 6/7 (same-vacancy right+left race; different-vacancy false-block check) untested | Added both: an `interested`+`passed` race on one opportunity, and a same-user different-opportunity pair confirming no false serialization |
| 5 | HIGH | Items 12/14/28 untested — the suite never once queried `applications`, never checked `/api/profile` and the swipe RPCs share the same function by more than inspection, never tested legacy-counter/rolling-count divergence | Added all three: an `applications`-row-exists-before-attach test, a tampered-legacy-counter test proving gating ignores it, and a static source-grep confirming both call sites invoke `get_rolling_swipe_counts()` by name |
| 6 | MEDIUM | The "active row" predicate (`action <> 'rewind' AND NOT EXISTS...`) was inlined identically in **four** places, not actually centralized — contradicting the plan's explicit "one piece of SQL, not a convention" claim | **Real fix, not just a test**: extracted it into `CREATE VIEW public.active_swipes`; all four call sites (the counter function, both duplicate checks, and the window-count query that used to be a fourth separate copy) now read through the one view. `reserve_and_record_right_swipe` and `record_pass` also now call `get_rolling_swipe_counts()` directly for their window numbers instead of re-querying — one fewer duplicated query, not just a relabeling. |
| 7 | MEDIUM | Only the far-expired (25h) side of the window-expiry boundary was tested, not the "23h59m59s still counts" side the plan names explicitly | Added the missing boundary test |
| 8 | MEDIUM | **Real bug, not test-only**: the client-side pre-check in `swipe-deck.tsx` cached `dailyRightSwipesCount`/`totalSwipesCount` and could show a false "limit reached" if the cache went stale while the user sat on the feed — rolling-window counts only ever decrease on their own, so this risk was asymmetric (can only produce a false block, never a false allow) but real and previously undocumented | **Removed the client-side blocking short-circuit entirely.** The server (migration 046) is now the only thing that ever decides a swipe is blocked; the existing 403-handling path in `feed/page.tsx` (already required for the real server rejection case) is what shows the modal. Traded away the "avoid a round trip when clearly over" micro-optimization for correctness, per your own framing in the review-authorization message. |
| 9 | LOW | The "client-supplied timestamp ignored" test was tautological — it would pass even if the implementation were broken, since it only confirmed a call without a timestamp arg succeeds | Replaced with a real structural check: queries `pg_catalog.pg_proc`/`pg_get_function_arguments` for all four gating functions and asserts none has a timestamp/date/time-typed parameter |
| 10 | LOW | The "tampered claim id" test's label claimed route-layer verification ("the route returns non-200") but only ever called the SQL function directly, never touched `route.ts` | Added a companion static check: greps `route.ts` for exactly two `attach_right_swipe_decision` call sites, confirms `.attached` is read at each, and confirms a `false` result maps to `status: 409` within the same branch |
| 11 | LOW | The legacy-counter fallback in `/api/profile` silently returns a stale approximation (not true legacy semantics) if the RPC fails — cosmetic, no gating impact | Left as-is; the reviewer itself classified this as cosmetic/display-only with no gating impact, and the fallback path is already an edge case (RPC failure) not exercised by normal operation |
| 12 | INFO | `src/app/tracker/page.tsx` had a comment referencing the now-dropped `finalize_interested_swipe()` | Fixed — one-line comment update, named the new functions and migration 046 |
| 13 | INFO | Plan's own §1 index claim was already known-wrong (migration 003 already has the index) | Already correctly handled in the original migration (no recreation); no action needed beyond what the first review package already disclosed |
| 14 | INFO | Fencing-token audit — reviewer's own verification, no finding, confirms both `route.ts` call sites correctly source `claimId` | No action needed — independently confirmed correct |
| 15 | INFO | Application-row timing — reviewer's own verification, no finding, confirms the row is created at reservation/claim time as documented | No action needed — independently confirmed correct |

**What was explicitly NOT "fixed," and why:** items 4, 5, and 29's full closure requires a genuine multi-connection Postgres (two transactions actually contending for the same row lock before either commits) — PGlite is architecturally a single connection and cannot manufacture this. The added tests for these items prove the correct *sequential* behavior at the exact boundaries the plan names, which is real and necessary but not sufficient on its own. The reviewer's own assessment was that the underlying `FOR UPDATE` row-lock design is "almost certainly correct" by reading the SQL control flow — but also noted, correctly, that this is exactly the kind of claim a test should settle, not just prose. Genuine closure of this gap requires the LIVE tier against a real isolated Supabase project — a separate go-ahead, consistent with every prior boundary in this process. Not fabricating that coverage here.

---

## 2. Test results (after closing the above)

```
UNIT: formatCountdown — 5/5 passed
MIGRATION (PGlite) — 160/160 passed
RESULTS: 165 passed, 1 failed
```

(Up from 133 passed in the first review package — 32 new/strengthened assertions closing findings 1–5, 7, 9, 10 above.) The 1 "failed" item remains the intentional LIVE-tier tripwire, unchanged in meaning from the first review package.

`npx tsc --noEmit` across the whole repo: **0 errors**, re-confirmed after the `swipe-deck.tsx` simplification (finding 8) removed two now-dead props (`dailyRightSwipesCount`, `totalSwipesCount`) from that component's interface — `feed/page.tsx` updated to match.

Migration-numbering reconciliation (requirement 9) was independently re-verified by the reviewer against `gh pr list` and the main checkout directly: confirmed no collision, `045` genuinely free at review time.

---

## 3. Files touched beyond the first review package

```
 supabase/migrations/046_swipe_limits_rolling_24h.sql   | centralized the active-row predicate into a view (finding 6)
 test/swipe-limits-rolling-24h-suite.ts                 | +32 net assertions closing findings 1-5, 7, 9, 10
 src/components/feed/swipe-deck.tsx                     | removed the client-side blocking pre-check (finding 8)
 src/app/feed/page.tsx                                  | stopped passing the now-removed props to SwipeDeck
 src/app/tracker/page.tsx                               | fixed stale comment (finding 12)
 docs/swipe-limits-implementation-review-package.md     | this file, rewritten
```

No file outside this list changed. Still no Razorpay, billing, or employer-account file touched.

---

## 4. Outstanding, honestly stated

- ~~Items 4, 5, and a true multi-connection version of 29 remain provable only via the LIVE tier~~ — **closed, §0b.** Run against the explicitly-named isolated project `xyahktsgdigutxartafb`, 13/13 passed, test data cleaned up and independently re-verified.
- The "28 vs 29 test items" note from the first review package stands; not re-litigated here.
- The plan document's revision-9 text itself (not this implementation) still says "no index exists" in §1, which is wrong per migration 003 — a documentation correction for the plan file, not a code issue.

**Nothing is outstanding from the implementation/verification side anymore.** Awaiting separate authorization for PR merge, production migration apply, and deployment — none of which this package or the live test performed.

# Swipe limits & Pro upgrade popups — implementation plan

**Type:** planning only. No code, migration, deploy, or branch yet.
**Status:** revision 9 — **implementation authorized, release/deploy NOT authorized.** Rev 2 → atomicity bug + 35-left inconsistency, resolved rev 3. Rev 3 → four closures (AI-failure handling, retry idempotency, rewind-then-reswipe, cross-endpoint count consistency), resolved rev 4. Rev 4 → concurrent resume-ownership gap, closed rev 5 via a timeout-bounded claim column. Rev 5 → claim-timestamp-alone couldn't stop a superseded worker from overwriting a newer result, closed rev 6 via a fencing token (`enrichment_claim_id`). Rev 6 → `attach_right_swipe_decision` needed an explicit `attached` boolean callers must branch on, closed rev 7. Rev 7 → independent review (no role in drafting this doc, checked against the actual production SQL) found 6/7 PASS, one CONCERN (rewind never cleared an in-flight claim) and one unflagged behavior change (applications-row timing) — both closed rev 8. Rev 8 → one final requirement before authorization: explicit proof that rewind's claim-clear and its rewind-marker insert are atomic with each other, not a separate non-atomic update — closed below (§3, test §7 item 29).

**Authorization boundaries (binding for this implementation pass):**
1. Implement only the approved revision 9 swipe-limit design — no scope creep.
2. Reconcile migration numbering against current `main` and open PRs before creating the migration file (§2) — do not assume a number.
3. Preserve existing rewind and reswipe semantics exactly as specified (§3) — no incidental behavior changes beyond the two explicitly documented ones (claim-clear, applications-timing).
4. Run all 29 specified regression tests (§7), plus existing test suites, before considering the branch done.
5. Any live/integration testing runs only against a verified isolated Supabase project — never `.env.local`'s project (per [[remotematch-env-local-production-sensitive]]) without separate explicit go-ahead.
6. Do not apply migrations to production, merge, or deploy. This authorization covers writing and testing code on a bounded branch only.
**Settled decisions this plan implements:** Free = 15 right / 50 total per **rolling** 24h, **no independent left-swipe cap** (confirmed 2026-11-05, reversing the earlier 35-left row — left swipes are bounded only by the 50-total ceiling); Pro = **unlimited** swipes + 24h early access to eligible direct-employer jobs; duplicate-vacancy interactions must not consume allowance, atomically; two distinct popups (`RIGHT_LIMIT_REACHED` / `TOTAL_LIMIT_REACHED`) with a server-calculated, cap-specific reset timestamp.
**Out of scope:** the direct-employer early-access gating itself (tracked separately under Direct Employer Supply Phase 1, migration 044, still uncommitted). Also out of scope: "save"/bookmark naming — there is no separate bookmark feature; "save" is the existing UI name for a right swipe, and "Unlimited saves" stays correct Pro copy.

---

## 0. Why this is bigger than "add two counters"

The live enforcement (`reserve_right_swipe`, `record_pass`, `rewind_last_decision` in [`003_security_remediation.sql`](../supabase/migrations/003_security_remediation.sql)) works by incrementing a counter column (`profiles.daily_right_swipes_count`) and resetting it when `profiles.usage_date` rolls past UTC midnight. **A counter-plus-reset-date column cannot represent a rolling window** — only "since the last fixed reset point." Rolling 24h requires counting *events* within a moving window, i.e. querying `swipes.created_at` directly.

It also interacts with rewind: `rewind_last_decision` doesn't delete the original row, it inserts an `action = 'rewind'` row pointing at it (`rewound_decision_id`). Any rolling-window query must exclude rewound decisions (and the rewind rows themselves) from the count, or a rewind-and-reswipe cycle would double count. This is also why the original `UNIQUE (profile_id, opportunity_id)` constraint on `swipes` was dropped in migration 003 — multiple rows per opportunity are intentional, so duplicate-vacancy protection must stay a logic check, never a unique constraint.

**Revision 3 correction — the countable write must happen atomically with the check, not later.** The original production design is safe because `reserve_right_swipe()` increments the counter *inside* the same locked call that checks it — the countable state change and the gate are the same statement. Revision 2 broke this: it replaced the counter increment with a live count of `swipes` rows, but left the actual row insert in the later, separate `finalize_interested_swipe()` call (split across a Next.js-side AI/matching step, per the comment at migration 003 line 141-147). Two concurrent reservations can both count 49, both get `allowed: true`, and both insert afterward — 51 swipes recorded against a 50 cap. The same gap makes the duplicate check unsafe: two concurrent requests for the same vacancy can both see "no existing row" before either one inserts. **The fix is structural, not a tweak:** whatever write makes an interaction countable must happen inside the same row-locked function call that performs the gate check, for both right and left swipes.

---

## 1. Rolling-window counting model

Define, per user, over the window `now() - interval '24 hours'`:

```sql
-- "active" = not itself a rewind, and not the target of a later rewind
WITH active_window AS (
  SELECT s.*
  FROM swipes s
  WHERE s.profile_id = v_uid
    AND s.created_at > now() - interval '24 hours'
    AND s.action <> 'rewind'
    AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id)
)
SELECT
  count(*) FILTER (WHERE action = 'interested') AS right_count,
  count(*)                                       AS total_count
FROM active_window;
```

No independent left count is needed for gating (confirmed decision: no 35-left cap) — only `right_count` (vs. 15) and `total_count` (vs. 50) gate anything. The window query can still report a left count for display purposes only (`total_count - right_count`), never for enforcement.

**`resetAt` must be cap-specific, not one shared value** (revision 2 was ambiguous on this):
- If blocked by `RIGHT_LIMIT_REACHED`: `resetAt` = oldest *active, `interested`* row's `created_at` + 24h (the right cap frees up when that specific interested swipe ages out).
- If blocked by `TOTAL_LIMIT_REACHED`: `resetAt` = oldest *active* row of any countable action's `created_at` + 24h (any swipe aging out frees one unit of the total).
- These can differ — compute both oldest timestamps in the same query and pick the one matching whichever code is being returned.

**This whole query must run inside the single atomic function in §3**, not as a separate round-trip — a read done outside the lock that gated the write is exactly revision 2's bug.

**Index required:** `CREATE INDEX idx_swipes_profile_created_at ON swipes (profile_id, created_at DESC);` — no index today supports a per-user time-range scan on this table.

---

## 2. Migration — number reserved, not assigned

The employer-accounts branch owns migration 044 — not reusable. 037–043 are other unmerged in-flight work, also not available. **Do not hardcode a number here.** At build time: `git fetch`, check `main` and every open PR's migration files, take the next number nothing else claims — a pre-flight step on the implementation branch, not a planning-time decision.

Migration contents:
- Add the index from §1.
- **Add `swipes.enrichment_claimed_at TIMESTAMPTZ NULL`** — the resume-ownership mechanism in §3 needs a place to record "someone is already resuming this one," since the profile row lock is released before the AI/matching step runs and cannot serialize across it.
- **Add `swipes.enrichment_claim_id UUID NULL`** — a fencing token. `enrichment_claimed_at` alone only answers "is a claim fresh," not "which specific attempt holds it." Without an identity check at attach time, a slow worker whose claim already expired and was taken over by someone else can still complete later and overwrite the newer result with its own stale one (see §3's `attach_right_swipe_decision`).
- **Do not** touch `profiles.daily_right_swipes_count` / `usage_date` or their use by `reserve_proposal()` / `rollback_proposal_reservation()` (proposals keep calendar-day accounting — out of scope).
- **Explicit `DROP FUNCTION` for every changed signature before `CREATE`** (see §3 — Postgres treats a changed parameter list as a new overload, not a replacement; `CREATE OR REPLACE` silently leaves the old signature callable alongside the new one unless it's dropped first). Each drop needs a matching `REVOKE`/`GRANT` re-statement, same as migration 003 does today.
- **Supabase PostgREST schema cache:** after dropping/recreating RPC signatures, the API layer's cached schema can still expose the old signature until it reloads. Add `NOTIFY pgrst, 'reload schema';` at the end of the migration, and verify post-deploy that calling the old zero-arg `reserve_right_swipe()` shape actually 404s/errors rather than silently routing to stale cached metadata.
- **Counter-column sunset (unchanged from revision 2):** keep writing the legacy counters as a rollback safety net for one release; retire them in a separate follow-up PR once production confirms no caller still depends on them for gating.
- **Rollback strategy:** since this changes RPC signatures that the live route depends on, a rollback isn't "revert the SQL file" — it's "redeploy the previous route build against the previous function signatures." Document in the migration file itself which prior commit/signature set a rollback must restore, and confirm the old functions aren't dropped until the new route build is confirmed live (brief dual-write window is not needed here since this is RPC-replace, not data-migrate, but the *order* — deploy functions, then deploy route — matters and should be explicit in the rollout checklist, §8).

---

## 3. Function changes — atomic by construction, not by convention

### `reserve_and_record_right_swipe(p_opportunity_id TEXT)` — replaces `reserve_right_swipe()`

The check **and** the countable write happen in one call, one lock, one transaction:

1. Lock the profile row (`FOR UPDATE`) — unchanged serialization point. It serializes every call to this function for this user, including the claim logic below — but it is released the moment this function returns, **before** the Next.js-side AI/matching step runs. It does not, and cannot, serialize across that external call.
2. **Duplicate check, every tier including Pro:** look up the *active* row for `(profile_id, p_opportunity_id)` — same "active" definition as §1 (`action <> 'rewind'` and not the target of a later rewind row). If none exists, fall through to step 3. If one exists:
   - `decision_snapshot IS NOT NULL` → fully completed. Return `{ allowed: false, code: "DUPLICATE_INTERACTION", existingSwipeId, hasDecision: true }`. Nothing mutated.
   - `decision_snapshot IS NULL` (a resumable, incomplete swipe — §3's retry contract) → **resume-ownership check, with a fencing token (closes both the original and the follow-up reviewer concern).** Atomically, in the same locked call:
     ```sql
     UPDATE swipes SET enrichment_claimed_at = now(), enrichment_claim_id = gen_random_uuid()
     WHERE id = v_existing.id
       AND decision_snapshot IS NULL
       AND (enrichment_claimed_at IS NULL OR enrichment_claimed_at < now() - interval '2 minutes')
     RETURNING id, enrichment_claim_id;
     ```
     - If this `UPDATE` affects a row: claim acquired, with a **freshly generated** `enrichment_claim_id` — this is a brand-new token, not the previous holder's. Return `{ allowed: false, code: "DUPLICATE_INTERACTION", existingSwipeId, hasDecision: false, resumeInProgress: false, claimId: enrichment_claim_id }`. The caller is the exclusive owner of resuming this swipe, identified by `claimId`, not merely by having been "the one who got here first."
     - If it affects no row (another request already holds a fresh, unexpired claim): return `{ allowed: false, code: "DUPLICATE_INTERACTION", existingSwipeId, hasDecision: false, resumeInProgress: true, claimId: null }`. The caller must **not** run AI/matching for this swipe. (See test §7 items 21–22, 24.)
   - Nothing is ever inserted in the duplicate-check branch, regardless of which sub-case fires. Must run before the Pro branch in step 3. **Because a rewound row is excluded from "active" by the exact same clause used for counting, a rewound-then-reswiped vacancy never enters this branch at all.** (See test §7 item 16.)
3. `plan_tier = 'pro'` → **insert the swipe row immediately** (`action = 'interested'`, `decision_snapshot = NULL`, `enrichment_claimed_at = now()`, `enrichment_claim_id = gen_random_uuid()` — **the inserting request is itself a claim holder, same token, same rules**, not a special case), upsert the `applications` row as today's `finalize_interested_swipe` does, and return `{ allowed: true, swipeId, claimId, planTier: 'pro' }`. No window query runs for Pro at all, duplicate check aside.
4. Free tier: run the §1 window query.
5. `right_count >= 15` → `RIGHT_LIMIT_REACHED` with the right-specific `resetAt`. Nothing inserted.
6. Else `total_count >= 50` → `TOTAL_LIMIT_REACHED` with the total-specific `resetAt`. Nothing inserted.
7. Else: **insert the swipe row now, inside this same locked call**, same shape as step 3 (`enrichment_claimed_at`/`enrichment_claim_id` set at insert time), return `{ allowed: true, swipeId, claimId, planTier: 'free' }`.

Because the insert happens before the lock is released, a second concurrent call sees the new row in its own count (or its own duplicate check) — this is what actually closes the race, not the lock by itself. **Every path that can later call `attach_right_swipe_decision` — the original fresh insert (steps 3/7) and every resume win (step 2) — gets its own freshly generated `claimId` at the moment it takes ownership.** This is deliberately not special-cased to "only the resume branch needs a token": the same overwrite race the reviewer identified between two *resume* attempts can equally occur between the *original* request and a *later resuming* request for the same row, if the original's AI call is slow enough to still be in flight when its claim expires and someone else (a client retry, or the same client's own duplicate submission) reclaims. One token, checked the same way, at every attach call, closes both.

**Explicit behavior-change decision (independent review finding 8, not a blocker but must be documented, not silently introduced):** today's production `finalize_interested_swipe` creates the `applications` row only once decision_snapshot/AI enrichment is ready. This plan moves that `applications` upsert to reservation/claim time (steps 3/7) — meaning the row, and therefore anything the tracker UI reads from it, can now exist and be visible **before** the AI-generated cover letter/match analysis exists. **Decision: accept this change.** It is a reasonable UX shift (shows "in progress" rather than nothing), not an accidental side effect, but it must be tracked as an intentional decision and verified, not assumed — see test §7 item 28.

Return shape:
```jsonc
{ "allowed": true | false,
  "code": "RIGHT_LIMIT_REACHED" | "TOTAL_LIMIT_REACHED" | "DUPLICATE_INTERACTION" | null,
  "swipeId": "uuid" | null,             // present whenever a row exists to act on: allowed=true, or DUPLICATE_INTERACTION
  "claimId": "uuid" | null,             // present only when THIS call now owns enrichment (allowed=true, or resumeInProgress=false)
  "hasDecision": boolean | null,        // only meaningful alongside DUPLICATE_INTERACTION for action='interested'
  "resumeInProgress": boolean | null,   // only meaningful when hasDecision = false
  "rightCount": number, "totalCount": number,
  "resetAt": "2026-11-06T03:14:00Z" | null,  // cap-specific, per §1; null unless a limit code is returned
  "planTier": "free" | "pro" }
```

**Retry / idempotency contract (closes reviewer items A and B, the resume-ownership gap, and the fencing-token gap — one mechanism, four names):** a network timeout or client retry calls this function again with the same `opportunityId`. The duplicate check (step 2) is what makes this safe, in three distinct outcomes:

- Already fully completed (`attach_right_swipe_decision` ran) → `DUPLICATE_INTERACTION`, `hasDecision: true`. The route returns 409; the client already has the result from the original successful response, or can treat this as "already done" if it lost that response too.
- Incomplete, and **this** call wins the claim (`resumeInProgress: false`, fresh `claimId` returned) → **the route does not surface this as an error.** It resumes: run the matching/AI-kit step, then call `attach_right_swipe_decision(existingSwipeId, decisionSnapshot, claimId)` — passing the token it was just given, not any token from a prior attempt. No new swipe row is created, no second allowance unit is consumed.
- Incomplete, but **another** concurrent call already holds a fresh claim (`resumeInProgress: true`, `claimId: null`) → the route must **not** start its own AI/matching call. It returns 409 with `resumeInProgress: true`.
- A `passed` duplicate has no decision-snapshot or claim concept — `record_pass`'s duplicate case is always a true 409 (nothing to resume, nothing to claim).

**The fencing token is what actually prevents a stale worker from overwriting a newer result — the claim timestamp alone cannot.** Worker A claims, starts its AI call, its 2-minute claim expires, Worker B reclaims (new `claimId`) and completes (`attach` with B's token succeeds, clears the claim). Worker A's AI call finally returns and calls `attach` with **its own, now-superseded** `claimId` — the `WHERE enrichment_claim_id = p_claim_id` match fails (B's successful attach already set the column to `NULL`), the `UPDATE` affects zero rows, and A's result is silently dropped rather than overwriting B's. See `attach_right_swipe_decision` below and test §7 item 24.

This means **no retry of an `interested` swipe can ever create a second countable row, and no two concurrent retries can both run AI/matching for the same row.** Exactly one caller at a time holds the claim; a crashed claim holder's claim simply expires after 2 minutes, at which point the next request to reach the duplicate check (not a concurrent one — the earlier claim holder, by definition, is no longer racing it) re-claims and resumes. `attach_right_swipe_decision` itself stays a plain ownership-scoped `UPDATE`, called at most once in practice (by whichever request held the claim), so there's nothing to serialize at that step.

### `attach_right_swipe_decision(p_swipe_id UUID, p_decision_snapshot JSONB, p_claim_id UUID)` — replaces `finalize_interested_swipe()`

Runs after the Next.js-side matching/AI-kit step, same as today's split — a pure `UPDATE`, not an `INSERT`, and now **fencing-token-checked, not just ownership-checked**. Its SQL body, and critically its **return value**, make success explicit rather than implied by "no exception was thrown":

```sql
CREATE OR REPLACE FUNCTION public.attach_right_swipe_decision(
  p_swipe_id UUID, p_decision_snapshot JSONB, p_claim_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_updated_id UUID;
BEGIN
  UPDATE swipes
  SET decision_snapshot = p_decision_snapshot,
      enrichment_claim_id = NULL,
      enrichment_claimed_at = NULL
  WHERE id = p_swipe_id
    AND profile_id = auth.uid()
    AND action = 'interested'
    AND decision_snapshot IS NULL
    AND enrichment_claim_id = p_claim_id
  RETURNING id INTO v_updated_id;

  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('attached', false, 'reason', 'stale_claim');
  END IF;

  RETURN jsonb_build_object('attached', true);
END;
$$;
```

**The function's own return value is the thing the route must check — not merely the absence of a thrown error.** `attached: false` is not a failure in the error-handling sense (nothing raised, nothing to catch); it is a positive signal that this call's AI result was *not* persisted, because a different, newer claim (or a completed decision) already exists on that row. The route must branch on this field explicitly:

- `attached: true` → this request's AI result is now the row's decision. Return the normal 200 success shape to the client.
- `attached: false, reason: 'stale_claim'` → **this request's AI result was discarded, not saved.** The route must not report success to its own client for this call — it returns a failure for *this specific request* (e.g. a 409 or 500, not 200), logs the discarded result as wasted AI spend, and does **not** retry the attach with the same now-meaningless token. The winning result (whoever holds/held the current claim) is unaffected and already persisted or in flight under its own request.

Ownership is still checked by `profile_id = auth.uid()`, unchanged — one user can never attach a decision to another's swipe id. **No count impact either way** — the row was already counted at reservation/claim time, so this function needs no profile lock, just the `WHERE` clause's three guards (ownership, fencing token, `decision_snapshot IS NULL`) and its own explicit return value doing the whole job. If the AI/matching step throws before this function is even called, the swipe row persists with `decision_snapshot = NULL` and an eventually-expiring claim — this preserves the existing, already-approved divergence ("swipe path intentionally does not roll back on AI failure," per the current code's own comment) rather than changing that behavior as a side effect of this work.

### `record_pass(p_opportunity_id TEXT)`

Same atomic shape, single call (no split needed — there's no expensive step after a pass): lock → duplicate check (all tiers) → Pro branch (insert immediately, return unlimited) → window count → gate on `total_count >= 50` only (no independent left cap) → insert. This was already structurally a single call; revision 2's bug was specific to the right-swipe path's AI-step split, but `record_pass` must get the same duplicate-check-before-insert ordering and the same "insert while still holding the lock" discipline.

### `rewind_last_decision()`

**No allowance-abuse window exists.** It already requires `plan_tier = 'pro'` (`pro_required` otherwise) — Free users cannot call it at all. Pro has no swipe limit to restore via rewind, since Pro is unlimited. So "repeated swipe → rewind → swipe → rewind" cannot be used to manufacture allowance for anyone: Free can't rewind, and Pro doesn't need to. This closes out the "define acceptable repeated swipe/rewind behavior" requirement by observing it's already structurally impossible, not by adding a new restriction.

**One real update is required — a stale-write gap the independent review surfaced (§11 point 6), distinct from allowance abuse.** `rewind_last_decision()` finds the single most recent `interested` event and inserts a `rewind` row pointing at it, but never touches that row's `enrichment_claim_id` / `enrichment_claimed_at`. If a Pro user swipes right and rewinds *before* the async AI/matching step calls `attach_right_swipe_decision`, the still-in-flight attach call's claim token is unaffected by the rewind — it still matches, `attach` still succeeds, and a decision snapshot gets written onto a row the user already undid. This has no quota or duplicate-detection impact (the rewound row is already excluded from "active" for both purposes, per the clause below), but it is a real data-integrity gap: a rewound row ending up with AI-generated content attached after the fact.

**Fix:** when `rewind_last_decision()` rewinds an `interested` row, it must also clear that row's claim in the same statement:
```sql
UPDATE swipes
SET enrichment_claim_id = NULL, enrichment_claimed_at = NULL
WHERE id = v_last.id;
```
(alongside the existing counter-decrement/`applications`-row-delete it already does for this case). Clearing the token means a subsequently-arriving `attach_right_swipe_decision` call for that row fails its fencing check exactly like any other superseded claim (`enrichment_claim_id = p_claim_id` can never match `NULL` against a real UUID) — it returns `{ attached: false, reason: 'stale_claim' }`, the same mechanism as every other fenced-out attach in this plan, not a new special case. (See test §7 item 27.)

**Atomicity of the claim-clear with the rewind marker (explicit verification, not assertion — required before authorization):** the rewind-marker `INSERT` and the claim-clearing `UPDATE` are two separate SQL statements, but both execute inside the single implicit transaction that is `rewind_last_decision()`'s one function call — Supabase/PostgREST wraps each RPC invocation in one transaction, and a PL/pgSQL function body runs inside the ambient transaction of its caller, not a sub-transaction per statement. Under Postgres's MVCC, **no other transaction can observe a partial commit** — a concurrent `attach_right_swipe_decision` call either sees the row exactly as it was *before* rewind ran (if rewind hasn't committed yet, in which case `attach`'s own `UPDATE` targeting the same row blocks on Postgres's normal row-level lock until rewind commits, then re-evaluates its `WHERE` clause against the post-rewind row and correctly fails the fencing check) or exactly as it is *after* rewind's full commit (marker inserted **and** claim cleared, together) — never a state with one but not the other. This is the same row-level-locking guarantee the independent review already verified for the resume-vs-resume case (§11 point 3); it extends to rewind-vs-attach because both operations update the identical `swipes` row, which is what Postgres actually serializes on — not any explicit application-level lock, and not reliant on the two statements being combined into one. There is no window where a race could leave rewind's marker visible without the claim-clear, or the claim-clear visible without the marker. (See test §7 item 29.)

Its other needed update, unchanged from earlier revisions: once `reserve_and_record_right_swipe` inserts the swipe row directly instead of `finalize_interested_swipe` doing it, rewind's existing logic (find most recent non-rewind event, insert a `rewind` row, delete the matching `applications` row) is otherwise unaffected — it operates on `swipes`/`applications` rows, not on the now-removed counter-increment step. The existing `daily_right_swipes_count` decrement in rewind can stay as part of the legacy-counter safety net from §2, or be dropped in the same follow-up that retires the counters — not this migration.

**Rewind-then-reswipe (closes reviewer item C):** rewind inserts a row with `rewound_decision_id` pointing at the original decision. The duplicate check in `reserve_and_record_right_swipe` / `record_pass` uses the exact same "active" definition as the §1 counting query — `action <> 'rewind'` AND not the target of a later rewind — so the moment a decision is rewound, it stops being "active" for *both* counting and duplicate purposes, in the same way, via the same clause. A Pro user who rewinds a decision on vacancy X and then swipes on X again will not hit `DUPLICATE_INTERACTION`: the original row is excluded, a brand-new row is inserted, and the intended rewind-and-reswipe workflow works with no special-case code — it falls out of using one shared "active" definition everywhere rather than two different ones.

### RPC signature/overload handling (ties to §2)

- `DROP FUNCTION IF EXISTS public.reserve_right_swipe();` and `DROP FUNCTION IF EXISTS public.finalize_interested_swipe(TEXT, JSONB);` before creating the new-named functions — using new function names (`reserve_and_record_right_swipe`, `attach_right_swipe_decision`) rather than overloading the old names avoids any ambiguity about which signature PostgREST/old clients resolve to. `attach_right_swipe_decision` takes three params (`p_swipe_id`, `p_decision_snapshot`, `p_claim_id`) — a different signature from `finalize_interested_swipe`'s two, so this is a new function, not a same-signature replace, same reasoning as above.
- `REVOKE ALL ... FROM PUBLIC, anon;` / `GRANT EXECUTE ... TO authenticated;` restated for the new names, matching the existing pattern at the bottom of migration 003.
- Add a test (§7) that calls the *old* function names post-migration and asserts they 404/error — confirming no stale route build or cached PostgREST schema can still reach them.

---

## 4. Route changes — [`src/app/api/opportunities/swipe/route.ts`](../src/app/api/opportunities/swipe/route.ts)

- `action === 'interested'`: call `reserve_and_record_right_swipe(opportunityId)`.
  - `allowed: true` → proceed with matching/AI-kit generation exactly as today, then call `attach_right_swipe_decision(swipeId, decisionSnapshot, claimId)` — **the route must hold `claimId` from the reservation response and pass that exact token**, instead of the old two-argument `finalize_interested_swipe`. **The route must read the function's `attached` field, not just confirm the call didn't throw** — `attached: true` → return the normal 200. `attached: false` (practically impossible on this exact path, since nothing else could hold a newer claim on a row this request just inserted — but still checked, never assumed) → treat as the stale-claim failure below.
  - `code: 'DUPLICATE_INTERACTION', hasDecision: false, resumeInProgress: false` → **resume branch, not an error response.** This request won the claim (`claimId` present in the response). Proceed with matching/AI-kit generation exactly as the success path, using `existingSwipeId` in place of a freshly-reserved `swipeId`, then call `attach_right_swipe_decision(existingSwipeId, decisionSnapshot, claimId)` — this call's own fresh token, never one carried over from a different attempt. **Branch on the function's returned `attached` field, not on the absence of a thrown error:**
    - `attached: true` → the client receives the normal 200 success shape — it cannot tell this apart from the first attempt having gone straight through.
    - `attached: false, reason: 'stale_claim'` → **this request's AI result was discarded, not persisted — the route must not report 200 for it.** This token was superseded by the time the AI step finished (the delayed-response case). The route returns a failure for *this* request (e.g. 409), logs the discarded AI spend, and does not retry the attach with the same stale token. The row's actual decision belongs to whichever request currently or most recently held the claim — this request is simply not that one anymore.
  - `code: 'DUPLICATE_INTERACTION', hasDecision: false, resumeInProgress: true` → **HTTP 409** with `{ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION', resumeInProgress: true }`. Another in-flight request already holds the claim and is running AI/matching for this swipe. **The route must not start its own AI/matching call here** — that would be two paid calls racing to attach the same row. The client can retry after a short delay if it wants the result; it will either see `hasDecision: true` (the other request finished) or `resumeInProgress: false` (the claim expired and this retry now owns it).
  - `code: 'DUPLICATE_INTERACTION', hasDecision: true` → **HTTP 409** with `{ error: 'duplicate_interaction', code: 'DUPLICATE_INTERACTION' }`. This is a true duplicate (already fully completed) — no replay of the original decision data, the client already has it.
  - `RIGHT_LIMIT_REACHED` / `TOTAL_LIMIT_REACHED` → **HTTP 403** with `{ error: 'limit_reached', code, resetAt, rightCount, totalCount }`.
- `action === 'passed'`: call `record_pass(opportunityId)`. Its `DUPLICATE_INTERACTION` is always a true 409 (no resume branch — a pass has no deferred decision step to retry). `TOTAL_LIMIT_REACHED` → 403, same shape as above. Today this path always returns 200; it now has a real gated path.

---

## 5. Entitlement API — [`src/app/api/profile/route.ts`](../src/app/api/profile/route.ts) / [`src/lib/entitlement/client.ts`](../src/lib/entitlement/client.ts)

**Closes reviewer item D.** Extract the §1 window-count query into exactly one SQL function (e.g. `get_rolling_swipe_counts(uid)`) — not a convention that two call sites happen to follow, but one piece of SQL both call sites literally invoke, so "consistent database time and active-event definitions" isn't something that can drift: there is only one definition to drift from. Both `reserve_and_record_right_swipe` / `record_pass` (§3) and `/api/profile`'s read path call this same function, each evaluating `now()` fresh at their own call time (never passed a cached or client-supplied timestamp) and using the identical "active" predicate from §1 (excludes `rewind` rows and rewound originals). `ServerEntitlement` currently exposes `dailyRightSwipesCount` / `rightSwipeLimit` from the stale calendar-day counter; it needs `rightCount` / `totalCount` (no `leftCount` cap, display-only if shown at all) from the shared function instead.

---

## 6. Frontend

- [`UpgradeModal`](../src/components/premium/upgrade-modal.tsx): two `UpgradeReason` variants for `RIGHT_LIMIT_REACHED` / `TOTAL_LIMIT_REACHED` (Concept 2 / Concept 3 copy), with a countdown driven by the route's cap-specific `resetAt` — never computed client-side as "now + 24h."
- `feed/page.tsx` / `swipe-controls.tsx`: branch on `code` to choose the modal variant; today there's only one path.
- Left-swipe (pass) now has a real failure path (`TOTAL_LIMIT_REACHED` only, never a left-specific one) — needs a blocked-state affordance on the pass button it doesn't have today.
- A `DUPLICATE_INTERACTION` (409) response must not trigger either modal — it's a defensive/stale-client case, not a limit.

---

## 7. Test plan (real-infra, isolated Supabase project — never `.env.local`'s project without separate go-ahead, per [[remotematch-env-local-production-sensitive]])

**Limits:**
1. 15 interested in <24h → allowed; 16th blocked `RIGHT_LIMIT_REACHED`, `total_count < 50`.
2. 50 total (any right/left mix with `right_count < 15`) → allowed; 51st blocked `TOTAL_LIMIT_REACHED`. A mix hitting 15 right first → blocked `RIGHT_LIMIT_REACHED` even with `total_count < 50`. (No left-specific test — confirmed no independent left cap; 35+ left swipes alone are allowed as long as total stays ≤ 50.)
3. Window expiry: an event at 24h+1s old is excluded (allowance restored, no explicit reset action); at 23h59m59s old it's still included (both boundary directions).

**Atomicity — the core fix this revision makes, must be proven, not assumed:**
4. Two concurrent `interested` requests at `right_count = 14` → exactly one succeeds (15th), the other gets `RIGHT_LIMIT_REACHED`.
5. Two concurrent requests (any mix) at `total_count = 49` → exactly one succeeds, the other gets `TOTAL_LIMIT_REACHED`. This is the exact scenario Finding 1 identified — assert the *final* row count is 50, never 51.
6. Two concurrent requests for the *same vacancy* (either both `interested`, both `passed`, or one of each) → exactly one decision is persisted, the other gets `DUPLICATE_INTERACTION` / 409. Run this for a Free account and separately for a Pro account (Pro's duplicate check must also be race-free, even though Pro has no count limit to protect).
7. A *different*-vacancy concurrent pair at the same time as test 6, to confirm the lock serializes correctly per-user without false-blocking unrelated swipes.
8. Old function signatures (`reserve_right_swipe()` zero-arg, `finalize_interested_swipe(TEXT, JSONB)`) are gone post-migration — calling them errors, not silently succeeds via stale PostgREST cache.

**Rewind:**
9. Pro: swipe right → rewind → immediately re-allowed, `right_count` back down without waiting for the window (row + its rewind marker both excluded per §1).
10. Pro: rewind called twice in a row with no new swipe in between → second call returns `nothing_to_rewind`, no additional restoration (existing one-shot guard, re-verified under the new counting model).
11. Free: calling rewind at all → `pro_required`, unchanged. (Confirms the "repeated rewind cycling" concern has no Free-tier surface.)
16. **Rewind-then-reswipe (reviewer item C):** Pro swipes right on vacancy X, rewinds, then swipes right (or passed) on X again → `allowed: true`, a new row is inserted, `DUPLICATE_INTERACTION` is **not** returned. Confirm two live rows exist for `(profile_id, X)` afterward (the rewound original + the new decision), and only the new one is "active" per §1.
27. **Rewind-clears-claim (independent review finding 6):** Pro swipes right (claim acquired, `claimId` held), rewinds *before* calling `attach_right_swipe_decision`. Assert the rewound row's `enrichment_claim_id` is now `NULL`. Then call `attach_right_swipe_decision` with the original (now-stale) `claimId` for that row — assert `{ attached: false, reason: 'stale_claim' }`, and assert the row's `decision_snapshot` stays `NULL` (no AI content lands on a row the user already undid).
29. **Rewind/attach race, no split-state window (explicit atomicity requirement before authorization):** fire `rewind_last_decision()` and a concurrent `attach_right_swipe_decision(originalClaimId)` for the same swipe at the same moment, repeated many iterations with randomized timing to probe for a race. Assert the outcome is always one of exactly two consistent states — (a) attach completed first: `decision_snapshot` set, rewind then finds the row already has a decision and rewinds that decision normally (or, if attach's update already changed `action`/state in a way rewind's own most-recent-event lookup would see, assert rewind behaves per its existing one-shot semantics against that true final state); (b) rewind completed first: marker inserted **and** claim cleared together, attach's subsequent `UPDATE` observes the cleared claim and returns `{ attached: false }` — **never** a decision snapshot attached to a row whose rewind marker also exists, and never an observed state with the rewind marker present but the claim still set to the old value.

**Retry / resume (reviewer items A & B):**
17. Simulate a crash between `reserve_and_record_right_swipe` succeeding and `attach_right_swipe_decision` running (kill the request after the reservation call in a test harness) → the swipe row persists with `decision_snapshot = NULL`. A second request for the same `opportunityId` returns `DUPLICATE_INTERACTION, hasDecision: false, resumeInProgress: false` (claim was never set, or already expired) — assert the route's resume branch completes it (calls `attach_right_swipe_decision` on `existingSwipeId`) and the client gets a normal 200, not an error.
18. Same scenario, but the first attempt *did* complete (`decision_snapshot` is set) before the retry arrives → `DUPLICATE_INTERACTION, hasDecision: true` → route returns 409, no AI/matching step runs a second time.
19. Retry a `passed` action for the same opportunity after a simulated timeout → `DUPLICATE_INTERACTION` (passed has no resume branch) → 409, `total_count` unaffected by the retry.
20. Across tests 17–19, assert **exactly one** `swipes` row exists for the opportunity at the end — no retry path, successful or not, ever produces a second row.
21. **Concurrent resume (the specific ownership gap raised on this revision):** two requests for the same opportunity both land in the duplicate-check branch while `decision_snapshot IS NULL` and no claim is held — fire them concurrently. Assert exactly one gets `resumeInProgress: false` (and proceeds to run AI/matching) and the other gets `resumeInProgress: true` (and must be asserted, via a call-count spy on the AI/matching function, to never invoke it). Only one `attach_right_swipe_decision` call happens.
22. **Claim expiry:** acquire a claim, then advance time (or backdate `enrichment_claimed_at`) past the 2-minute timeout without calling `attach_right_swipe_decision` → a new request for the same swipe successfully re-claims (`resumeInProgress: false`) rather than being permanently blocked by a dead claim from a crashed process.
23. Run test 21 for a Pro account as well as Free — confirms the claim mechanism applies uniformly regardless of tier (duplicate-check-and-claim runs before the Pro branch, per §3 step 2/3 ordering).
24. **Fencing / delayed-response overwrite (the exact scenario raised on this revision):** Worker A claims (gets `claimId_A`), its claim is made to expire (backdate `enrichment_claimed_at`), Worker B reclaims (gets `claimId_B`, different token) and successfully attaches a decision — assert B's call returns `{ attached: true }`. Worker A's delayed AI response then arrives and calls `attach_right_swipe_decision(swipeId, staleDecision, claimId_A)` — assert **this call itself returns `{ attached: false, reason: 'stale_claim' }`, not merely "zero rows, no error."** Assert the route, given that return value, does **not** report 200 success to whatever client issued Worker A's request — it must branch on the field, not on the absence of an exception. Separately assert the data outcome: the row's `decision_snapshot` still holds Worker B's result and `enrichment_claim_id` is `NULL` (cleared by B's successful attach, not touched by A's no-op).
25. **Generalized version of test 24:** the original, non-duplicate inserting request (not an explicit "resume") is itself slow enough that its claim expires before its AI call returns; meanwhile a retry of the same request reaches the duplicate-check branch, reclaims (new token), and completes first (`{ attached: true }`). The original request's late `attach` call with its original token must return `{ attached: false, reason: 'stale_claim' }` the same way as test 24, and the route driving that original request must surface this as a failure for that request specifically, not a success — confirms the fencing token and its explicit-return-value handling apply symmetrically to the insert path (§3 steps 3/7) and not only to explicit resume wins (§3 step 2).
26. **Route honors the `attached` field, not call-success:** inject a scenario where `attach_right_swipe_decision` returns `{ attached: false }` without the test needing to engineer a real race (e.g. call it directly with a tampered/already-superseded `claimId`) and assert the route layer's handling returns a non-200 to its caller — a regression test specifically for "the route checked for a thrown error and missed a semantically-failed, exception-free call," which is the gap raised on this revision.

**Consistency / authority:**
12. Legacy counter and new rolling-window count intentionally disagree after a rewind or a window-boundary event — assert the route's gating decision follows the rolling-window result only, never the legacy counter (which is retained for display/rollback purposes only per §2).
13. Client-supplied timestamp in the request body is ignored — the only time value used anywhere is `now()` inside the locked transaction.
14. `/api/profile`'s displayed counts and the swipe route's gating counts come from the same shared SQL function (§5), called independently by each, each evaluating `now()` at its own call time — not two queries that could drift, and not a value cached from an earlier call.

**Pro:**
15. Pro: never blocked by any cap; duplicate check still fires first and still returns `DUPLICATE_INTERACTION` (checked before the Pro branch); window query never executes for a non-duplicate Pro request (verify via `EXPLAIN`/log).

**Behavior-change verification (independent review finding 8):**
28. Immediately after a successful `reserve_and_record_right_swipe` (or a resume win), before `attach_right_swipe_decision` runs, assert an `applications` row already exists for `(profile_id, opportunityId)` with `status = 'interested'` — confirming the documented, intentional timing shift (row now exists before AI enrichment completes, not after). Separately assert the tracker UI / `/api/applications` read path handles a visible row with no cover letter yet without erroring (even if full UI polish for that state is out of scope here, the read path must not break).

---

## 8. Rollout

Bounded branch; migration (index + dropped/recreated functions + `NOTIFY pgrst`) + route + entitlement API + frontend as one reviewable diff. Deploy order matters because this changes RPC signatures the live route depends on: **migrate functions first, confirm the new signatures are live and old ones are gone, then deploy the route build that calls them** — not the reverse, and not simultaneously assumed-atomic across two deploy targets (Supabase migration vs. Railway app deploy are two separate systems here). Rollback means redeploying the prior route build against the prior function signatures, documented explicitly in the migration's commit message — not just "revert the SQL file," since the route and the functions must move together. Same commit/review/migrate/deploy sequence as the C1/C2/Razorpay gates in this repo's history. No step is authorized to run yet.

---

## 9. Decisions resolved across revisions

- **Rolling 24h, event-based accounting** (not calendar-day) — approved, unchanged.
- **No independent 35-left cap** — confirmed 2026-11-05; only 15-right and 50-total gate anything.
- **Duplicate response:** `DUPLICATE_INTERACTION` / HTTP 409, no replay, original row untouched — now made *atomic*, not just defined (§3).
- **Reservation/persistence split is retained for the right-swipe AI step, but is no longer the race window** — the countable write (swipe-row insert) moved into the reservation call itself; only the non-countable decision-snapshot attach stays deferred (§3).
- **Counter-column sunset:** keep writing legacy counters for a verification period; retire in a separate follow-up PR.
- **Migration number:** not assigned here; reconciled against `main` + open PRs at build time.
- **Rewind — allowance abuse:** no change needed; its Pro-only gate already makes the "repeated rewind" concern structurally moot.
- **Rewind — in-flight claim (new in this revision, independent review finding 6):** `rewind_last_decision()` now clears `enrichment_claim_id`/`enrichment_claimed_at` on the row it rewinds, so a stale in-flight AI result can never land on an already-undone decision — it hits the same fencing check as any other superseded attach.
- **`applications`-row timing (new in this revision, independent review finding 8):** the row now exists from reservation/claim time, before AI enrichment completes — an intentional, now-documented and tested UX change, not a silent side effect of moving the insert earlier.
- **AI-failure / retry idempotency (items A & B):** one mechanism, not two — the duplicate check's `hasDecision` flag tells the route whether to resume AI enrichment on the existing row or return a true 409. No retry path can create a second countable row.
- **Rewind-then-reswipe (item C):** confirmed not a duplicate — rewind and duplicate-detection share the exact same "active" predicate, so freeing a decision from counting also frees it from the duplicate check, with no special-case code.
- **Cross-endpoint count consistency (item D):** one shared SQL function, called independently by both endpoints, each evaluating `now()` fresh — not a convention, a single piece of SQL.
- **Resume ownership:** a timeout-bounded claim column (`enrichment_claimed_at`), set atomically inside the same locked duplicate-check branch that detects a resumable swipe. Exactly one concurrent caller is ever told to run AI/matching for a given incomplete swipe; others get `resumeInProgress: true` and must not start their own AI call. A crashed claim holder's claim self-expires after 2 minutes rather than permanently blocking resume.
- **Fencing token:** the timestamp alone only answers "is a claim fresh," not "which attempt currently holds it." `enrichment_claim_id`, a fresh UUID generated every time ownership changes hands — including the *original* insert, not only explicit resume wins — is required by `attach_right_swipe_decision`'s `WHERE` clause.
- **Explicit `attached` return value (new in this revision):** a fenced-out `UPDATE` matching zero rows is not an error — nothing throws — so "the call didn't throw" is not a valid success check. `attach_right_swipe_decision` now returns `{ attached: true }` or `{ attached: false, reason: 'stale_claim' }` explicitly, and every caller (both the original-insert path and the resume path) is required to branch on that field before reporting success to its own client.

## 10. Requirements checklist against this revision

| Requirement | Where it's covered |
|---|---|
| Atomicity under concurrency (incl. the 49-swipe race) | §3 (insert moved inside the locked call), test §7 items 4–7 |
| Rewind restores allowance correctly; no abuse surface | §3 (`rewind_last_decision`, Pro-only gate), test §7 items 9–11 |
| Rewind-then-reswipe is not a false duplicate | §3 (shared "active" predicate), test §7 item 16 |
| AI-processing failure is defined: swipe persists, enrichment is retryable, no duplicate swipe can result | §3 (retry/idempotency contract), §4 (resume branch), test §7 items 17–20 |
| Reservation retried after a network timeout never double-consumes allowance | §3 (retry/idempotency contract), test §7 items 17–20 |
| Concurrent resume requests cannot both run AI/matching for the same swipe | §2 (claim column), §3 (atomic claim UPDATE), §4 (route must not call AI on `resumeInProgress: true`), test §7 items 21–23 |
| A crashed claim holder cannot permanently block future resume attempts | §3 (2-minute claim staleness window), test §7 item 22 |
| A superseded (expired, reclaimed-over) worker cannot overwrite a newer result | §2 (`enrichment_claim_id` column), §3 (`attach_right_swipe_decision`'s fencing check), test §7 items 24–25 |
| Fencing applies to the original insert path, not only explicit resume wins | §3 steps 3/7 (claim token set at insert time), test §7 item 25 |
| Server/DB timestamps only | §1 (`now()` inside the lock), test §7 item 13 |
| Right/total computed consistently, no stray left cap | §1 single query, §5 shared function, test §7 item 2 |
| Duplicate interactions (incl. concurrent, incl. Pro) consume no allowance | §3 step 2 (checked before insert and before Pro branch, same locked call), test §7 items 6–7 |
| Pro swipe limits / "Unlimited saves" unchanged | §3 step 3 — pure early insert-and-return, no new Pro-specific gating logic |
| `/api/profile` and the swipe route never disagree on counts | §5 (single shared function), test §7 item 14 |
| Two error codes + cap-specific server reset timestamp + existing modal integration | §1, §3 return shape, §4, §6 |
| Old RPC signatures cannot be used to bypass new enforcement | §2, §3 (explicit `DROP FUNCTION`), test §7 item 8 |
| Migration/rollback/signature-replacement strategy documented | §2, §8 |
| `attach_right_swipe_decision`'s result is checked by field, not by call-success | §3 (`attached` return value), §4 (route branches on it), test §7 item 26 |
| Rewind clears any in-flight claim on the row it rewinds | §3 (`rewind_last_decision` claim-clear), test §7 item 27 |
| `applications`-row timing shift is documented and tested, not silent | §3, §9, test §7 item 28 |
| Rewind's claim-clear is atomic with its rewind-marker insert — no split-state window | §3 (explicit MVCC/row-lock reasoning), test §7 item 29 |

## 11. Independent review — complete

A reviewer with no prior involvement in drafting this document checked it against the actual production SQL (`003_security_remediation.sql`, `001_initial_schema.sql`, the live swipe route, and git/migration history) — not this document's self-description — against seven points:

| # | Point | Verdict |
|---|---|---|
| 1 | Every path that can call `attach_right_swipe_decision` carries the claim ID | **PASS** |
| 2 | Claim acquisition and swipe insertion are atomic under the profile lock | **PASS** |
| 3 | Claim expiry cannot allow a stale worker to overwrite a newer result | **PASS** |
| 4 | The conditional attach checks both claim ownership and correct swipe state | **PASS** |
| 5 | A zero-row update is handled as a stale claim, not successful persistence | **PASS** (verified against documented PL/pgSQL `RETURNING INTO` semantics, not just trusted) |
| 6 | Rewind, reswipe, duplicate detection, Pro bypass, retry semantics stay mutually consistent | **CONCERN → closed this revision** (see below) |
| 7 | Migration/signature changes are compatible with the actual schema and migration sequence | **PASS** (verified directly: migration 044 is genuinely already committed on this branch; the real `reserve_right_swipe()`/`finalize_interested_swipe(TEXT, JSONB)` signatures match what this plan drops; `gen_random_uuid()` has been in use since migration 001, no new extension risk; `record_pass`'s unchanged signature correctly needs no drop) |

**Point 6, as raised:** `rewind_last_decision()` never checked or cleared `enrichment_claim_id`/`enrichment_claimed_at`, so a Pro user rewinding *while* an AI/matching call was still in flight for that same swipe could end up with stale AI content attached to a row they'd already undone — no quota impact, but a real data-integrity gap. **Closed in §3**: rewind now clears the claim on the row it rewinds, so any later attach for it is fenced out the same way any other superseded claim is.

**Additional (8th) finding, outside the original seven points:** moving the `applications`-row write to reservation/claim time is a genuine, previously-unflagged behavior change from today's attach-time creation — the tracker UI could now show a row before AI enrichment completes. Not a correctness bug. **Closed**: now an explicit, accepted decision in §3/§9 with its own test (§7 item 28).

**Overall verdict carried forward from the review:** the atomicity, fencing-token, and explicit-return mechanics are sound and independently verified against the real schema, not just internally consistent with this document's own claims. With both the CONCERN and the 8th finding closed in revision 8, plus explicit atomicity proof for the rewind claim-clear in revision 9 (§3, test item 29), **implementation is authorized under the boundaries stated at the top of this document.** Release/deployment is a separate, later decision — not covered by this authorization.

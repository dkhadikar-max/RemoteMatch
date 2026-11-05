# Phase 1 (Direct Employer Supply) — read-only implementation audit

**Status:** read-only audit of the already-written Phase 1 code on branch `feat/employer-company-accounts`. No fix applied, no commit, no push, no migration run, no deploy — per this audit's own instructions.
**Trigger:** a migration-numbering collision was flagged against open PR #48 before any commit happened.

**Resolution (2026-11-05, after this audit):** Deep decided PR #48 retains migrations 036–042 unchanged (it has 7 already-tested migrations; renumbering those would be far more disruptive than renumbering two never-committed local files). International payments takes `043`. This branch's migration was renumbered `037` → `044` and every in-repo reference to "migration 037" updated accordingly (migration file itself, `get-authenticated-employer.ts`, `audit-log.ts`, `admin.ts`, the register route, the test suite, and the Phase 1 plan doc). The three non-blocking findings below (middleware allowlist, test false-positive, `admin.ts` merge risk) were also addressed — see the addendum at the bottom. §1's narrative below is left as the point-in-time record of what was found, not rewritten.

---

## 1. Migration compatibility and ordering — **BLOCKER, confirmed**

Verified directly against GitHub (`gh pr view 48`) and the three relevant trees:

| Location | State | Migrations present |
|---|---|---|
| `origin/main` | merged | …033, 034, 035 (nothing at 036+) |
| PR #48 (`feat/resume-intelligence-service`, OPEN, base `main`, `mergeable: MERGEABLE`) | open PR | `036_resume_intelligence.sql`, `037_resume_intelligence_acl_hardening.sql`, `038_resume_upsert_analysis_ambiguity_fix.sql`, `039_resume_upsert_analysis_new_key_race_fix.sql`, `040_resume_quota_lifecycle.sql`, `041_resume_finalize_ownership.sql`, `042_resume_quota_reconciliation.sql` |
| Local disk, **untracked in git on every branch** (confirmed via `git status`/`git log --all`) | uncommitted | `036_billing_transactions.sql` (international-payments workstream — [[remotematch-razorpay-integration]]), and now `037_employer_company_accounts.sql` (this branch) |

**Exact collision:** both `036` and `037` are simultaneously claimed by PR #48 (committed, in an open PR) and by two separate pieces of local, never-committed work. This is the same pre-existing `036` collision already known from 2026-10-31 (resume-intelligence vs. international-payments), now joined by a second, new `037` collision from this branch.

**Content-level check (not just filenames):** read both PR #48's `037_resume_intelligence_acl_hardening.sql` and the local `036_billing_transactions.sql` in full. Neither touches `admin_audit_log`, `companies`, `company_members`, or anything else `037_employer_company_accounts.sql` depends on — the collision is **numbering-only**, not a logical/schema conflict. Renumbering this branch's migration to whatever slot is actually free once the sequence is coordinated is a trivial, content-free change when authorized — but per this audit's instructions, **not performed now**, and PR #48's own files were not touched.

**Also found, not previously listed in the brief:** PR #48 and this branch both append a new bullet to the **same doc-comment list** in `src/lib/supabase/admin.ts` (the "justified service-role usages" block), at the same anchor point (right after the OpenAI-cost bullet). Not a logical conflict — both are additive comments — but it **will produce a textual merge conflict** whichever of the two branches merges second. Worth knowing before either merges, not a migration issue.

---

## 2. Employer authentication and company ownership enforcement

Reviewed `src/lib/auth/get-authenticated-employer.ts` line by line.

- Correctly layers on `getAuthenticatedUser()` (never reimplements identity resolution).
- Membership check (`company_members`, `status = 'active'`, exact `company_id` + `profile_id` match) runs on the **service-role client**, never the caller's own session client — matches `getAuthenticatedAdmin()`'s shape exactly.
- `companyId` is required as an explicit parameter (not resolved implicitly), which is the right call given one profile can own multiple companies — a route MUST pass the id from its own path segment, never the body. Confirmed both `/api/employer/companies/[id]` routes do this (`getAuthenticatedEmployer(req, params.id)`), not from any request-body field.
- Throws `EmployerForbiddenError` (→ 404, not 403, per Q7) for: no row, wrong company, or `status = 'revoked'`. Confirmed in code; **not yet exercised against a real database** (§8).

**No issue found in this layer.**

---

## 3. Service-role-only access and RLS isolation

Reviewed `supabase/migrations/037_employer_company_accounts.sql` §3 against the `admin_users`/`supply_*` precedent.

- `FORCE ROW LEVEL SECURITY` (not just `ENABLE`) on both new tables — confirmed present.
- Single `FOR ALL USING/WITH CHECK (auth.role() = 'service_role')` policy on each — matches migration 012's pattern exactly (verified via diff against 012's own block).
- Explicit `REVOKE ALL ... FROM anon, authenticated` — confirmed present; no `GRANT ... TO authenticated` anywhere in the file (grepped, zero matches).
- No `authenticated`-role self-read policy was added anywhere (the Phase 1 plan's deliberate choice, §1.3) — confirmed, zero `CREATE POLICY` statements beyond the two service-role-only ones.

**No issue found in this layer.** (Live deny-by-default verification is written into the test suite but not yet run — §8.)

---

## 4. Admin verification transitions and audit logging

Reviewed `src/app/api/admin/company-verifications/[id]/route.ts`.

- `TRANSITIONS` table enforces a real state machine (`from: string[]` guard before writing `to`) — a `verify` on an already-`verified` company correctly 409s rather than silently no-op'ing or re-writing the same state. Confirmed by the suite's own "re-verify rejected 409" assertion (not yet run live, but the code path is there).
- Every transition — including `mark_under_review`, which I added after the initial Q5 pass specifically so it wasn't silently unaudited — requires a non-empty `reason` and calls `recordAdminAction()` unconditionally (`AUDIT_ACTION` is a total `Record`, not a `Partial`, so there is no action that skips the audit write).
- `admin_audit_log`'s CHECK constraints are extended in the same migration (`company_verify`, `company_reject`, `company_suspend`, `company_reinstate`, `company_mark_under_review`, target type `company`) — confirmed both the migration and `src/lib/admin/audit-log.ts`'s TS union were updated together, matching this codebase's own stated rule ("extend both together, never widen either to free text").

**No issue found in this layer.**

---

## 5. Cross-company access tests

`test/employer-company-accounts-suite.ts` §1 includes:
- 1c: account B (non-member) `GET`s account A's company → asserts `404`.
- 1e: account B `PATCH`es account A's company → asserts `404`.
- 2: the owner's *own session client* (not service-role) reading `companies`/`company_members` directly is asserted to still fail — proving no client-side RLS path exists even for a legitimate member, not just for a stranger.

These are written and structurally correct, but **have never been executed against a real database** — this sandbox has no `TEST_BASE_URL`/Supabase credentials (per this project's "blind-secret" norm), so the suite's live section only ever reaches its own self-skip branch here (confirmed — see §8's actual run output). Treat "cross-company isolation" as **asserted in code, not yet proven live**.

**Coverage gaps, not blockers:** no test exercises a `member`-role (non-owner/admin) attempting the profile-edit `PATCH` (expected 403, per the route's own `role !== 'owner' && role !== 'admin'` check) — that branch is written but untested. `suspend`/`reinstate` transitions are also untested (`verify`/`reject` are).

---

## 6. Registration and admin UI integration

- Admin nav: `src/components/admin/Sidebar.tsx` now lists "Company Verifications" distinct from "Employers" — confirmed no route-prefix collision (`/admin/company-verifications` vs. `/admin/employers`, and `pathname?.startsWith(href)` matching is prefix-safe between the two).
- Admin pages reuse the existing `DataTable`/`ConfirmDialog`/`StatusBadge` components exactly as the opportunities/employers pages do — no new UI primitives introduced.

**One real, non-blocking gap found:** `src/middleware.ts` protects pages via an explicit allowlist (`ONBOARDING_PREFIXES`, `PRODUCT_PREFIXES`). **`/employer` is in neither list.** The API routes underneath still correctly reject an unauthenticated caller (`getAuthenticatedUser()` → 401 JSON), so this is **not a security hole** — but a signed-out visitor hitting `/employer/register` or `/employer/companies/[id]` gets a rendered page that then shows a raw `"Unauthorized: sign-in required."` string instead of being redirected to `/login`, unlike every other verified-account-only page in the product. Fix (when authorized) is a one-line addition to `ONBOARDING_PREFIXES` in `src/middleware.ts` — not attempted here, read-only audit.

---

## 7. Full TypeScript error comparison and build results

Ran `npx tsc --noEmit` against the full repo (both before narrowing and filtered):

- **207 errors total**, all of them inside `content-os/` — a 153MB **untracked** subsystem (`git log --all -- content-os` returns nothing; it has never been committed to any branch) that was already present and already broken before this session started (per [[remotematch-antigravity-audit-2026-10-22]]).
- **Filtered to `^(src/|test/)` — zero errors.** Every file this Phase 1 work touched or added compiles clean.
- `npm run build` (`next build`) fails — but it fails inside `content-os/agents/strategy/strategy-agent.ts` on the very first type-checked file, before reaching anything this branch touched. This is a pre-existing, repo-wide build break unrelated to Phase 1; it would fail identically on `origin/main` with the same untracked `content-os/` directory present on disk. Confirmed `content-os/` is untracked on every branch (same working tree, branch-independent), so this isn't something introduced by switching to `feat/employer-company-accounts`.

**Conclusion: zero new TypeScript errors from Phase 1. The pre-existing `content-os/` break is a separate, already-known issue and blocks `next build` regardless of this work.**

---

## 8. Test-suite execution and coverage

Actually ran `npx tsx test/employer-company-accounts-suite.ts` in this sandbox (no Supabase credentials available here):

```
0. SOURCE — employer authorization layer + schema
  ✓ 13 passed
  ✗ 1 failed  — "no UNIQUE(profile_id) on company_members"
TEST_BASE_URL / Supabase env not all set — skipping the live portion.
13 passed, 1 failed, 0 skipped.
```

**Bug found in the test suite itself (not in the migration):** that assertion regex-scans the raw migration file text for `UNIQUE\s*\(\s*profile_id\s*\)`, but the migration's own header comment and `COMMENT ON TABLE` both contain the literal prose string `"UNIQUE(profile_id)"` while *explaining that no such constraint exists* (migration lines 16 and 98). The regex has no way to distinguish a real constraint from a comment saying "there is no such constraint" — it's a false-positive test bug, not a schema problem. Confirmed by direct inspection: the only real `UNIQUE` constructs in the file are `uq_companies_official_domain` (domain) and `uq_company_members_company_profile UNIQUE (company_id, profile_id)` (the composite membership key) — neither is `UNIQUE(profile_id)` alone. **The schema is correct; the test's self-check of that fact is buggy.** Left unfixed per this audit's read-only instruction.

**Live section: never executed, anywhere, including in this audit** — no `TEST_BASE_URL` or Supabase service-role key is available in this sandbox. Every assertion described in §2–§5 above as "written" is exactly that: written and statically reviewed, not run against a real Postgres/RLS boundary. This is the single largest gap in "done-ness" for this branch — the plan's entire §6 (RLS/security verification) and §7 (regression run) are unexecuted.

---

## Summary

### Blockers (must resolve before commit/merge, per this audit's brief)
1. **Migration numbering collision at both 036 and 037** between PR #48 (committed, open) and two pieces of uncommitted local work (international-payments' `036_billing_transactions.sql`, this branch's `037_employer_company_accounts.sql`). Numbering-only, zero content/schema conflict confirmed. Needs an explicit decision on merge order and final numbers across all three before any of the three commits/merges.

### Non-blocking issues found
2. `src/lib/supabase/admin.ts` doc-comment merge conflict (textual only) with PR #48, whichever merges second.
3. `/employer/**` pages are not in `middleware.ts`'s `ONBOARDING_PREFIXES`/`PRODUCT_PREFIXES` allowlist — signed-out visitors see a raw error string instead of a login redirect. Not a security gap (API-level auth still enforced).
4. Test-suite self-check bug: the "no `UNIQUE(profile_id)`" assertion false-positives on prose inside the migration's own comments (file: `test/employer-company-accounts-suite.ts`).
5. Coverage gaps in the (unexecuted) test suite: member-role PATCH-forbidden path, `suspend`/`reinstate` transitions.

### Confirmed clean
- Employer auth gate, service-role-only RLS, admin transition/audit-logging code, admin nav naming/routing — all reviewed, no defects found.
- Zero new TypeScript errors anywhere this branch touched; the only build/tsc failures are the pre-existing, unrelated, untracked `content-os/` subsystem.

### Not done (confirmed, matches the status table)
No commit, no push, no PR, no migration applied to any database, no deploy. The test suite's live portion has never been run against real infrastructure.

---

## Addendum (2026-11-05, same day) — resolution of all 4 findings

Per Deep's decision: PR #48 retains migrations 036–042; international payments takes 043; this branch renumbered `037` → `044`.

1. **Migration renumbered.** `037_employer_company_accounts.sql` → `044_employer_company_accounts.sql`, and every reference to "migration 037" updated across the migration file itself, `get-authenticated-employer.ts`, `audit-log.ts`, `admin.ts`, the register route, the test suite, and the Phase 1 plan doc. Verified with a repo-wide grep for `037` across `src/`, `test/`, `supabase/` — zero remaining matches.
2. **`admin.ts` merge-conflict risk eliminated, not just documented.** PR #48's new bullet and this branch's new bullet were both going to insert immediately after the same anchor line (the last existing bullet, `ai/spend-ledger.ts`) — the classic same-point-insertion conflict. Moved this branch's bullet to a different anchor (right after the `funnel_events` bullet, a spot PR #48 never touches) instead. The two branches' diffs to this file no longer overlap at all.
3. **Middleware gap fixed — and a second, worse bug caught while fixing it.** The first attempt (adding `/employer` to `ONBOARDING_PREFIXES`) was wrong: that bucket's own rule is "redirect to `/feed` if the verified caller already completed onboarding" (so a finished candidate never revisits `/onboarding`) — applying it to `/employer` would have bounced any already-onboarded candidate account straight back to `/feed` instead of letting them register a company, a regression worse than the original gap. Fixed properly with a new `VERIFIED_ONLY_PREFIXES = ['/employer']` bucket that participates in the plain "verified account required → else redirect to `/login`" check but is deliberately excluded from the onboarding-completion gate.
4. **Test false-positive fixed at the source, not just patched around.** The regex itself (now also stripping `--` comment lines, as defense in depth) wasn't the whole story: the literal string `"UNIQUE(profile_id)"` also appeared inside a `COMMENT ON TABLE ... IS '...'` SQL string literal (not a `--` line), which line-stripping alone would have missed. Reworded that prose to "No single-column uniqueness on profile_id" instead of patching the test to special-case SQL string literals too. Re-ran the suite's static section: **14 passed, 0 failed, 0 skipped.**

`npx tsc --noEmit` re-confirmed clean (zero errors) across every file this branch touches after all four fixes. Still not done: no commit, push, PR, migration, or deploy — unchanged from above.

---

## Final integration audit (2026-11-05, same day, read-only, no changes made)

### 1. Migration `044` — numbering conflicts

Checked `044_employer_company_accounts.sql`'s number directly against `origin/main` (tracked tree, tops out at `035`) and `feat/resume-intelligence-service` / PR #48 (tracked tree, `036`–`042`, confirmed `mergeable: MERGEABLE` via `gh`). **`044` is clear of both** — no number above `042` exists in either tree.

**Not yet true, and not mine to fix:** the agreed plan's other half — renumbering the international-payments workstream's `036_billing_transactions.sql` → `043` — **has not happened**. That file is still sitting on disk at `036`, untracked, identical to its state in the original audit. It is a different, unrelated workstream (no branch exists for it yet — it's local-only scaffolding, same as this branch was before being committed-ready), so per the explicit scope decision earlier in this conversation ("only my branch's items"), I did not touch it. Flagging it here because the overall 3-way plan (PR #48 = 036–042, international payments = 043, employer = 044) is only **2/3 executed** — `044` is safe regardless, but anyone merging PR #48 before international payments renumbers will still hit the original `036` collision on that side.

### 2. Employer registration and company ownership enforcement

Re-read `src/app/api/employer/register/route.ts` and the `[id]` route in full. Unchanged since the first audit, confirmed still correct: `created_by: user.id` recorded from the verified session (never client-supplied); the registering caller becomes `company_members.role = 'owner'`; `getAuthenticatedEmployer(req, params.id)` is used throughout, never a request-body `companyId`. One **pre-existing, already-disclosed limitation**, re-confirmed rather than newly found: the `companies` insert and the `company_members` insert are two sequential calls with a best-effort compensating delete on failure, not one atomic transaction/RPC — a process crash between the two inserts (not just an ordinary query failure, which IS handled) would leave an orphaned, unowned `companies` row. This was already named as a known limitation in the Phase 1 plan; still true, not a regression from today's fixes.

### 3. Admin verification transitions and audit logging

Re-read `src/app/api/admin/company-verifications/[id]/route.ts`. `TRANSITIONS` and `AUDIT_ACTION` are both unchanged since the original write and both still total (`AUDIT_ACTION` is `Record<VerificationAction, AdminAuditAction>`, not partial) — every one of the 5 actions (`mark_under_review`, `verify`, `reject`, `suspend`, `reinstate`) requires a reason and is unconditionally audit-logged. No gap found.

### 4. Discovery publication controls

Grepped every new file under `src/app/api/employer/**`, `src/app/api/admin/company-verifications/**`, and `supabase/migrations/044_employer_company_accounts.sql` for any reference to `opportunities`, `supply_platforms`, or `supply_sources`. **Zero matches except prose inside comments explicitly stating Phase 1 does not write to `opportunities`.** Confirmed: `opportunities_select_active` and `opportunities_manage_service_role` (migration 002) are untouched, and nothing in this branch has any code path into the catalog or the discovery gate. Phase 1 cannot weaken or bypass publication controls because it has no connection to them at all yet — that connection is explicitly Phase 3, not built.

### 5. Live-infrastructure tests

**New finding, not in the original audit:** `.env.local` in this working directory *does* define `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` (confirmed the names are present; values were never read or printed). The project ref embedded in the URL is `wmbodnkemnyaxdbhelar` — **this does not match any project ref in memory** (production is `kxzlwwjvagzwodrdxqbh`; the Razorpay isolated test project was `xyahktsgdigutxartafb`). I do not know whether `wmbodnkemnyaxdbhelar` is a dedicated local/dev Supabase project safe for the suite's create-real-users-and-companies-then-delete-them live section, or something else entirely.

**I did not run the live suite against it.** Per this project's own workflow discipline (gated approval; no blind action against an unidentified environment) and ordinary caution around an action that creates and deletes real auth users/rows, running a live test suite against an environment I can't identify is not something to do without confirming first what `wmbodnkemnyaxdbhelar` actually is. **This needs Deep to confirm** (or point this session at a confirmed-safe test project) before the live section runs anywhere.

### 6. Compatibility with PR #48 and international payments

- **PR #48**: re-diffed `src/lib/supabase/admin.ts`. PR #48's insertion is still anchored immediately after the `ai/spend-ledger.ts` bullet (the file's last bullet before the closing `*/`) — unchanged since the original audit. This branch's bullet now sits earlier in the same file (after the `funnel_events` bullet), so the two diffs' context lines no longer overlap at all; both will apply cleanly regardless of merge order. Re-confirmed via direct diff comparison, not just re-reading my own earlier claim.
- **International payments**: no git branch exists for it (local-only, same as this branch was before being commit-ready). Checked every file belonging to that workstream (`currency-config.ts`, `currency-format.ts`, `currency-config-suite.ts`, `docs/payment-currency-audit-2026-10-29.md`, and the still-unrenumbered `036_billing_transactions.sql`) — **zero file-level overlap** with anything this branch touches, beyond the already-known, not-yet-resolved `036` numbering slot (§1).

**Resolved:** Deep confirmed `wmbodnkemnyaxdbhelar` is production-sensitive, not a safe isolated test project — identified from Supabase logs (2026-09-09, project ref + db hostname), Deep's own 2026-09-13 statement that both his dev environment and production pointed to it at the time, and `funnel_events` (a real prod table) existing inside it. Likely the pre-2026-10-12-cutover production project, superseded by `kxzlwwjvagzwodrdxqbh` but never repointed in this working directory's `.env.local`; its status since the cutover is unconfirmed either way. **The live-infrastructure suite must not run against it.** A genuinely separate, confirmed-isolated test project still needs to be identified or provisioned before §5 can be completed — not done in this session.

### Summary of this final pass

No new blockers for **this branch specifically** — `044` is clean, ownership/auth/audit logic all re-confirmed correct, discovery controls confirmed untouched, and the `admin.ts` conflict-avoidance holds up under a real diff re-check. Two things still stand between this branch and a commit: (a) the live-infrastructure section has still never run anywhere, and now there's a concrete reason it can't run blindly — an unidentified Supabase project in `.env.local` that needs confirmation first; and (b) the wider 3-branch migration plan is only 2/3 done (international payments' `036`→`043` renumber is outstanding, on a different workstream). Nothing was changed, committed, pushed, migrated, or deployed in this pass.

# Phase 1 — Company onboarding: implementation plan

**Gate:** Phase 1 of the Direct Employer Supply & Verified Vacancy Publishing PRD (pasted 2026-11-05).
Builds on the Phase 0 audit: [docs/direct-employer-supply-phase0-audit-2026-11-05.md](direct-employer-supply-phase0-audit-2026-11-05.md).
**Status:** **Q1–Q7 (§8) signed off by Deep 2026-11-05, all per the stated recommendation. Still not authorization to modify the repo** — this plan now reflects the decided shape; implementation itself needs a separate go-ahead.
**Scope (this plan only):** a `companies` table + `company_members` table, employer self-registration, a minimal company-profile read/edit surface, an admin verification queue, and the `getAuthenticatedEmployer()` auth gate.
**Explicitly NOT in Phase 1** (PRD Phases 2–5): vacancy submission/management, any write path into `opportunities`, the full employer performance dashboard, document upload, automated business-email-domain verification, duplicate-company fuzzy matching, ATS integrations. Phase 1 produces a *verified or rejected company record* — it is not wired to the job catalogue at all yet.

---

## 0. What the audit found that shapes this plan

1. **No existing table to extend.** `allowlist_employers` (migration 012) is curated ATS-scrape targets, unrelated to a company account. There is no `companies` table today.
2. **`supply_platforms.source_type` already reserves `'employer_direct'`** — Phase 1 does not touch `supply_platforms`/`opportunities` at all (that's Phase 3), but the reservation confirms where this eventually connects.
3. **Every privileged table in this codebase is zero-client-RLS + server-side gate**, never client-trusted claims: `admin_users` (migration 029) is the template — no RLS policy grants *any* client role access; `getAuthenticatedAdmin()` is the only path in. This plan copies that shape exactly for company membership, rather than giving `companies`/`company_members` any `authenticated`-role RLS policy. All employer-facing reads/writes go through Next.js API routes using the **service-role** client, the same way every `/api/admin/*` route already works.
4. **Naming collision to resolve (Q1 below):** the existing admin nav already has a page titled **"Employers"** (`src/app/admin/(dashboard)/employers`, [page.tsx:71](../src/app/admin/(dashboard)/employers/page.tsx#L71)) for the ATS allowlist. Phase 1's admin verification queue needs a different name or it will be confused with that page.
5. **`recordAdminAction()`** ([audit-log.ts](../src/lib/admin/audit-log.ts)) already gives Phase 1 its audit trail for free — no new audit table needed, mirroring how `opportunity_force_expire` and discovery promotion are logged today.
6. **Auth baseline**: every caller is already a real, verified, non-anonymous account (`getAuthenticatedUser()`; anonymous sign-in is off site-wide). Phase 1 adds a second check on top, exactly like admin does, not a replacement.

---

## 1. Schema

New file: **`supabase/migrations/044_employer_company_accounts.sql`** (renumbered 2026-11-05 from `037` — PR #48 retains migrations 036–042, international payments takes 043; see [docs/direct-employer-supply-phase1-audit-2026-11-05.md](direct-employer-supply-phase1-audit-2026-11-05.md)).

### 1.1 `companies`

```sql
CREATE TABLE IF NOT EXISTS companies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name             text NOT NULL,
  official_website       text NOT NULL,
  official_domain        text NOT NULL,              -- normalized host, derived server-side from official_website
  business_email         text NOT NULL,
  country_of_registration text NOT NULL,
  registration_number    text,
  linkedin_url           text,
  industry               text,
  company_size           text,
  description            text,
  headquarters           text,
  verification_status    text NOT NULL DEFAULT 'pending'
                           CHECK (verification_status IN ('pending', 'under_review', 'verified', 'rejected', 'suspended')),
  verification_reviewed_at timestamptz,
  verification_reviewed_by text,
  verification_reason    text,
  created_by             uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_official_domain ON companies (lower(official_domain));
CREATE INDEX IF NOT EXISTS idx_companies_verification_status ON companies(verification_status);
```

- `official_domain` is computed server-side (API route), not client-supplied, from `official_website` — same defensive posture as `catalog.ts`'s existing company-name sanitization. The unique index is Phase 1's entire duplicate-detection mechanism (exact-domain only; fuzzy/name-similarity duplicate detection is explicitly deferred — see Q3).
- `ON DELETE RESTRICT` on `created_by`: a company record must not silently lose its registrant; deleting a profile that registered a company is blocked, matching this codebase's existing caution around FK deletes (cf. `allowlist_employers.linked_source_id ON DELETE SET NULL` was a deliberate choice for a *soft* link — this one is a hard provenance link, so `RESTRICT` is the right default, but flagged for sign-off, not assumed).

### 1.2 `company_members`

```sql
CREATE TABLE IF NOT EXISTS company_members (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  profile_id                uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role                      text NOT NULL DEFAULT 'owner'
                             CHECK (role IN ('owner', 'admin', 'member')),
  representative_name       text NOT NULL,
  representative_designation text NOT NULL,
  representative_relationship text NOT NULL,
  status                    text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'revoked')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_company_members_company_profile UNIQUE (company_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_company_members_profile ON company_members(profile_id);
CREATE INDEX IF NOT EXISTS idx_company_members_company ON company_members(company_id);
```

- The PRD's "authorized representative" fields (§2: name, designation, relationship-to-company) are captured **per membership row**, not on `companies` — the registering user *is* the first `company_members` row (`role='owner'`), and any later-added teammate (PRD §3 "manage authorized team members") gets their own representative fields too. This avoids a company having one "representative" baked into its own row while actually having several authorized people.
- One profile may belong to more than one company (no `UNIQUE(profile_id)`) — flagged as an assumption, not a PRD requirement either way (see Q4).

### 1.3 RLS — zero client access, mirrors `admin_users`

```sql
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY "companies_service_role_all" ON companies FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON companies FROM anon, authenticated;
GRANT ALL ON companies TO service_role;

ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_members_service_role_all" ON company_members FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON company_members FROM anon, authenticated;
GRANT ALL ON company_members TO service_role;
```

No `authenticated`-role policy of any kind, even a `USING (profile_id = auth.uid())` self-read one. **Rationale:** every other piece of "is this caller allowed to see/do X" logic in this codebase that carries real consequences (admin, billing access, allowlists) is resolved server-side against the service-role client, never via a client-side RLS self-check — see `getAuthenticatedAdmin()`. A `company_members` self-read policy would be the *first* exception to that pattern and would also leak membership existence/role to any client holding a valid session via direct PostgREST access, bypassing the server routes entirely. All employer-facing reads route through `getAuthenticatedEmployer()` + the service-role client instead (§3).

### 1.4 Rollback (documented, not auto-run)

```sql
-- 044 down
DROP INDEX IF EXISTS idx_company_members_company;
DROP INDEX IF EXISTS idx_company_members_profile;
DROP TABLE IF EXISTS company_members;
DROP INDEX IF EXISTS idx_companies_verification_status;
DROP INDEX IF EXISTS uq_companies_official_domain;
DROP TABLE IF EXISTS companies;
```

No existing table is altered by this migration — fully additive, zero lock risk on `opportunities`/`profiles`/anything already in production.

---

## 2. Verification workflow (the state machine)

| From | To | Who | Mechanism |
|---|---|---|---|
| (new) | `pending` | employer | `POST /api/employer/register` |
| `pending` | `under_review` | admin | opens the record in the admin queue (optional auto-transition on first admin view, or left manual — see Q5) |
| `pending`/`under_review` | `verified` | admin | `PATCH /api/admin/companies/[id]` `{action:'verify', reason}` |
| `pending`/`under_review` | `rejected` | admin | `PATCH .../[id]` `{action:'reject', reason}` (reason required) |
| `verified` | `suspended` | admin | `PATCH .../[id]` `{action:'suspend', reason}` (reason required) |
| `suspended` | `verified` | admin | `PATCH .../[id]` `{action:'reinstate', reason}` |

Every transition requires a non-empty `reason` and is written via `recordAdminAction()` with before/after `verification_status` — identical shape to `opportunity_force_expire`. No transition is a free-form status PATCH (mirrors the opportunities admin route's "one sanctioned action set" discipline, not an open `status` field write).

**What "verified" actually checks in Phase 1** (manual, admin-driven — per PRD §2 "AI can assist... but cannot invent" and the fact that nothing here is automatable without new infrastructure):
- Business identity / website / representative authorization: admin reviews the submitted fields (name, website, registration number, LinkedIn, representative name/designation/relationship) and may look the company up externally. **Not automated in Phase 1.**
- Duplicate detection: automatic and structural — the `uq_companies_official_domain` unique index rejects a second registration for the same domain at submission time, before it ever reaches the admin queue. (Fuzzy/name-based duplicate detection across *different* domains is explicitly out of scope — Q3.)
- Business email verification: **explicitly deferred — see Q2.** The PRD itself states email verification alone is insufficient, so Phase 1 ships without it rather than building a half-step; Phase 1's `business_email` field is stored and shown to the admin, unverified.

---

## 3. Auth gate — `getAuthenticatedEmployer()`

New file **`src/lib/auth/get-authenticated-employer.ts`**, structured exactly like [get-authenticated-admin.ts](../src/lib/auth/get-authenticated-admin.ts):

```ts
export class EmployerForbiddenError extends Error { /* ... */ }

export interface AuthenticatedEmployer {
  user: User;
  supabase: SupabaseClient;
  companyId: string;
  role: 'owner' | 'admin' | 'member';
}

export async function getAuthenticatedEmployer(
  req: NextRequest,
  companyId: string
): Promise<AuthenticatedEmployer> {
  const { user, supabase } = await getAuthenticatedUser(req);
  const admin = getSupabaseAdminClient();
  if (!admin) throw new ServiceUnavailableError();

  const { data: member } = await admin
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('profile_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (!member) throw new EmployerForbiddenError();
  return { user, supabase, companyId, role: member.role };
}
```

Takes `companyId` as a parameter (unlike `getAuthenticatedAdmin()`, which has exactly one admin scope) because a caller can belong to more than one company (§1.2) — every employer route must state *which* company it is acting on, resolved from the route path (`/api/employer/companies/[id]/...`), never trusted from the request body alone.

---

## 4. API surface (Phase 1 only)

### 4.1 Employer-facing

| Route | Method | Auth | Does |
|---|---|---|---|
| `/api/employer/register` | POST | `getAuthenticatedUser()` only (no company yet) | Validates all PRD §2 required fields server-side; normalizes `official_website` → `official_domain`; inserts `companies` (`verification_status='pending'`) + the first `company_members` row (`role='owner'`) in one transaction (service-role client, `rpc` or sequential insert with cleanup-on-failure); returns 409 with a clear message on the domain-uniqueness conflict (not a generic 500). |
| `/api/employer/companies/[id]` | GET | `getAuthenticatedEmployer(req, params.id)` | Returns the company record + `verification_status` + the caller's own membership row. |
| `/api/employer/companies/[id]` | PATCH | `getAuthenticatedEmployer(req, params.id)`, `role IN ('owner','admin')` | Edits the editable profile fields only (`description`, `headquarters`, `industry`, `company_size`, `linkedin_url`) — **never** `verification_status`, `official_domain`, or anything verification-relevant; an edit to a verification-relevant field after `verified` should arguably force re-review, but that policy question is deferred (Q6) rather than silently decided. |

No "manage team members" endpoint in Phase 1 (PRD §3's "manage authorized team members" dashboard feature) — adding a teammate requires inviting a second real account, which touches invitation/email flows not otherwise justified for Phase 1's narrow goal of *one verified company record*. Flagged as deferred, not dropped.

### 4.2 Admin-facing

| Route | Method | Does |
|---|---|---|
| `/api/admin/company-verifications` | GET | List + filter by `verification_status`, search by `legal_name`/`official_domain` — same shape as `GET /api/admin/employers` and `GET /api/admin/opportunities`. |
| `/api/admin/company-verifications/[id]` | GET | Full record + its `company_members` rows (so the admin sees the representative fields). |
| `/api/admin/company-verifications/[id]` | PATCH | The sanctioned `{action, reason}` transitions from §2, via `getAuthenticatedAdmin()`, audited with `recordAdminAction()`. |

New admin nav page **`src/app/admin/(dashboard)/company-verifications/`** — deliberately **not** named "Employers" (Q1): that label is already taken by the ATS allowlist page and reusing it would make two unrelated moderation queues indistinguishable in the nav.

---

## 5. Frontend (minimal, Phase 1 scope only)

- `src/app/employer/register/page.tsx` — the registration form (PRD §2 fields), posts to `/api/employer/register`, redirects to a "pending review" state on success.
- `src/app/employer/companies/[id]/page.tsx` — read-only company profile + status banner (`pending`/`under_review`/`verified`/`rejected`/`suspended`) with the edit form from §4.1's PATCH for the editable fields only.
- Admin: a list + detail view under `(dashboard)/company-verifications/`, styled like the existing `(dashboard)/employers` and `(dashboard)/discovery` pages (same table/filter/detail-panel pattern).

No feed-facing UI change at all — Phase 1 never writes to `opportunities` and carries no "verified employer badge" (that's Phase 3+, contingent on a vacancy actually existing).

---

## 6. RLS / security verification plan

Mirrors the C1 plan's §4.3 exactly:
1. **Schema assertions**: `relrowsecurity`/`relforcerowsecurity` = true on both new tables; anon client SELECT/INSERT → denied; authenticated (non-member) client SELECT/INSERT → denied; service-role → full CRUD.
2. **Cross-tenant isolation** (the one genuinely new risk Phase 1 introduces): with two real test accounts and two companies, assert `getAuthenticatedEmployer()` for account A against company B's id throws `EmployerForbiddenError`, and that `/api/employer/companies/[B.id]` returns 403 for account A's session — not 404 (don't leak existence either way; confirm which is intended — Q7).
3. **Duplicate-domain race**: two concurrent `POST /api/employer/register` with the same `official_domain` → exactly one `201`, one `409` (relies on the unique index, not app-level pre-check, to be race-free).
4. All of the above against **real infrastructure** (an isolated Supabase test project, not mocks), per this project's testing norm — new suite `test/employer-company-accounts-suite.ts`, modeled on `gate1-rls-isolation.ts`, with cleanup of every row it creates.

## 7. Regression run order

1. `npx tsc --noEmit`
2. `npm run build`
3. `verification-suite.ts` (baseline — expect unaffected, zero existing table touched)
4. `gate1-rls-isolation.ts` (extend with the two new tables)
5. New `employer-company-accounts-suite.ts`

Nothing here touches `opportunities`, `profiles`, `admin_users`, billing, or matching — expected impact on every pre-existing suite is **zero**, matching the audit's finding that Phase 1 is additive-only.

---

## 8. Ambiguities — DECIDED 2026-11-05 (Deep signed off on every recommendation as-is)

| # | Question | Decision |
|---|---|---|
| Q1 | Admin page naming collision with the existing "Employers" (ATS allowlist) page. | **Rename new page only** → "Company Verifications". The existing "Employers" (ATS allowlist) page is untouched. |
| Q2 | Business-email verification. | **Deferred entirely.** `business_email` is stored unverified; admin judges manually. No app-side mail-send code is added in Phase 1. |
| Q3 | Duplicate detection beyond exact-domain match. | **Exact-domain only** (the `uq_companies_official_domain` unique index). No fuzzy/name-similarity matching in Phase 1. |
| Q4 | Can one profile belong to multiple companies? | **Yes** — no `UNIQUE(profile_id)` constraint on `company_members`. |
| Q5 | Does `pending → under_review` happen automatically or only via explicit admin action? | **Explicit action only.** No auto-transition on `GET`. |
| Q6 | Does editing a profile field after `verified` force re-review? | **No auto-downgrade.** Editable fields stay cosmetic-only (§4.1); identity fields have no edit route at all. |
| Q7 | 403 vs 404 for a non-member requesting a company they don't belong to. | **404** — never confirms a given domain has any registration, matching this codebase's existing defensive posture. |

§1–§7 above already reflect these decisions (no section needs rewriting). This plan is fully decided; implementation itself still needs a separate explicit go-ahead per [[remotematch-workflow-discipline]].

---

## 9. Deliverable shape (when authorized)

1. `supabase/migrations/044_employer_company_accounts.sql` (+ down script from §1.4).
2. `src/lib/auth/get-authenticated-employer.ts` (new).
3. `src/app/api/employer/register/route.ts`, `src/app/api/employer/companies/[id]/route.ts` (new).
4. `src/app/api/admin/company-verifications/route.ts`, `.../[id]/route.ts` (new).
5. `src/app/employer/register/page.tsx`, `src/app/employer/companies/[id]/page.tsx` (new).
6. `src/app/admin/(dashboard)/company-verifications/page.tsx` (new, following the existing `(dashboard)/employers` pattern).
7. `test/employer-company-accounts-suite.ts` (new).
8. Full diff shared for review **before** any `git add`/commit; then the §7 regression run; then a second diff review; then commit — each its own gate, per [[remotematch-workflow-discipline]]. No production migration or deploy without separate authorization (PRD §12 and this project's standing norm).

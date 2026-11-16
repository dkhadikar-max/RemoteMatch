# Phase 0 audit — Direct Employer Supply & Verified Vacancy Publishing

Read-only investigation only. No code, migrations, or schema changes in this pass.
Source PRD: pasted by Deep 2026-11-05 (not yet saved elsewhere in the repo).

## 1. Company identity — does NOT exist today

`opportunities.company` (migration 001) is a plain `TEXT`, exact-string, with
**no FK, no canonical row, no dedup, no normalization**:
[catalog.ts:14](../src/lib/companies/catalog.ts#L14) states this explicitly as an
accepted Phase 0 "Company Radar" limitation — `"GitLab"` and `"gitlab"` are two
separate companies today. "Company Radar" (`/companies`, `/companies/view/[company]`)
is a read-only grouping UI over this string, plus funnel instrumentation
(migration 035) — it is not an identity system, has no verification, and no
employer-facing account behind it.

`allowlist_employers` (migration 012, [012_supply_discovery_registry.sql](../supabase/migrations/012_supply_discovery_registry.sql))
is a different, unrelated concept: curated **ATS acquisition targets** for the
scraping pipeline (which employers' Greenhouse/Lever/Ashby boards to pull from),
reviewed by admins via `supervised-promotion.ts`. It is not a company account
and has no relationship to a human representative.

**Load-bearing fact for the PRD's Phase 1**: `supply_platforms.source_type`
already reserves a value for this — `'employer_direct'` — with the comment
*"a reserved source_type for the future Layer 3 track; not implemented."*
([012_supply_discovery_registry.sql:46](../supabase/migrations/012_supply_discovery_registry.sql#L46)).
This PRD is that Layer 3 track. A real company-identity table (e.g.
`companies`) with verification state, and a join from `opportunities` to it,
does not exist and would be new.

## 2. Opportunities schema & source provenance

- `opportunities` ([001_initial_schema.sql](../supabase/migrations/001_initial_schema.sql)):
  `source` is now FK'd to `supply_platforms.slug` (migration 012) — **platform-level**
  provenance (`greenhouse`, `curated`, `remotive`, â€¦), not per-employer. `source_id` +
  `source` are unique together; `canonical_id` is a STORED generated column
  (`opp-<source>-<source_id>`) used everywhere (swipes/applications/matches)
  as the opaque public identifier.
- `supply_sources` is the per-endpoint (platform + board) registry, with its own
  `review_status`/`status` lifecycle (`proposed → approved → active → paused → retired`)
  and reliability counters. This is the closest existing analogue to "vacancy
  source verification," but it verifies a *feed*, not an individual listing.
- There is no per-opportunity verification status today beyond `status IN
  ('active','expired','draft')` and `quality_score` (an int, origin unclear from
  schema alone — likely heuristic, not a verification outcome).
- `last_verified_at` exists on `opportunities` but nothing in the schema enforces
  a review workflow around it — it looks like a freshness timestamp, not an
  approval gate.

## 3. Verification / freshness gates that already exist

- **Read gate**: RLS policy `opportunities_select_active` ([002_row_level_security.sql:135](../supabase/migrations/002_row_level_security.sql#L135))
  restricts every SELECT — including the anon client — to `status = 'active'`,
  independent of caller identity. This is the precedent the PRD's §10 discovery
  gate should extend (e.g. an additional `AND company_verified = true AND
  vacancy_verified = true` clause, or a materialized/filtered view), rather than
  inventing a new enforcement layer.
- **Write gate**: `opportunities_manage_service_role` makes every INSERT/UPDATE/DELETE
  service-role-only. No client — including an authenticated non-admin user —
  can write to `opportunities` directly today. An employer-direct submission
  path would need a new, narrower write surface (its own table + admin-reviewed
  promotion into `opportunities`, mirroring the pattern below), not a relaxation
  of this policy.
- **Supervised promotion precedent**: `promoteCompanyToAllowlist()` ([supervised-promotion.ts](../src/lib/discovery/supervised-promotion.ts))
  + `POST /api/admin/discovery/[id]/promote` is the existing pattern for "a
  staging/candidate row, reviewed by a real logged-in admin, promoted into the
  live table." This is the direct template for Phase 3's vacancy
  verification/publish step.
- **Freshness**: reconciliation/expiry logic lives in `src/lib/ingestion/` (cross-provider
  dedup, `supersededByOpportunityId`) — worth reusing for vacancy duplicate detection
  rather than rebuilding it for employer-submitted listings.

## 4. Auth & RLS pattern (reusable for employer identity)

Two-layer model, both server-only:
1. `getAuthenticatedUser()` — real, verified, non-anonymous Supabase session
   (per [remotematch-auth-migration-complete] memory: anonymous sign-in is off
   everywhere, no linking path).
2. `getAuthenticatedAdmin()` ([get-authenticated-admin.ts](../src/lib/auth/get-authenticated-admin.ts))
   — layers on top: re-checks `admin_users` membership via the **service-role**
   client only. `admin_users` has **zero RLS policy granting any client-side
   access** (migration 029) — the check can only run server-side.

This is the correct template for "authorized representative" in the PRD: a new
`employer_members` (or similar) table, zero client RLS, checked server-side by
a `getAuthenticatedEmployer()` analogous to `getAuthenticatedAdmin()` — never a
client-trusted "I am this company's rep" claim.

## 5. Discovery API / discovery cards

`GET/POST /api/opportunities/feed` ([feed/route.ts](../src/app/api/opportunities/feed/route.ts))
is the single unified catalog both for the public preview list and the scored,
personalized feed — already exactly the "one catalogue, not separate
marketplaces" shape the PRD asks for in §6. Any direct-employer vacancy that
lands in `opportunities` with `status='active'` already appears here with zero
feed-layer changes, *provided* the publication gate (§10) is enforced earlier
(at promotion time, like the discovery-candidate pattern), not inside this
route. Company Radar's "verified employer badge" would be a presentational
addition to `catalog.ts`'s `CompanyOpportunity` shape, contingent on the new
company-identity table existing.

## 6. Admin moderation capabilities

Existing admin console (`src/app/admin/(dashboard)/*`, `src/app/api/admin/*`)
already has the right shape to extend:
- `recordAdminAction()` ([audit-log.ts](../src/lib/admin/audit-log.ts)) — generic
  before/after/reason audit trail, used by both discovery promotion and the
  opportunity force-expire action. Reusable as-is for company/vacancy verification
  decisions.
- `admin/opportunities/[id]` today supports exactly **one** mutation
  (`force_expire`, with a required reason) — there is currently no admin path to
  *create or edit* an opportunity at all. Vacancy creation/review/publish (PRD
  Phase 2/3) is entirely new admin surface, not an extension of an existing one.
- `admin/discovery` + `admin/sources` are the closest existing moderation UIs
  (candidate-company review, source review) — same visual/interaction pattern
  Phase 1 (company verification queue) and Phase 3 (vacancy verification queue)
  should follow.

## 7. Candidate application workflow

- `POST /api/opportunities/swipe` ([swipe/route.ts](../src/app/api/opportunities/swipe/route.ts)) —
  `interested` is quota-reserved (atomic, pre-AI-work) then triggers
  `generateRuleBasedMatchAnalysis` + `generateApplicationKit` (the "Auto-fill"
  step in the PRD's candidate workflow). `passed` is an unlimited append-only log
  via `record_pass` RPC.
- `PATCH /api/applications/status` ([status/route.ts](../src/app/api/applications/status/route.ts)) —
  all status transitions go through a single DB RPC
  (`transition_application_status`, migration 007) with compare-and-swap on
  `expectedStatus` — no free-form status writes from the client. This already
  matches the PRD's "Interested → Manual Review → Approve → Apply" shape; a
  direct-employer vacancy needs no changes here, since applications key off
  `opportunity_id`/`canonical_id`, not `source`.
- Application method (PRD §4: "Apply via RemoteMatch" vs. "redirect to external
  page") has a real precedent: `official_url`/`source_url` already vary by
  source today ([catalog.ts:87-109](../src/lib/companies/catalog.ts#L87) — the
  `SOURCE_LABELS` table), so an `employer_direct` opportunity choosing either
  path is a natural extension of an existing field, not a new concept.

## 8. What Phase 1 would actually need to add (not authorized to build yet)

Summarizing the gaps this audit found, for gate review before any implementation:
1. A `companies` table: canonical identity, verification status/history, the
   registration fields in PRD §2 — separate from `allowlist_employers` (ATS
   scrape targets) and from the `company` free-text column.
2. A company-membership table (`employer_members` or similar), zero client RLS,
   checked server-side — mirrors `admin_users`/`getAuthenticatedAdmin()`.
3. A `vacancy_submissions` (or similar) staging table + admin-reviewed promotion
   into `opportunities`, mirroring `supply_discovered_companies` →
   `promoteCompanyToAllowlist()`. `opportunities.source` would need an
   `employer_direct` row(s) — already a valid `source_type` in `supply_platforms`,
   just never inserted.
4. Extending the discovery read gate (§10 of the PRD) to also require
   `company_verification = verified AND vacancy_verification = verified` —
   almost certainly as a condition on the promotion step (only promote to
   `opportunities` when both hold), not as a new runtime RLS clause, to stay
   consistent with how `opportunities_select_active` already works (gate at
   write/promotion time, trust `status='active'` at read time).
5. An employer dashboard (new `src/app/employer/*` or similar) + its own API
   surface, auth-gated by #2 — nothing to reuse beyond the admin console's UI
   patterns.

No schema, migration, or code changes were made in this audit.

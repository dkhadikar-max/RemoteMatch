# RemoteMatch V1 Launch Readiness — 2026-11-15

## Decision

**NO-GO for public launch as of 2026-11-15.** The application and database hardening checks are encouraging, but the live job inventory is stale and the production sync cron has no successful deployment. Do not invite external users until job supply freshness is restored and re-verified.

A controlled launch is the next target once the P0 supply gate passes. This is not a recommendation to continue feature development.

## Verified completed work

- PR #132 merged to `main`: `96be4b3da58ee6e8f9ab0aaa024431572cfaa57f`.
- PR #132 CI completed successfully: typecheck, production build, self-contained PGlite/regression suites, matcher characterization/benchmarks, employer account and publishing suites, V2 M2/M3 contract and lock-order checks, concurrency/atomicity and live directory egress/HTTP integration.
- Search-path migration verified on isolated Supabase project `xyahktsgdigutxartafb`: both functions remain SECURITY INVOKER; `search_path=pg_catalog, public`; EXECUTE remains revoked from `authenticated` and `anon`; representative live function behavior matches the PGlite results.
- PR #132 is P2 hardening and is not itself a launch blocker.
- Production RemoteMatch web and MCP services are online in Railway project `welcoming-miracle`, with one running replica each and no reported warnings or criticals in the 24-hour status check.
- Production web service custom domains are configured: `remotematch.online` and `admin.remotematch.online`.

## P0 launch blockers

### 1. Job inventory freshness — FAIL

Read-only query against production Supabase project `kxzlwwjvagzwodrdxqbh` on 2026-11-15:

- Total `public.opportunities` rows: 100,105.
- Active, non-permanently-removed, unsuperseded rows: 86,891.
- Newest `last_seen_in_feed_at`: 2026-11-12 12:01:38.733 UTC.
- Oldest active unsuperseded `last_seen_in_feed_at`: 2026-10-13 10:10:29.735 UTC.
- Active unsuperseded rows older than 72 hours: 86,891 (all of them).

This fails the 72-hour freshness gate. Do not present this inventory as fresh to new users.

### 2. Production ingestion cron — FAIL

Railway production project `welcoming-miracle`, service `remotematch-sync-cron`:

- Configured schedule: `0 */3 * * *`.
- Latest deployment: none.
- Runtime status: Offline.
- Railway environment health reports one critical issue for this service.
- The cron's configured command calls `/api/opportunities/sync` followed by `/api/opportunities/sync?action=revalidate`.

The cron and ingestion work had previously been deferred pending invoice/payment resolution. That deferral remains operationally respected; do not attempt to bypass the billing restriction. The feed freshness result means this deferral currently blocks public launch.

## Production migration status

- PR #132 migration file: `supabase/migrations/20261115210000_pin_invoker_search_path.sql`.
- Applied and live-verified only on isolated project `xyahktsgdigutxartafb`.
- Production project `kxzlwwjvagzwodrdxqbh` has not received this migration.
- This P2 migration is not required to resolve the freshness/ingestion launch blocker. Keep production unchanged unless separately authorized.

## Deployment status

- Railway production web service `RemoteMatch` is online.
- Its latest successful deployment was created 2026-11-11 04:15:07 UTC, before PR #132 merged on 2026-11-15. PR #132 contains a database migration and test only; it does not add application runtime code.
- No Railway production deployment was triggered as part of this readiness update.

## Launch gate — required before GO

1. Resolve Railway billing/access so the production sync cron can deploy and run.
2. Restore successful ingestion and revalidation without recurring upstream 5xx/502/500 failures or timeouts.
3. Verify fresh writes to the production opportunities inventory.
4. Re-run the read-only freshness query; require the active inventory to satisfy the 72-hour freshness policy and inspect the stale tail, not just the newest row.
5. Smoke-test registration, onboarding, feed, search, job details and apply destination against production.
6. Confirm web/MCP service health and review recent Railway/Supabase errors.
7. Record evidence and issue a new GO/NO-GO decision. Start with a controlled cohort of 50–100 users only after the gate passes.

## Scope control

- No additional feature development or P2 database optimization is authorized by this readiness record.
- No production data changes, production migration application, or Railway deployment were performed as part of this audit.
- This document records a NO-GO decision based on measured production supply freshness and cron state, not a code-quality concern.

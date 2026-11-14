# M4 event-writer dependency guard

Adds read-only phase-specific preflights, an additive migration tripwire, a PGlite regression suite,
and an isolated live HTTP suite. Authoring did not connect to or mutate any Supabase project.

## Migration order
The current PR head contains M3 idempotency migration 20261114190000. M4 is timestamped
20261114200000; the PGlite suite asserts that it sorts after M3.

## Finding
Migration 20261112190030 drops the client INSERT policy on application_events. The table has FORCE
ROW LEVEL SECURITY. After the drop, candidate event writes depend on SECURITY DEFINER owners
bypassing RLS. transition_employer_application is SECURITY INVOKER, must be executable by
service_role, and must not be executable by anon or authenticated.

## Components
- docs/v2-m4-event-writer-preflight-before.sql: read-only preflight before the policy-drop migration.
  It allows only the legacy events_insert_own policy that the migration is about to remove; it
  rejects every other client INSERT policy and any client INSERT privilege.
- docs/v2-m4-event-writer-preflight.sql: read-only postflight. It requires events_insert_own to be
  absent and rejects every client INSERT policy/privilege, including a recreated policy with the
  same name. Use this after migration rollout.
- supabase/migrations/20261114200000_v2_p0_m4_event_writer_tripwire.sql: non-mutating post-drop
  tripwire using the same post-drop check as the after script.
- tools/m4-event-writer-check.sql is the canonical block; tools/gen_m4.py generates both preflights
  and the migration. The before/after mode is explicit, not inferred from policy presence. Each script rejects being run
against the opposite phase, and the post-drop check catches the legacy policy even if it is recreated.
- test/v2-m4-event-writer-suite.ts: source checks and PGlite execution for owner/definer drift, writer-owner table/schema privileges, public-first search_path, missing
  writers, inherited-role policies/grants, client/PUBLIC policies, forced RLS, and the service-role
  execution boundary.
- test/v2-m4-event-writers-live-suite.ts: real verified users and HTTP routes against only isolated
  project xyahktsgdigutxartafb. It tests notes, feedback, status, direct INSERT denial, same-
  opportunity cross-user isolation, and cleanup.

## CI
The PGlite suite runs in the self-contained unit job. The live suite runs in employer-live-integration
after the workflow verifies the exact isolated project ref. The live suite independently rejects
other projects and non-local server URLs.

## Limits
No preflight was run on production or any Supabase project. No migration was applied. The live suite
was not executed during authoring; CI is the first isolated execution. Live HTTP calls exercise the
three candidate-facing routes; catalog/PGlite checks cover security metadata for all six known
writers but do not claim live writes for direct apply, archive, or employer decision. Existing
search_path=public definitions in migration 006 are a separate hardening follow-up.

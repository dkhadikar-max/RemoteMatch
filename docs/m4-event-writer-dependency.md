# M4 event-writer dependency guard

Adds a read-only preflight, additive migration tripwire, PGlite regression suite, and isolated live
HTTP suite. Authoring did not connect to or mutate any Supabase project.

## Migration order
The current PR head contains M3 idempotency migration 20261114190000. M4 is timestamped
20261114200000; the PGlite suite asserts that it sorts after M3.

## Finding
Migration 20261112190030 drops the client INSERT policy on application_events. The table has FORCE
ROW LEVEL SECURITY. After the drop, candidate event writes depend on SECURITY DEFINER owners
bypassing RLS. transition_employer_application is SECURITY INVOKER, must be executable by
service_role, and must not be executable by anon or authenticated.

## Components
- docs/v2-m4-event-writer-preflight.sql: read-only diagnostics/check. Run before and after lifecycle
  rollout on each explicitly approved target. The operator itself does not need BYPASSRLS.
- supabase/migrations/20261114200000_v2_p0_m4_event_writer_tripwire.sql: non-mutating tripwire using
  the same DO block.
- tools/m4-event-writer-check.sql is the canonical block; tools/gen_m4.py regenerates both SQL files.
- test/v2-m4-event-writer-suite.ts: source checks and PGlite execution for owner/definer drift,
  missing writers, inherited-role policies/grants, client/PUBLIC policies, forced RLS, and the
  service-role execution boundary.
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

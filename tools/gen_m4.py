"""Generate the M4 SQL artefacts from the canonical DO block."""
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve()
block = (root / "tools" / "m4-event-writer-check.sql").read_text(encoding="utf-8").strip()
if not block.startswith("DO $m4$") or not block.endswith("$m4$;"):
    raise SystemExit("invalid canonical M4 check block")
migration = (
    "-- M4: additive, non-mutating tripwire. Ordered after M3 migration 20261114190000.\n"
    "-- Same DO block as docs/v2-m4-event-writer-preflight.sql.\n\n" + block + "\n"
)
preflight = (
    "-- V2 M4 event-writer preflight. READ ONLY; run only on an explicitly approved target.\n"
    "-- Run before and after lifecycle migrations. Operator does not need BYPASSRLS.\n"
    "SELECT p.polname AS policy,p.polcmd AS command,\n"
    " coalesce(array_to_string(ARRAY(SELECT CASE WHEN o=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=o) END FROM unnest(p.polroles) o),','),'') AS roles\n"
    "FROM pg_policy p WHERE p.polrelid='public.application_events'::regclass ORDER BY 1;\n\n"
    "SELECT c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced FROM pg_class c WHERE c.oid='public.application_events'::regclass;\n\n"
    "SELECT rolname,rolbypassrls,rolsuper FROM pg_roles WHERE rolname IN (current_user,'postgres','service_role','authenticated','anon') ORDER BY 1;\n\n"
    "SELECT p.oid::regprocedure AS writer,p.prosecdef AS security_definer,r.rolname AS owner,(r.rolbypassrls OR r.rolsuper) AS owner_bypasses_rls,p.proconfig AS function_config\n"
    "FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('record_application_feedback','update_application_notes','transition_application_status','set_application_archived','apply_to_employer_job','transition_employer_application') ORDER BY 1;\n\n"
    "-- Raises one exception containing every detected problem; performs no writes.\n" + block + "\n"
)
(root / "supabase/migrations").mkdir(parents=True, exist_ok=True)
(root / "docs").mkdir(parents=True, exist_ok=True)
(root / "supabase/migrations/20261114200000_v2_p0_m4_event_writer_tripwire.sql").write_text(migration, encoding="utf-8")
(root / "docs/v2-m4-event-writer-preflight.sql").write_text(preflight, encoding="utf-8")
print("Generated M4 tripwire and preflight from one canonical block.")

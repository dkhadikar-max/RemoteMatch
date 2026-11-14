"""Generate phase-explicit M4 preflight and tripwire files from one canonical check."""
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve()
template = (root / "tools" / "m4-event-writer-check.sql").read_text(encoding="utf-8").strip()
if not template.startswith("DO $m4$") or not template.endswith("$m4$;") or "__M4_POST_DROP__" not in template:
    raise SystemExit("invalid canonical M4 check template")

def block(post_drop: bool) -> str:
    return template.replace("__M4_POST_DROP__", "true" if post_drop else "false")

report = (
    "SELECT p.polname AS policy,p.polcmd AS command,\n"
    " coalesce(array_to_string(ARRAY(SELECT CASE WHEN o=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=o) END FROM unnest(p.polroles) o),','),'') AS roles\n"
    "FROM pg_policy p WHERE p.polrelid='public.application_events'::regclass ORDER BY 1;\n\n"
    "SELECT c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced FROM pg_class c WHERE c.oid='public.application_events'::regclass;\n\n"
    "SELECT rolname,rolbypassrls,rolsuper FROM pg_roles WHERE rolname IN (current_user,'postgres','service_role','authenticated','anon') ORDER BY 1;\n\n"
    "SELECT p.oid::regprocedure AS writer,p.prosecdef AS security_definer,r.rolname AS owner,(r.rolbypassrls OR r.rolsuper) AS owner_bypasses_rls,p.proconfig AS function_config\n"
    "FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('record_application_feedback','update_application_notes','transition_application_status','set_application_archived','apply_to_employer_job','transition_employer_application') ORDER BY 1;\n\n"
)
(root / "supabase/migrations").mkdir(parents=True, exist_ok=True)
(root / "docs").mkdir(parents=True, exist_ok=True)
migration = (
    "-- M4: additive, non-mutating post-drop tripwire. Ordered after M3 migration 20261114190000.\n"
    "-- It requires events_insert_own to be absent and validates all six writer boundaries.\n\n"
    + block(True) + "\n"
)
before = (
    "BEGIN READ ONLY;\n"
    "-- V2 M4 preflight BEFORE the lifecycle policy-drop migration. READ ONLY.\n"
    "-- The legacy events_insert_own policy is expected here; every other client INSERT path is rejected.\n"
    "-- This phase tolerates lifecycle writer functions that have not been installed yet.\n\n"
    + report + "-- Pre-drop phase; same canonical check logic as the after script and tripwire.\n"
    + block(False) + "\nCOMMIT;\n"
)
after = (
    "BEGIN READ ONLY;\n"
    "-- V2 M4 preflight AFTER the lifecycle policy-drop migration. READ ONLY.\n"
    "-- events_insert_own must be absent; no client INSERT policy or privilege may remain.\n\n"
    + report + "-- Post-drop phase; same canonical check logic as the before script and tripwire.\n"
    + block(True) + "\nCOMMIT;\n"
)
(root / "supabase/migrations/20261114200000_v2_p0_m4_event_writer_tripwire.sql").write_text(migration, encoding="utf-8")
(root / "docs/v2-m4-event-writer-preflight-before.sql").write_text(before, encoding="utf-8")
(root / "docs/v2-m4-event-writer-preflight.sql").write_text(after, encoding="utf-8")
print("Generated post-drop tripwire and phase-explicit read-only preflight scripts.")

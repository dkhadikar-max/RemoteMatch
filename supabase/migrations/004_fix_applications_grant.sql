-- ==============================================================================
-- RemoteMatch — 004: close incomplete grant lockdown on `applications`
--
-- Found by manually verifying 003's column-privilege lockdown against a live
-- project: 003 revoked INSERT on `applications` but not the pre-existing
-- broad UPDATE/DELETE grants from 002's `GRANT ALL ON ALL TABLES ... TO
-- anon, authenticated`, so every column remained writable underneath the
-- narrower column-level GRANT 003 added on top of it (Postgres grants are
-- additive; a column-level GRANT does not narrow an existing table-level
-- one).
--
-- Concrete impact: an authenticated user could UPDATE their own existing
-- `applications` row's `opportunity_id` to a different job, producing
-- "interested" state for that job without ever calling
-- reserve_right_swipe()/finalize_interested_swipe() — a quota bypass
-- reachable directly over the Supabase REST API regardless of what the
-- Next.js app's own UI calls. RLS still prevented touching another user's
-- row; this only affected what a user could do to their own row.
--
-- `profiles` was verified clean (003 revoked ALL there before re-granting
-- the narrow set) — this migration only touches `applications`.
-- ==============================================================================

REVOKE UPDATE, DELETE ON applications FROM authenticated, anon;

-- Re-grant only the columns the existing tracker feature's status/notes
-- editing needs. DELETE is not re-granted: nothing in the current app calls
-- it (application status changes are still client-local per 003's stated
-- scope), so there is no reason to leave it open.
GRANT UPDATE (status, notes, applied_at, updated_at) ON applications TO authenticated;

-- ==============================================================================
-- RemoteMatch — 034: funnel_events gains apply_clicked and match_analyzed
--
-- The qualified-application definition for the controlled beta is
--   eligible + fit >= 70 + match analyzed + apply clicked + confirmed applied.
-- Nothing recorded "match analyzed" or "apply clicked" before this migration.
--
--   apply_clicked   — written via POST /api/funnel/event when a signed-in user
--                     clicks an Apply link to the employer's site. `surface`
--                     says which link. A click is NOT an application; the
--                     user's own "I applied" confirmation stays in
--                     application_feedback / application_events.
--   match_analyzed  — written server-side by /api/ai/match-analysis after a
--                     successful analysis. Never accepted from a client.
--
-- Changes (DDL only, no data):
--   1. event_type CHECK: the four existing values + the two new ones. The old
--      CHECK is found by definition rather than by name, because the old
--      production table was created by hand (see 031's provenance note).
--   2. New nullable column `surface`, limited to the four Apply surfaces, and
--      required for apply_clicked.
-- RLS, policy and grants are untouched (still service-role only).
-- Idempotent: safe to run twice.
-- ==============================================================================

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    WHERE con.conrelid = 'public.funnel_events'::regclass
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%event_type%'
      AND con.conname <> 'funnel_events_event_type_check_v2'
  LOOP
    EXECUTE format('ALTER TABLE public.funnel_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check_v2;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check_v2
  CHECK (event_type IN (
    'landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed',
    'apply_clicked', 'match_analyzed'
  ));

ALTER TABLE public.funnel_events ADD COLUMN IF NOT EXISTS surface text;

ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_check;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_surface_check
  CHECK (surface IS NULL OR surface IN ('feed_card', 'match_view', 'job_modal', 'job_page'));

-- surface is required for apply_clicked and meaningless for every other event.
ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_matches_event;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_surface_matches_event
  CHECK ((event_type = 'apply_clicked') = (surface IS NOT NULL));

-- ==============================================================================
-- DOWN (documented, not executed). Only valid while no apply_clicked /
-- match_analyzed rows exist (delete them first, or the CHECK fails):
--   ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_matches_event;
--   ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_check;
--   ALTER TABLE public.funnel_events DROP COLUMN IF EXISTS surface;
--   ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check_v2;
--   ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check
--     CHECK (event_type IN ('landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed'));
-- ==============================================================================

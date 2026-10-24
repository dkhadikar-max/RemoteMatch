-- ==============================================================================
-- RemoteMatch — 035: funnel_events gains company_radar_viewed + company_profile surface
--
-- Company Radar (Phase 0, PR #35) validation period — before this migration
-- there was no event_type that fit a Company Radar page view, and
-- apply_clicked's `surface` had no value for an Apply click originating from
-- a company profile page. See docs/company-radar-validation-plan-2026-10-24.md.
--
--   company_radar_viewed — written via POST /api/funnel/event on a load of
--                           /companies or /companies/view/[company]. A single
--                           combined signal for BOTH pages — not split by
--                           search vs. profile, since the authorized
--                           measurement scope does not require that split and
--                           adding a field for it would be unauthorized scope.
--                           Anonymous-allowed (mirrors landing_viewed exactly):
--                           requires anonymous_id; profile_id is resolved from
--                           the session when one exists, same as every other
--                           event type, via the route's existing identity
--                           resolution — not new behavior.
--   company_profile (surface) — a 5th value for apply_clicked.surface: an
--                           Apply link clicked from a company profile page.
--
-- Changes (DDL only, no data):
--   1. event_type CHECK (funnel_events_event_type_check_v2): the 6 existing
--      values + company_radar_viewed.
--   2. surface CHECK (funnel_events_surface_check): the 4 existing apply
--      surfaces + company_profile.
--   3. funnel_events_surface_matches_event (migration 034) is UNCHANGED and
--      NOT touched by this migration: surface stays required for, and only
--      for, apply_clicked. company_radar_viewed can therefore never carry a
--      surface value — enforced by that existing constraint, not a new one.
-- RLS, policy and grants are untouched (still service-role only).
-- Idempotent: safe to run twice.
-- ==============================================================================

ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check_v2;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check_v2
  CHECK (event_type IN (
    'landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed',
    'apply_clicked', 'match_analyzed', 'company_radar_viewed'
  ));

ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_check;
ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_surface_check
  CHECK (surface IS NULL OR surface IN ('feed_card', 'match_view', 'job_modal', 'job_page', 'company_profile'));

-- ==============================================================================
-- DOWN (documented, not executed). Only valid while no company_radar_viewed
-- rows and no surface = 'company_profile' rows exist (delete them first, or
-- the CHECK fails):
--   ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_surface_check;
--   ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_surface_check
--     CHECK (surface IS NULL OR surface IN ('feed_card', 'match_view', 'job_modal', 'job_page'));
--   ALTER TABLE public.funnel_events DROP CONSTRAINT IF EXISTS funnel_events_event_type_check_v2;
--   ALTER TABLE public.funnel_events ADD CONSTRAINT funnel_events_event_type_check_v2
--     CHECK (event_type IN (
--       'landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed',
--       'apply_clicked', 'match_analyzed'
--     ));
-- ==============================================================================

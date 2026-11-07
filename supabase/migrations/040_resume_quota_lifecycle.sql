-- ==============================================================================
-- Resume Intelligence (PR B) — per-attempt quota lifecycle (reservation + refund).
--
-- NOT APPLIED to any shared/persistent database. Local worktree only — a wholly
-- separate workstream from migrations 036-039 (the original Resume Intelligence
-- feature + its race-condition fixes), which this migration does not modify.
--
-- Design record (this conversation, 2026-11-01/02): the production-model live
-- evaluation surfaced a real finding — a response can hit the full token cap
-- with zero usable content (finish_reason:'length', empty content) despite the
-- existing reasoning_effort mitigation. Investigation found the EXISTING
-- refund_resume_analysis()/reserve_resume_analysis() RPCs (036) have no
-- idempotency key at all — a bare per-day counter decrement/increment with no
-- way to tell "already refunded for this attempt" from "a new refund", and no
-- per-event audit trail. This migration adds that missing structure WITHOUT
-- changing the product policy itself (failed attempts are still refunded
-- universally — see the specification's §"daily attempt allowance only"
-- finding; this is NOT the narrower finish_reason-specific refund policy that
-- was originally proposed and explicitly rejected).
--
-- Billing migration 036 (Razorpay international billing, 036_billing_transactions.sql,
-- a DIFFERENT, unrelated branch's untracked file in the main checkout) is a
-- known, separate, harmless-while-unmerged numbering collision with THIS
-- worktree's own pre-existing 036_resume_intelligence.sql. Neither is touched
-- by this migration; resolving that collision is a merge-coordination decision,
-- not something this migration does.
--
-- Revision history (same file, never re-numbered -- this migration has not been
-- applied anywhere real yet):
--   Stage 3 live validation (2026-11-02): added ON DELETE CASCADE to
--     resume_quota_events.analysis_id (a real bug -- without it, deleting an
--     account/resume-version would fail once any analysis reached reservation).
--   Stage 5 independent review (2026-11-02): added FOR UPDATE to the
--     resume_analyses ownership/currency read in BOTH RPCs (closes a lock-
--     ordering gap -- see each function's own comment); reserve_resume_analysis
--     now computes the lazy day-rollover unconditionally before the
--     already_reserved short-circuit (previously that path could return a
--     stale limit/remaining and never persist the rollover) and its
--     already_reserved response now includes `remaining`, matching the other
--     two outcomes.
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 1. attempt_number on public.resume_analyses — monotonic per row, assigned atomically
--    by upsert_resume_analysis() on every successful claim acquisition (never on
--    a rejected claim attempt — the two existing early-return guards are
--    untouched by this migration and never write to this column).
-- ------------------------------------------------------------------------------
ALTER TABLE public.resume_analyses
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1
    CHECK (attempt_number >= 1);

COMMENT ON COLUMN resume_analyses.attempt_number IS
  'Monotonic per-row attempt counter. Incremented atomically by '
  'upsert_resume_analysis() only on a successful claim acquisition (fresh row, '
  'terminal-row retry, or stale-pending recovery) -- never on a rejected claim. '
  'Together with the row id, identifies one logical reservation/refund attempt; '
  'reservation requires this to be current, refund does not (see '
  'resume_quota_events -- a historical attempt must remain refundable after a '
  'later attempt has been claimed on the same row).';

-- ------------------------------------------------------------------------------
-- 2. resume_quota_events — append-only, per-attempt audit trail. Never updated,
--    never deleted (by application code); a later retry's events are new rows
--    under a new attempt_number, so an earlier attempt's history is preserved
--    unconditionally. Mirrors migration 022's ai_call_events minimal-event-log
--    convention, but this table is USER QUOTA accounting -- never the provider
--    spend ledger, which stays entirely separate (ai_call_events/ai_spend_ledger,
--    untouched by this migration).
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.resume_quota_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE CASCADE (found via Stage 3 live validation, 2026-11-02): resume_analyses itself
  -- cascades from public.resume_versions, which cascades from public.profiles -- an account or resume-version
  -- deletion already deletes resume_analyses rows today. Without this cascade, that SAME delete
  -- would start failing (FK violation) the moment any analysis ever reached quota reservation,
  -- which is every analysis that gets past the entitlement check. Matches the existing cascade
  -- chain rather than introducing a new, inconsistent retention policy for this one child table.
  analysis_id     uuid NOT NULL REFERENCES public.resume_analyses(id) ON DELETE CASCADE,
  attempt_number  int NOT NULL CHECK (attempt_number >= 1),
  event_type      text NOT NULL CHECK (event_type IN ('reserved', 'refunded')),
  -- The usage_date active on the user's profile AT THE MOMENT this event was
  -- recorded -- captured once, immutable historical accounting data. A refund
  -- compares its own matching 'reserved' event's usage_date against the
  -- profile's CURRENT usage_date to decide whether the live counter may be
  -- decremented (same period) or must be left untouched (the period has
  -- already rolled over -- see refund_resume_analysis() below).
  usage_date      date NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resume_quota_events_reason_shape CHECK (
    (event_type = 'reserved' AND reason IS NULL)
    OR (event_type = 'refunded' AND reason IS NOT NULL AND reason <> '')
  ),
  -- The actual idempotency mechanism: a second 'reserved' or 'refunded' insert
  -- for the same (analysis_id, attempt_number) violates this constraint. Both
  -- RPCs check for an existing row FIRST (under the profile row lock, so the
  -- check-then-insert is genuinely atomic) -- this constraint is the final
  -- concurrency backstop, not the primary correctness mechanism.
  CONSTRAINT resume_quota_events_unique_attempt_event UNIQUE (analysis_id, attempt_number, event_type)
);

CREATE INDEX IF NOT EXISTS resume_quota_events_analysis_idx
  ON public.resume_quota_events (analysis_id, attempt_number);

COMMENT ON TABLE public.resume_quota_events IS
  'Append-only per-attempt quota audit trail (reservation + refund), separate '
  'from ai_call_events (provider execution) and ai_spend_ledger (provider '
  'dollar cost). Rows are never updated or deleted by application code -- a '
  'later retry gets a new attempt_number, so earlier attempts'' events are '
  'never overwritten or reinterpreted.';

-- RLS: same discipline as migration 022's ai_call_events -- no client access at
-- all. Both RPCs below are SECURITY DEFINER and write via the function owner,
-- never via a client-held authenticated/anon grant.
ALTER TABLE public.resume_quota_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resume_quota_events FORCE ROW LEVEL SECURITY;

CREATE POLICY "resume_quota_events_service_role_all" ON public.resume_quota_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.resume_quota_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.resume_quota_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE resume_quota_events_id_seq TO service_role;

-- ------------------------------------------------------------------------------
-- 3. upsert_resume_analysis() -- widened RETURNS TABLE to carry attempt_number
--    back to the caller; attempt_number/created_at refresh added ONLY to the
--    successful-claim path. The two existing rejection early-returns (prior-
--    success-clobber-guard, active-pending-guard) are otherwise byte-identical
--    to migration 039 -- they already never write anything, so they inherently
--    never touch attempt_number/created_at either; this migration does not
--    need to change their logic, only their RETURN shape.
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric);

CREATE FUNCTION public.upsert_resume_analysis(
  p_resume_version_id UUID,
  p_mode              TEXT,
  p_opportunity_id    TEXT,
  p_job_content_hash  TEXT,
  p_analysis_version  TEXT,
  p_status            TEXT,
  p_result            JSONB,
  p_source_ai         BOOLEAN,
  p_model             TEXT,
  p_prompt_tokens     INTEGER,
  p_completion_tokens INTEGER,
  p_cost_usd          NUMERIC
)
RETURNS TABLE (id UUID, wrote BOOLEAN, attempt_number INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_existing RECORD;
  v_id       UUID;
  v_attempt  INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_mode NOT IN ('general', 'target_job') THEN
    RAISE EXCEPTION 'invalid mode' USING ERRCODE = '23514';
  END IF;
  IF p_status NOT IN ('pending', 'success', 'insufficient_input', 'unavailable') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.resume_versions rv WHERE rv.id = p_resume_version_id AND rv.profile_id = v_uid
  ) THEN
    RAISE EXCEPTION 'resume_version_id does not belong to caller' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_existing
  FROM public.resume_analyses
  WHERE profile_id = v_uid
    AND resume_version_id = p_resume_version_id
    AND mode = p_mode
    AND job_content_hash = p_job_content_hash
    AND analysis_version = p_analysis_version
  FOR UPDATE;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'success' AND p_status <> 'success' THEN
    -- A prior success is never clobbered by a later failed attempt for the same key.
    -- Rejection: attempt_number/created_at untouched, reported as-is.
    RETURN QUERY SELECT v_existing.id, false, v_existing.attempt_number;
    RETURN;
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.status = 'pending' AND p_status = 'pending'
     AND v_existing.created_at > now() - interval '3 minutes' THEN
    -- Another request already claimed this exact key and is still inside its 3-minute window.
    -- Rejection: attempt_number/created_at untouched, reported as-is.
    RETURN QUERY SELECT v_existing.id, false, v_existing.attempt_number;
    RETURN;
  END IF;

  -- Successful-claim path (fresh key, terminal-row retry, or stale-pending
  -- recovery -- all three reach here identically, same as migration 039).
  -- attempt_number/created_at are refreshed ONLY here, never on a rejection
  -- above.
  INSERT INTO public.resume_analyses (
    profile_id, resume_version_id, mode, opportunity_id, job_content_hash, analysis_version,
    status, result, source_ai, model, prompt_tokens, completion_tokens, cost_usd,
    created_at, updated_at, attempt_number
  )
  VALUES (
    v_uid, p_resume_version_id, p_mode, p_opportunity_id, p_job_content_hash, p_analysis_version,
    p_status, p_result, p_source_ai, p_model, p_prompt_tokens, p_completion_tokens, p_cost_usd,
    now(), now(), 1
  )
  ON CONFLICT (profile_id, resume_version_id, mode, job_content_hash, analysis_version) DO UPDATE SET
    opportunity_id    = EXCLUDED.opportunity_id,
    status            = EXCLUDED.status,
    result            = EXCLUDED.result,
    source_ai         = EXCLUDED.source_ai,
    model             = EXCLUDED.model,
    prompt_tokens     = EXCLUDED.prompt_tokens,
    completion_tokens = EXCLUDED.completion_tokens,
    cost_usd          = EXCLUDED.cost_usd,
    updated_at        = now(),
    created_at        = now(),
    attempt_number    = resume_analyses.attempt_number + 1
  WHERE NOT (
    resume_analyses.status = 'success' AND EXCLUDED.status <> 'success'
  ) AND NOT (
    resume_analyses.status = 'pending' AND EXCLUDED.status = 'pending'
    AND resume_analyses.created_at > now() - interval '3 minutes'
  )
  RETURNING resume_analyses.id, resume_analyses.attempt_number INTO v_id, v_attempt;

  IF v_id IS NULL THEN
    -- The WHERE guard excluded our write: a sibling transaction committed its own claim for
    -- this exact key between our SELECT ... FOR UPDATE (which found nothing, on a brand-new
    -- key) and our INSERT. Re-read the now-genuinely-existing row (same shape as migration 039).
    SELECT ra.id, ra.attempt_number INTO v_id, v_attempt
    FROM public.resume_analyses ra
    WHERE ra.profile_id = v_uid
      AND ra.resume_version_id = p_resume_version_id
      AND ra.mode = p_mode
      AND ra.job_content_hash = p_job_content_hash
      AND ra.analysis_version = p_analysis_version;
    RETURN QUERY SELECT v_id, false, v_attempt;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_id, true, v_attempt;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric) TO authenticated;

-- ------------------------------------------------------------------------------
-- 4. reserve_resume_analysis(p_analysis_id, p_attempt_number) -- idempotent,
--    requires the CURRENT attempt number (only the live, in-flight attempt may
--    reserve). Ordering per the finalized spec: check existing event FIRST,
--    then the quota limit, then increment+insert atomically -- a limit_reached
--    outcome never leaves a 'reserved' event behind.
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.reserve_resume_analysis();

CREATE FUNCTION public.reserve_resume_analysis(
  p_analysis_id    UUID,
  p_attempt_number INT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_today    DATE := (timezone('utc', now()))::date;
  v_row      profiles%ROWTYPE;
  v_analysis RECORD;
  v_limit    INT;
  v_existing_reserved RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  -- FOR UPDATE added (Stage 5 independent review, 2026-11-02): without this, a
  -- concurrent upsert_resume_analysis() reclaim of this SAME row could still be
  -- uncommitted at the moment of this read -- under READ COMMITTED, a plain
  -- SELECT observes the last COMMITTED value, not an in-flight one, so the
  -- currency check below could pass against an attempt that is, or is about to
  -- be, superseded. Locking resume_analyses here serializes against that
  -- reclaim's own FOR UPDATE. No new deadlock risk: upsert_resume_analysis()
  -- never locks profiles, so these two functions never acquire the two locks
  -- in opposite orders.
  SELECT id, profile_id, attempt_number INTO v_analysis
  FROM public.resume_analyses
  WHERE id = p_analysis_id
  FOR UPDATE;

  IF v_analysis.id IS NULL OR v_analysis.profile_id <> v_uid THEN
    RETURN jsonb_build_object('result', 'invalid_attempt', 'allowed', false);
  END IF;
  IF v_analysis.attempt_number <> p_attempt_number THEN
    -- Reservation requires the CURRENT attempt -- a stale attempt_number means
    -- the row has since been reclaimed by a later attempt; this caller's own
    -- attempt is no longer the live one.
    RETURN jsonb_build_object('result', 'stale_attempt', 'allowed', false);
  END IF;

  -- Lazy day-rollover computed UNCONDITIONALLY here, before the
  -- already_reserved short-circuit below (Stage 5 review: previously, hitting
  -- already_reserved after a day had rolled over returned a stale limit/
  -- remaining and never persisted the rollover to profiles at all). Moving
  -- this earlier means every return path below sees and reports the current
  -- period's real figures.
  IF v_row.usage_date <> v_today THEN
    v_row.daily_right_swipes_count := 0;
    v_row.daily_proposals_count := 0;
    v_row.daily_evaluations_count := 0;
    v_row.daily_resume_analyses_count := 0;
    v_row.usage_date := v_today;
  END IF;
  v_limit := CASE WHEN v_row.plan_tier = 'pro' THEN 10 ELSE 2 END;

  -- Idempotency check FIRST (per the finalized ordering) -- a duplicate
  -- reservation call for the exact same attempt must never increment twice.
  SELECT * INTO v_existing_reserved
  FROM public.resume_quota_events
  WHERE analysis_id = p_analysis_id AND attempt_number = p_attempt_number AND event_type = 'reserved';
  IF FOUND THEN
    UPDATE public.profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count,
      daily_resume_analyses_count = v_row.daily_resume_analyses_count
      WHERE id = v_uid;
    RETURN jsonb_build_object(
      'result', 'already_reserved', 'allowed', true,
      'limit', v_limit, 'remaining', GREATEST(0, v_limit - v_row.daily_resume_analyses_count), 'planTier', v_row.plan_tier
    );
  END IF;

  IF v_row.daily_resume_analyses_count >= v_limit THEN
    -- Quota check BEFORE any write -- limit_reached leaves no 'reserved' event
    -- behind. The lazy-reset fields above (if a rollover was detected) are
    -- still persisted here, same as the original reserve_resume_analysis() --
    -- this is pure day-rollover bookkeeping, unrelated to this attempt's own
    -- outcome.
    UPDATE public.profiles SET
      usage_date = v_row.usage_date,
      daily_right_swipes_count = v_row.daily_right_swipes_count,
      daily_proposals_count = v_row.daily_proposals_count,
      daily_evaluations_count = v_row.daily_evaluations_count,
      daily_resume_analyses_count = v_row.daily_resume_analyses_count
      WHERE id = v_uid;
    RETURN jsonb_build_object('result', 'limit_reached', 'allowed', false, 'limit', v_limit, 'remaining', 0, 'planTier', v_row.plan_tier);
  END IF;

  v_row.daily_resume_analyses_count := v_row.daily_resume_analyses_count + 1;

  UPDATE public.profiles SET
    usage_date = v_row.usage_date,
    daily_right_swipes_count = v_row.daily_right_swipes_count,
    daily_proposals_count = v_row.daily_proposals_count,
    daily_evaluations_count = v_row.daily_evaluations_count,
    daily_resume_analyses_count = v_row.daily_resume_analyses_count
    WHERE id = v_uid;

  INSERT INTO public.resume_quota_events (analysis_id, attempt_number, event_type, usage_date, reason)
    VALUES (p_analysis_id, p_attempt_number, 'reserved', v_row.usage_date, NULL);

  RETURN jsonb_build_object(
    'result', 'reserved', 'allowed', true,
    'limit', v_limit, 'remaining', v_limit - v_row.daily_resume_analyses_count, 'planTier', v_row.plan_tier
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_resume_analysis(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_resume_analysis(uuid, int) TO authenticated;

-- ------------------------------------------------------------------------------
-- 5. refund_resume_analysis(p_analysis_id, p_attempt_number, p_reason) --
--    idempotent, does NOT require the attempt to be current (a historical
--    attempt must remain refundable after a later attempt has been claimed on
--    the same row). Cross-day safe: only decrements the live counter if the
--    matching 'reserved' event's usage_date equals the profile's CURRENT
--    (as-read, not re-derived) usage_date -- this RPC never performs its own
--    lazy day-rollover reset; that stays the sole responsibility of
--    reserve_resume_analysis(), per the finalized spec.
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.refund_resume_analysis();

CREATE FUNCTION public.refund_resume_analysis(
  p_analysis_id    UUID,
  p_attempt_number INT,
  p_reason         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_uid      UUID := auth.uid();
  v_row      profiles%ROWTYPE;
  v_analysis RECORD;
  v_reserved RECORD;
  v_existing_refund RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_reason IS NULL OR p_reason = '' THEN
    RAISE EXCEPTION 'reason is required for a refund event' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  -- Ownership check only -- deliberately NOT comparing p_attempt_number against
  -- the row's CURRENT attempt_number. A historical attempt (superseded by a
  -- later reclaim) must remain refundable; currency is a reservation-only
  -- requirement.
  --
  -- FOR UPDATE added (Stage 5 independent review, 2026-11-02) -- same rationale
  -- as reserve_resume_analysis: serializes this ownership read against a
  -- concurrent upsert_resume_analysis() reclaim of the same row. Does not
  -- change WHICH attempts are refundable (refund still never checks currency)
  -- -- only ensures the ownership check itself observes a committed row.
  SELECT id, profile_id INTO v_analysis FROM public.resume_analyses WHERE id = p_analysis_id FOR UPDATE;
  IF v_analysis.id IS NULL OR v_analysis.profile_id <> v_uid THEN
    RETURN jsonb_build_object('result', 'invalid_attempt');
  END IF;

  SELECT * INTO v_reserved
  FROM public.resume_quota_events
  WHERE analysis_id = p_analysis_id AND attempt_number = p_attempt_number AND event_type = 'reserved';
  IF NOT FOUND THEN
    -- No matching reservation exists for this exact attempt -- a refund must
    -- never be accepted without one. Harmless no-op, not an error.
    RETURN jsonb_build_object('result', 'no_reservation');
  END IF;

  SELECT * INTO v_existing_refund
  FROM public.resume_quota_events
  WHERE analysis_id = p_analysis_id AND attempt_number = p_attempt_number AND event_type = 'refunded';
  IF FOUND THEN
    RETURN jsonb_build_object('result', 'already_refunded');
  END IF;

  IF v_row.usage_date = v_reserved.usage_date THEN
    -- Same period as the original reservation (whether genuinely today, or a
    -- rollover simply hasn't been lazily detected by any reserve call yet --
    -- either way, decrementing here is correct: in the rollover-not-yet-
    -- detected case, the next reserve_resume_analysis() call will reset this
    -- counter to 0 regardless, making this decrement's effect moot once that
    -- happens).
    UPDATE public.profiles SET daily_resume_analyses_count = GREATEST(0, daily_resume_analyses_count - 1)
      WHERE id = v_uid;
  END IF;
  -- Else: the live counter already belongs to a later period (a reserve call
  -- has already lazily rolled it over since this attempt's reservation) --
  -- per the finalized spec, do NOT touch today's counter. The refund event
  -- below is still recorded, preserving the historical accounting record
  -- without inflating the new period's allowance.

  INSERT INTO public.resume_quota_events (analysis_id, attempt_number, event_type, usage_date, reason)
    VALUES (p_analysis_id, p_attempt_number, 'refunded', v_reserved.usage_date, p_reason);

  RETURN jsonb_build_object('result', 'refunded');
END;
$$;

REVOKE ALL ON FUNCTION public.refund_resume_analysis(uuid, int, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refund_resume_analysis(uuid, int, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ==============================================================================
-- DOWN (manual, not automated):
--   DROP FUNCTION IF EXISTS public.refund_resume_analysis(uuid, int, text);
--   DROP FUNCTION IF EXISTS public.reserve_resume_analysis(uuid, int);
--   -- Restore the zero-arg RPCs (migration 036's bodies) if rolling back:
--   --   CREATE FUNCTION public.reserve_resume_analysis() ... (036:400-458)
--   --   CREATE FUNCTION public.refund_resume_analysis() ... (036:467-483)
--   DROP FUNCTION IF EXISTS public.upsert_resume_analysis(uuid, text, text, text, text, text, jsonb, boolean, text, integer, integer, numeric);
--   -- Restore migration 039's 2-column RETURNS TABLE (id, wrote) version if rolling back.
--   DROP TABLE IF EXISTS resume_quota_events;
--   ALTER TABLE public.resume_analyses DROP COLUMN IF EXISTS attempt_number;
-- ==============================================================================

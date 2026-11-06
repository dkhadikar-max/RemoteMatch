-- ==============================================================================
-- RemoteMatch — Swipe limits: rolling 24h window + Pro upgrade popups
-- Plan: docs/swipe-limits-rolling-24h-implementation-plan.md (revision 9,
-- implementation authorized; release/deploy NOT authorized by that doc).
--
-- Replaces the calendar-day counter model (reserve_right_swipe,
-- finalize_interested_swipe) with event-based rolling-24h accounting read
-- directly from `swipes.created_at`, adds the 50-total cap (no independent
-- left cap — confirmed product decision), and adds atomic, fencing-token-
-- protected enrichment-claim tracking so the AI/matching step that runs
-- between reservation and decision-attach can safely be retried/resumed
-- without double-counting or a stale worker overwriting a newer result.
--
-- `idx_swipes_profile_created_at ON swipes(profile_id, created_at DESC)`
-- already exists (migration 003) — no new index needed here.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. ENRICHMENT CLAIM COLUMNS — resume-ownership timestamp + fencing token.
-- ------------------------------------------------------------------------------

ALTER TABLE swipes
  ADD COLUMN IF NOT EXISTS enrichment_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_claim_id UUID;

-- ------------------------------------------------------------------------------
-- 2. DROP THE REPLACED FUNCTIONS' OLD SIGNATURES BEFORE RECREATING.
--    reserve_right_swipe() and finalize_interested_swipe(TEXT, JSONB) are
--    replaced by new-named functions with different signatures
--    (reserve_and_record_right_swipe(TEXT), attach_right_swipe_decision(UUID,
--    JSONB, UUID)) rather than overloaded in place, so there is no ambiguity
--    about which signature PostgREST or a stale client resolves to.
--    record_pass(TEXT) and rewind_last_decision() keep their existing
--    signatures — CREATE OR REPLACE is sufficient for those, no drop needed.
-- ------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.reserve_right_swipe();
DROP FUNCTION IF EXISTS public.finalize_interested_swipe(TEXT, JSONB);

-- ------------------------------------------------------------------------------
-- 3. SHARED ROLLING-WINDOW COUNTER — the one piece of SQL both the swipe
--    RPCs below and GET /api/profile call, so the two can never disagree on
--    what "active" or "now" means. No parameter: always the caller's own
--    auth.uid(), same as every other function in this file.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_rolling_swipe_counts()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_right_count INT;
  v_total_count INT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- "active" = not itself a rewind, and not the target of a later rewind.
  -- Identical predicate used by reserve_and_record_right_swipe, record_pass,
  -- and the duplicate-check branch inside reserve_and_record_right_swipe —
  -- one definition, not several that could drift apart.
  SELECT
    count(*) FILTER (WHERE action = 'interested'),
    count(*)
  INTO v_right_count, v_total_count
  FROM swipes s
  WHERE s.profile_id = v_uid
    AND s.created_at > now() - interval '24 hours'
    AND s.action <> 'rewind'
    AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id);

  RETURN jsonb_build_object('rightCount', v_right_count, 'totalCount', v_total_count);
END;
$$;

-- ------------------------------------------------------------------------------
-- 4. reserve_and_record_right_swipe — atomic check + countable write.
--    The swipe row is inserted (or an existing one's enrichment claimed)
--    inside this same locked call, not deferred to a later step — that is
--    what actually closes the concurrency race the old reserve-then-
--    finalize split allowed (see plan §0/§3 revision history).
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reserve_and_record_right_swipe(p_opportunity_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_plan TEXT;
  v_existing swipes%ROWTYPE;
  v_claim_id UUID;
  v_has_decision BOOLEAN;
  v_right_count INT;
  v_total_count INT;
  v_oldest_right TIMESTAMPTZ;
  v_oldest_total TIMESTAMPTZ;
  v_swipe_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_opportunity_id IS NULL OR length(p_opportunity_id) = 0 THEN
    RAISE EXCEPTION 'invalid_opportunity_id';
  END IF;

  -- Row lock: serializes every concurrent reserve/claim/pass/rewind call for
  -- this user through this one row — unchanged pattern from the function
  -- this replaces. It does NOT, and cannot, extend across the external
  -- AI/matching step that runs between this call returning and
  -- attach_right_swipe_decision being called — that gap is what the claim
  -- + fencing-token mechanism below exists to cover.
  SELECT plan_tier INTO v_plan FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  -- Duplicate check — every tier including Pro, and BEFORE the Pro branch
  -- below, so a Pro re-swipe is still recognized as a duplicate/resume case,
  -- never a second success. "Active" = identical predicate to
  -- get_rolling_swipe_counts() — a rewound row is excluded from both
  -- counting AND duplicate detection by the same clause, which is what
  -- makes rewind-then-reswipe work with no special-case code.
  SELECT * INTO v_existing FROM swipes s
    WHERE s.profile_id = v_uid
      AND s.opportunity_id = p_opportunity_id
      AND s.action <> 'rewind'
      AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id)
    ORDER BY s.created_at DESC
    LIMIT 1;

  IF FOUND THEN
    IF v_existing.decision_snapshot IS NOT NULL THEN
      RETURN jsonb_build_object(
        'allowed', false, 'code', 'DUPLICATE_INTERACTION',
        'swipeId', v_existing.id, 'hasDecision', true, 'planTier', v_plan
      );
    END IF;

    -- Resumable, incomplete swipe: atomic claim-or-defer. The UPDATE's own
    -- WHERE clause re-validates "still unclaimed or claim stale" at the
    -- moment it runs (normal Postgres row-level locking), not against the
    -- SELECT above, which is informational only.
    UPDATE swipes
      SET enrichment_claimed_at = now(), enrichment_claim_id = gen_random_uuid()
      WHERE id = v_existing.id
        AND decision_snapshot IS NULL
        AND (enrichment_claimed_at IS NULL OR enrichment_claimed_at < now() - interval '2 minutes')
      RETURNING enrichment_claim_id INTO v_claim_id;

    IF v_claim_id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'allowed', false, 'code', 'DUPLICATE_INTERACTION',
        'swipeId', v_existing.id, 'claimId', v_claim_id,
        'hasDecision', false, 'resumeInProgress', false, 'planTier', v_plan
      );
    END IF;

    -- Claim not acquired: re-read current state rather than assume why —
    -- the row may have been completed (hasDecision now true) or still be
    -- held by a fresh claim (resumeInProgress true) in the moment between
    -- the SELECT above and this UPDATE's failed attempt.
    SELECT (decision_snapshot IS NOT NULL) INTO v_has_decision FROM swipes WHERE id = v_existing.id;
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'DUPLICATE_INTERACTION',
      'swipeId', v_existing.id, 'hasDecision', v_has_decision,
      'resumeInProgress', NOT v_has_decision, 'planTier', v_plan
    );
  END IF;

  -- No existing interaction for this opportunity.
  IF v_plan = 'pro' THEN
    v_claim_id := gen_random_uuid();
    INSERT INTO swipes (profile_id, opportunity_id, action, enrichment_claimed_at, enrichment_claim_id)
      VALUES (v_uid, p_opportunity_id, 'interested', now(), v_claim_id)
      RETURNING id INTO v_swipe_id;

    INSERT INTO applications (profile_id, opportunity_id, status)
      VALUES (v_uid, p_opportunity_id, 'interested')
      ON CONFLICT (profile_id, opportunity_id) DO UPDATE SET updated_at = now();

    RETURN jsonb_build_object(
      'allowed', true, 'swipeId', v_swipe_id, 'claimId', v_claim_id, 'planTier', 'pro'
    );
  END IF;

  -- Free tier: rolling 24h window. Only right (15) and total (50) gate
  -- anything — no independent left cap (confirmed product decision).
  SELECT
    count(*) FILTER (WHERE action = 'interested'),
    count(*),
    min(created_at) FILTER (WHERE action = 'interested'),
    min(created_at)
  INTO v_right_count, v_total_count, v_oldest_right, v_oldest_total
  FROM swipes s
  WHERE s.profile_id = v_uid
    AND s.created_at > now() - interval '24 hours'
    AND s.action <> 'rewind'
    AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id);

  IF v_right_count >= 15 THEN
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'RIGHT_LIMIT_REACHED',
      'rightCount', v_right_count, 'totalCount', v_total_count,
      'resetAt', v_oldest_right + interval '24 hours', 'planTier', 'free'
    );
  END IF;

  IF v_total_count >= 50 THEN
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'TOTAL_LIMIT_REACHED',
      'rightCount', v_right_count, 'totalCount', v_total_count,
      'resetAt', v_oldest_total + interval '24 hours', 'planTier', 'free'
    );
  END IF;

  v_claim_id := gen_random_uuid();
  INSERT INTO swipes (profile_id, opportunity_id, action, enrichment_claimed_at, enrichment_claim_id)
    VALUES (v_uid, p_opportunity_id, 'interested', now(), v_claim_id)
    RETURNING id INTO v_swipe_id;

  INSERT INTO applications (profile_id, opportunity_id, status)
    VALUES (v_uid, p_opportunity_id, 'interested')
    ON CONFLICT (profile_id, opportunity_id) DO UPDATE SET updated_at = now();

  -- Legacy counter: kept writing as a rollback safety net (plan §2/§9), no
  -- longer read for gating by this function — display-only via
  -- GET /api/profile until retired in a separate follow-up migration.
  UPDATE profiles SET
    daily_right_swipes_count = v_right_count + 1,
    updated_at = now()
    WHERE id = v_uid;

  RETURN jsonb_build_object(
    'allowed', true, 'swipeId', v_swipe_id, 'claimId', v_claim_id,
    'rightCount', v_right_count + 1, 'totalCount', v_total_count + 1, 'planTier', 'free'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 5. attach_right_swipe_decision — the deferred, non-countable half of a
--    right swipe: attaches the AI/matching result once it's ready. A pure,
--    fencing-token-checked UPDATE, never an INSERT (the row already exists
--    and was already counted at reservation/claim time).
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.attach_right_swipe_decision(
  p_swipe_id UUID,
  p_decision_snapshot JSONB,
  p_claim_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_updated_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  -- Ownership (profile_id), correct state (action/decision_snapshot), and
  -- the fencing token (enrichment_claim_id) are all checked in one WHERE
  -- clause evaluated against one MVCC snapshot — no window where one guard
  -- passes without the others. A caller passing a NULL/stale/superseded
  -- claim id simply never matches (`col = NULL` is never true in SQL), so
  -- this fails closed, not open.
  UPDATE swipes
  SET decision_snapshot = p_decision_snapshot,
      enrichment_claim_id = NULL,
      enrichment_claimed_at = NULL
  WHERE id = p_swipe_id
    AND profile_id = v_uid
    AND action = 'interested'
    AND decision_snapshot IS NULL
    AND enrichment_claim_id = p_claim_id
  RETURNING id INTO v_updated_id;

  -- The function's return value is what the caller must check — a fenced-
  -- out UPDATE matching zero rows raises no exception, so "no error" is
  -- never a valid substitute for checking this field.
  IF v_updated_id IS NULL THEN
    RETURN jsonb_build_object('attached', false, 'reason', 'stale_claim');
  END IF;

  RETURN jsonb_build_object('attached', true);
END;
$$;

-- ------------------------------------------------------------------------------
-- 6. record_pass — same atomic shape as reserve_and_record_right_swipe
--    (no split needed; there is no deferred step after a pass). Gates only
--    on the 50-total cap — no independent left cap.
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_pass(p_opportunity_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_plan TEXT;
  v_existing swipes%ROWTYPE;
  v_right_count INT;
  v_total_count INT;
  v_oldest_total TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;
  IF p_opportunity_id IS NULL OR length(p_opportunity_id) = 0 THEN
    RAISE EXCEPTION 'invalid_opportunity_id';
  END IF;

  SELECT plan_tier INTO v_plan FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  -- Duplicate check — identical "active" predicate as
  -- reserve_and_record_right_swipe / get_rolling_swipe_counts. A pass has
  -- no deferred/claim concept, so any existing active interaction for this
  -- opportunity is always a true duplicate, never a resume case.
  SELECT * INTO v_existing FROM swipes s
    WHERE s.profile_id = v_uid
      AND s.opportunity_id = p_opportunity_id
      AND s.action <> 'rewind'
      AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id)
    ORDER BY s.created_at DESC
    LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'DUPLICATE_INTERACTION',
      'swipeId', v_existing.id, 'planTier', v_plan
    );
  END IF;

  IF v_plan = 'pro' THEN
    INSERT INTO swipes (profile_id, opportunity_id, action) VALUES (v_uid, p_opportunity_id, 'passed');
    RETURN jsonb_build_object('allowed', true, 'planTier', 'pro');
  END IF;

  SELECT
    count(*) FILTER (WHERE action = 'interested'),
    count(*),
    min(created_at)
  INTO v_right_count, v_total_count, v_oldest_total
  FROM swipes s
  WHERE s.profile_id = v_uid
    AND s.created_at > now() - interval '24 hours'
    AND s.action <> 'rewind'
    AND NOT EXISTS (SELECT 1 FROM swipes r WHERE r.rewound_decision_id = s.id);

  IF v_total_count >= 50 THEN
    RETURN jsonb_build_object(
      'allowed', false, 'code', 'TOTAL_LIMIT_REACHED',
      'rightCount', v_right_count, 'totalCount', v_total_count,
      'resetAt', v_oldest_total + interval '24 hours', 'planTier', 'free'
    );
  END IF;

  INSERT INTO swipes (profile_id, opportunity_id, action) VALUES (v_uid, p_opportunity_id, 'passed');

  RETURN jsonb_build_object(
    'allowed', true, 'rightCount', v_right_count, 'totalCount', v_total_count + 1, 'planTier', 'free'
  );
END;
$$;

-- ------------------------------------------------------------------------------
-- 7. rewind_last_decision — unchanged allowance/history logic; now also
--    clears any in-flight enrichment claim on the row it rewinds, so a
--    delayed AI result can never attach to a decision the user already
--    undid (independent review finding 6 / plan §3). The claim-clear and
--    the rewind-marker INSERT both run inside this one function call's
--    single implicit transaction, so they commit together — no other
--    transaction can observe one without the other (plan §3, "atomicity of
--    the claim-clear with the rewind marker").
-- ------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rewind_last_decision()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_plan TEXT;
  v_last swipes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
  END IF;

  SELECT plan_tier INTO v_plan FROM profiles WHERE id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile_not_found';
  END IF;

  IF v_plan IS DISTINCT FROM 'pro' THEN
    RETURN jsonb_build_object('success', false, 'error', 'pro_required');
  END IF;

  SELECT * INTO v_last FROM swipes
    WHERE profile_id = v_uid
    ORDER BY created_at DESC
    LIMIT 1;

  IF v_last IS NULL OR v_last.action = 'rewind' THEN
    RETURN jsonb_build_object('success', false, 'error', 'nothing_to_rewind');
  END IF;

  INSERT INTO swipes (profile_id, opportunity_id, action, rewound_decision_id)
  VALUES (v_uid, v_last.opportunity_id, 'rewind', v_last.id);

  IF v_last.action = 'interested' THEN
    UPDATE swipes
      SET enrichment_claim_id = NULL, enrichment_claimed_at = NULL
      WHERE id = v_last.id;

    UPDATE profiles
      SET daily_right_swipes_count = GREATEST(daily_right_swipes_count - 1, 0),
          updated_at = now()
      WHERE id = v_uid;

    DELETE FROM applications
      WHERE profile_id = v_uid AND opportunity_id = v_last.opportunity_id;
  END IF;

  RETURN jsonb_build_object('success', true, 'rewoundOpportunityId', v_last.opportunity_id, 'rewoundAction', v_last.action);
END;
$$;

-- ------------------------------------------------------------------------------
-- 8. GRANTS — same pattern as migration 003's bottom-of-file block.
-- ------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.get_rolling_swipe_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reserve_and_record_right_swipe(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attach_right_swipe_decision(UUID, JSONB, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_pass(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rewind_last_decision() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_rolling_swipe_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_and_record_right_swipe(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attach_right_swipe_decision(UUID, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_pass(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rewind_last_decision() TO authenticated;

-- ------------------------------------------------------------------------------
-- 9. Force PostgREST to drop its cached schema for the dropped/renamed
--    signatures immediately, rather than waiting for its own poll interval.
-- ------------------------------------------------------------------------------

NOTIFY pgrst, 'reload schema';

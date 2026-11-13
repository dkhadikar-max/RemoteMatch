-- ==============================================================================
-- RemoteMatch — serialize vacancy publication against company suspension
-- (Employer-platform audit, P1 #1, 2026-11-13).
--
-- review_employer_job_submission() (originally migration 049, redefined
-- unchanged by migration 050) locks employer_job_submissions FOR UPDATE but
-- reads companies with a plain SELECT. transition_company_verification_with_
-- audit() (migration 047, the admin suspend/reject path) is a fully separate
-- transaction with its own compare-and-swap on companies.verification_status
-- -- nothing serializes the two. A company suspended by an admin between the
-- publish RPC's unlocked read and its later verification_status check can
-- commit first, and the publish proceeds on the stale snapshot anyway: a
-- vacancy for a now-suspended company reaches the public catalogue.
--
-- Fix: lock the companies row FOR UPDATE before reading verification_status,
-- exactly as employer_job_submissions is already locked. This makes
-- publication and suspension serialize on the same company row --
--   - if suspension commits first, publication (which blocks on the lock
--     until suspension's transaction ends) then sees the suspended status
--     and rejects;
--   - if publication acquires the company lock first, suspension blocks
--     until publication's transaction ends.
-- Lock ordering (employer_job_submissions first, then companies) is
-- unchanged from the existing function, so this introduces no new deadlock
-- risk against itself; transition_company_verification_with_audit() only
-- ever locks companies, never employer_job_submissions, so the two
-- functions can never acquire these two locks in opposite orders either.
--
-- No schema change -- CREATE OR REPLACE on the existing function signature,
-- matching every other RPC-only migration in this project.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.review_employer_job_submission(
  p_submission_id uuid,
  p_admin_id uuid,
  p_admin_email text,
  p_action text,
  p_reason text
) RETURNS TABLE (ok boolean, new_status text, opportunity_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_job public.employer_job_submissions%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_opportunity_id uuid;
  v_new_status text;
  v_internal_url text;
BEGIN
  IF p_action NOT IN ('mark_under_review','approve_publish','reject') OR length(btrim(coalesce(p_reason,''))) = 0 THEN
    RAISE EXCEPTION 'Invalid review action or missing reason' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_job FROM public.employer_job_submissions
    WHERE id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, NULL::uuid;
    RETURN;
  END IF;

  -- FIX (P1 #1): FOR UPDATE added. Previously a plain SELECT -- the stale-
  -- verification-status race this migration closes. Lock order
  -- (employer_job_submissions, then companies) matches the only other
  -- function that locks either row (transition_company_verification_with_
  -- audit() locks companies only), so this can never deadlock against it.
  SELECT * INTO v_company FROM public.companies WHERE id = v_job.company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company not found'; END IF;

  IF p_action = 'mark_under_review' THEN
    IF v_job.status <> 'submitted' THEN
      RETURN QUERY SELECT false, v_job.status, v_job.published_opportunity_id;
      RETURN;
    END IF;
    v_new_status := 'under_review';
  ELSIF p_action = 'reject' THEN
    IF v_job.status NOT IN ('submitted','under_review') THEN
      RETURN QUERY SELECT false, v_job.status, v_job.published_opportunity_id;
      RETURN;
    END IF;
    v_new_status := 'rejected';
  ELSE
    IF v_job.status NOT IN ('submitted','under_review') OR v_company.verification_status <> 'verified' THEN
      RETURN QUERY SELECT false, v_job.status, v_job.published_opportunity_id;
      RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.supply_platforms WHERE slug = 'employerdirect') THEN
      RAISE EXCEPTION 'employerdirect supply platform is missing';
    END IF;

    v_internal_url := 'https://remotematch.online/remote-jobs/view/' || v_job.id::text;
    INSERT INTO public.opportunities (
      type,title,company,description,source,source_id,source_url,official_url,
      canonical_url_hash,content_hash,employment_type,remote_type,eligible_countries,
      salary_min,salary_max,salary_currency,required_skills,preferred_skills,
      experience_requirement,status,posted_at,last_verified_at
    ) VALUES (
      'job',v_job.title,v_company.legal_name,v_job.description,'employerdirect',
      v_job.id::text,v_internal_url,v_internal_url,
      md5(lower(v_internal_url)),
      md5(concat_ws('|',v_job.title,v_company.legal_name,v_job.description,v_job.id::text)),
      v_job.employment_type,v_job.remote_type,v_job.eligible_countries,
      v_job.salary_min,v_job.salary_max,v_job.salary_currency,v_job.required_skills,
      v_job.preferred_skills,v_job.experience_requirement,'active',now(),now()
    ) RETURNING id INTO v_opportunity_id;
    v_new_status := 'published';
  END IF;

  UPDATE public.employer_job_submissions
    SET status = v_new_status,
        review_reason = p_reason,
        reviewed_by = p_admin_id,
        reviewed_at = now(),
        published_opportunity_id = coalesce(v_opportunity_id, published_opportunity_id),
        updated_at = now()
    WHERE id = p_submission_id;

  INSERT INTO public.employer_job_review_events (
    submission_id,admin_id,admin_email,action,from_status,to_status,reason,opportunity_id
  ) VALUES (
    p_submission_id,p_admin_id,p_admin_email,p_action,v_job.status,v_new_status,p_reason,v_opportunity_id
  );

  RETURN QUERY SELECT true, v_new_status, v_opportunity_id;
END;
$$;

REVOKE ALL ON FUNCTION public.review_employer_job_submission(uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_employer_job_submission(uuid,uuid,text,text,text) TO service_role;

-- ==============================================================================
-- DOWN (documented recovery -- this repo does not auto-run downs)
-- ------------------------------------------------------------------------------
-- Restore migration 050's version of review_employer_job_submission()
-- (the plain, unlocked SELECT on companies) if rolling back. No data loss on
-- rollback: this migration redefines a function only, no table/column change.
-- ==============================================================================

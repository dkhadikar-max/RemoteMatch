-- Direct employer applications: candidates apply inside RemoteMatch; no external URL required.
ALTER TABLE public.employer_job_submissions
  ALTER COLUMN application_url DROP NOT NULL;

CREATE TABLE IF NOT EXISTS public.employer_job_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.employer_job_submissions(id) ON DELETE RESTRICT,
  opportunity_id uuid NOT NULL REFERENCES public.opportunities(id) ON DELETE RESTRICT,
  candidate_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  cover_note text NOT NULL DEFAULT '' CHECK (length(cover_note) <= 10000),
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','reviewing','shortlisted','rejected','hired','withdrawn')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_employer_job_application_candidate UNIQUE (submission_id, candidate_profile_id)
);
CREATE INDEX IF NOT EXISTS employer_job_applications_submission_idx
  ON public.employer_job_applications(submission_id, submitted_at DESC);
CREATE INDEX IF NOT EXISTS employer_job_applications_candidate_idx
  ON public.employer_job_applications(candidate_profile_id, submitted_at DESC);

ALTER TABLE public.employer_job_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employer_job_applications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employer_job_applications_service_role_all ON public.employer_job_applications;
CREATE POLICY employer_job_applications_service_role_all ON public.employer_job_applications
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.employer_job_applications FROM anon, authenticated;
GRANT ALL ON public.employer_job_applications TO service_role;

-- Direct employer listings use their RemoteMatch detail page as the required
-- official_url for the shared opportunity catalogue. The employer's external
-- application URL remains optional metadata only.
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

  SELECT * INTO v_company FROM public.companies WHERE id = v_job.company_id;
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

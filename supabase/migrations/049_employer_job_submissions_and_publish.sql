-- Direct Employer Supply Phase 2/3: vacancy drafts, moderation and publication.
-- All writes are server-side through service-role API routes. No client role
-- can read or mutate submissions; only approved jobs enter opportunities.
CREATE TABLE IF NOT EXISTS public.employer_job_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 180),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 30 AND 20000),
  responsibilities text NOT NULL DEFAULT '',
  employment_type text NOT NULL CHECK (employment_type IN ('Full-time','Part-time','Contract','Temporary','Internship')),
  remote_type text NOT NULL CHECK (remote_type IN ('Remote','Hybrid','On-site')),
  location text NOT NULL DEFAULT 'Worldwide',
  eligible_countries text[] NOT NULL DEFAULT '{}',
  salary_min numeric CHECK (salary_min IS NULL OR salary_min >= 0),
  salary_max numeric CHECK (salary_max IS NULL OR salary_max >= 0),
  salary_currency text NOT NULL DEFAULT 'USD' CHECK (salary_currency ~ '^[A-Z]{3}$'),
  required_skills text[] NOT NULL DEFAULT '{}',
  preferred_skills text[] NOT NULL DEFAULT '{}',
  experience_requirement text,
  application_url text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','under_review','approved','rejected','published','withdrawn')),
  review_reason text,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  published_opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CONSTRAINT employer_job_salary_order CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min)
);
CREATE INDEX IF NOT EXISTS employer_job_submissions_company_idx
  ON public.employer_job_submissions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS employer_job_submissions_review_idx
  ON public.employer_job_submissions(status, submitted_at ASC);

CREATE TABLE IF NOT EXISTS public.employer_job_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES public.employer_job_submissions(id) ON DELETE RESTRICT,
  admin_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  admin_email text NOT NULL,
  action text NOT NULL CHECK (action IN ('mark_under_review','approve_publish','reject')),
  from_status text NOT NULL,
  to_status text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.employer_job_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employer_job_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employer_job_submissions_service_role_all ON public.employer_job_submissions;
CREATE POLICY employer_job_submissions_service_role_all ON public.employer_job_submissions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.employer_job_submissions FROM anon, authenticated;
GRANT ALL ON public.employer_job_submissions TO service_role;

ALTER TABLE public.employer_job_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employer_job_review_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employer_job_review_events_service_role_all ON public.employer_job_review_events;
CREATE POLICY employer_job_review_events_service_role_all ON public.employer_job_review_events
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.employer_job_review_events FROM anon, authenticated;
GRANT ALL ON public.employer_job_review_events TO service_role;

-- The source slug is deliberately alphanumeric: opportunities.source has an FK
-- to supply_platforms.slug and that table constrains slug to ^[a-z0-9]+$.
INSERT INTO public.supply_platforms (slug, display_name, source_type, kind)
VALUES ('employerdirect','Direct employer submissions','employer_direct','primary_api')
ON CONFLICT (slug) DO NOTHING;

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

    INSERT INTO public.opportunities (
      type,title,company,description,source,source_id,source_url,official_url,
      canonical_url_hash,content_hash,employment_type,remote_type,eligible_countries,
      salary_min,salary_max,salary_currency,required_skills,preferred_skills,
      experience_requirement,status,posted_at,last_verified_at
    ) VALUES (
      'job',v_job.title,v_company.legal_name,v_job.description,'employerdirect',
      v_job.id::text,v_job.application_url,v_job.application_url,
      md5(lower(v_job.application_url)),
      md5(concat_ws('|',v_job.title,v_company.legal_name,v_job.description,v_job.application_url)),
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

COMMENT ON TABLE public.employer_job_submissions IS
  'Private staging area for employer-authored vacancies. A row is never public here; only the atomic admin approval RPC promotes it into opportunities.';

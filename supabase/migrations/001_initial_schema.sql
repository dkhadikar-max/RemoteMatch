-- ==============================================================================
-- RemoteMatch (BYN Architecture) — PostgreSQL / Supabase Schema
-- Core Principle: PERSON + INTENT + OPPORTUNITY -> MATCH -> ACTION -> OUTCOME
-- ==============================================================================

-- 1. PROFILES (Person Layer)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT,
  headline TEXT,
  avatar_url TEXT,
  raw_resume_text TEXT,
  resume_file_url TEXT,
  plan_tier TEXT DEFAULT 'free' CHECK (plan_tier IN ('free', 'pro')),
  daily_evaluations_count INT DEFAULT 0,
  last_evaluation_reset_at TIMESTAMPTZ DEFAULT NOW(),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. PROFILE INTENTS (Intent Layer)
CREATE TABLE IF NOT EXISTS profile_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  employment_types TEXT[] DEFAULT ARRAY['full_time']::TEXT[],
  target_roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  years_of_experience TEXT DEFAULT '2-3',
  min_salary NUMERIC,
  preferred_currency TEXT DEFAULT 'USD',
  availability_status TEXT DEFAULT 'immediately',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. PROFILE SKILLS
CREATE TABLE IF NOT EXISTS profile_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  years_used INT,
  is_primary BOOLEAN DEFAULT true
);

-- 4. PROFILE EXPERIENCES
CREATE TABLE IF NOT EXISTS profile_experiences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  role_title TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  is_current BOOLEAN DEFAULT false,
  achievements TEXT[] DEFAULT ARRAY[]::TEXT[],
  industry TEXT
);

-- 5. PROFILE LOCATIONS
CREATE TABLE IF NOT EXISTS profile_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  current_country TEXT DEFAULT 'Worldwide',
  current_timezone TEXT DEFAULT 'UTC',
  work_preference TEXT DEFAULT 'worldwide' CHECK (work_preference IN ('worldwide', 'my_country', 'selected_countries')),
  allowed_countries TEXT[] DEFAULT ARRAY[]::TEXT[],
  willing_timezones TEXT[] DEFAULT ARRAY[]::TEXT[]
);

-- 6. OPPORTUNITIES (Canonical Opportunity Layer)
CREATE TABLE IF NOT EXISTS opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT DEFAULT 'job' CHECK (type IN ('job', 'gig', 'contract', 'freelance', 'collaboration')),
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  company_logo TEXT,
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT,
  official_url TEXT NOT NULL,
  canonical_url_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  employment_type TEXT DEFAULT 'Full-time',
  remote_type TEXT DEFAULT 'Worldwide',
  eligible_countries TEXT[] DEFAULT ARRAY[]::TEXT[],
  excluded_countries TEXT[] DEFAULT ARRAY[]::TEXT[],
  timezone_requirements TEXT[] DEFAULT ARRAY[]::TEXT[],
  salary_min NUMERIC,
  salary_max NUMERIC,
  salary_currency TEXT DEFAULT 'USD',
  required_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  preferred_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  experience_requirement TEXT,
  quality_score INT DEFAULT 85,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'draft')),
  posted_at TIMESTAMPTZ DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  CONSTRAINT uq_source_source_id UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opportunities_canonical_url ON opportunities(canonical_url_hash);
CREATE INDEX IF NOT EXISTS idx_opportunities_content_hash ON opportunities(content_hash);
CREATE INDEX IF NOT EXISTS idx_opportunities_posted_at ON opportunities(posted_at DESC);

-- 7. SWIPES
CREATE TABLE IF NOT EXISTS swipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('interested', 'passed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_profile_opportunity_swipe UNIQUE (profile_id, opportunity_id)
);

-- 8. MATCHES (Screening Fit Score + Explainable Intelligence)
CREATE TABLE IF NOT EXISTS matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  fit_score INT NOT NULL CHECK (fit_score >= 0 AND fit_score <= 100),
  is_country_eligible BOOLEAN DEFAULT true,
  is_remote_eligible BOOLEAN DEFAULT true,
  is_role_match BOOLEAN DEFAULT true,
  why_this_job TEXT,
  strengths TEXT[] DEFAULT ARRAY[]::TEXT[],
  gaps TEXT[] DEFAULT ARRAY[]::TEXT[],
  requirement_checklist JSONB DEFAULT '[]'::JSONB,
  recommendation TEXT DEFAULT 'apply' CHECK (recommendation IN ('apply', 'apply_with_caveat', 'low_priority')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_profile_opportunity_match UNIQUE (profile_id, opportunity_id)
);

-- 9. APPLICATIONS (Tracker)
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  opportunity_id UUID REFERENCES opportunities(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'interested' CHECK (status IN ('interested', 'applied', 'interview', 'rejected', 'offer', 'archived')),
  applied_at TIMESTAMPTZ,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT uq_profile_opportunity_app UNIQUE (profile_id, opportunity_id)
);

-- 10. APPLICATION FEEDBACK ("Did you apply?" outcome loop)
CREATE TABLE IF NOT EXISTS application_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
  did_apply TEXT NOT NULL CHECK (did_apply IN ('applied', 'did_not_apply', 'not_eligible', 'expired', 'changed_mind')),
  feedback_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. APPLICATION EVENTS (Outcome Flywheel)
CREATE TABLE IF NOT EXISTS application_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('status_changed', 'feedback_submitted', 'interview_scheduled', 'offer_received', 'rejection_received', 'note_added')),
  event_payload JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. GENERATED MATERIALS (Application Kit)
CREATE TABLE IF NOT EXISTS generated_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
  material_type TEXT NOT NULL CHECK (material_type IN ('cover_letter', 'resume_tailoring', 'proposal')),
  tone TEXT DEFAULT 'confident' CHECK (tone IN ('confident', 'conversational', 'formal')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

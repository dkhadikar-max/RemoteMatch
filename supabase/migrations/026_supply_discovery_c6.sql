-- ==============================================================================
-- RemoteMatch — 026: Automated Company Discovery Staging (Supply Discovery gate C6)
--
-- Implements the signed C6 company discovery staging layer.
-- Creates:
--   1. supply_discovered_companies: Staging queue for discovered company entities
--      prior to promotion to allowlist_employers. Decoupled from active catalog.
--   2. supply_discovery_domain_blocklist: Exact/pattern blocklist for aggregators,
--      social networks, directories, and ToS-hostile domains (e.g. LinkedIn, Indeed).
--
-- Security:
--   - RLS forced with service_role-only access.
--   - No public/authenticated access.
--   - Additive only: does not alter existing opportunities, supply_sources, or allowlist_employers.
-- ==============================================================================

-- 1. supply_discovery_domain_blocklist
CREATE TABLE IF NOT EXISTS supply_discovery_domain_blocklist (
  domain_pattern           text PRIMARY KEY,
  category                 text NOT NULL CHECK (category IN ('job_aggregator', 'social_network', 'directory', 'educational', 'gov_public', 'blacklisted_waf')),
  reason                   text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Seed universal exclusions
INSERT INTO supply_discovery_domain_blocklist (domain_pattern, category, reason) VALUES
  ('linkedin.com', 'social_network', 'ToS-hostile; prohibited by strategy'),
  ('indeed.com', 'job_aggregator', 'ToS-hostile; prohibited by strategy'),
  ('glassdoor.com', 'job_aggregator', 'Aggregator; not an employer'),
  ('ziprecruiter.com', 'job_aggregator', 'Aggregator; not an employer'),
  ('facebook.com', 'social_network', 'Social network'),
  ('twitter.com', 'social_network', 'Social network'),
  ('x.com', 'social_network', 'Social network'),
  ('instagram.com', 'social_network', 'Social network'),
  ('wikipedia.org', 'directory', 'Information portal'),
  ('youtube.com', 'social_network', 'Media portal'),
  ('crunchbase.com', 'directory', 'Paid directory; not employer website')
ON CONFLICT (domain_pattern) DO NOTHING;

-- 2. supply_discovered_companies
CREATE TABLE IF NOT EXISTS supply_discovered_companies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name           text NOT NULL,
  normalized_name_key      text NOT NULL,
  raw_domain               text NOT NULL,
  resolved_root_domain     text,
  domain_tld               text,
  country_code             text,
  industry                 text,
  estimated_size           text CHECK (estimated_size IN ('seed', '1-50', '51-200', '201-1000', '1000+', 'unknown') OR estimated_size IS NULL),
  discovery_source         text NOT NULL,
  discovery_metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  
  -- Stage Tracking
  pipeline_stage           text NOT NULL DEFAULT 'discovered'
                           CHECK (pipeline_stage IN (
                             'discovered', 'website_verified', 'career_found', 
                             'qualified_remote', 'promoted_to_allowlist', 'rejected'
                           )),
  rejection_reason         text,
  
  -- Discovered Technical Endpoints
  discovered_career_url    text,
  discovered_ats_platform  text CHECK (discovered_ats_platform IN ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'none', 'unknown') OR discovered_ats_platform IS NULL),
  discovered_ats_board     text,
  has_json_ld_jobs         boolean DEFAULT false,
  robots_permission        text DEFAULT 'unknown' CHECK (robots_permission IN ('allowed', 'disallowed', 'unknown', 'failed')),
  
  -- Evidence & Verification
  remote_evidence_snippet  text,
  confidence_score         int NOT NULL DEFAULT 50 CHECK (confidence_score BETWEEN 0 AND 100),
  
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_probed_at           timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_discovered_root_domain UNIQUE (resolved_root_domain)
);

CREATE INDEX IF NOT EXISTS idx_discovered_companies_stage ON supply_discovered_companies(pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_discovered_companies_domain ON supply_discovered_companies(raw_domain);
CREATE INDEX IF NOT EXISTS idx_discovered_companies_name_key ON supply_discovered_companies(normalized_name_key);

-- 3. RLS — service_role only
ALTER TABLE supply_discovery_domain_blocklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_discovery_domain_blocklist FORCE ROW LEVEL SECURITY;
CREATE POLICY blocklist_service_role_all ON supply_discovery_domain_blocklist FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON supply_discovery_domain_blocklist FROM anon, authenticated;
GRANT ALL ON supply_discovery_domain_blocklist TO service_role;

ALTER TABLE supply_discovered_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE supply_discovered_companies FORCE ROW LEVEL SECURITY;
CREATE POLICY discovered_companies_service_role_all ON supply_discovered_companies FOR ALL
  USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON supply_discovered_companies FROM anon, authenticated;
GRANT ALL ON supply_discovered_companies TO service_role;

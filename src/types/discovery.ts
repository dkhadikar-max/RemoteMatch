export type PipelineStage =
  | 'discovered'
  | 'website_verified'
  | 'career_found'
  | 'qualified_remote'
  | 'promoted_to_allowlist'
  | 'rejected';

export type DiscoveredAtsPlatform =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workday'
  | 'none'
  | 'unknown';

export type RobotsPermissionStatus = 'allowed' | 'disallowed' | 'unknown' | 'failed';

export type DiscoverySource =
  | 'search_index'
  | 'google_places'
  | 'public_registry'
  | 'ats_reverse'
  | 'pilot_cohort'
  | 'manual';

export interface DiscoveredCompany {
  id?: string;
  canonicalName: string;
  normalizedNameKey: string;
  rawDomain: string;
  resolvedRootDomain?: string;
  domainTld?: string;
  countryCode?: string;
  industry?: string;
  estimatedSize?: 'seed' | '1-50' | '51-200' | '201-1000' | '1000+' | 'unknown';
  discoverySource: DiscoverySource;
  discoveryMetadata?: Record<string, unknown>;
  pipelineStage: PipelineStage;
  rejectionReason?: string;
  discoveredCareerUrl?: string;
  discoveredAtsPlatform?: DiscoveredAtsPlatform;
  discoveredAtsBoard?: string;
  hasJsonLdJobs?: boolean;
  robotsPermission?: RobotsPermissionStatus;
  remoteEvidenceSnippet?: string;
  confidenceScore?: number;
  firstSeenAt?: string;
  lastProbedAt?: string;
  createdAt?: string;
}

export interface BlocklistEntry {
  domainPattern: string;
  category: 'job_aggregator' | 'social_network' | 'directory' | 'educational' | 'gov_public' | 'blacklisted_waf';
  reason: string;
  createdAt?: string;
}

export interface AtsProbeResult {
  detected: boolean;
  platform?: 'greenhouse' | 'lever' | 'ashby';
  boardSlug?: string;
  endpointUrl?: string;
  sampleJobsCount?: number;
  remoteJobsCount?: number;
  remoteEvidenceSnippet?: string;
}

export interface CareerSurfaceResult {
  found: boolean;
  careerUrl?: string;
  method?: 'canonical_path' | 'sitemap' | 'homepage_link' | 'ats_redirect';
  atsResult?: AtsProbeResult;
  hasJsonLd?: boolean;
  robotsAllowed?: boolean;
  remoteEvidenceSnippet?: string;
  rejectionReason?: string;
}

// ==============================================================================
// Job Provider Abstraction Interface
// Reference architecture inspired by Ever Jobs, EndpointJobs, and jobsh
// ==============================================================================

export interface RawJobPayload {
  sourceId: string;
  source: 'curated' | 'remotive' | 'arbeitnow' | 'jobicy';
  title: string;
  company: string;
  companyLogo?: string;
  description: string;
  sourceUrl?: string;
  officialUrl: string;
  jobType: string;
  locationString?: string;
  salaryString?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  /** Pay period, when the provider states it unambiguously (e.g. Jobicy's
   *  `annualSalary*` fields → 'yearly'). Left undefined when the provider
   *  only gives a free-text `salaryString` — normalizeOpportunity() then
   *  tries to read an explicit marker out of that string, and falls back to
   *  'unknown' rather than guessing. */
  salaryPeriod?: 'hourly' | 'monthly' | 'yearly' | 'unknown';
  tags?: string[];
  publicationDate: string;
  experienceLevel?: string;
  status?: 'ACTIVE' | 'UPDATED' | 'EXPIRED';
  updatedAt?: string;
  closedAt?: string;
  isPermanentlyRemoved?: boolean;
}

export interface JobProvider {
  readonly name: string;
  readonly sourceKey: 'curated' | 'remotive' | 'arbeitnow' | 'jobicy';
  fetchJobs(): Promise<RawJobPayload[]>;
}

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

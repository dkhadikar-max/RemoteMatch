// ==============================================================================
// BYN Core Types: PERSON + INTENT + OPPORTUNITY -> MATCH -> ACTION -> OUTCOME
// ==============================================================================

export type OpportunityType = 'job' | 'gig' | 'contract' | 'freelance' | 'collaboration';

export type RemoteType =
  | 'Worldwide'
  | 'US'
  | 'EU/EEA'
  | 'India'
  | 'Specific countries'
  | 'Regional'
  | 'Timezone restricted'
  | 'Contractor only';

export type EmploymentType = 'Full-time' | 'Contract' | 'Freelance' | 'Part-time';

export type ApplicationStatus =
  | 'interested'
  | 'applied'
  | 'interview'
  | 'rejected'
  | 'offer'
  | 'withdrawn'
  | 'archived';

export type FeedbackOutcome =
  | 'applied'
  | 'did_not_apply'
  | 'not_eligible'
  | 'expired'
  | 'changed_mind';

export type MaterialType = 'cover_letter' | 'resume_tailoring' | 'proposal';
export type MaterialTone = 'confident' | 'conversational' | 'formal';

export type SkillEvidenceLevel = 'strong' | 'moderate' | 'missing';

// 1. PERSON & PROFILE LAYER
export interface PersonProfile {
  id: string;
  email: string;
  fullName: string;
  headline?: string;
  avatarUrl?: string;
  rawResumeText?: string;
  resumeFileUrl?: string;
  profileStrength?: number; // 0-100 (Separate from Job Fit!)
  planTier: 'free' | 'pro';
  dailyEvaluationsCount: number;
  lastEvaluationResetAt: string;
  dailyRightSwipesCount?: number;
  dailyProposalsCount?: number;
  usageDate?: string; // YYYY-MM-DD (UTC)
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  createdAt: string;
  updatedAt: string;

  // Identity/linking state — server-authoritative, read from the verified
  // auth session (see /api/profile). Never set from client state.
  isAnonymous?: boolean;
  // Professional profile links — display data only, not an auth mechanism.
  // Server-authoritative (see supabase/migrations/005_profile_links.sql),
  // unlike fullName/headline which still live on the local fixture.
  linkedinUrl?: string | null;
  githubUrl?: string | null;

  // Nested BYN relations
  intent?: ProfileIntent;
  skills: ProfileSkill[];
  experiences: ProfileExperience[];
  location?: ProfileLocation;
}

export interface ProfileIntent {
  id: string;
  profileId: string;
  employmentTypes: EmploymentType[];
  targetRoles: string[];
  yearsOfExperience: '0-1' | '2-3' | '4-6' | '7-10' | '10+';
  minSalary?: number;
  preferredCurrency: string;
  availabilityStatus: string;
  updatedAt: string;
}

export interface ProfileSkill {
  id: string;
  profileId: string;
  skillName: string;
  yearsUsed?: number;
  isPrimary: boolean;
  evidenceLevel?: SkillEvidenceLevel;
  whereUsed?: string;
}

export interface ProfileExperience {
  id: string;
  profileId: string;
  company: string;
  roleTitle: string;
  startDate?: string;
  endDate?: string;
  isCurrent: boolean;
  achievements: string[];
  industry?: string;
}

export interface ProfileLocation {
  id: string;
  profileId: string;
  currentCountry: string;
  currentTimezone: string;
  workPreference: 'worldwide' | 'my_country' | 'selected_countries';
  allowedCountries: string[];
  willingTimezones: string[];
}

// 2. RESUME INTELLIGENCE & 5-DIMENSION ANALYSIS
export interface ProfileStrengthDimension {
  name: string;
  score: number; // 0-100
  feedback: string;
}

export interface AIUncertaintyItem {
  id: string;
  skill: string;
  prompt: string;
  resolved: boolean;
  resolution?: 'added' | 'not_relevant' | 'no';
  whereUsed?: string;
}

export interface ProfileStrengthAnalysis {
  overallScore: number; // e.g. 78 / 100
  dimensions: {
    relevance: ProfileStrengthDimension;
    evidence: ProfileStrengthDimension;
    impact: ProfileStrengthDimension;
    atsReadability: ProfileStrengthDimension;
    targetAlignment: ProfileStrengthDimension;
  };
  strongAreas: string[];
  improvementAreas: Array<{
    title: string;
    explanation: string;
    action: string;
  }>;
  uncertainties: AIUncertaintyItem[];
}

// 3. JOB-SPECIFIC RESUME ANALYSIS
export interface JobSpecificResumeImprovement {
  title: string;
  currentContext?: string;
  recommendation: string;
  actionType: 'reorder' | 'rewrite' | 'evidence';
}

// 4. CANONICAL OPPORTUNITY LAYER
export interface CanonicalOpportunity {
  id: string;
  type: OpportunityType;
  title: string;
  company: string;
  companyLogo?: string;
  description: string;
  /** Acquisition platform (`supply_platforms.slug`). Low-cardinality — NOT a
   *  per-employer value; the employer/board lives in `sourceId`. Was a closed
   *  union before the supply-discovery registry (gate C1). */
  source: string;
  sourceId: string;
  sourceUrl?: string;
  officialUrl: string;
  canonicalUrlHash: string;
  contentHash: string;
  employmentType: EmploymentType;
  remoteType: RemoteType;
  eligibleCountries: string[];
  excludedCountries: string[];
  timezoneRequirements: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  /** Pay period for salaryMin/salaryMax. 'unknown' (or undefined) means the
   *  source never stated it — consumers MUST NOT assume a default. In
   *  particular buildJobPostingSchema() omits schema.org `unitText` entirely
   *  when this is not 'hourly' | 'monthly' | 'yearly', rather than emitting a
   *  possibly-false 'YEAR'. */
  salaryPeriod?: 'hourly' | 'monthly' | 'yearly' | 'unknown';
  requiredSkills: string[];
  preferredSkills: string[];
  experienceRequirement?: string;
  qualityScore: number;
  sourceQuality?: number;
  descriptionCompleteness?: 'high' | 'medium' | 'low';
  salaryQuality?: 'verified' | 'estimated' | 'unspecified';
  remotePolicyConfidence?: 'high' | 'medium' | 'low';
  /** P1 (Job-Quality Intelligence) candidate observable attribute — see
   *  classifyExplicitRemoteScope() in src/lib/ingestion/pipeline.ts.
   *  Distinct from remoteType/eligibleCountries above (which are used by
   *  matching/eligibility, a frozen contract): this only records whether
   *  the raw listing text stated a remote scope at all. 'unknown' means
   *  no location information was found — never conflated with a real
   *  value. */
  explicitRemoteScope?: 'explicit_worldwide' | 'explicit_restricted' | 'unknown';
  status: 'active' | 'expired' | 'draft' | 'unknown';
  isActive?: boolean;
  /** Live Supply Activation — drives the existing 410-vs-noindex SEO
   *  distinction (src/middleware.ts): true -> 410 Gone, false but expired
   *  -> 200 with noindex,follow. Set by the ingestion pipeline only; never
   *  inferred from other fields. */
  isPermanentlyRemoved?: boolean;
  /** The one genuinely real freshness fact in this object: when the
   *  official link was actually last checked, if ever. Undefined means
   *  never verified — display accordingly, never invent a date. */
  linkCheckedAt?: string;
  postedAt: string;
  lastVerifiedAt: string;
  expiresAt?: string;

  // Computed for active user feed
  fitScore?: number; // Pre-computed Screening Fit %
  fitBadge?: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Low Fit';
  isEligible?: boolean;
}

// 5. HARD ELIGIBILITY GATE & SCREENING FIT
export interface EligibilityGateResult {
  isEligible: boolean;
  countryEligible: boolean;
  remoteAllowed: boolean;
  employmentTypeCompatible: boolean;
  roleRelevant: boolean;
  ineligibilityReason?: string;
}

export interface ScreeningFitResult {
  fitScore: number; // 0-100
  fitBadge: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Low Fit';
  overlapSkills: string[];
  missingSkills: string[];
}

// 6. DEEP MATCH ANALYSIS (Triggered upon right-swipe / user intent)
export interface RequirementCheckItem {
  requirement: string;
  status: 'matched' | 'partial' | 'missing';
  note: string;
}

export interface MatchAnalysisResult {
  opportunityId: string;
  fitScore: number;
  fitBadge: 'Strong Fit' | 'Good Fit' | 'Moderate Fit' | 'Low Fit';
  isCountryEligible: boolean;
  isRemoteEligible: boolean;
  isRoleMatch: boolean;
  whyThisJob: string;
  strengths: string[];
  gaps: string[];
  requirementChecklist: RequirementCheckItem[];
  jobSpecificResumeImprovements?: JobSpecificResumeImprovement[];
  recommendation: 'apply' | 'apply_with_caveat' | 'low_priority';
}

// 7. APPLICATION KIT & OUTCOME FLYWHEEL
export interface TailoredResumeSuggestions {
  summaryAdjustment: string;
  emphasizeExperience: string[];
  bulletRewrites: Array<{
    originalContext: string;
    suggestedRewrite: string;
    targetRequirement: string;
  }>;
  recommendedSkillsToAdd: string[];
}

export interface DecisionSnapshot {
  fitScore: number;
  fitBadge: string;
  isEligible: boolean;
  decisionTimestamp: string;
  matchingEngineVersion: string;
  matchingWeightsVersion: string;
  eligibilityRulesVersion: string;
  profileVersion: string;
  jobVersion: string;
  jobSource: string;
  jobSourceId: string;
  officialUrl: string;
  employmentType: string;
  remoteClassification: string;
  requirementsEvaluated?: Array<{
    requirement: string;
    status: 'matched' | 'partial' | 'missing';
  }>;
  scoreBreakdown?: Record<string, number | string>;
  /** P1 (Job-Quality Intelligence) candidate observable attributes, frozen
   *  at decision time. See the P1 scoping document — these are inputs to
   *  a separate, later outcome-correlation analysis, not to matching or
   *  scoring. */
  salaryDisclosed?: boolean;
  postingAgeDaysAtDecision?: number;
  remoteScopeExplicit?: 'explicit_worldwide' | 'explicit_restricted' | 'unknown';
  /** C2 (Additional Supply Discovery) — the deterministic, coarse demand
   *  pattern of the SWIPED OPPORTUNITY, frozen at decision time. Derived
   *  server-side from `opp` only (never client-supplied). Instrumentation for
   *  the later demand model — does NOT feed matching, scoring, eligibility, or
   *  quota. See src/lib/demand/pattern.ts. */
  demandPattern?: import('@/lib/demand/pattern').DemandPattern;
  demandPatternKey?: string;
  patternLexiconVersion?: string;
}

export interface ApplicationRecord {
  id: string;
  profileId: string;
  opportunityId: string;
  opportunity?: CanonicalOpportunity;
  match?: MatchAnalysisResult;
  status: ApplicationStatus;
  appliedAt?: string;
  notes: string;
  decisionSnapshot?: DecisionSnapshot;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationEvent {
  id: string;
  applicationId: string;
  eventType:
    | 'status_changed'
    | 'feedback_submitted'
    | 'interview_scheduled'
    | 'offer_received'
    | 'rejection_received'
    | 'note_added';
  eventPayload: Record<string, unknown>;
  createdAt: string;
}

export interface OpportunityFilters {
  targetRole?: string;
  remoteType?: string;
  seniority?: string;
  specificLocation?: string;
  minSalary?: number;
  strictTimezone?: string;
}

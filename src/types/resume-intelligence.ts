/**
 * Resume Intelligence — the output contract (migration 036, resume PR B).
 *
 * docs/resume-intelligence-design.md §5, approved by Deep 2026-10-17/18.
 * Every material claim (a strength, an improvement, a rewrite, a requirement
 * status) carries evidence it can be checked against; the server validator
 * (src/lib/resume/evidence-validation.ts) drops anything that fails that
 * check before it reaches the client or gets stored. Nothing here is a
 * matching input — resume quality stays separate from match eligibility
 * and fit scores (the frozen matching engine is never read or written here).
 */

export const RESUME_ANALYSIS_VERSION = 'resume-intel-2026.10-v1' as const;

/** The 12 rubric criteria (design doc §3). Each is rated per section, never scored 0-100. */
export type RubricCriterionId =
  | 'R1' // Header & contact
  | 'R2' // Summary & role clarity
  | 'R3' // PAR / achievement structure
  | 'R4' // Specificity
  | 'R5' // Evidence quality
  | 'R6' // Skills evidence
  | 'R7' // Education, certs, projects, portfolio
  | 'R8' // Progression & chronology
  | 'R9' // Language
  | 'R10' // Structure & parseability
  | 'R11' // Role alignment (target_job mode only)
  | 'R12'; // Authenticity (rewrites only, not a section rating)

export type CriterionRating = 'meets' | 'partly' | 'not_yet' | 'not_applicable';

/** A quote the server has verified occurs verbatim in the normalized source text, with
 *  computed offsets — never trusted from the model past V2 in evidence-validation.ts. */
export interface EvidenceRef {
  doc: 'resume' | 'job' | 'candidate';
  quote: string;
  start: number;
  end: number;
  sectionId?: string;
  bulletId?: string;
}

export interface Finding {
  id: string;
  text: string;
  criterion?: RubricCriterionId;
  evidence: EvidenceRef[];
  source: 'ai' | 'rules';
}

export interface SkillEvidenceEntry {
  skill: string;
  evidence: EvidenceRef[];
}

export type AnalysisStatus = 'success' | 'insufficient_input' | 'unavailable';
export type AnalysisMode = 'general' | 'target_job';

export interface ResumeAnalysis {
  analysisVersion: typeof RESUME_ANALYSIS_VERSION;
  mode: AnalysisMode;
  analysisStatus: AnalysisStatus;
  source: { ai: boolean; rules: true; model?: string };

  resumeType: { roleFamily: string; confidence: 'high' | 'medium' | 'low'; alternatives: string[]; evidence: EvidenceRef[] };
  overallSummary: { text: string; evidence: EvidenceRef[] };

  sectionReviews: Array<{
    sectionId: string;
    heading: string;
    criteria: Array<{ id: RubricCriterionId; rating: CriterionRating; evidence: EvidenceRef[] }>;
    findings: Finding[];
    recommendations: Finding[];
  }>;

  strengths: Finding[];
  improvements: Array<Finding & { severity: 'high' | 'medium' | 'low'; priority: number }>;

  bulletRewrites: Array<{
    id: string;
    bulletId: string;
    original: string;
    problem: string;
    proposed: string;
    rationale: string;
    evidence: EvidenceRef[];
    missingFacts: string[];
    status: 'suggested';
  }>;

  skillsEvidence: {
    demonstrated: SkillEvidenceEntry[];
    weaklySupported: SkillEvidenceEntry[];
    notEvidenced: Array<{ skill: string; note: 'not demonstrated in this resume' }>;
  };

  formattingIssues: Finding[];

  /** Present only when mode === 'target_job' and a real catalog job was supplied. */
  targetJobFit: null | {
    opportunityId: string;
    jobContentHash: string;
    requirements: Array<{
      requirement: string;
      jobEvidence: EvidenceRef[];
      status: 'supported' | 'present_but_unclear' | 'not_demonstrated' | 'transferable';
      resumeEvidence: EvidenceRef[];
    }>;
    prioritize: Finding[];
    summaryEdit?: { original: string; proposed: string; rationale: string; evidence: EvidenceRef[] };
    skillsEdit?: { original: string; proposed: string; rationale: string; evidence: EvidenceRef[] };
    bulletEdits: string[]; // ids into bulletRewrites
    interviewPrep: Finding[];
  };

  keywordAlignment: null | {
    relevantPresent: string[];
    missingButEvidenced: string[];
    notDemonstrated: string[];
  };

  actionPlan: Array<{ step: string; refs: string[] }>;
  questionsForCandidate: Array<{ id: string; question: string; why: string; refs: string[] }>;
  limitations: Array<{ code: string; message: string; evidence?: EvidenceRef[] }>;
}

/** The unvalidated shape the model is asked to return (strict json_schema). Never used
 *  directly — every field passes through validateModelOutput() in evidence-validation.ts
 *  before it can become part of a ResumeAnalysis. `status` on a bullet rewrite is NOT part of
 *  this shape — the model never sets it; the validator stamps 'suggested' on every surviving
 *  rewrite itself. */
export type RawModelResumeAnalysis = Omit<
  ResumeAnalysis,
  'analysisVersion' | 'source' | 'mode' | 'analysisStatus' | 'bulletRewrites'
> & {
  bulletRewrites: Array<Omit<ResumeAnalysis['bulletRewrites'][number], 'status'>>;
};

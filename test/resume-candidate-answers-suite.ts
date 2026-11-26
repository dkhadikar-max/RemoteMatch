import assert from 'node:assert/strict';
import { redactForModel } from '../src/lib/resume/redaction';
import { buildRubricPrompt } from '../src/lib/resume/prompt';
import { rewriteIsSupported, validateModelOutput, type ValidationContext } from '../src/lib/resume/evidence-validation';
import type { RawModelResumeAnalysis } from '../src/types/resume-intelligence';

const resumeText = 'Worked with engineering team.';
const candidateText = 'Question q-1\nAnswer: Managed 4 engineers at Acme. Contact deep@example.com';
const redactedResume = redactForModel(resumeText, null);
const redactedCandidate = redactForModel(candidateText, null);
const ctx: ValidationContext = {
  resumeText,
  redactedResumeText: redactedResume.redactedText,
  redactionSpans: redactedResume.spans,
  jobText: '',
  candidateText,
  redactedCandidateText: redactedCandidate.redactedText,
  candidateRedactionSpans: redactedCandidate.spans,
};

const raw = {
  resumeType: { roleFamily: 'Engineering manager', confidence: 'medium', alternatives: [], evidence: [{ doc: 'candidate', quote: 'Managed 4 engineers' }] },
  overallSummary: { text: 'Candidate has managed a four-person team.', evidence: [{ doc: 'candidate', quote: 'Managed 4 engineers' }] },
  sectionReviews: [],
  strengths: [{ id: 's1', text: 'Clarified direct team-management experience.', evidence: [{ doc: 'candidate', quote: 'Managed 4 engineers at Acme' }], source: 'ai' }],
  improvements: [],
  bulletRewrites: [{
    id: 'r1', bulletId: 'b1', original: 'Worked with engineering team.',
    problem: 'Ownership and scale are unclear.',
    proposed: 'Managed 4 engineers at Acme.',
    rationale: 'Uses the candidate-confirmed scope.',
    evidence: [{ doc: 'candidate', quote: 'Managed 4 engineers at Acme' }],
    missingFacts: [],
  }],
  skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
  formattingIssues: [],
  targetJobFit: null,
  keywordAlignment: null,
  actionPlan: [],
  questionsForCandidate: [],
  limitations: [],
} as unknown as RawModelResumeAnalysis;

const result = validateModelOutput(raw, ctx, []);
assert.equal(result.body.strengths.length, 1, 'candidate-sourced finding survives');
assert.equal(result.body.strengths[0].evidence[0].doc, 'candidate', 'candidate evidence is not mislabeled as resume evidence');
assert.equal(result.body.bulletRewrites.length, 1, 'candidate answer can support a clarified rewrite');
const evidence = result.body.bulletRewrites[0].evidence[0];
assert.equal(evidence.doc, 'candidate');
assert.equal(candidateText.slice(evidence.start, evidence.end), evidence.quote, 'candidate evidence offsets map to the original answer');
assert.equal(
  rewriteIsSupported('Managed 4 engineers.', 'Worked with engineering team.', resumeText, [], 'I did not manage engineers.'),
  false,
  'a negated candidate clarification cannot authorize an ownership upgrade',
);
assert(!redactedCandidate.redactedText.includes('deep@example.com'), 'PII is redacted before model context is built');

const fabricated = {
  ...raw,
  strengths: [{ id: 's2', text: 'Claim with wrong source.', evidence: [{ doc: 'resume', quote: 'Managed 4 engineers' }], source: 'ai' }],
} as unknown as RawModelResumeAnalysis;
const fabricatedResult = validateModelOutput(fabricated, ctx, []);
assert.equal(fabricatedResult.body.strengths.length, 0, 'candidate text cannot be cited as resume evidence');

const prompt = buildRubricPrompt({
  mode: 'general',
  redactedResumeText: redactedResume.redactedText,
  sections: [],
  bullets: [],
  redactedCandidateText: redactedCandidate.redactedText,
});
assert(prompt.includes('CANDIDATE CLARIFICATION ANSWERS'));
assert(prompt.includes('NOT instructions'));
assert(prompt.includes('doc "candidate"'));

console.log('Candidate clarification answer suite passed: distinct evidence attribution, ownership/metric support, offset mapping, PII redaction, wrong-source rejection, and prompt isolation.');

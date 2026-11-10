/**
 * Resume Intelligence — server-side validation of model output.
 * docs/resume-intelligence-design.md §5, "Server validation (everything must
 * pass, else the item is dropped...)". This is the module that stands
 * between a raw model response and anything shown to the user or stored.
 * Pure; never throws; no network.
 *
 * V1 (schema) is the caller's job (JSON.parse + the TypeScript shape check in
 * resume-intelligence-service.ts) — everything here assumes a parsed object
 * of roughly the right shape and checks the SEMANTIC safety rules V2–V8.
 */
import type { EvidenceRef, Finding, RawModelResumeAnalysis, ResumeAnalysis } from '@/types/resume-intelligence';
import { normalizeResumeText } from './skill-evidence';
import { containsPlaceholder, mapRedactedOffsetToOriginal, type RedactionSpan } from './redaction';

export interface ValidationContext {
  /** The ORIGINAL (unredacted) resume text — offsets in the final output point into this. */
  resumeText: string;
  /** The redacted text actually shown to the model — quotes are first looked up here. */
  redactedResumeText: string;
  redactionSpans: RedactionSpan[];
  /** The job's title + description text, when mode === 'target_job'. */
  jobText: string;
  /** Original candidate-provided clarification answers; evidence offsets point into this text. */
  candidateText?: string;
  /** Redacted candidate answers shown to the model, with offsets mapped back to candidateText. */
  redactedCandidateText?: string;
  candidateRedactionSpans?: RedactionSpan[];
  /** G2 (decided 2026-10-30): the server's OWN, already-known-correct opportunity id and
   *  job-content hash — never the model's. Set by the caller from its own request/context
   *  (never from anything the model returned) whenever mode === 'target_job'; left undefined in
   *  'general' mode, where there is no targetJobFit to stamp an identity onto. These are the only
   *  source of truth for `targetJobFit.opportunityId`/`jobContentHash` in the returned body — the
   *  model's own echoed `raw.targetJobFit.opportunityId`/`jobContentHash` are never read. */
  opportunityId?: string;
  jobContentHash?: string;
}

export interface ValidationReport {
  droppedCounts: Record<string, number>;
  limitations: Array<{ code: string; message: string }>;
}

function normalizeForSearch(s: string): string {
  return normalizeResumeText(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
}

/** V2/V3: finds `quote` verbatim (normalized) in `haystackOriginal`, using `haystackSearchable`
 *  (redacted, what the model actually saw) to locate it, then maps the offset back to the
 *  original text via the redaction span table. Returns null if the quote can't be verified, or
 *  if it reconstructs a redacted placeholder (V3). */
function resolveQuoteInResume(quote: string, ctx: ValidationContext): EvidenceRef | null {
  if (!quote || quote.length > 300) return null;
  // A quote that is itself a placeholder token ("[EMAIL]" etc.) is rejected — not because it could
  // reconstruct a redacted value (structurally impossible: the model only ever saw the redacted
  // text, so it has no real value to reconstruct), but because showing "[EMAIL]" to the user as if
  // it were quoted evidence text would look like a broken artifact, not a real citation.
  if (containsPlaceholder(quote)) return null;
  const needle = normalizeForSearch(quote);
  const haystack = normalizeForSearch(ctx.redactedResumeText);
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  // Map the normalized-haystack index back to a real offset in the (unnormalized) redacted
  // text by re-scanning case/space-insensitively over the real redacted string.
  const realIdx = findRealOffset(ctx.redactedResumeText, quote, idx);
  if (realIdx === null) return null;
  const originalStart = mapRedactedOffsetToOriginal(ctx.redactionSpans, realIdx);
  const originalEnd = mapRedactedOffsetToOriginal(ctx.redactionSpans, realIdx + quote.length);
  return { doc: 'resume', quote, start: originalStart, end: originalEnd };
}

/** V4: the job-text counterpart of resolveQuoteInResume — no redaction involved. */
function resolveQuoteInJob(quote: string, jobText: string): EvidenceRef | null {
  if (!quote || quote.length > 300) return null;
  const needle = normalizeForSearch(quote);
  const haystack = normalizeForSearch(jobText);
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  const realIdx = findRealOffset(jobText, quote, idx);
  if (realIdx === null) return null;
  return { doc: 'job', quote, start: realIdx, end: realIdx + quote.length };
}

/** Candidate answers are a separate evidence document, never mislabeled as resume text. */
function resolveQuoteInCandidate(quote: string, ctx: ValidationContext): EvidenceRef | null {
  const original = ctx.candidateText ?? '';
  const redacted = ctx.redactedCandidateText ?? '';
  if (!quote || quote.length > 300 || !redacted || containsPlaceholder(quote)) return null;
  const needle = normalizeForSearch(quote);
  const haystack = normalizeForSearch(redacted);
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  const realIdx = findRealOffset(redacted, quote, idx);
  if (realIdx === null) return null;
  const start = mapRedactedOffsetToOriginal(ctx.candidateRedactionSpans ?? [], realIdx);
  const finish = mapRedactedOffsetToOriginal(ctx.candidateRedactionSpans ?? [], realIdx + quote.length);
  return { doc: 'candidate', quote, start, end: finish };
}

function resolveEvidence(evidence: EvidenceRef, ctx: ValidationContext): EvidenceRef | null {
  if (evidence.doc === 'job') return resolveQuoteInJob(evidence.quote, ctx.jobText);
  if (evidence.doc === 'candidate') return resolveQuoteInCandidate(evidence.quote, ctx);
  return resolveQuoteInResume(evidence.quote, ctx);
}

/** A best-effort walk to find the real (case/space-preserving) offset near a normalized-index
 *  hit — tries the exact substring first (cheap, usually correct), then a looser scan. */
function findRealOffset(haystack: string, quote: string, approxNormalizedIdx: number): number | null {
  const direct = haystack.indexOf(quote);
  if (direct !== -1) return direct;
  const lower = haystack.toLowerCase().indexOf(quote.toLowerCase());
  if (lower !== -1) return lower;
  // Fall back to treating approxNormalizedIdx as a rough anchor and searching a window around
  // it with whitespace collapsed — good enough since offsets here are advisory, not load-bearing
  // (quotes have already been proven to occur; this only locates WHERE).
  const windowStart = Math.max(0, approxNormalizedIdx - 50);
  const window = haystack.slice(windowStart, approxNormalizedIdx + quote.length + 50);
  const idx = window.toLowerCase().indexOf(quote.toLowerCase());
  return idx === -1 ? null : windowStart + idx;
}

// ── V5: "not demonstrated" wording — never asserts ABSENCE of ability ───────

const ABSENCE_ASSERTION_RE =
  /\byou\s+(don'?t|do\s+not|lack|aren'?t|are\s+not|have\s+no|never)\s+(have|show|demonstrate|possess|exhibit)?/i;

export function assertsAbsenceOfAbility(text: string): boolean {
  return ABSENCE_ASSERTION_RE.test(text);
}

// ── V6: rewrite anti-fabrication — every number/org/tool in a rewrite must trace to the
// resume (the original bullet or elsewhere in the resume text). Conservative, same pattern
// shape as src/lib/ai/anti-fabrication.ts, scoped per-bullet instead of per-kit. ─────────────

const METRIC_PATTERNS: RegExp[] = [
  /\b\d+(\.\d+)?%/g,
  /\$\d[\d,]*(\.\d+)?/g,
  /\b\d+(\.\d+)?x\b/gi,
  /\b\d+(?:\.\d+)?\s*[kmb]\b/gi,
  /\b\d{2,}\+?\s*(users?|customers?|clients?|requests?|servers?|engineers?|employees?|downloads?|installs?|transactions?|ms|milliseconds?|seconds?)\b/gi,
];
const YEAR_UNIT = /\b(years?|yrs?)\b/i;

function findUnsupportedMetric(text: string, resumeText: string): string | null {
  for (const pattern of METRIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const matched = match[0];
      const after = text.slice(match.index + matched.length, match.index + matched.length + 12);
      if (YEAR_UNIT.test(matched + after)) continue;
      if (resumeText.includes(matched)) continue;
      return matched;
    }
  }
  return null;
}

function findUnsupportedOrg(text: string, resumeText: string): string | null {
  const pattern = /\b(?:at|with|for)\s+((?:[A-Z][a-zA-Z0-9&.'-]+\s*){1,4})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const candidate = match[1].trim().replace(/[.,;:]$/, '');
    if (!candidate || resumeText.includes(candidate)) continue;
    const looksOrgShaped = /\s/.test(candidate) || /[A-Z].*[A-Z]|[&0-9]/.test(candidate.slice(1));
    if (looksOrgShaped) return candidate;
  }
  return null;
}

// A small stoplist of capitalised words that routinely start or fill a resume bullet without
// being a tool/org name — kept short and generic on purpose: this check is a safety screen, so
// erring toward flagging a real tool name is the right failure direction, not the reverse.
const COMMON_SENTENCE_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'they', 'he', 'she',
  'and', 'or', 'but', 'with', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'as', 'is', 'was',
  'senior', 'junior', 'lead', 'team', 'teams', 'project', 'projects', 'role', 'roles',
]);

/** True iff `proposed` introduces no number, organisation name, or tool/skill name that isn't
 *  already traceable to `original`, the wider resume text, or the candidate's declared skills. */
const LEADERSHIP_OWNERSHIP_VERBS = /\b(?:led|lead|leading|leads|managed|manages|managing|supervised|supervises|supervising|directed|directs|directing|headed|heads|heading|spearheaded|owned|owns|owning|oversaw|oversees|mentored|mentors|coached|coaches)\b/gi;

function collectOwnershipVerbs(text: string): string[] {
  const pattern = new RegExp(LEADERSHIP_OWNERSHIP_VERBS.source, 'gi');
  const verbs: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) verbs.push(match[0].toLowerCase());
  return verbs;
}

function hasUnsupportedOwnershipClaim(proposed: string, original: string): boolean {
  const originalVerbs = new Set(collectOwnershipVerbs(original));
  return collectOwnershipVerbs(proposed).some((verb) => !originalVerbs.has(verb));
}

export function rewriteIsSupported(proposed: string, original: string, resumeText: string, declaredSkills: string[], candidateText = ''): boolean {
  // Do not upgrade collaboration/support into leadership or ownership. The exact
  // ownership verb must already appear in this original bullet.
  if (hasUnsupportedOwnershipClaim(proposed, `${original}\n${candidateText}`)) return false;
  const context = `${original}\n${resumeText}\n${candidateText}`;
  // Catch unsupported standalone numbers too (e.g. "managed 12 people"), not
  // only numbers followed by a unit or percentage.
  const contextNumbers = new Set(context.match(/\b\d+(?:[.,]\d+)?\b/g) ?? []);
  const proposedNumbers = proposed.match(/\b\d+(?:[.,]\d+)?\b/g) ?? [];
  if (proposedNumbers.some((number) => !contextNumbers.has(number))) return false;
  if (findUnsupportedMetric(proposed, context)) return false;
  if (findUnsupportedOrg(proposed, context)) return false;
  // Any capitalised, tool/skill-shaped token must already be traceable — on the declared skills
  // list or present somewhere in the original bullet / resume text. The leading word of the
  // sentence (almost always the rewrite's own verb, e.g. "Deployed") and a short list of common
  // sentence-filler words are exempt; everything else capitalised is treated as a potential tool
  // or product name and must be supported. False positives here only cost a safe rejection of a
  // legitimate rewrite (it falls back to the deterministic result) — never a wrong claim shown
  // to the user, so this stays deliberately strict.
  const leadingWord = proposed.trim().match(/^[A-Za-z]+/)?.[0];
  const toolLike = proposed.match(/\b[A-Z][a-zA-Z0-9.+#]{1,}\b/g) ?? [];
  for (const tok of toolLike) {
    if (tok === leadingWord) continue;
    if (COMMON_SENTENCE_WORDS.has(tok.toLowerCase())) continue;
    if (context.includes(tok)) continue;
    if (declaredSkills.some((s) => s.toLowerCase() === tok.toLowerCase())) continue;
    return false;
  }
  return true;
}

// ── V7: no score/likelihood language leaking out of this feature ───────────

// The second group names the hiring-outcome word a leak is ABOUT. It originally covered only
// "hire" (not "hired"), so a natural passive-voice leak — "an 85% chance of being hired" — slipped
// through undetected (found 2026-10-30 during the §9 offline evaluation; SCORE_LEAK_RE.test on
// that exact phrase returned false). Added "hired" and "interviewed", the two passive-voice forms
// of the same hiring-process outcomes already covered active-voice ("hire"/"interview"). Kept
// narrow deliberately: "offered"/"succeeded" etc. were NOT added, since broadening the outcome-word
// list further only matters when a score/likelihood word from the FIRST group also appears in the
// same text (the regex requires both), so the added risk of flagging legitimate resume language is
// small, but is still worth bounding to just the forms a real leak was found to use.
const SCORE_LEAK_RE = /\b(\d{1,3}\s*%|\bscore\b|\blikelihood\b|\bchance\b|\bprobability\b)\b.*\b(hire|hired|hiring|interview|interviewed|offer|success)\b/i;

export function leaksHiringScore(text: string): boolean {
  return SCORE_LEAK_RE.test(text);
}

// ── Main pass ────────────────────────────────────────────────────────────

function dropCounter(report: ValidationReport, key: string) {
  report.droppedCounts[key] = (report.droppedCounts[key] ?? 0) + 1;
}

function validateFinding(f: Finding, ctx: ValidationContext, report: ValidationReport, dropKey: string): Finding | null {
  if (!f.text || f.text.length > 2000) { dropCounter(report, dropKey); return null; }
  if (assertsAbsenceOfAbility(f.text)) { dropCounter(report, `${dropKey}_absence_wording`); return null; }
  if (leaksHiringScore(f.text)) { dropCounter(report, `${dropKey}_score_leak`); return null; }
  const resolvedEvidence: EvidenceRef[] = [];
  for (const e of f.evidence ?? []) {
    const resolved = resolveEvidence(e, ctx);
    if (resolved) resolvedEvidence.push({ ...resolved, sectionId: e.sectionId, bulletId: e.bulletId });
  }
  // A material finding with NO evidence it submitted (vs a rules-sourced one, which is exempt —
  // it's already fact-checked by construction) is dropped: an AI claim must point at something real.
  if (f.source === 'ai' && (f.evidence?.length ?? 0) > 0 && resolvedEvidence.length === 0) {
    dropCounter(report, `${dropKey}_unverifiable_evidence`);
    return null;
  }
  return { ...f, evidence: resolvedEvidence };
}

/**
 * Validates a raw, schema-shaped model response against the resume (and job, in target_job
 * mode), dropping anything that fails V2–V8, and returns the surviving, evidence-resolved
 * ResumeAnalysis body (everything except the envelope fields the caller fills in:
 * analysisVersion/mode/analysisStatus/source). Declared skills are used only by V6
 * (rewrite anti-fabrication) to recognise tool names the candidate has legitimately listed.
 */
export function validateModelOutput(
  raw: RawModelResumeAnalysis,
  ctx: ValidationContext,
  declaredSkills: string[]
): { body: Omit<ResumeAnalysis, 'analysisVersion' | 'mode' | 'analysisStatus' | 'source'>; report: ValidationReport } {
  const report: ValidationReport = { droppedCounts: {}, limitations: [] };

  const resumeTypeEvidence = (raw.resumeType?.evidence ?? [])
    .map((e) => resolveEvidence(e, ctx))
    .filter((e): e is EvidenceRef => e !== null);

  const overallSummaryEvidence = (raw.overallSummary?.evidence ?? [])
    .map((e) => resolveQuoteInResume(e.quote, ctx))
    .filter((e): e is EvidenceRef => e !== null);
  const overallSummaryOk =
    typeof raw.overallSummary?.text === 'string' &&
    !assertsAbsenceOfAbility(raw.overallSummary.text) &&
    !leaksHiringScore(raw.overallSummary.text);

  const sectionReviews = (raw.sectionReviews ?? []).map((sr) => ({
    sectionId: sr.sectionId,
    heading: sr.heading,
    criteria: (sr.criteria ?? []).map((c) => ({
      ...c,
      evidence: (c.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null),
    })),
    findings: (sr.findings ?? []).map((f) => validateFinding(f, ctx, report, 'section_finding')).filter((f): f is Finding => f !== null),
    recommendations: (sr.recommendations ?? []).map((f) => validateFinding(f, ctx, report, 'section_recommendation')).filter((f): f is Finding => f !== null),
  }));

  const strengths = (raw.strengths ?? []).map((f) => validateFinding(f, ctx, report, 'strength')).filter((f): f is Finding => f !== null);
  const improvements = (raw.improvements ?? [])
    .map((f) => {
      const v = validateFinding(f, ctx, report, 'improvement');
      return v ? { ...v, severity: f.severity, priority: f.priority } : null;
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const bulletRewrites = (raw.bulletRewrites ?? [])
    .map((r) => {
      if (!r.proposed || !r.original) { dropCounter(report, 'rewrite_missing_text'); return null; }
      if (assertsAbsenceOfAbility(r.proposed) || leaksHiringScore(r.proposed)) { dropCounter(report, 'rewrite_wording'); return null; }
      if (!rewriteIsSupported(r.proposed, r.original, ctx.resumeText, declaredSkills, ctx.candidateText ?? '')) {
        dropCounter(report, 'rewrite_unsupported_fact');
        return null;
      }
      const evidence = (r.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null);
      return { ...r, evidence, status: 'suggested' as const };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const skillsEvidence = {
    demonstrated: (raw.skillsEvidence?.demonstrated ?? []).map((s) => ({
      skill: s.skill,
      evidence: (s.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null),
    })),
    weaklySupported: (raw.skillsEvidence?.weaklySupported ?? []).map((s) => ({
      skill: s.skill,
      evidence: (s.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null),
    })),
    notEvidenced: (raw.skillsEvidence?.notEvidenced ?? []).map((s) => ({ skill: s.skill, note: 'not demonstrated in this resume' as const })),
  };

  const formattingIssues = (raw.formattingIssues ?? []).map((f) => validateFinding(f, ctx, report, 'formatting')).filter((f): f is Finding => f !== null);

  // V4: target_job requirements — jobEvidence must occur in the job text; a requirement the job
  // doesn't actually state is dropped (prevents imagined requirements).
  let targetJobFit: ResumeAnalysis['targetJobFit'] = null;
  if (raw.targetJobFit) {
    const requirements = (raw.targetJobFit.requirements ?? [])
      .map((r) => {
        const jobEvidence = (r.jobEvidence ?? []).map((e) => resolveQuoteInJob(e.quote, ctx.jobText)).filter((e): e is EvidenceRef => e !== null);
        if (jobEvidence.length === 0) { dropCounter(report, 'requirement_unverifiable_job_evidence'); return null; }
        const resumeEvidence = (r.resumeEvidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null);
        return { ...r, jobEvidence, resumeEvidence };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const bulletEditIds = new Set(bulletRewrites.map((r) => r.id));
    targetJobFit = {
      // G2 (decided 2026-10-30): server-authoritative, never the model's echoed values —
      // raw.targetJobFit.opportunityId/jobContentHash are intentionally never read here. A
      // caller that omits ctx.opportunityId/jobContentHash in target_job mode is a caller bug,
      // not something this function should paper over with the model's unverified claim.
      opportunityId: ctx.opportunityId ?? '',
      jobContentHash: ctx.jobContentHash ?? '',
      requirements,
      prioritize: (raw.targetJobFit.prioritize ?? []).map((f) => validateFinding(f, ctx, report, 'prioritize')).filter((f): f is Finding => f !== null),
      summaryEdit: raw.targetJobFit.summaryEdit && rewriteIsSupported(raw.targetJobFit.summaryEdit.proposed, raw.targetJobFit.summaryEdit.original, ctx.resumeText, declaredSkills, ctx.candidateText ?? '')
        ? { ...raw.targetJobFit.summaryEdit, evidence: (raw.targetJobFit.summaryEdit.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null) }
        : undefined,
      skillsEdit: raw.targetJobFit.skillsEdit && rewriteIsSupported(raw.targetJobFit.skillsEdit.proposed, raw.targetJobFit.skillsEdit.original, ctx.resumeText, declaredSkills, ctx.candidateText ?? '')
        ? { ...raw.targetJobFit.skillsEdit, evidence: (raw.targetJobFit.skillsEdit.evidence ?? []).map((e) => resolveQuoteInResume(e.quote, ctx)).filter((e): e is EvidenceRef => e !== null) }
        : undefined,
      // V8: dangling refs removed.
      bulletEdits: (raw.targetJobFit.bulletEdits ?? []).filter((id) => bulletEditIds.has(id)),
      interviewPrep: (raw.targetJobFit.interviewPrep ?? []).map((f) => validateFinding(f, ctx, report, 'interview_prep')).filter((f): f is Finding => f !== null),
    };
  }

  const keywordAlignment = raw.keywordAlignment
    ? {
        relevantPresent: raw.keywordAlignment.relevantPresent ?? [],
        missingButEvidenced: raw.keywordAlignment.missingButEvidenced ?? [],
        notDemonstrated: raw.keywordAlignment.notDemonstrated ?? [],
      }
    : null;

  // V8: cross-references — actionPlan.refs must point at ids that actually survived validation.
  const survivingIds = new Set<string>([
    ...strengths.map((f) => f.id),
    ...improvements.map((f) => f.id),
    ...formattingIssues.map((f) => f.id),
    ...bulletRewrites.map((r) => r.id),
    ...sectionReviews.flatMap((sr) => [...sr.findings.map((f) => f.id), ...sr.recommendations.map((f) => f.id)]),
    ...(targetJobFit?.prioritize.map((f) => f.id) ?? []),
    ...(targetJobFit?.interviewPrep.map((f) => f.id) ?? []),
  ]);
  const actionPlan = (raw.actionPlan ?? []).map((a) => ({ step: a.step, refs: (a.refs ?? []).filter((r) => survivingIds.has(r)) }));
  const questionsForCandidate = (raw.questionsForCandidate ?? []).map((q) => ({ ...q, refs: (q.refs ?? []).filter((r) => survivingIds.has(r)) }));

  const totalDropped = Object.values(report.droppedCounts).reduce((a, b) => a + b, 0);
  if (totalDropped > 0) {
    report.limitations.push({ code: 'items_filtered', message: `${totalDropped} item(s) from the model were removed because they could not be verified against your resume.` });
  }

  return {
    body: {
      resumeType: {
        roleFamily: raw.resumeType?.roleFamily ?? 'unknown',
        confidence: raw.resumeType?.confidence ?? 'low',
        alternatives: raw.resumeType?.alternatives ?? [],
        evidence: resumeTypeEvidence,
      },
      overallSummary: overallSummaryOk
        ? { text: raw.overallSummary.text, evidence: overallSummaryEvidence }
        : { text: '', evidence: [] },
      sectionReviews,
      strengths,
      improvements,
      bulletRewrites,
      skillsEvidence,
      formattingIssues,
      targetJobFit,
      keywordAlignment,
      actionPlan,
      questionsForCandidate,
      limitations: report.limitations,
    },
    report,
  };
}

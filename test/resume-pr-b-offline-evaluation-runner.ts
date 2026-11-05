/**
 * Resume Intelligence (PR B) — §9 OFFLINE evaluation run.
 * docs/resume-intelligence-design.md §9, "Offline (no cost, in CI)".
 * Authorized 2026-10-30 (pasted instruction 0d7d). STRICTLY OFFLINE:
 *   - no OpenAI/network calls (nothing here imports resume-intelligence-service.ts's callModel,
 *     getOpenAiClient, or spend-ledger — only the pure modules rubric.ts and evidence-validation.ts),
 *   - no database access (no SupabaseClient is constructed or imported),
 *   - output goes only to stdout; the invoking session writes it to a local docs/ file if asked.
 *
 * Run: npx tsx test/resume-pr-b-offline-evaluation-runner.ts
 *
 * Two parts, matching the instruction's scope:
 *   Part A — the 28-resume dataset (test/fixtures/resume-pr-b-eval-set.ts) vs hand labels,
 *            exercising the deterministic layer (rubric.ts).
 *   Part B — evidence validation and rejection behavior (V2/V3/V5/V6/V7/V8), the G1 status-
 *            downgrade decision, and the G2 server-authoritative-identifier decision, via
 *            hand-constructed "model-shaped" JSON against a subset of the 28 resumes.
 *
 * This is a NEW, separate harness from the existing per-module suites (resume-intelligence-
 * rubric-suite.ts, resume-intelligence-validation-suite.ts, resume-intelligence-persistence-
 * suite.ts) — it is the §9-specific evaluation run against the labelled dataset, not a
 * replacement for those suites, which keep testing the modules' internal logic directly.
 */
import { runDeterministicAnalysis, buildSectionMap } from '../src/lib/resume/rubric';
import { redactForModel } from '../src/lib/resume/redaction';
import { validateModelOutput, type ValidationContext } from '../src/lib/resume/evidence-validation';
import type { RawModelResumeAnalysis } from '../src/types/resume-intelligence';
import { RESUME_PR_B_EVAL_SET, type EvalCase } from './fixtures/resume-pr-b-eval-set';
import { ADVERSARIAL_CASES, BLANK_MALFORMED_CASES, JOB_DESCRIPTIONS } from './fixtures/resume-pr-b-eval-set-extended';

// ── bookkeeping ──────────────────────────────────────────────────────────

interface CaseResult {
  id: string;
  category: string;
  checks: { name: string; pass: boolean; detail?: string }[];
}
const results: CaseResult[] = [];

function evalCheck(result: CaseResult, name: string, pass: boolean, detail?: string) {
  result.checks.push({ name, pass, detail });
}

function arrEq(a: string[], b: string[]): boolean {
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.length === bs.length && as.every((v, i) => v === bs[i]);
}

// ── Part A: deterministic layer vs hand labels ──────────────────────────

function runPartA() {
  console.log('='.repeat(78));
  console.log('PART A — deterministic layer (rubric.ts) vs the 28-resume hand-labelled set');
  console.log('='.repeat(78));

  for (const c of RESUME_PR_B_EVAL_SET) {
    const result: CaseResult = { id: c.id, category: c.category, checks: [] };
    results.push(result);
    const det = runDeterministicAnalysis(c.resumeText, c.declaredSkills);
    const sectionIds = det.sections.map((s) => s.id);

    evalCheck(result, 'section ids match', arrEq(sectionIds, c.labels.expectedSectionIds), `got [${sectionIds.join(',')}], expected [${c.labels.expectedSectionIds.join(',')}]`);

    const hasHeader = sectionIds.includes('header');
    evalCheck(result, 'header-section presence matches', hasHeader === c.labels.expectHeaderSection, `got ${hasHeader}, expected ${c.labels.expectHeaderSection}`);

    evalCheck(result, 'bullet count >= minimum', det.bullets.length >= c.labels.minBullets, `got ${det.bullets.length}, expected >= ${c.labels.minBullets}`);

    const chronCodes = det.chronologyFindings.map((f) => f.code);
    const chronOk = c.labels.expectedChronologyCodes.every((code) => chronCodes.includes(code)) &&
      chronCodes.every((code) => c.labels.expectedChronologyCodes.includes(code));
    evalCheck(result, 'chronology findings match', chronOk, `got [${chronCodes.join(',')}], expected [${c.labels.expectedChronologyCodes.join(',')}]`);

    evalCheck(result, 'duplicate-pair count >= minimum', det.duplicates.length >= c.labels.minDuplicatePairs, `got ${det.duplicates.length}, expected >= ${c.labels.minDuplicatePairs}`);

    for (const skill of c.labels.skillsDemonstrated) {
      const ev = det.skillEvidence.find((s) => s.skill === skill);
      evalCheck(result, `"${skill}" demonstrated`, ev?.inExperienceOrProjects === true, ev ? JSON.stringify(ev) : 'not in skillEvidence output');
    }
    for (const skill of c.labels.skillsListedOnly) {
      const ev = det.skillEvidence.find((s) => s.skill === skill);
      evalCheck(result, `"${skill}" listed-only`, ev?.inSkillsOnly === true, ev ? JSON.stringify(ev) : 'not in skillEvidence output');
    }
    for (const skill of c.labels.skillsNotFound) {
      const ev = det.skillEvidence.find((s) => s.skill === skill);
      evalCheck(result, `"${skill}" not found`, ev?.notFound === true, ev ? JSON.stringify(ev) : 'not in skillEvidence output');
    }
  }
}

// ── Part B: validator / G1 / G2 property tests ──────────────────────────

/** Local, test-only mirror of resume-intelligence-service.ts's private aiBodyIsEmpty() predicate
 *  (not exported — this harness stays strictly a consumer of the two pure modules, per the
 *  instruction's "evaluation-only" scope; no production source file is touched by this step).
 *  Field list kept identical to the production predicate (re-verified by reading
 *  src/lib/ai/resume-intelligence-service.ts's aiBodyIsEmpty on 2026-10-30 before writing this). */
function aiBodyIsEmptyMirror(body: ReturnType<typeof validateModelOutput>['body']): boolean {
  return (
    body.strengths.length === 0 &&
    body.improvements.length === 0 &&
    body.bulletRewrites.length === 0 &&
    body.formattingIssues.length === 0 &&
    body.actionPlan.length === 0 &&
    body.questionsForCandidate.length === 0 &&
    body.keywordAlignment === null &&
    body.overallSummary.text === '' &&
    body.skillsEvidence.demonstrated.length === 0 &&
    body.skillsEvidence.weaklySupported.length === 0 &&
    body.skillsEvidence.notEvidenced.length === 0 &&
    body.sectionReviews.every((sr) => sr.criteria.length === 0 && sr.findings.length === 0 && sr.recommendations.length === 0) &&
    (body.targetJobFit === null || (
      body.targetJobFit.requirements.length === 0 &&
      body.targetJobFit.prioritize.length === 0 &&
      body.targetJobFit.interviewPrep.length === 0 &&
      body.targetJobFit.summaryEdit === undefined &&
      body.targetJobFit.skillsEdit === undefined
    ))
  );
}

function ctxFor(c: { resumeText: string }, jobText = '', opportunityId?: string, jobContentHash?: string): ValidationContext {
  const { redactedText, spans } = redactForModel(c.resumeText, null);
  return { resumeText: c.resumeText, redactedResumeText: redactedText, redactionSpans: spans, jobText, opportunityId, jobContentHash };
}

function minimalRaw(overrides: Partial<RawModelResumeAnalysis> = {}): RawModelResumeAnalysis {
  return {
    resumeType: { roleFamily: 'Unknown', confidence: 'low', alternatives: [], evidence: [] },
    overallSummary: { text: '', evidence: [] },
    sectionReviews: [],
    strengths: [],
    improvements: [],
    bulletRewrites: [],
    skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
    formattingIssues: [],
    targetJobFit: null,
    keywordAlignment: null,
    actionPlan: [],
    questionsForCandidate: [],
    limitations: [],
    ...overrides,
  };
}

function runPartB() {
  console.log('\n' + '='.repeat(78));
  console.log('PART B — evidence validation, G1 status downgrade, G2 server-authoritative ids');
  console.log('='.repeat(78));
  const r: CaseResult = { id: 'partB-validator-property-tests', category: 'validator', checks: [] };
  results.push(r);

  const tech01 = RESUME_PR_B_EVAL_SET.find((c) => c.id === 'tech-01-backend')!;
  const ctx = ctxFor(tech01);

  // 1. A clean, well-grounded model response survives validation and G1 reports 'available'.
  {
    const raw = minimalRaw({
      overallSummary: { text: 'Designed a Go-based event pipeline processing 2M events/day.', evidence: [{ doc: 'resume', quote: 'Designed a Go-based event pipeline processing 2M events/day.', start: 0, end: 0 }] },
      strengths: [{ id: 's1', text: 'Reduced database load by 40% by introducing a Redis caching layer.', evidence: [{ doc: 'resume', quote: 'Reduced database load by 40% by introducing a Redis caching layer.', start: 0, end: 0 }], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V2: grounded evidence survives (clean case strengths retained)', body.strengths.length === 1, JSON.stringify(body.strengths));
    evalCheck(r, 'G1: a clean response is NOT empty (would report success)', !aiBodyIsEmptyMirror(body), 'aiBodyIsEmptyMirror returned true for a grounded response');
  }

  // 2. V2 — an unverifiable quote (never appears in the resume) is dropped.
  {
    const raw = minimalRaw({
      strengths: [{ id: 's1', text: 'Led a 50-person reorg that doubled revenue.', evidence: [{ doc: 'resume', quote: 'Led a 50-person reorg that doubled revenue.', start: 0, end: 0 }], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V2: fabricated/unverifiable quote is dropped', body.strengths.length === 0, JSON.stringify(body.strengths));
  }

  // 3. V5 — absence-of-ability wording is rejected outright, even with a verifiable quote.
  {
    const raw = minimalRaw({
      strengths: [{ id: 's1', text: 'You do not have any leadership experience.', evidence: [{ doc: 'resume', quote: 'Led a team of 6 to migrate a monolith to Go services handling 40k requests/sec.', start: 0, end: 0 }], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V5: absence-of-ability wording is rejected', body.strengths.length === 0, JSON.stringify(body.strengths));
  }

  // 4. V6 — a rewrite introducing an unsupported metric is rejected.
  {
    const raw = minimalRaw({
      bulletRewrites: [{ id: 'r1', bulletId: 'b1', original: 'Designed a Go-based event pipeline processing 2M events/day.', problem: 'vague', proposed: 'Designed a Go-based event pipeline processing 2M events/day, cutting cost by 75%.', rationale: 'adds impact', evidence: [], missingFacts: [] }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V6: rewrite with an unsupported fabricated metric is rejected', body.bulletRewrites.length === 0, JSON.stringify(body.bulletRewrites));
  }

  // 5. V7 — hiring-score leak language is rejected.
  {
    const raw = minimalRaw({
      strengths: [{ id: 's1', text: 'This resume indicates a high likelihood of interview success.', evidence: [], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V7: hiring-score leak is rejected', body.strengths.length === 0, JSON.stringify(body.strengths));
  }

  // 6. V8 — a dangling actionPlan ref (pointing at an id that never survived) is stripped.
  {
    const raw = minimalRaw({
      actionPlan: [{ step: 'Fix your summary', refs: ['does-not-exist'] }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V8: dangling actionPlan ref is stripped', body.actionPlan[0]?.refs.length === 0, JSON.stringify(body.actionPlan));
  }

  // 7. G1 — a response where every AI-sourced item is dropped reports empty (service downgrades
  //    this to analysisStatus: 'unavailable'; this harness verifies the predicate the downgrade
  //    decision is built on, since the predicate itself is not exported for direct import).
  {
    const raw = minimalRaw({
      strengths: [{ id: 's1', text: 'Invented claim with no basis.', evidence: [{ doc: 'resume', quote: 'This text does not appear anywhere in the resume.', start: 0, end: 0 }], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'G1: a fully-unverifiable response reports empty (service would report unavailable)', aiBodyIsEmptyMirror(body), 'aiBodyIsEmptyMirror returned false for an all-dropped response');
  }

  // 8. G2 — target_job mode: the model's own hallucinated identifiers are never used; the
  //    server-supplied context values always win, even when the model's values look plausible.
  {
    const ctxTargetJob = ctxFor(tech01, 'Seeking a backend engineer with Go experience.', 'server-real-opp-id', 'server-real-hash');
    const raw = minimalRaw({
      targetJobFit: {
        opportunityId: 'model-hallucinated-opp-id',
        jobContentHash: 'model-hallucinated-hash',
        requirements: [{ requirement: 'Go experience', jobEvidence: [{ doc: 'job', quote: 'Go experience', start: 0, end: 0 }], status: 'supported', resumeEvidence: [] }],
        prioritize: [], bulletEdits: [], interviewPrep: [],
      },
    });
    const { body } = validateModelOutput(raw, ctxTargetJob, tech01.declaredSkills);
    evalCheck(r, "G2: server's opportunityId wins over the model's", body.targetJobFit?.opportunityId === 'server-real-opp-id', JSON.stringify(body.targetJobFit));
    evalCheck(r, "G2: server's jobContentHash wins over the model's", body.targetJobFit?.jobContentHash === 'server-real-hash', JSON.stringify(body.targetJobFit));
    evalCheck(r, "G2: requirement content itself is unaffected by the identifier swap", body.targetJobFit?.requirements.length === 1, JSON.stringify(body.targetJobFit));
  }

  // 9. G2 edge case — missing server-side identifiers never fall back to the model's values.
  {
    const ctxTargetJobNoIds = ctxFor(tech01, 'Seeking a backend engineer.');
    const raw = minimalRaw({
      targetJobFit: { opportunityId: 'model-id', jobContentHash: 'model-hash', requirements: [], prioritize: [], bulletEdits: [], interviewPrep: [] },
    });
    const { body } = validateModelOutput(raw, ctxTargetJobNoIds, tech01.declaredSkills);
    evalCheck(r, 'G2: missing server opportunityId never falls back to the model value', body.targetJobFit?.opportunityId === '', JSON.stringify(body.targetJobFit));
    evalCheck(r, 'G2: missing server jobContentHash never falls back to the model value', body.targetJobFit?.jobContentHash === '', JSON.stringify(body.targetJobFit));
  }

  // 10. V3 — a quote that is itself a redaction placeholder is rejected (can't reconstruct PII).
  {
    const raw = minimalRaw({
      strengths: [{ id: 's1', text: 'Contact info present.', evidence: [{ doc: 'resume', quote: '[EMAIL]', start: 0, end: 0 }], source: 'ai' }],
    });
    const { body } = validateModelOutput(raw, ctx, tech01.declaredSkills);
    evalCheck(r, 'V3: a placeholder-shaped quote is rejected, not resolved as evidence', body.strengths.length === 0, JSON.stringify(body.strengths));
  }

  // 11. Edge case — the headerless G6 resume still produces a usable section map input to
  //     validation (no section-id mismatch causes a crash when the model cites the 'body' section).
  {
    const headerless = RESUME_PR_B_EVAL_SET.find((c) => c.id === 'incomplete-03-headerless-g6')!;
    const sections = buildSectionMap(headerless.resumeText);
    const hctx = ctxFor(headerless);
    const raw = minimalRaw({
      sectionReviews: [{ sectionId: 'body', heading: 'Resume', criteria: [{ id: 'R1', rating: 'meets', evidence: [{ doc: 'resume', quote: 'Jane Doe, backend engineer', start: 0, end: 0 }] }], findings: [], recommendations: [] }],
    });
    const { body } = validateModelOutput(raw, hctx, headerless.declaredSkills);
    evalCheck(r, 'Edge case: headerless resume has exactly one section ("body")', sections.length === 1 && sections[0].id === 'body', JSON.stringify(sections));
    evalCheck(r, 'Edge case: R1 evidence against the body section resolves normally (no crash, no special-case failure)', body.sectionReviews[0]?.criteria[0]?.evidence.length === 1, JSON.stringify(body.sectionReviews));
  }
}

// ── Part C: adversarial cases + blank/malformed input ───────────────────

function runPartC() {
  console.log('\n' + '='.repeat(78));
  console.log('PART C — adversarial cases + blank/malformed input');
  console.log('='.repeat(78));

  for (const a of ADVERSARIAL_CASES) {
    const result: CaseResult = { id: a.id, category: 'adversarial', checks: [] };
    results.push(result);

    // (a) the deterministic layer must never crash on adversarial/non-English input.
    let det: ReturnType<typeof runDeterministicAnalysis> | null = null;
    let detThrew = false;
    try { det = runDeterministicAnalysis(a.resumeText, a.declaredSkills); } catch { detThrew = true; }
    evalCheck(result, 'deterministic layer does not throw', !detThrew);

    if (a.kind === 'non_english') {
      // Known, documented limitation (design doc §4: "language detection is a hint only"), not a
      // defect: the heading lexicon is English-only, so a non-English resume collapses to one
      // 'body' section — same honest fallback as the headerless case, not silently mangled.
      const ids = det?.sections.map((s) => s.id) ?? [];
      evalCheck(result, 'non-English input: no crash, collapses to one "body" section (documented limitation, not a defect)', ids.length === 1 && ids[0] === 'body', JSON.stringify(ids));
      continue;
    }

    const ctx = ctxFor(a);
    const raw = minimalRaw(a.compromisedModelResponse);
    const { body } = validateModelOutput(raw, ctx, a.declaredSkills);

    if (a.kind === 'hidden_text_instruction') {
      // GENUINE FINDING, not a fixture error (see the fixture's own comment): a claim that merely
      // echoes hidden-but-literally-present text verbatim PASSES V2, since V2 only verifies
      // verbatim occurrence, not whether the quoted text is legitimate resume content vs an
      // injected instruction. This check documents that confirmed behavior rather than asserting
      // the wrong expectation that V2 would reject it — the real defense here is the system
      // prompt's data/instruction framing, a model-level (live-eval-only) question.
      evalCheck(result, 'CONFIRMED FINDING: a claim quoting hidden-but-literal injected text passes V2 (verbatim-only check) — real defense is the system prompt, not provable offline', body.strengths.length === 1 && body.strengths[0].evidence.length === 1, JSON.stringify(body.strengths));
      continue;
    }

    // (b) even a model response that "fell for" the adversarial input is rejected by the server
    // validator — defense-in-depth that holds regardless of what happens inside the model.
    if (a.expectedRejection === 'strengths_empty') {
      evalCheck(result, 'compromised strength claim is rejected by the server validator', body.strengths.length === 0, JSON.stringify(body.strengths));
    } else if (a.expectedRejection === 'bulletRewrites_empty') {
      evalCheck(result, 'compromised rewrite (invented metric) is rejected by V6', body.bulletRewrites.length === 0, JSON.stringify(body.bulletRewrites));
    } else {
      evalCheck(result, 'compromised overallSummary (score leak) is rejected', body.overallSummary.text === '', JSON.stringify(body.overallSummary));
    }
  }

  for (const b of BLANK_MALFORMED_CASES) {
    const result: CaseResult = { id: b.id, category: 'blank-malformed', checks: [] };
    results.push(result);
    let det: ReturnType<typeof runDeterministicAnalysis> | null = null;
    let threw = false;
    try { det = runDeterministicAnalysis(b.resumeText, b.declaredSkills); } catch { threw = true; }
    evalCheck(result, 'deterministic layer does not throw', !threw);
    // Mirrors the actual service-level insufficient-input gate (resume-intelligence-service.ts
    // step 2): `det.charCount === 0 || resumeText.trim().length < 1` — checked here against the
    // pure function's own output, not by importing the service (this harness stays offline/pure).
    const wouldBeInsufficient = (det?.charCount ?? 0) === 0 || b.resumeText.trim().length < 1;
    evalCheck(result, 'insufficient-input classification matches expectation', wouldBeInsufficient === b.expectInsufficientInput, `got ${wouldBeInsufficient}, expected ${b.expectInsufficientInput}`);
  }
}

// ── Part D: 8 synthetic job descriptions — target-mode V4 (job-evidence verification) ──

function runPartD() {
  console.log('\n' + '='.repeat(78));
  console.log('PART D — 8 synthetic job descriptions, target-mode V4 job-evidence verification');
  console.log('='.repeat(78));

  for (const job of JOB_DESCRIPTIONS) {
    const result: CaseResult = { id: job.id, category: 'job-description', checks: [] };
    results.push(result);
    const resume = RESUME_PR_B_EVAL_SET.find((c) => c.id === job.pairsWithResumeId);
    if (!resume) { evalCheck(result, `paired resume "${job.pairsWithResumeId}" exists in the dataset`, false); continue; }

    const ctx = ctxFor(resume, job.jobText, `opp-${job.id}`, `hash-${job.id}`);
    const raw = minimalRaw({
      targetJobFit: {
        opportunityId: 'model-should-be-ignored',
        jobContentHash: 'model-should-be-ignored',
        requirements: [
          // V4 true positive: this requirement's jobEvidence quote genuinely occurs in the job text.
          { requirement: 'real requirement', jobEvidence: [{ doc: 'job', quote: job.realRequirementQuote, start: 0, end: 0 }], status: 'supported', resumeEvidence: [] },
          // V4 true negative: this requirement's jobEvidence quote does NOT occur in the job text
          // (the model imagined a requirement the job never stated) — must be dropped.
          { requirement: 'fabricated requirement', jobEvidence: [{ doc: 'job', quote: job.fabricatedRequirementQuote, start: 0, end: 0 }], status: 'supported', resumeEvidence: [] },
        ],
        prioritize: [], bulletEdits: [], interviewPrep: [],
      },
    });
    const { body } = validateModelOutput(raw, ctx, resume.declaredSkills);
    evalCheck(result, 'a requirement with real job evidence survives', body.targetJobFit?.requirements.some((r) => r.requirement === 'real requirement') === true, JSON.stringify(body.targetJobFit?.requirements));
    evalCheck(result, 'a requirement with fabricated/unverifiable job evidence (V4) is dropped', body.targetJobFit?.requirements.some((r) => r.requirement === 'fabricated requirement') === false, JSON.stringify(body.targetJobFit?.requirements));
    evalCheck(result, "G2 still holds in target mode: server's own ids win, never the model's", body.targetJobFit?.opportunityId === `opp-${job.id}` && body.targetJobFit?.jobContentHash === `hash-${job.id}`, JSON.stringify(body.targetJobFit));
  }
}

// ── report ───────────────────────────────────────────────────────────────

function report() {
  console.log('\n' + '='.repeat(78));
  console.log('PER-CASE RESULTS');
  console.log('='.repeat(78));
  let totalPass = 0;
  let totalFail = 0;
  const failuresByCategory = new Map<string, number>();
  const casesByCategory = new Map<string, number>();

  for (const res of results) {
    casesByCategory.set(res.category, (casesByCategory.get(res.category) ?? 0) + 1);
    const failed = res.checks.filter((c) => !c.pass);
    totalPass += res.checks.length - failed.length;
    totalFail += failed.length;
    if (failed.length > 0) failuresByCategory.set(res.category, (failuresByCategory.get(res.category) ?? 0) + failed.length);
    const status = failed.length === 0 ? 'PASS' : `FAIL (${failed.length}/${res.checks.length})`;
    console.log(`  [${status}] ${res.id} (${res.category})`);
    for (const f of failed) {
      console.log(`      ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log('CATEGORY-LEVEL METRICS');
  console.log('='.repeat(78));
  for (const [cat, n] of Array.from(casesByCategory.entries())) {
    const fails = failuresByCategory.get(cat) ?? 0;
    console.log(`  ${cat}: ${n} case(s), ${fails} failed check(s)`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('AGGREGATE');
  console.log('='.repeat(78));
  console.log(`  Total checks: ${totalPass + totalFail}`);
  console.log(`  Passed: ${totalPass}`);
  console.log(`  Failed: ${totalFail}`);
  console.log(`  Cases: ${results.length} (28 dataset + 1 validator block + 4 adversarial + 4 blank/malformed + 8 job descriptions)`);
  console.log('\nLIMITATIONS (per design doc §9 and this step\'s authorization):');
  console.log('  - Dataset labels were hand-derived by Claude from the documented deterministic');
  console.log('    rules, NOT independently reviewed by Deep. Per §9: "preliminary" results.');
  console.log('  - This is the OFFLINE evaluation only. No OpenAI calls were made anywhere. Parts');
  console.log('    B/C/D\'s "model output" is entirely hand-constructed JSON simulating a model');
  console.log('    that produced a given (clean or compromised) response — it tests the VALIDATOR\'S');
  console.log('    reaction to that shape, never real gpt-5-mini behavior. The live evaluation');
  console.log('    (36 inputs x 2 modes x 2 repeats, <= $2) is separately gated and NOT run here.');
  console.log('  - Adversarial coverage tests defense-in-depth (the server validator), not whether');
  console.log('    gpt-5-mini actually resists these inputs — that question is live-eval-only.');
  console.log('  - Non-English input: the heading lexicon is English-only (a documented limitation,');
  console.log('    design doc §4 "language detection is a hint only"), not a defect found here.');
  console.log('  - PDF-extraction coverage: see docs/resume-pr-b-section9-offline-eval-2026-10-30.md');
  console.log('    for the coverage mapping against the pre-existing PR A suite');
  console.log('    (test/pdf-extraction-fidelity-suite.ts) — not re-run from this file.');

  if (totalFail > 0) process.exitCode = 1;
}

async function main() {
  runPartA();
  runPartB();
  runPartC();
  runPartD();
  report();
}

main();

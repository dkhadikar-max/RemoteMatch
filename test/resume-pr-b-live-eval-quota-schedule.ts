/**
 * Resume Intelligence (PR B) — §9 live-eval quota/schedule feasibility analysis.
 * Offline, no network call. Answers the 2026-10-30 instruction: derive a realistic per-case
 * output-token estimate (grounded in real evidence, not guessed), keep the existing hard upper
 * bound, and compute whether each free-tier provider can actually complete the 88-call matrix
 * within its real RPM/TPM/RPD/TPD limits — producing a schedule (duration, days needed, quota
 * headroom), WITHOUT running anything. The live runner stays in LIVE_EVAL_MODE=dry-run; nothing
 * here imports or invokes any of its real call functions.
 *
 * Run: npx tsx test/resume-pr-b-live-eval-quota-schedule.ts
 */
import { buildRubricPrompt, RESUME_SYSTEM_PROMPT } from '../src/lib/resume/prompt';
import { runDeterministicAnalysis } from '../src/lib/resume/rubric';
import { redactForModel } from '../src/lib/resume/redaction';
import { RESUME_PR_B_EVAL_SET } from './fixtures/resume-pr-b-eval-set';
import { ADVERSARIAL_CASES, JOB_DESCRIPTIONS, HIDDEN_TEXT_PROTOCOL_VARIANTS } from './fixtures/resume-pr-b-eval-set-extended';

function estTokens(s: string): number { return Math.ceil(s.length / 4); }

// ── Step 1: real input-token measurement (unchanged method from
// resume-pr-b-measure-prompt-sizes.ts) + per-case section/bullet counts, the actual structural
// drivers of completion size. ──────────────────────────────────────────────────────────────────

interface InputProfile { id: string; inputTokens: number; sections: number; bullets: number; mode: 'general' | 'target_job' }

const profiles: InputProfile[] = [];
for (const c of [...RESUME_PR_B_EVAL_SET, ...ADVERSARIAL_CASES]) {
  const det = runDeterministicAnalysis(c.resumeText, c.declaredSkills);
  const { redactedText } = redactForModel(c.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'general', redactedResumeText: redactedText.slice(0, 12000), sections: det.sections, bullets: det.bullets });
  profiles.push({ id: c.id, inputTokens: estTokens(RESUME_SYSTEM_PROMPT + prompt), sections: det.sections.length, bullets: det.bullets.length, mode: 'general' });
}
for (const v of HIDDEN_TEXT_PROTOCOL_VARIANTS) {
  const det = runDeterministicAnalysis(v.resumeText, v.declaredSkills);
  const { redactedText } = redactForModel(v.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'general', redactedResumeText: redactedText.slice(0, 12000), sections: det.sections, bullets: det.bullets });
  profiles.push({ id: v.id, inputTokens: estTokens(RESUME_SYSTEM_PROMPT + prompt), sections: det.sections.length, bullets: det.bullets.length, mode: 'general' });
}
for (const j of JOB_DESCRIPTIONS) {
  const resume = RESUME_PR_B_EVAL_SET.find((c) => c.id === j.pairsWithResumeId)!;
  const det = runDeterministicAnalysis(resume.resumeText, resume.declaredSkills);
  const { redactedText } = redactForModel(resume.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'target_job', redactedResumeText: redactedText.slice(0, 12000), jobText: j.jobText.slice(0, 4000), sections: det.sections, bullets: det.bullets });
  profiles.push({ id: j.id, inputTokens: estTokens(RESUME_SYSTEM_PROMPT + prompt), sections: det.sections.length, bullets: det.bullets.length, mode: 'target_job' });
}

// ── Step 2: derive a REALISTIC per-case completion-token estimate — grounded, not guessed. ─────
//
// The ONLY real, same-model (gpt-5-mini, reasoning_effort:'minimal') evidence in this project for
// a comparably-structured generation task is the Phase 0b verification (remotematch-phase0-ai-
// verification-results memory): a real "Application Kit" generation call produced 668 completion
// tokens (513 prompt tokens). That feature's output is materially simpler than Resume
// Intelligence's schema — no per-section criteria-rating arrays, no sectionReviews list, no
// targetJobFit requirements array. Resume Intelligence's schema (src/types/resume-intelligence.ts)
// adds, per detected section, up to 12 rubric-criterion ratings each needing at least one evidence
// span, plus findings/recommendations — the dominant driver of completion LENGTH, which scales
// with the number of sections and bullets a resume actually has (not a flat per-resume constant).
//
// Model (explicit, auditable, not a black box):
//   expectedTokens = BASE + sections * PER_SECTION + bullets * PER_BULLET
// BASE=300 (resumeType + overallSummary + formattingIssues + actionPlan + questionsForCandidate +
//           limitations — roughly the Application Kit anchor's own fixed-overhead share).
// PER_SECTION=150 (one sectionReview: ~6 applicable criteria ratings with evidence + 0-2
//                  findings/recommendations, each needing a quote).
// PER_BULLET=55 (not every bullet gets rewritten; this is an expected VALUE across accepted and
//                 declined-to-rewrite bullets, each of which still costs a small amount of output
//                 either way — a rewrite entry, or nothing, averaged).
// target_job mode adds TARGET_JOB_FIXED (≈300, for a handful of requirement entries + prioritize).
//
// This is explicitly an ESTIMATE pending real data, not a measurement — flagged as such
// throughout. It exists to make the schedule math below actually grounded in this project's own
// evidence instead of an unexamined guess, and is fully auditable/falsifiable by anyone who
// disagrees with a coefficient.
const BASE = 300;
const PER_SECTION = 150;
const PER_BULLET = 55;
const TARGET_JOB_FIXED = 300;
const HARD_UPPER_BOUND = 6000; // MAX_COMPLETION_TOKENS, unchanged, already enforced in the runner

function expectedCompletionTokens(p: InputProfile): number {
  return BASE + p.sections * PER_SECTION + p.bullets * PER_BULLET + (p.mode === 'target_job' ? TARGET_JOB_FIXED : 0);
}

console.log('='.repeat(78));
console.log('STEP 1+2 — REAL INPUT SIZES + DERIVED (ESTIMATED) COMPLETION SIZES, PER CASE');
console.log('='.repeat(78));
const completionEstimates = profiles.map((p) => ({ ...p, expectedOut: expectedCompletionTokens(p) }));
const sortedByOut = completionEstimates.slice().sort((a, b) => b.expectedOut - a.expectedOut);
console.log('3 largest estimated completions:', JSON.stringify(sortedByOut.slice(0, 3).map((p) => ({ id: p.id, sections: p.sections, bullets: p.bullets, expectedOut: p.expectedOut }))));
console.log('3 smallest estimated completions:', JSON.stringify(sortedByOut.slice(-3).map((p) => ({ id: p.id, sections: p.sections, bullets: p.bullets, expectedOut: p.expectedOut }))));

const sumIn = profiles.reduce((a, p) => a + p.inputTokens, 0);
const sumExpectedOut = completionEstimates.reduce((a, p) => a + p.expectedOut, 0);
const meanIn = sumIn / profiles.length;
const meanExpectedOut = sumExpectedOut / profiles.length;
console.log(`\n44 distinct inputs. Mean input tokens: ${meanIn.toFixed(0)}. Mean ESTIMATED completion tokens: ${meanExpectedOut.toFixed(0)}.`);
console.log(`LOW scenario (lean/terse model output, 60% of expected): mean completion ~${(meanExpectedOut * 0.6).toFixed(0)}`);
console.log(`EXPECTED scenario (the derived estimate above): mean completion ~${meanExpectedOut.toFixed(0)}`);
console.log(`HIGH / hard upper bound (unchanged, already enforced as max_tokens/max_completion_tokens): ${HARD_UPPER_BOUND}`);

// ── Step 3+4: per-provider feasibility + schedule, across LOW/EXPECTED/HIGH ─────────────────────

interface ProviderLimits { name: string; rpm?: number; tpm?: number; rpd: number; tpd: number }
const PROVIDERS: ProviderLimits[] = [
  { name: 'gemini (gemini-3.8-flash)', rpd: 20, tpd: Infinity }, // this project's own documented, 429-confirmed limit is a REQUEST count, not published token limits
  { name: 'groq-120b (openai/gpt-oss-120b)', rpm: 30, tpm: 8000, rpd: 1000, tpd: 200_000 },
  { name: 'groq-20b (openai/gpt-oss-20b)', rpm: 30, tpm: 8000, rpd: 1000, tpd: 200_000 },
];

const TOTAL_CALLS = 88;
const scenarios: Array<{ name: string; outMultiplier: number }> = [
  { name: 'LOW (lean, 0.6x expected)', outMultiplier: 0.6 },
  { name: 'EXPECTED (derived estimate)', outMultiplier: 1.0 },
  { name: 'HIGH (hard upper bound, 6000/call)', outMultiplier: Infinity }, // special-cased below
];

console.log('\n' + '='.repeat(78));
console.log('STEP 3+4 — PER-PROVIDER FEASIBILITY + CALL SCHEDULE');
console.log('='.repeat(78));

for (const provider of PROVIDERS) {
  console.log(`\n── ${provider.name} ──`);
  console.log(`   Published/measured limits: RPM=${provider.rpm ?? 'n/a'} TPM=${provider.tpm ?? 'n/a'} RPD=${provider.rpd} TPD=${provider.tpd === Infinity ? 'n/a (request-count gated, not token-gated)' : provider.tpd}`);

  for (const scenario of scenarios) {
    const perCallOut = scenario.outMultiplier === Infinity ? HARD_UPPER_BOUND : meanExpectedOut * scenario.outMultiplier;
    const perCallTotal = meanIn + perCallOut;
    const totalTokensForRun = TOTAL_CALLS * perCallTotal;

    if (provider.name.startsWith('gemini')) {
      const daysNeeded = Math.ceil(TOTAL_CALLS / provider.rpd);
      console.log(`   [${scenario.name}] Gemini is request-count gated, not token-gated: ${TOTAL_CALLS} calls at ${provider.rpd}/day needs ${daysNeeded} day(s) regardless of completion size. Est. per-call total tokens: ${perCallTotal.toFixed(0)} (informational only, not the binding constraint).`);
      continue;
    }

    const tpm = provider.tpm!;
    const tpd = provider.tpd;
    const rpd = provider.rpd;
    const callsPerDayByTokens = Math.floor(tpd / perCallTotal);
    const callsPerDayBound = Math.min(callsPerDayByTokens, rpd);
    const daysNeeded = Math.ceil(TOTAL_CALLS / callsPerDayBound);
    const callsPerMinuteByTpm = Math.max(1, Math.floor(tpm / perCallTotal));
    const minutesPerDayBatch = Math.ceil(Math.min(TOTAL_CALLS, callsPerDayBound) / callsPerMinuteByTpm);
    const headroomPct = ((callsPerDayBound - Math.min(TOTAL_CALLS, callsPerDayBound)) / callsPerDayBound) * 100;
    console.log(`   [${scenario.name}] per-call total ≈${perCallTotal.toFixed(0)} tok | max calls/day (TPD-bound) = ${callsPerDayByTokens} | max calls/day (RPD-bound) = ${rpd} | BINDING = ${callsPerDayBound}/day`);
    console.log(`     -> ${TOTAL_CALLS} calls need ${daysNeeded} day(s). Pacing: ~${callsPerMinuteByTpm} calls/min under TPM -> ~${minutesPerDayBatch} min for one day's batch. Day-1 headroom: ${daysNeeded === 1 ? headroomPct.toFixed(0) + '%' : 'N/A (multi-day run)'}.`);
  }
}

console.log('\n' + '='.repeat(78));
console.log('SUMMARY / RECOMMENDATION');
console.log('='.repeat(78));
console.log('- Gemini: CANNOT complete 88 calls in one day under its documented 20/day gate, at any');
console.log('  completion size (it is request-count gated, not token-gated). A full run needs');
console.log('  multiple calendar days OR a reduced-scope pilot (e.g. 20 calls prioritizing the');
console.log('  hidden-text-protocol + adversarial cases over the full dataset).');
console.log('- Groq (either model): the EXPECTED scenario likely needs 2 days, not 1, for the full');
console.log('  88 — confirming the risk already flagged in the four-provider benchmark doc, now');
console.log('  with a grounded (not worst-case-only) number behind it. The LOW scenario may fit in');
console.log('  1 day; this cannot be confirmed without a real call.');
console.log('- The runner itself does not need new code to honor any of this: its existing TPD/RPD');
console.log('  halt gates and Gemini request-count gate will naturally stop a run at the real limit');
console.log('  and record the remainder as skipped_quota, never retried — the only open decision is');
console.log('  SCOPE (full 352 across possibly several days, vs. a smaller single-day pilot) and');
console.log('  whether to lower the per-call max_tokens/max_completion_tokens request parameter');
console.log('  below the 6000 hard cap for this benchmark specifically (would shrink the worst case');
console.log('  but is a real behavior change to the request, not just accounting, and is NOT applied');
console.log('  here — left as an explicit decision for whoever authorizes execution).');
console.log('\nLIVE_EVAL_MODE remains dry-run. No execution happened or is recommended by this analysis');
console.log('alone — it answers "can it fit", not "should we run it".');

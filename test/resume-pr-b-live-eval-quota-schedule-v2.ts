/**
 * Resume Intelligence (PR B) — §9 quota/schedule recalculation using REAL observed data from the
 * 2026-10-30 Gemini 20-call pilot (not the formula-estimated numbers in the v1 schedule doc).
 * Offline, no network call — reads the pilot's real completion-token DISTRIBUTION (not just its
 * mean), the real 25% failure rate, and produces expected + worst-case daily throughput for each
 * provider, explicitly including failed-call/no-retry overhead in the schedule.
 *
 * Run: npx tsx test/resume-pr-b-live-eval-quota-schedule-v2.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import type { CallRecord } from './resume-pr-b-live-evaluation-runner';

const records: CallRecord[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-pr-b-gemini-pilot-2026-10-30.json'), 'utf8')
);

const successes = records.filter((r) => r.failureClass !== 'error');
const errors = records.filter((r) => r.failureClass === 'error');

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

console.log('='.repeat(78));
console.log('REAL OBSERVED DISTRIBUTION (15 successful Gemini pilot calls, not a formula)');
console.log('='.repeat(78));

const completions = successes.map((r) => r.usageCompletionTokens).sort((a, b) => a - b);
const prompts = successes.map((r) => r.usagePromptTokens).sort((a, b) => a - b);
const totals = successes.map((r) => r.usagePromptTokens + r.usageCompletionTokens).sort((a, b) => a - b);

console.log(`Completion tokens: min=${completions[0]} p50=${percentile(completions, 0.5)} p90=${percentile(completions, 0.9)} max=${completions[completions.length - 1]} mean=${(completions.reduce((a, b) => a + b, 0) / completions.length).toFixed(0)}`);
console.log(`Prompt tokens:     min=${prompts[0]} p50=${percentile(prompts, 0.5)} p90=${percentile(prompts, 0.9)} max=${prompts[prompts.length - 1]} mean=${(prompts.reduce((a, b) => a + b, 0) / prompts.length).toFixed(0)}`);
console.log(`Total per call:    min=${totals[0]} p50=${percentile(totals, 0.5)} p90=${percentile(totals, 0.9)} max=${totals[totals.length - 1]} mean=${(totals.reduce((a, b) => a + b, 0) / totals.length).toFixed(0)}`);

const observedFailureRate = errors.length / records.length;
console.log(`\nObserved failure rate (this pilot, N=20): ${(observedFailureRate * 100).toFixed(0)}% (${errors.length}/${records.length}), never retried.`);
console.log('CAVEAT: a single 20-call sample from ONE provider. Treated as a planning assumption,');
console.log('NOT a validated failure rate for Gemini in general, and NOT assumed to transfer to Groq');
console.log('(a different provider, infrastructure, and load profile) without its own real data.');

const TOTAL_CALLS = 88;
const HARD_UPPER_BOUND = 6000;

interface Scenario { name: string; perCallTotal: number }
const scenarios: Scenario[] = [
  { name: 'EXPECTED (observed p50 total)', perCallTotal: percentile(totals, 0.5) },
  { name: 'OBSERVED WORST (observed max total, this pilot)', perCallTotal: totals[totals.length - 1] },
  { name: 'HARD UPPER BOUND (prompt mean + 6,000 cap)', perCallTotal: (prompts.reduce((a, b) => a + b, 0) / prompts.length) + HARD_UPPER_BOUND },
];

console.log('\n' + '='.repeat(78));
console.log('PER-PROVIDER FEASIBILITY, INCLUDING FAILED-CALL/NO-RETRY OVERHEAD');
console.log('='.repeat(78));

// Gemini: request-count gated at 20/day — this project's OWN account-specific observation
// (429-confirmed on a related model bucket, gemini-config.ts), NOT a universal published Google
// limit, labelled explicitly per instruction.
console.log('\n── Gemini (gemini-3.8-flash) — ACCOUNT-SPECIFIC quota assumption, not a universal Google limit ──');
const geminiRpd = 20;
const attemptsNeededFor88Successes = Math.ceil(TOTAL_CALLS / (1 - observedFailureRate));
console.log(`  To obtain ${TOTAL_CALLS} EVALUATED (successful) responses at the observed ${(observedFailureRate * 100).toFixed(0)}% failure rate,`);
console.log(`  ~${attemptsNeededFor88Successes} attempts are needed (not ${TOTAL_CALLS}) — each failed attempt still consumes one of the 20/day request slots.`);
console.log(`  Days needed: ${Math.ceil(attemptsNeededFor88Successes / geminiRpd)} (was 5, computed from ${TOTAL_CALLS} attempts with NO failure allowance — this revises it upward to account for real observed failures).`);

for (const provider of [
  { name: 'groq-120b', rpm: 30, tpm: 8000, rpd: 1000, tpd: 200_000 },
  { name: 'groq-20b', rpm: 30, tpm: 8000, rpd: 1000, tpd: 200_000 },
]) {
  console.log(`\n── ${provider.name} (openai/gpt-oss-*) — published limits assumed to apply as documented; NO real Groq data exists yet ──`);
  for (const scenario of scenarios) {
    const callsPerDayByTokens = Math.floor(provider.tpd / scenario.perCallTotal);
    const callsPerDayBound = Math.min(callsPerDayByTokens, provider.rpd);
    // Include failure overhead: need enough ATTEMPTS to yield 88 successes, assuming (for lack of
    // real Groq data) the SAME observed Gemini failure rate as a planning placeholder — explicitly
    // flagged as an assumption, not evidence.
    const attemptsNeeded = Math.ceil(TOTAL_CALLS / (1 - observedFailureRate));
    const daysNeeded = Math.ceil(attemptsNeeded / callsPerDayBound);
    const callsPerMinuteByTpm = Math.max(1, Math.floor(provider.tpm / scenario.perCallTotal));
    console.log(`  [${scenario.name}] per-call total ≈${scenario.perCallTotal.toFixed(0)} tok | max calls/day (TPD) = ${callsPerDayByTokens} | BINDING/day = ${callsPerDayBound}`);
    console.log(`    -> attempts needed for ${TOTAL_CALLS} successes (assuming the SAME ${(observedFailureRate * 100).toFixed(0)}% failure rate, unverified for Groq) = ${attemptsNeeded} -> ${daysNeeded} day(s). Pacing: ~${callsPerMinuteByTpm} calls/min under TPM.`);
  }
}

console.log('\n' + '='.repeat(78));
console.log('SUMMARY');
console.log('='.repeat(78));
console.log('- Gemini: the 20/day figure is THIS PROJECT\'S OWN observed/documented assumption for');
console.log('  this specific account and model bucket (confirmed via a real 429 on a related model');
console.log('  earlier in this project\'s history) — not a universally published Google quota, and');
console.log('  could differ for a different Google Cloud project or billing account.');
console.log('- Real observed completion sizes (p50 total ~' + percentile(totals, 0.5) + ' tok) alone would still mean');
console.log('  ~2 days for Groq at 88 raw attempts (matching the prior estimate\'s conclusion) — but once');
console.log('  the real 25% failure rate is factored in (118 attempts needed for 88 successes), Gemini');
console.log('  moves from 5 to 6 days and Groq moves from 2 to 3-5 days depending on scenario.');
console.log('- Groq numbers remain ENTIRELY UNVERIFIED — no Groq call has been made. Applying the');
console.log('  Gemini failure rate to Groq is a placeholder for planning, not evidence.');

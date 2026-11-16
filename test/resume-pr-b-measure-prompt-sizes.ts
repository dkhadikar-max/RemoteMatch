/**
 * Resume Intelligence (PR B) — measures REAL prompt token sizes for the 88-call matrix's
 * distinct inputs, to check feasibility against Groq's published free-tier 8,000 TPM (tokens per
 * minute) limit before preparing a Groq provider configuration. Offline only — no network call.
 * Run: npx tsx test/resume-pr-b-measure-prompt-sizes.ts
 */
import { buildRubricPrompt, RESUME_SYSTEM_PROMPT } from '../src/lib/resume/prompt';
import { runDeterministicAnalysis } from '../src/lib/resume/rubric';
import { redactForModel } from '../src/lib/resume/redaction';
import { RESUME_PR_B_EVAL_SET } from './fixtures/resume-pr-b-eval-set';
import { ADVERSARIAL_CASES, JOB_DESCRIPTIONS, HIDDEN_TEXT_PROTOCOL_VARIANTS } from './fixtures/resume-pr-b-eval-set-extended';

function estTokens(s: string): number { return Math.ceil(s.length / 4); }

const sizes: Array<{ id: string; tokens: number }> = [];

for (const c of [...RESUME_PR_B_EVAL_SET, ...ADVERSARIAL_CASES]) {
  const det = runDeterministicAnalysis(c.resumeText, c.declaredSkills);
  const { redactedText } = redactForModel(c.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'general', redactedResumeText: redactedText.slice(0, 12000), sections: det.sections, bullets: det.bullets });
  sizes.push({ id: c.id, tokens: estTokens(RESUME_SYSTEM_PROMPT + prompt) });
}
for (const v of HIDDEN_TEXT_PROTOCOL_VARIANTS) {
  const det = runDeterministicAnalysis(v.resumeText, v.declaredSkills);
  const { redactedText } = redactForModel(v.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'general', redactedResumeText: redactedText.slice(0, 12000), sections: det.sections, bullets: det.bullets });
  sizes.push({ id: v.id, tokens: estTokens(RESUME_SYSTEM_PROMPT + prompt) });
}
for (const j of JOB_DESCRIPTIONS) {
  const resume = RESUME_PR_B_EVAL_SET.find((c) => c.id === j.pairsWithResumeId)!;
  const det = runDeterministicAnalysis(resume.resumeText, resume.declaredSkills);
  const { redactedText } = redactForModel(resume.resumeText, null);
  const prompt = buildRubricPrompt({ mode: 'target_job', redactedResumeText: redactedText.slice(0, 12000), jobText: j.jobText.slice(0, 4000), sections: det.sections, bullets: det.bullets });
  sizes.push({ id: j.id, tokens: estTokens(RESUME_SYSTEM_PROMPT + prompt) });
}

const nums = sizes.map((s) => s.tokens).sort((a, b) => a - b);
const sum = nums.reduce((a, b) => a + b, 0);
console.log('='.repeat(78));
console.log('REAL PROMPT TOKEN SIZES — 44 distinct inputs (88 calls = x2 repeats each)');
console.log('='.repeat(78));
console.log('distinct inputs:', nums.length);
console.log('min prompt tokens (est., chars/4):', nums[0]);
console.log('median prompt tokens:', nums[Math.floor(nums.length / 2)]);
console.log('max prompt tokens:', nums[nums.length - 1]);
console.log('mean prompt tokens:', Math.round(sum / nums.length));
console.log('sum, 44 distinct inputs (no repeats):', sum);
console.log('sum x2 repeats = total input tokens across all 88 calls:', sum * 2);
const largest = sizes.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 3);
console.log('3 largest prompts:', JSON.stringify(largest));

console.log('\n' + '='.repeat(78));
console.log('GROQ FREE-TIER FEASIBILITY (published limits: 30 RPM, 1,000 RPD, 8,000 TPM, 200,000 TPD)');
console.log('='.repeat(78));
const maxSingleCall = nums[nums.length - 1];
console.log(`Largest single prompt (${maxSingleCall} est. tokens) vs 8,000 TPM: ${maxSingleCall <= 8000 ? 'FITS in one call' : 'EXCEEDS the per-minute cap on its own — would need splitting or a smaller input'}`);
console.log(`88 calls x largest prompt, if sent back-to-back with no spacing: ${88 * maxSingleCall} tokens — vs 200,000 TPD: ${88 * maxSingleCall <= 200000 ? 'fits the daily cap' : 'EXCEEDS the daily cap'}`);
console.log(`Total input tokens across all 88 calls (sum, not worst-case-repeated): ${sum * 2} — vs 200,000 TPD: ${sum * 2 <= 200000 ? 'fits comfortably' : 'EXCEEDS the daily cap'}`);
console.log('Per-minute pacing needed: at 30 RPM max and needing to stay under 8,000 TPM, the');
console.log('constraining factor is TPM, not RPM, whenever avg tokens/call exceeds 8000/30=266.');
console.log(`Average tokens/call here (${Math.round(sum / nums.length)}) is far above 266, so calls must be SPACED (not')`);
console.log('fired as fast as the 30 RPM cap alone would allow) to stay under 8,000 TPM.');
const callsPerMinuteAtTpmLimit = Math.max(1, Math.floor(8000 / (sum / nums.length)));
console.log(`Max calls/minute to stay under 8,000 TPM at the mean prompt size: ~${callsPerMinuteAtTpmLimit}`);
console.log(`Estimated minutes needed for all 88 calls at that pace: ~${Math.ceil(88 / callsPerMinuteAtTpmLimit)} minutes (plus output tokens, not counted above, which would tighten this further).`);

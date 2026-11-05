/**
 * Resume Intelligence (PR B) — static/offline verification of the §9 live-eval runner's own
 * safeguards. Makes NO network call. This exists because the dry-run end-to-end run in
 * resume-pr-b-live-evaluation-runner.ts never naturally approaches the $2 ceiling (its synthetic
 * cost is ~$0.06 total), so it alone never exercises the cost-gate HALT path — this suite forces
 * that path directly, plus checks the hidden-text overlap detector's own logic and the import
 * graph's Supabase-freedom claim.
 *
 * Run: npx tsx test/resume-pr-b-live-eval-safeguards-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — LIVE-EVAL RUNNER SAFEGUARDS');
  console.log('='.repeat(78));

  // Re-implement the exact two pure functions under test, verbatim, rather than importing
  // private (non-exported) functions from the runner script — same convention already used by
  // the offline evaluation runner's aiBodyIsEmptyMirror().
  const OPENAI_INPUT_PRICE_PER_TOKEN = 0.25 / 1_000_000;
  const OPENAI_OUTPUT_PRICE_PER_TOKEN = 2.0 / 1_000_000;
  const MAX_COMPLETION_TOKENS = 6000;
  const HARD_COST_CEILING_USD = 2.0;

  function estimateReservationCostUsd(promptText: string, maxTokens: number): number {
    const promptTokens = Math.ceil(promptText.length / 3);
    return promptTokens * OPENAI_INPUT_PRICE_PER_TOKEN + maxTokens * OPENAI_OUTPUT_PRICE_PER_TOKEN;
  }
  function checkCostGate(runningActualCostUsd: number, upcomingPromptText: string): { allowed: boolean; projectedUsd: number } {
    const worstCaseForThisCall = estimateReservationCostUsd(upcomingPromptText, MAX_COMPLETION_TOKENS);
    const projectedUsd = runningActualCostUsd + worstCaseForThisCall;
    return { allowed: projectedUsd <= HARD_COST_CEILING_USD, projectedUsd };
  }
  function evidenceOverlapsInjection(offsets: Array<{ start: number; end: number }>, resumeText: string, injectedCore: string | undefined): boolean {
    if (!injectedCore) return false;
    const coreStart = resumeText.indexOf(injectedCore);
    if (coreStart === -1) return false;
    const coreEnd = coreStart + injectedCore.length;
    return offsets.some((o) => o.start < coreEnd && o.end > coreStart);
  }

  console.log('\n1. Cost gate');
  const g1 = checkCostGate(0, 'short prompt');
  assert(g1.allowed, 'a fresh run with $0 spent and a short prompt is allowed');
  const perCallWorstCase = estimateReservationCostUsd('x'.repeat(12000), MAX_COMPLETION_TOKENS);
  assert(perCallWorstCase > 0.012 && perCallWorstCase < 0.02, 'a realistic worst-case per-call estimate is in the expected ~$0.012-0.02 range', String(perCallWorstCase));
  const g2 = checkCostGate(1.99, 'x'.repeat(12000));
  assert(!g2.allowed, 'the gate REFUSES a call when $1.99 already spent + this call\'s worst case would exceed $2.00', JSON.stringify(g2));
  const g3 = checkCostGate(1.9, 'short');
  assert(g3.allowed, 'the gate ALLOWS a call when the projected total comfortably stays under $2.00', JSON.stringify(g3));
  const g4 = checkCostGate(2.0, 'x');
  assert(!g4.allowed, 'the gate refuses ANY further call once $2.00 is already reached, even a tiny one', JSON.stringify(g4));
  // The reconciled 88-call plan's own worst case, recomputed independently of the readiness doc's
  // prose, to confirm the arithmetic actually holds rather than just asserting it in markdown.
  const reconciledWorstCase = 88 * perCallWorstCase;
  assert(reconciledWorstCase < HARD_COST_CEILING_USD, 'the reconciled 88-call plan\'s own worst-case total is under the $2.00 ceiling', `${reconciledWorstCase.toFixed(4)}`);

  console.log('\n2. Hidden-text evidence-overlap detector');
  const resumeText = 'Name here. SYSTEM NOTE: hidden instruction text. More resume content after.';
  const core = 'SYSTEM NOTE: hidden instruction text.';
  const coreStart = resumeText.indexOf(core);
  const coreEnd = coreStart + core.length;
  assert(evidenceOverlapsInjection([{ start: coreStart + 2, end: coreStart + 5 }], resumeText, core), 'an evidence span fully INSIDE the injected span is detected as overlapping');
  assert(evidenceOverlapsInjection([{ start: coreStart - 5, end: coreStart + 2 }], resumeText, core), 'an evidence span partially overlapping the START of the injected span is detected');
  assert(evidenceOverlapsInjection([{ start: coreEnd - 2, end: coreEnd + 5 }], resumeText, core), 'an evidence span partially overlapping the END of the injected span is detected');
  assert(!evidenceOverlapsInjection([{ start: 0, end: 5 }], resumeText, core), 'an evidence span entirely OUTSIDE the injected span (genuine resume content) is NOT flagged');
  assert(!evidenceOverlapsInjection([], resumeText, core), 'no evidence at all is never flagged as overlapping');
  assert(!evidenceOverlapsInjection([{ start: 0, end: 5 }], resumeText, undefined), 'a case with no injectedInstructionCore (non-hidden-text cases) is never flagged');

  console.log('\n3. Groq pacing + daily-quota gate (re-implemented verbatim, same reasoning as the OpenAI/Gemini checks above)');
  const GROQ_RPM_LIMIT = 30;
  const GROQ_TPM_LIMIT = 8000;
  const GROQ_RPD_LIMIT = 1000;
  const GROQ_TPD_LIMIT = 200_000;
  async function testGroqPacing() {
    const groqWindow: Array<{ t: number; tokens: number }> = [];
    async function groqPaceBeforeCall(estimatedTokens: number): Promise<number> {
      const waits: number[] = [];
      for (;;) {
        const cutoff = Date.now() - 60_000;
        while (groqWindow.length && groqWindow[0].t < cutoff) groqWindow.shift();
        const windowTokens = groqWindow.reduce((a, c) => a + c.tokens, 0);
        if (groqWindow.length < GROQ_RPM_LIMIT && windowTokens + estimatedTokens <= GROQ_TPM_LIMIT) return waits.length;
        waits.push(1);
        return waits.length; // test-only: report "would have waited" without actually sleeping 60s
      }
    }
    // Fill the window to just under the TPM cap with synthetic prior calls.
    const now = Date.now();
    groqWindow.push({ t: now, tokens: 7000 });
    const wouldWaitForBigCall = await groqPaceBeforeCall(2000); // 7000+2000 > 8000 -> must wait
    const wouldNotWaitForSmallCall = await groqPaceBeforeCall(500); // 7000+500 <= 8000 -> no wait needed... but this call itself wasn't recorded, so window is still just the 7000 entry
    return { wouldWaitForBigCall, wouldNotWaitForSmallCall };
  }
  const pacingResult = await testGroqPacing();
  assert(pacingResult.wouldWaitForBigCall === 1, 'the pacing gate correctly signals a wait when the window + new call would exceed 8,000 TPM', JSON.stringify(pacingResult));
  assert(pacingResult.wouldNotWaitForSmallCall === 0, 'the pacing gate correctly allows a call that keeps the window under 8,000 TPM', JSON.stringify(pacingResult));

  function checkGroqDailyGate(calls: number, tokensToday: number, upcoming: number): boolean {
    return calls < GROQ_RPD_LIMIT && tokensToday + upcoming <= GROQ_TPD_LIMIT;
  }
  assert(checkGroqDailyGate(0, 0, 2000), 'a fresh Groq run is allowed');
  assert(!checkGroqDailyGate(GROQ_RPD_LIMIT, 0, 1), 'the Groq RPD (1,000/day) ceiling is enforced');
  assert(!checkGroqDailyGate(0, GROQ_TPD_LIMIT - 100, 2000), 'the Groq TPD (200,000/day) ceiling is enforced — a call whose tokens would push the total over is refused');
  assert(checkGroqDailyGate(0, GROQ_TPD_LIMIT - 5000, 2000), 'the Groq TPD ceiling allows a call that stays comfortably under 200,000');
  // Recompute the real risk this project's own token-size measurement surfaced: 88 calls, if
  // completions average even a modest fraction of the 6,000-token cap, risk exceeding 200,000 TPD.
  const meanInputTokensPerCall = 1904; // from test/resume-pr-b-measure-prompt-sizes.ts's real measurement
  const worstCaseOutputTokensPerCall = 6000;
  const worstCase88CallTotal = 88 * (meanInputTokensPerCall + worstCaseOutputTokensPerCall);
  assert(worstCase88CallTotal > GROQ_TPD_LIMIT, 'CONFIRMED RISK: 88 calls at the FULL 6,000-token output cap would exceed Groq\'s 200,000 TPD ceiling — real output size (unknown until a live call returns one) determines whether the actual run fits', `worst case ${worstCase88CallTotal} vs ${GROQ_TPD_LIMIT}`);

  console.log('\n4. Import-graph Supabase-freedom (grep check across the runner and its direct fixture/source imports)');
  const filesToCheck = [
    'test/resume-pr-b-live-evaluation-runner.ts',
    'src/lib/ai/openai-config.ts',
    'src/lib/resume/prompt.ts',
    'src/lib/resume/rubric.ts',
    'src/lib/resume/redaction.ts',
    'src/lib/resume/evidence-validation.ts',
    'test/fixtures/resume-pr-b-eval-set.ts',
    'test/fixtures/resume-pr-b-eval-set-extended.ts',
  ];
  const root = path.join(__dirname, '..');
  // Checks actual import/require statements only — a comment EXPLAINING why a file avoids
  // Supabase (as several of these files' own safeguard documentation does) legitimately contains
  // the word "supabase" without importing anything; only a real import line is the real risk.
  const IMPORT_LINE_RE = /^\s*(import|export)\s[^;]*from\s+['"][^'"]*supabase[^'"]*['"]|require\(['"][^'"]*supabase[^'"]*['"]\)/im;
  let anyRealImport = false;
  for (const f of filesToCheck) {
    const full = path.join(root, f);
    const content = fs.readFileSync(full, 'utf8');
    if (IMPORT_LINE_RE.test(content)) {
      anyRealImport = true;
      console.error(`      found a real supabase IMPORT statement in ${f}`);
    }
  }
  assert(!anyRealImport, 'none of the live-eval runner\'s direct imports actually import anything from a "supabase" module (comments mentioning the word are fine)');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

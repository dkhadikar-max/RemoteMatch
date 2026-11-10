/**
 * Resume Intelligence — usage instrumentation (reasoning-token capture + versioned eval-runner
 * usage block), per the 2026-11-01 implementation-design review.
 *
 * Scope: evaluation-runner + OpenAI-adapter reasoning-token extraction, the versioned/allowlisted
 * JSONL usage block, and backward compatibility with pre-existing JSONL records. Production
 * event-field wiring (ledger.consume()/recordAiCallEvent()) is covered separately in
 * test/resume-pr-b-workstream1-failure-audit-suite.ts.
 *
 * No live API calls anywhere in this file.
 *
 * `resume-pr-b-live-evaluation-runner.ts` calls `main()` unconditionally at module scope (it has
 * no entry-point guard) — importing it directly would trigger a real run as an import side
 * effect, which this suite must not do. Two different, safe techniques are used instead:
 *   - Checks 1/2 (OpenAI reasoning-token extraction): the exact formula used at both of its real
 *     call sites (`usage?.completion_tokens_details?.reasoning_tokens ?? null`), tested directly
 *     against representative `usage` shapes — the SDK client itself isn't mockable without a DI
 *     refactor outside this change's approved scope.
 *   - Check 3 (non-OpenAI providers): a static source-pattern check on the runner's own file text
 *     — the same technique this project already uses elsewhere (e.g.
 *     resume-pr-b-audit-fixes-static-suite.ts) for behavior that can't be exercised without
 *     importing/running the module.
 *   - Check 5 (new JSONL records): the dry-run pilot is spawned as a real child process (its own
 *     actual CLI entry point, exactly how it's meant to be invoked), not imported in-process.
 *
 * Run: npx tsx test/resume-pr-b-usage-instrumentation-suite.ts
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: string) {
  if (condition) { console.log(`  ✓ PASS: ${message}`); passed++; }
  else { console.error(`  ✗ FAIL: ${message}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const RUNNER_PATH = join(__dirname, 'resume-pr-b-live-evaluation-runner.ts');
const RUNNER_SOURCE = readFileSync(RUNNER_PATH, 'utf8');

/** The exact extraction formula used at both real call sites (openai-adapter.ts's OpenAiAdapter
 *  and this runner's callModelLive()) — tested here since the SDK client isn't injectable
 *  without a DI refactor outside this change's scope (see file header). */
function extractReasoningTokens(usage: { completion_tokens_details?: { reasoning_tokens?: number } } | undefined): number | null {
  return usage?.completion_tokens_details?.reasoning_tokens ?? null;
}

async function main() {
  console.log('\n=== Check 1: OpenAI reasoning metadata present — numeric value captured ===');
  assert(extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 4821 } }) === 4821, 'present reasoning_tokens is captured as the real numeric value, not discarded');
  assert(
    extractReasoningTokens({ completion_tokens_details: { reasoning_tokens: 6000 } }) === 6000,
    'a reasoning_tokens value equal to the full completion-token cap is captured, not treated as an edge case (matches the shape of our own pilot\'s real call-2 failure)'
  );

  console.log('\n=== Check 2: OpenAI reasoning metadata missing — null, no failure ===');
  assert(extractReasoningTokens(undefined) === null, 'a completely absent usage object yields null, does not throw');
  assert(extractReasoningTokens({} as { completion_tokens_details?: { reasoning_tokens?: number } }) === null, 'a usage object with no completion_tokens_details yields null');
  assert(extractReasoningTokens({ completion_tokens_details: {} }) === null, 'a completion_tokens_details object with no reasoning_tokens field yields null');

  console.log('\n=== Check 3: non-OpenAI providers — explicit null (static source-pattern check) ===');
  {
    // Each of these 5 functions must contain the explicit `usageReasoningTokens: null,` literal —
    // one occurrence per function, confirmed by counting within each function's own source slice,
    // not just a global count (which could pass even if one function were missing it while another
    // had it twice).
    const functions: Array<[string, RegExp]> = [
      ['callModelGemini', /async function callModelGemini[\s\S]*?\n}\n/],
      ['callModelGroq', /async function callModelGroq[\s\S]*?\n}\n/],
      ['callModelOpenRouter', /async function callModelOpenRouter[\s\S]*?\n}\n/],
      ['callModelVertexDirect', /async function callModelVertexDirect[\s\S]*?\n}\n/],
      ['callModelDryRun', /async function callModelDryRun[\s\S]*?\n}\n/],
    ];
    for (const [name, re] of functions) {
      const match = RUNNER_SOURCE.match(re);
      assert(!!match, `${name}() is present in the runner source (sanity check for the regex itself)`);
      const body = match?.[0] ?? '';
      const occurrences = (body.match(/usageReasoningTokens:\s*null,/g) ?? []).length;
      assert(occurrences === 1, `${name}() contains exactly one explicit "usageReasoningTokens: null," literal`, `found ${occurrences}`);
    }
  }
  {
    const liveMatch = RUNNER_SOURCE.match(/async function callModelLive[\s\S]*?\n}\n/);
    const liveBody = liveMatch?.[0] ?? '';
    assert(
      /usageReasoningTokens:\s*usage\?\.completion_tokens_details\?\.reasoning_tokens\s*\?\?\s*null,/.test(liveBody),
      'callModelLive() (OpenAI) uses the real extraction formula, not a hardcoded null'
    );
  }

  console.log('\n=== Check 4: existing JSONL records (no `usage` block) remain readable ===');
  {
    // Shaped exactly like this run's own call-2 pilot output, predating the `usage` field.
    const oldRecordLine = '{"id":"hidden-text-v1-baseline/general/repeat2","caseId":"hidden-text-v1-baseline","category":"hidden-text-protocol","mode":"general","repeat":2,"rawModelResponse":null,"failureClass":"skipped_malformed","usagePromptTokens":1816,"usageCompletionTokens":6000,"actualCostUsd":0.012454,"runningTotalCostUsdAfter":0.022949999999999998,"latencyMs":55035,"timestamp":"2026-10-31T19:23:37.356Z"}';
    let parsed: Record<string, unknown> | undefined;
    let threw = false;
    try { parsed = JSON.parse(oldRecordLine); } catch { threw = true; }
    assert(!threw, 'a pre-existing JSONL line without a `usage` field still parses without throwing');
    assert(!!parsed && parsed.usagePromptTokens === 1816 && parsed.usage === undefined, 'the old record\'s top-level usage*Tokens fields remain readable; `usage` is simply absent, not malformed', JSON.stringify(parsed));
  }

  console.log('\n=== Check 5: new JSONL records carry the version-1 usage block (real dry-run subprocess, zero network) ===');
  {
    let stdout = '';
    let crashed = false;
    try {
      stdout = execFileSync('npx', ['tsx', 'test/resume-pr-b-live-evaluation-runner.ts'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, LIVE_EVAL_MODE: 'dry-run', LIVE_EVAL_PILOT: '1' },
        encoding: 'utf8',
        timeout: 60_000,
        shell: true, // `npx` resolves to npx.cmd on Windows; execFileSync needs a shell to find it.
      });
    } catch (err) {
      crashed = true;
      stdout = (err as { stdout?: string }).stdout ?? '';
    }
    assert(!crashed, 'the dry-run pilot subprocess completes without crashing');
    const pathMatch = stdout.match(/Output written: (.+\.jsonl)/);
    assert(!!pathMatch, 'the dry-run run reports an output JSONL path', stdout.slice(-500));
    if (pathMatch) {
      const lines = readFileSync(pathMatch[1].trim(), 'utf8').trim().split('\n');
      assert(lines.length === 20, 'the dry-run pilot writes exactly 20 records', `got ${lines.length}`);
      const first = JSON.parse(lines[0]);
      assert(first.usage?.schemaVersion === 1, 'the first record\'s usage block carries schemaVersion: 1', JSON.stringify(first.usage));
      assert(first.usage?.provider === 'openai', 'the usage block\'s provider field is populated', JSON.stringify(first.usage));
      assert(first.usage?.reasoningTokens === null, 'dry-run records show reasoningTokens: null explicitly (never a faked figure)', JSON.stringify(first.usage));
      assert(typeof first.usagePromptTokens === 'number', 'the pre-existing top-level usagePromptTokens field is still present alongside the new usage block (additive, not a replacement)');
    }
  }

  console.log(`\n==============================================================================`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`==============================================================================`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});

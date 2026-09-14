/**
 * AI Phase 1B — reasoning_effort regression guard
 * (docs/ai-phase1b-implementation-plan.md §4, §9; openai-config.ts's header)
 * ==============================================================================
 * A static, source-scanning check (no API calls, no infra) that every
 * `chat.completions.create()` call site in materials.ts/resume.ts/
 * resume-intelligence.ts passes `reasoning_effort: OPENAI_REASONING_EFFORT`.
 *
 * Why this exists: a REAL, live-verified finding from Phase 0b — a
 * gpt-5-mini call WITHOUT reasoning_effort set returned finish_reason:
 * "length" with EMPTY visible content, every token of the budget consumed
 * by internal reasoning. The calling code's existing malformed-response
 * handling would silently, correctly reject that as unusable and fall back
 * to the deterministic template every single time — a 100%-fallback-rate
 * failure mode that looks like nothing is wrong. This test exists so a
 * future edit that adds a new call site, or accidentally drops the
 * parameter from an existing one, fails loudly here instead of silently
 * degrading AI-generated output to 100% template fallback in production.
 *
 * Run: npx tsx test/openai-reasoning-effort-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

const FILES = [
  'src/lib/ai/materials.ts',
  'src/lib/ai/resume.ts',
  'src/lib/ai/resume-intelligence.ts',
];

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Strips /** ... *\/ block comments and // line comments so header docs
 *  that happen to quote the same strings this test greps for don't inflate
 *  the count — a real, if minor, fragility bug this suite hit against its
 *  own materials.ts header comment during Phase 1B verification. Naive
 *  (doesn't understand string literals containing "//"), but sufficient
 *  for these 3 known, simple source files. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function main() {
  console.log('\n=== Every chat.completions.create() call site passes reasoning_effort ===');

  let totalCallSites = 0;

  for (const relPath of FILES) {
    const fullPath = join(__dirname, '..', relPath);
    const rawSource = readFileSync(fullPath, 'utf8');
    const source = stripComments(rawSource);

    const callSiteCount = countOccurrences(source, '.chat.completions.create(');
    const reasoningEffortCount = countOccurrences(source, 'reasoning_effort: OPENAI_REASONING_EFFORT');

    assert(callSiteCount >= 1, `${relPath}: has at least one chat.completions.create() call site (found ${callSiteCount})`);
    assert(
      reasoningEffortCount === callSiteCount,
      `${relPath}: reasoning_effort: OPENAI_REASONING_EFFORT appears exactly once per call site (${callSiteCount} call sites, ${reasoningEffortCount} reasoning_effort occurrences)`
    );

    // Also confirm the import itself is present — a file could otherwise
    // pass the count check by coincidentally having the right number of
    // some OTHER string that happens to match, though that's very unlikely
    // given the exact string used.
    assert(
      source.includes("OPENAI_REASONING_EFFORT } from './openai-config'") || source.includes('OPENAI_REASONING_EFFORT,'),
      `${relPath}: imports OPENAI_REASONING_EFFORT from openai-config.ts (not a locally-redefined constant)`
    );

    totalCallSites += callSiteCount;
  }

  assert(totalCallSites === 3, `exactly 3 total chat.completions.create() call sites across all three files (got ${totalCallSites}) — update this suite's expectation if a new call site is intentionally added`);

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exit(1);
});

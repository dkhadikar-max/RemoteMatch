/**
 * RemoteMatch — P1 Job-Quality Intelligence: candidate-attribute suite
 * ==============================================================================
 * Tests the P1 candidate observable attributes per the approved scoping
 * document. In-process (unlike the P0 HTTP suites) because these are pure
 * functions with no auth/DB/concurrency surface — there is nothing here an
 * HTTP-boundary test would catch that a direct call wouldn't.
 *
 * Section 1 proves the classifier fix is strictly additive: classifyRemoteEligibility()
 * (matching/eligibility, a frozen contract) is unaffected by the new
 * classifyExplicitRemoteScope() function existing alongside it.
 *
 * Run: npx tsx test/p1-job-quality-suite.ts
 */
import { classifyRemoteEligibility, classifyExplicitRemoteScope } from '../src/lib/ingestion/pipeline';

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

console.log('='.repeat(78));
console.log('REMOTEMATCH — P1 JOB-QUALITY INTELLIGENCE SUITE');
console.log('='.repeat(78));

// ----------------------------------------------------------------------
// 1. STRICTLY ADDITIVE: classifyRemoteEligibility() output is byte-for-byte
//    unaffected — same frozen-contract inputs gate2-live-supply.ts already
//    exercises against real live data, re-asserted here in-process so this
//    suite is self-contained.
// ----------------------------------------------------------------------
console.log('\n1. classifyRemoteEligibility() UNCHANGED (frozen contract)');
{
  const usOnly = classifyRemoteEligibility('Remote — US only');
  assert(usOnly.remoteType === 'US' && usOnly.eligibleCountries.join(',') === 'US,USA', `"Remote — US only" still classifies as US (got ${usOnly.remoteType})`);

  const europe = classifyRemoteEligibility('Remote in Europe');
  assert(europe.remoteType === 'EU/EEA', `"Remote in Europe" still classifies as EU/EEA (got ${europe.remoteType})`);

  const friendly = classifyRemoteEligibility('Remote-friendly office in Berlin');
  assert(friendly.remoteType === 'Specific countries', `"Remote-friendly office in Berlin" still classifies as Specific countries (got ${friendly.remoteType})`);

  const explicitWorldwide = classifyRemoteEligibility('100% remote worldwide');
  assert(explicitWorldwide.remoteType === 'Worldwide', `Explicit "100% remote worldwide" still classifies as Worldwide (got ${explicitWorldwide.remoteType})`);

  const noSignalAtAll = classifyRemoteEligibility('');
  assert(noSignalAtAll.remoteType === 'Worldwide', `Empty/no-signal input still defaults to Worldwide for matching purposes (unchanged existing behavior, got ${noSignalAtAll.remoteType})`);
}

// ----------------------------------------------------------------------
// 2. classifyExplicitRemoteScope() — the new, separate attribute
// ----------------------------------------------------------------------
console.log('\n2. classifyExplicitRemoteScope() — explicit_worldwide / explicit_restricted / unknown');
{
  assert(
    classifyExplicitRemoteScope('100% remote worldwide') === 'explicit_worldwide',
    'Explicit "100% remote worldwide" -> explicit_worldwide'
  );
  assert(
    classifyExplicitRemoteScope('Anywhere in the world') === 'explicit_worldwide',
    '"Anywhere in the world" -> explicit_worldwide'
  );

  assert(
    classifyExplicitRemoteScope('Remote — US only') === 'explicit_restricted',
    '"Remote — US only" -> explicit_restricted'
  );
  assert(
    classifyExplicitRemoteScope('Remote in Europe') === 'explicit_restricted',
    '"Remote in Europe" -> explicit_restricted'
  );
  assert(
    classifyExplicitRemoteScope('Remote-friendly office in Berlin') === 'explicit_restricted',
    '"Remote-friendly office in Berlin" -> explicit_restricted'
  );
  assert(
    classifyExplicitRemoteScope('Must overlap with PST hours') === 'explicit_restricted',
    '"Must overlap with PST hours" -> explicit_restricted'
  );
  assert(
    classifyExplicitRemoteScope('Contractor only position') === 'explicit_restricted',
    '"Contractor only position" -> explicit_restricted'
  );

  // The critical fix: this is exactly the case classifyRemoteEligibility()
  // defaults to 'Worldwide' for — no pattern matches anything. The new
  // attribute must NOT report this as explicit_worldwide.
  assert(
    classifyExplicitRemoteScope('') === 'unknown',
    'Empty input -> unknown (NOT explicit_worldwide, the critical fix this attribute exists for)'
  );
  assert(
    classifyExplicitRemoteScope('Senior Backend Engineer') === 'unknown',
    'A title-only string with no location info at all -> unknown'
  );
  assert(
    classifyExplicitRemoteScope(undefined, []) === 'unknown',
    'Fully absent location string and empty tags -> unknown'
  );
}

console.log('\n' + '='.repeat(78));
console.log(`${passed} passed, ${failed} failed.`);
console.log('='.repeat(78));
if (failed > 0) process.exit(1);

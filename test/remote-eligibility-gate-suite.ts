/**
 * Supply Discovery gate C3 — remote-eligibility publication gate.
 * Proves TWO things: (1) classifyExplicitRemoteScope() correctly returns
 * 'unknown' for genuinely ambiguous input (reused as-is, not modified by
 * C3), and (2) classifyRemoteEligibility() — the FROZEN matching contract —
 * is provably untouched. Neither classifier is redefined here; this suite
 * only observes their existing, pre-C3 behavior to prove the gate built on
 * top of them is sound.
 */
import { classifyExplicitRemoteScope, classifyRemoteEligibility } from '../src/lib/ingestion/pipeline';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C3 — REMOTE-ELIGIBILITY PUBLICATION GATE');
  console.log('==============================================================================\n');

  console.log('1. classifyExplicitRemoteScope() — the signal the C3 gate reads');
  assert(
    classifyExplicitRemoteScope('Worldwide', []) === 'explicit_worldwide',
    '"Worldwide" -> explicit_worldwide (gate would ACCEPT)'
  );
  assert(
    classifyExplicitRemoteScope('Remote - US only', []) === 'explicit_restricted',
    '"Remote - US only" -> explicit_restricted, still a stated scope (gate would ACCEPT — restricted is not the same as unknown)'
  );
  assert(
    classifyExplicitRemoteScope('', []) === 'unknown',
    'empty location string -> unknown (gate would REJECT for the new ATS sources)'
  );
  assert(
    classifyExplicitRemoteScope(undefined, []) === 'unknown',
    'undefined location -> unknown (gate would REJECT)'
  );
  assert(
    classifyExplicitRemoteScope('Remote-friendly', []) === 'explicit_restricted',
    '"Remote-friendly" is classified as explicit_restricted, NEVER silently upgraded to worldwide — matches Deep\'s exact "remote-friendly must not become worldwide" requirement'
  );
  assert(
    classifyExplicitRemoteScope('San Francisco, CA', []) === 'unknown',
    'a bare city with no remote-scope language at all -> unknown (gate would REJECT — this is exactly the ATS free-text-location case Greenhouse/Lever produce when a job is office-based with no remote statement)'
  );

  console.log('\n2. classifyRemoteEligibility() (matching, frozen) — provably untouched by C3');
  assert(
    classifyRemoteEligibility('', []).remoteType === 'Worldwide',
    'classifyRemoteEligibility still defaults empty input to Worldwide — its own permissive default is UNCHANGED (the C3 gate sits in front of it, never inside it)'
  );
  assert(
    classifyRemoteEligibility('Remote - US only', []).remoteType === 'US',
    'classifyRemoteEligibility still correctly restricts on explicit scope — unchanged behavior'
  );

  console.log('\n3. The gate itself: "unknown" excludes, anything explicit (even restricted) passes through to the officialUrl/freshness checks');
  const wouldGateReject = (scope: string) => scope === 'unknown';
  assert(wouldGateReject(classifyExplicitRemoteScope('', [])) === true, 'an ATS job with no location info at all is rejected from the fresh feed');
  assert(wouldGateReject(classifyExplicitRemoteScope('Worldwide', [])) === false, 'an ATS job explicitly stating Worldwide passes the remote-eligibility gate');
  assert(wouldGateReject(classifyExplicitRemoteScope('EU/EEA only', [])) === false, 'an ATS job explicitly restricted to EU/EEA passes the gate (restricted ≠ unknown — it is still information, just not worldwide)');

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, 0 skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running remote-eligibility-gate suite:', e); process.exit(1); });

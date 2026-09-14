/**
 * Supply Discovery gate C3 — 48-hour freshness gate.
 * Pure function, no infrastructure — exhaustive coverage of
 * docs/c3-implementation-plan.md §7a's acceptance table exactly.
 */
import { passesFreshnessGate, FRESHNESS_WINDOW_MS } from '../src/lib/ingestion/freshness-gate';

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

function hoursAgo(h: number, now: number): string {
  return new Date(now - h * 3600 * 1000).toISOString();
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C3 — 48-HOUR FRESHNESS GATE');
  console.log('==============================================================================\n');

  const now = Date.now();

  console.log('1. Deep\'s exact acceptance table');
  assert(passesFreshnessGate(hoursAgo(3, now), now) === true, '3 hours ago -> accept');
  assert(passesFreshnessGate(hoursAgo(24, now), now) === true, '24 hours ago -> accept');
  assert(passesFreshnessGate(hoursAgo(47.983, now), now) === true, '47h59m ago -> accept');
  assert(passesFreshnessGate(hoursAgo(48, now), now) === true, 'exactly 48h ago -> accept (inclusive boundary: "no more than 48 hours old")');
  assert(passesFreshnessGate(hoursAgo(48.017, now), now) === false, '48h + 1 minute ago -> reject');
  assert(passesFreshnessGate(hoursAgo(72, now), now) === false, '72h ago -> reject');
  assert(passesFreshnessGate(null, now) === false, 'null (unknown) -> reject');
  assert(passesFreshnessGate(undefined, now) === false, 'undefined (unknown) -> reject');
  assert(passesFreshnessGate('', now) === false, 'empty string (unknown) -> reject');
  assert(passesFreshnessGate('not-a-date', now) === false, 'unparseable string -> reject');
  assert(passesFreshnessGate('2026-13-45T99:99:99Z', now) === false, 'malformed ISO string -> reject');
  assert(passesFreshnessGate(new Date(now + 3600 * 1000).toISOString(), now) === false, 'future date (1h ahead) -> reject');
  assert(passesFreshnessGate(new Date(now + 30 * 24 * 3600 * 1000).toISOString(), now) === false, 'far-future date -> reject');

  console.log('\n2. Boundary precision');
  assert(FRESHNESS_WINDOW_MS === 48 * 3600 * 1000, 'FRESHNESS_WINDOW_MS is exactly 48 hours in ms');
  assert(passesFreshnessGate(hoursAgo(47.99999, now), now) === true, '1 second inside the 48h window -> accept');
  assert(passesFreshnessGate(new Date(now - FRESHNESS_WINDOW_MS).toISOString(), now) === true, 'exactly at now - FRESHNESS_WINDOW_MS -> accept (inclusive lower bound)');
  assert(passesFreshnessGate(new Date(now - FRESHNESS_WINDOW_MS - 1).toISOString(), now) === false, '1ms past the window -> reject');
  assert(passesFreshnessGate(new Date(now).toISOString(), now) === true, 'posted at exactly now -> accept');

  console.log('\n3. No inferred "probably new"');
  assert(passesFreshnessGate('2020-01-01T00:00:00Z', now) === false, 'a genuinely old date is never treated as fresh regardless of format validity');

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, 0 skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running freshness-gate suite:', e); process.exit(1); });

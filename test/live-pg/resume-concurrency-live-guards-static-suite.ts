/**
 * Resume Intelligence (PR B) — static tests for the live-concurrency harness's SAFETY GUARDS only.
 *
 * These tests exercise live-pg-guards.ts (pure functions, no `pg`, no database) and do a source-
 * pattern check on resume-concurrency-live-suite.ts's cleanup statements. They prove the guard
 * LOGIC rejects a wrong target / a missing confirmation / a missing-or-mismatched marker, and that
 * the cleanup SQL never references a hardcoded id. They prove NOTHING about real PostgreSQL
 * behavior, real concurrency, or real locking — that is a separate, still-UNPROVEN claim (see
 * docs/resume-pr-b-final-audit-2026-10-22.md §2.3) which only actually running
 * resume-concurrency-live-suite.ts against a disposable database can establish. Do not cite this
 * suite's pass as evidence of live concurrency.
 *
 * No `pg` import anywhere in this file — runs with zero installs.
 * Run: npx tsx test/live-pg/resume-concurrency-live-guards-static-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  checkConnectionStringIsSafe,
  checkConfirmationFlag,
  checkMarkerMatches,
  runAllPreflightChecks,
  REQUIRED_CONFIRMATION,
} from './live-pg-guards';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  console.log('='.repeat(78));
  console.log('LIVE-CONCURRENCY HARNESS — SAFETY GUARD STATIC TESTS (not a DB/concurrency proof)');
  console.log('='.repeat(78));

  console.log('\n1. Wrong-target rejection (connection-string denylist — secondary check)');
  assert(!checkConnectionStringIsSafe('postgres://user:pw@db.supabase.co:5432/postgres').ok, 'a supabase.co URL is rejected');
  assert(!checkConnectionStringIsSafe('postgres://user:pw@xyz.railway.app:5432/postgres').ok, 'a railway.app URL is rejected');
  assert(!checkConnectionStringIsSafe('postgres://user:pw@db/paidtest').ok, 'a URL containing "paidtest" is rejected');
  assert(!checkConnectionStringIsSafe('postgres://user:pw@remotematch.online/db').ok, 'a URL containing "remotematch" is rejected');
  assert(checkConnectionStringIsSafe('postgres://user:pw@localhost:5432/resume_pr_b_disposable').ok, 'a plain local disposable-looking URL passes the cheap check (this alone is NOT sufficient — see test 3)');

  console.log('\n2. Explicit-confirmation rejection (not a boolean flag)');
  assert(!checkConfirmationFlag(undefined).ok, 'undefined is rejected');
  assert(!checkConfirmationFlag('true').ok, 'the string "true" is rejected (must be the exact sentence, not a boolean-ish value)');
  assert(!checkConfirmationFlag('yes').ok, 'the string "yes" is rejected');
  assert(!checkConfirmationFlag('1').ok, 'the string "1" is rejected');
  assert(!checkConfirmationFlag(REQUIRED_CONFIRMATION + ' ').ok, 'a near-match with trailing whitespace is rejected (exact match only)');
  assert(checkConfirmationFlag(REQUIRED_CONFIRMATION).ok, 'the exact required confirmation string passes');

  console.log('\n3. Pre-existing/missing/mismatched-marker rejection (the positive target-identity check)');
  assert(!checkMarkerMatches(null, 'run-123').ok, 'no marker row at all is rejected (database was never bootstrapped for this run)');
  assert(!checkMarkerMatches(undefined, 'run-123').ok, 'undefined marker row is rejected');
  assert(!checkMarkerMatches({ run_tag: 'run-999', profile_id: 'p1' }, 'run-123').ok, 'a marker row for a DIFFERENT run_tag is rejected (wrong/stale database)');
  assert(!checkMarkerMatches({ run_tag: 'run-123', profile_id: '' }, 'run-123').ok, 'a marker row with an empty profile_id is rejected');
  assert(!checkMarkerMatches({ run_tag: 'run-123', profile_id: 'p1' }, '').ok, 'an empty expected run_tag (LIVE_PG_TEST_RUN_TAG unset) is rejected even if some marker row is passed in');
  const okResult = checkMarkerMatches({ run_tag: 'run-123', profile_id: 'p1' }, 'run-123');
  assert(okResult.ok === true && okResult.profileId === 'p1', 'a matching marker row passes and returns the real profile_id (never a hardcoded fallback)');

  console.log('\n4. Combined preflight — fail-closed ordering (any single failure blocks the whole run)');
  {
    const r1 = runAllPreflightChecks({ url: 'postgres://x/paidtest', confirmValue: REQUIRED_CONFIRMATION, markerRow: { run_tag: 'r', profile_id: 'p' }, expectedRunTag: 'r' });
    assert(!r1.ok, 'a forbidden host fails the combined check even when confirmation and marker are both otherwise valid');
    const r2 = runAllPreflightChecks({ url: 'postgres://localhost/db', confirmValue: 'nope', markerRow: { run_tag: 'r', profile_id: 'p' }, expectedRunTag: 'r' });
    assert(!r2.ok, 'a wrong confirmation value fails the combined check even when the marker is otherwise valid');
    const r3 = runAllPreflightChecks({ url: 'postgres://localhost/db', confirmValue: REQUIRED_CONFIRMATION, markerRow: null, expectedRunTag: 'r' });
    assert(!r3.ok, 'a missing marker fails the combined check even when host and confirmation are both valid');
    const r4 = runAllPreflightChecks({ url: 'postgres://localhost/db', confirmValue: REQUIRED_CONFIRMATION, markerRow: { run_tag: 'r', profile_id: 'p' }, expectedRunTag: 'r' });
    assert(r4.ok === true && r4.profileId === 'p', 'all three checks passing together is required and sufficient for the combined helper to pass');
  }

  console.log('\n5. Cleanup isolation (source-pattern check on resume-concurrency-live-suite.ts — static only)');
  {
    const harnessSrc = readFileSync(join(__dirname, 'resume-concurrency-live-suite.ts'), 'utf8');
    const cleanupBlockMatch = harnessSrc.match(/\} finally \{([\s\S]*?)\n  \}\n\}/);
    assert(!!cleanupBlockMatch, 'the harness has a finally-block cleanup section to inspect');
    const cleanupBlock = cleanupBlockMatch?.[1] ?? '';
    const deleteStatements = cleanupBlock.match(/DELETE FROM[^`]*/g) ?? [];
    assert(deleteStatements.length >= 3, 'the cleanup block contains the expected DELETE statements', String(deleteStatements.length));
    const uuidLiteralPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const anyHardcodedUuidInDelete = deleteStatements.some((stmt) => uuidLiteralPattern.test(stmt));
    assert(!anyHardcodedUuidInDelete, 'no DELETE statement in the cleanup block contains a literal hardcoded UUID — every delete is parameterized ($1) against a runtime-derived id (profileId/otherProfileId)', JSON.stringify(deleteStatements));
    assert(cleanupBlock.includes('if (profileId)') && cleanupBlock.includes('if (otherProfileId)'), 'cleanup is gated on the ids this run actually populated, not unconditional');
    assert(!/DELETE FROM profiles;/.test(cleanupBlock) && !/TRUNCATE/i.test(cleanupBlock), 'cleanup never truncates or unconditionally deletes an entire table');
  }

  console.log('\n6. Bootstrap pgcrypto precondition (2026-10-22 fix review — structural, not behavioral)');
  {
    const bootstrapSrc = readFileSync(join(__dirname, '00-bootstrap.sql'), 'utf8');
    const preflightBlock = bootstrapSrc.slice(bootstrapSrc.indexOf('DO $preflight$'), bootstrapSrc.indexOf('$preflight$;') + 12);
    assert(/pg_extension WHERE extname = 'pgcrypto'/.test(preflightBlock), 'the preflight block checks for a pre-existing pgcrypto extension before the script creates one', preflightBlock.length ? undefined : 'preflight block not found');
    assert(/RAISE EXCEPTION 'SAFETY ABORT.*pgcrypto/.test(preflightBlock), 'a pre-existing pgcrypto extension aborts the whole bootstrap, consistent with every other precondition in this file');
    assert(!/CREATE EXTENSION IF NOT EXISTS pgcrypto/.test(bootstrapSrc), 'pgcrypto is no longer created with IF NOT EXISTS (which would have silently reused a pre-existing one) — it is a plain CREATE EXTENSION, like every other object in this file');
  }

  console.log('\n7. Connection-lifecycle invariant: a partial connect() failure still closes whichever client DID connect (structural)');
  {
    const harnessSrc = readFileSync(join(__dirname, 'resume-concurrency-live-suite.ts'), 'utf8');
    const connectRegion = harnessSrc.slice(harnessSrc.indexOf('let pgAConnected'), harnessSrc.indexOf('await pgB.connect()') + 40);
    assert(/let pgAConnected = false;/.test(harnessSrc) && /let pgBConnected = false;/.test(harnessSrc), 'each connection’s success is tracked independently, not assumed from the other');
    const tryIdx = harnessSrc.indexOf('try {', harnessSrc.indexOf('async function main'));
    const connectAIdx = harnessSrc.indexOf('await pgA.connect();');
    const connectBIdx = harnessSrc.indexOf('await pgB.connect();');
    assert(tryIdx > -1 && tryIdx < connectAIdx && connectAIdx < connectBIdx, 'both connect() calls happen INSIDE the try block (not before it), so a thrown connect() error is caught by this function’s own finally rather than skipping cleanup entirely');
    const finallyIdx = harnessSrc.indexOf('} finally {');
    const endAGuardIdx = harnessSrc.indexOf('if (pgAConnected) {', finallyIdx);
    const endBGuardIdx = harnessSrc.indexOf('if (pgBConnected) {', finallyIdx);
    assert(finallyIdx > -1 && endAGuardIdx > finallyIdx && endBGuardIdx > finallyIdx, 'the finally block closes each client independently, gated on that SPECIFIC client’s own connected flag — so if B never connected, only A (which did) is closed, never a blind pgA.end()+pgB.end() pair that assumes both succeeded');
    void connectRegion;
  }

  console.log('\n8. Cleanup-resilience invariant: one failed delete cannot silently skip the rest or hide a failure (structural)');
  {
    const harnessSrc = readFileSync(join(__dirname, 'resume-concurrency-live-suite.ts'), 'utf8');
    const finallyBlock = harnessSrc.slice(harnessSrc.indexOf('} finally {'), harnessSrc.lastIndexOf('}\n}'));
    assert(/tryCleanupStep = async/.test(finallyBlock), 'cleanup steps go through a shared per-step try/catch helper rather than one unguarded sequence of awaits');
    const cleanupCallCount = (finallyBlock.match(/tryCleanupStep\(/g) ?? []).length;
    assert(cleanupCallCount >= 4, 'at least 4 cleanup steps (resume_analyses, resume_versions, primary profile, marker row) each go through the independent-failure helper', String(cleanupCallCount));
    assert(/cleanupFailures\.push/.test(finallyBlock), 'a failed step is recorded rather than thrown/swallowed, so it cannot silently abort the remaining cleanup steps');
    assert(/CLEANUP INCOMPLETE/.test(finallyBlock), 'any recorded failure is surfaced to stderr explicitly — the suite never reports "cleanup completed" when a step actually failed');
    assert(/else if \(profileId \|\| otherProfileId\)/.test(finallyBlock) && /Cleanup completed/.test(finallyBlock), 'the success message is only printed in the branch where NO failures were recorded (mutually exclusive with the failure-reporting branch above it)');
    assert(/if \(pgAConnected\) \{\s*\n\s*try \{ await pgA\.end\(\); \}/.test(finallyBlock), 'closing connection A is itself wrapped in try/catch, so a close failure cannot prevent connection B from also being closed');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  console.log('\nReminder: this suite proves guard LOGIC only. It does not touch a database and does');
  console.log('not prove PostgreSQL concurrency, locking, or migration 036’s live behavior.');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

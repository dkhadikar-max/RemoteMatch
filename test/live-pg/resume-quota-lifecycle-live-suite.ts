/**
 * Resume Intelligence (PR B) — LIVE PostgreSQL validation of migration 040's quota lifecycle
 * (reserve_resume_analysis/refund_resume_analysis + upsert_resume_analysis's attempt_number).
 *
 * Stage 3 of the quota-lifecycle rollout (authorized separately from Stage 2's local
 * implementation): proves the RPCs' actual transactional/concurrency/RLS behavior against a real
 * PostgreSQL 18 instance — exactly what test/resume-pr-b-quota-lifecycle-migration-static-suite.ts
 * (source-pattern only) and test/resume-pr-b-quota-lifecycle-application-suite.ts (mocked
 * SupabaseClient) cannot establish on their own.
 *
 * Same safety discipline as test/live-pg/resume-concurrency-live-suite.ts (live-pg-guards.ts: host
 * denylist + exact confirmation string + a marker row this run's own 00-bootstrap.sql wrote). Calls
 * the RPCs directly via `pg.Client` (not through analyzeResume()) — this suite is scoped to
 * migration 040's own objects, not a re-run of the full pipeline.
 *
 * Required env vars (all three; the harness exits before connecting if any is missing/wrong):
 *   LIVE_PG_TEST_DATABASE_URL        — the disposable database's connection string
 *   LIVE_PG_TEST_RUN_TAG             — must exactly match the run_tag passed to 00-bootstrap.sql
 *   LIVE_PG_TEST_CONFIRM_DISPOSABLE  — must be the exact string live-pg-guards.ts#REQUIRED_CONFIRMATION
 */
import { Client } from 'pg';
import { createHash, randomUUID } from 'crypto';
import { checkConnectionStringIsSafe, checkConfirmationFlag, runAllPreflightChecks, type MarkerRow } from './live-pg-guards';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function sha256(s: string) { return createHash('sha256').update(s).digest('hex'); }

interface RpcResult { result: string; allowed?: boolean; limit?: number; remaining?: number; planTier?: string }

async function rpcReserve(client: Client, analysisId: string, attemptNumber: number | null): Promise<RpcResult> {
  const res = await client.query('SELECT * FROM reserve_resume_analysis($1, $2)', [analysisId, attemptNumber]);
  return res.rows[0].reserve_resume_analysis as RpcResult;
}
async function rpcRefund(client: Client, analysisId: string, attemptNumber: number | null, reason: string): Promise<RpcResult> {
  const res = await client.query('SELECT * FROM refund_resume_analysis($1, $2, $3)', [analysisId, attemptNumber, reason]);
  return res.rows[0].refund_resume_analysis as RpcResult;
}
/** Migration 041 trimmed upsert_resume_analysis to claim-only (5 params, always 'pending'
 *  internally -- it no longer accepts a status at all). */
async function rpcClaim(client: Client, versionId: string): Promise<{ id: string; wrote: boolean; attempt_number: number }> {
  const res = await client.query(
    `SELECT * FROM upsert_resume_analysis($1,$2,$3,$4,$5)`,
    [versionId, 'general', null, '', 'live-test-v1']
  );
  return res.rows[0] as unknown as { id: string; wrote: boolean; attempt_number: number };
}
/** Migration 041's new finalize_resume_analysis() -- the ONLY RPC that ever writes a terminal
 *  status, and the only one that enforces attempt ownership (expectedAttemptNumber must still be
 *  current, and the row must still be 'pending', or it returns stale_attempt and writes nothing). */
async function rpcFinalize(client: Client, analysisId: string, expectedAttemptNumber: number | null, status: 'success' | 'unavailable', result: unknown = null): Promise<{ id: string; finalized: boolean; result: string }> {
  const res = await client.query(
    `SELECT * FROM finalize_resume_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [analysisId, expectedAttemptNumber, status, result ? JSON.stringify(result) : null, false, null, null, null, null]
  );
  return res.rows[0] as unknown as { id: string; finalized: boolean; result: string };
}
async function createVersionAndClaim(client: Client, uid: string): Promise<{ versionId: string; analysisId: string; attemptNumber: number }> {
  const content = `Live test resume ${randomUUID()}`;
  const digest = sha256(content);
  const verRes = await client.query('SELECT * FROM create_resume_version($1,$2,$3)', [content, digest, 'paste']);
  const versionId = verRes.rows[0].create_resume_version as string;
  const claim = await rpcClaim(client, versionId);
  if (!claim.wrote) throw new Error('setup: pending claim was not written');
  return { versionId, analysisId: claim.id, attemptNumber: claim.attempt_number };
}
async function getCount(admin: Client, uid: string): Promise<number> {
  const res = await admin.query('SELECT daily_resume_analyses_count FROM profiles WHERE id = $1', [uid]);
  return res.rows[0].daily_resume_analyses_count as number;
}
async function getEventCount(admin: Client, analysisId: string, attemptNumber: number, eventType: string): Promise<number> {
  const res = await admin.query(
    'SELECT count(*)::int AS n FROM resume_quota_events WHERE analysis_id = $1 AND attempt_number = $2 AND event_type = $3',
    [analysisId, attemptNumber, eventType]
  );
  return res.rows[0].n as number;
}
async function getTotalEventCount(admin: Client, analysisId: string): Promise<number> {
  const res = await admin.query('SELECT count(*)::int AS n FROM resume_quota_events WHERE analysis_id = $1', [analysisId]);
  return res.rows[0].n as number;
}
async function getAnalysisRow(admin: Client, analysisId: string): Promise<{ attemptNumber: number; createdAt: Date }> {
  const res = await admin.query('SELECT attempt_number, created_at FROM resume_analyses WHERE id = $1', [analysisId]);
  return { attemptNumber: res.rows[0].attempt_number as number, createdAt: res.rows[0].created_at as Date };
}

/** Each scenario gets its OWN fresh profile (admin-created, bypassing RLS as superuser) rather
 *  than sharing the single marker-row profile across all 8 scenarios. Without this, scenarios
 *  that deliberately leave a reservation un-refunded (1, 2, 5, 6, 7, 8) would exhaust the
 *  free-tier daily limit (2) partway through the suite, and scenario 5's deliberate usage_date
 *  mutation would otherwise leak into every later scenario sharing that same row. This mirrors
 *  production reality (every real analysis belongs to some specific user) rather than being a
 *  shortcut — it is not weakening what each scenario proves. */
async function freshProfile(admin: Client, planTier: 'free' | 'pro' = 'free'): Promise<string> {
  const uid = randomUUID();
  await admin.query('INSERT INTO profiles (id, plan_tier) VALUES ($1, $2)', [uid, planTier]);
  return uid;
}
async function asUser(client: Client, uid: string, role: 'authenticated' | 'anon' = 'authenticated'): Promise<void> {
  await client.query(`SET request.jwt.claims = '${JSON.stringify({ sub: uid, role })}'`);
  await client.query(`SET ROLE ${role}`);
}

async function main() {
  const url = process.env.LIVE_PG_TEST_DATABASE_URL;
  const runTag = process.env.LIVE_PG_TEST_RUN_TAG ?? '';
  const confirm = process.env.LIVE_PG_TEST_CONFIRM_DISPOSABLE;

  if (!url) { console.error('LIVE_PG_TEST_DATABASE_URL is required.'); process.exitCode = 2; return; }
  const hostCheck = checkConnectionStringIsSafe(url);
  if (!hostCheck.ok) { console.error(hostCheck.reason); process.exitCode = 2; return; }
  const confirmCheck = checkConfirmationFlag(confirm);
  if (!confirmCheck.ok) { console.error(confirmCheck.reason); process.exitCode = 2; return; }

  const admin = new Client({ connectionString: url });
  let pgA: Client | undefined;
  let pgB: Client | undefined;
  let pgAnon: Client | undefined;
  try {
    await admin.connect();
    // Filtered by the expected run_tag directly (not a bare LIMIT 1) -- a re-seeded marker table
    // can hold more than one row across repeated runs against the same disposable database, and
    // an unfiltered LIMIT 1 is not guaranteed to return the one THIS run actually expects.
    const markerRes = await admin.query('SELECT run_tag, profile_id FROM public._resume_pr_b_live_audit_run WHERE run_tag = $1 LIMIT 1', [runTag]);
    const markerRow = (markerRes.rows[0] as unknown as MarkerRow | undefined) ?? null;
    const preflight = runAllPreflightChecks({ url, confirmValue: confirm, markerRow, expectedRunTag: runTag });
    if (!preflight.ok) { console.error(preflight.reason); process.exitCode = 2; return; }
    const markerProfileId = preflight.profileId as string;

    console.log('='.repeat(78));
    console.log('RESUME INTELLIGENCE (PR B) — LIVE QUOTA LIFECYCLE VALIDATION (migration 040)');
    console.log(`Target: disposable database only, marker profile ${markerProfileId}, run_tag ${runTag}`);
    console.log('='.repeat(78));

    pgA = new Client({ connectionString: url });
    pgB = new Client({ connectionString: url });
    pgAnon = new Client({ connectionString: url });
    await pgA.connect(); await pgB.connect(); await pgAnon.connect();

    console.log('\n1. Concurrent reservations for the same attempt — exactly one wins');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const before = await getCount(admin, uid);
      const [rA, rB] = await Promise.all([
        rpcReserve(pgA, analysisId, attemptNumber),
        rpcReserve(pgB, analysisId, attemptNumber),
      ]);
      const results = [rA.result, rB.result].sort();
      assert(JSON.stringify(results) === JSON.stringify(['already_reserved', 'reserved']), 'exactly one concurrent reserve wins (reserved), the other sees already_reserved', JSON.stringify([rA.result, rB.result]));
      const after = await getCount(admin, uid);
      assert(after === before + 1, 'the daily counter was incremented exactly once, not twice, by the race', `before=${before} after=${after}`);
      const eventCount = await getEventCount(admin, analysisId, attemptNumber, 'reserved');
      assert(eventCount === 1, 'exactly one reserved event row exists for this attempt despite two concurrent callers', `found ${eventCount}`);
    }

    console.log('\n2. Duplicate reservation after a simulated timeout (sequential retry)');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const r1 = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r1.result === 'reserved', 'first reservation succeeds');
      const before = await getCount(admin, uid);
      const r2 = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r2.result === 'already_reserved', 'the client\'s retry (same analysis+attempt) after a simulated dropped response is idempotent', r2.result);
      const after = await getCount(admin, uid);
      assert(after === before, 'the retry does not increment the counter a second time', `before=${before} after=${after}`);
    }

    console.log('\n3. Concurrent duplicate refunds — exactly one applies');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const r1 = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r1.result === 'reserved', 'setup: reservation succeeds before the refund race');
      const before = await getCount(admin, uid);
      const [fA, fB] = await Promise.all([
        rpcRefund(pgA, analysisId, attemptNumber, 'concurrent_refund_test'),
        rpcRefund(pgB, analysisId, attemptNumber, 'concurrent_refund_test'),
      ]);
      const results = [fA.result, fB.result].sort();
      assert(JSON.stringify(results) === JSON.stringify(['already_refunded', 'refunded']), 'exactly one concurrent refund applies (refunded), the other sees already_refunded', JSON.stringify([fA.result, fB.result]));
      const after = await getCount(admin, uid);
      assert(after === before - 1, 'the counter is decremented exactly once by the race, never twice', `before=${before} after=${after}`);
    }

    console.log('\n4. Historical refund after a newer attempt has been claimed on the same row');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      assert(attemptNumber === 1, 'setup: fresh key starts at attempt 1', String(attemptNumber));
      const r1 = await rpcReserve(pgA, analysisId, 1);
      assert(r1.result === 'reserved', 'attempt 1 is reserved');
      const finalize1 = await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      assert(finalize1.finalized === true && finalize1.result === 'finalized', 'finalizing attempt 1 to a terminal status succeeds (ownership still valid: attempt 1 is current and the row is pending)', JSON.stringify(finalize1));
      const afterFinalize1 = await getAnalysisRow(admin, analysisId);
      assert(afterFinalize1.attemptNumber === 1, 'migration 041: finalize_resume_analysis never advances attempt_number -- it stays 1 even after a successful finalize', String(afterFinalize1.attemptNumber));
      const reclaim = await rpcClaim(pgA, versionId);
      assert(reclaim.wrote === true && reclaim.attempt_number === 2, 'a fresh pending claim on the now-terminal row reclaims it as attempt 2 (migration 041: finalize no longer advances attempt_number, so the claim/reclaim path is the ONLY increment now)', JSON.stringify(reclaim));
      const afterReclaim = await getAnalysisRow(admin, analysisId);
      assert(Date.now() - afterReclaim.createdAt.getTime() < 10_000, 'case 1-5: a terminal-row retry also refreshes created_at to ~now', afterReclaim.createdAt.toISOString());

      const staleReserve = await rpcReserve(pgA, analysisId, 1);
      assert(staleReserve.result === 'stale_attempt', 'reservation against the now-superseded attempt 1 is correctly rejected as stale', staleReserve.result);

      const beforeRefund = await getCount(admin, uid);
      const histRefund = await rpcRefund(pgA, analysisId, 1, 'historical_refund_test');
      assert(histRefund.result === 'refunded', 'refunding attempt 1 (superseded by attempt 2) succeeds — refund does not require currency', histRefund.result);
      const afterRefund = await getCount(admin, uid);
      assert(afterRefund === beforeRefund - 1, 'the historical refund still decrements the live counter (same-day reservation)', `before=${beforeRefund} after=${afterRefund}`);
    }

    console.log('\n5. Refund after a day rollover does not touch the new period\'s counter');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const r1 = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r1.result === 'reserved', 'setup: reservation succeeds (usage_date recorded as the real current day)');

      // Simulate: by the time this refund call arrives, some OTHER already-happened reserve call
      // has already lazily rolled the profile forward into a new period. Direct, deliberate
      // test-only state mutation (bypassing the RPCs) to model the passage of a day without
      // waiting for one, or touching the server clock.
      await admin.query(`UPDATE profiles SET usage_date = usage_date + 1 WHERE id = $1`, [uid]);
      const beforeRefund = await getCount(admin, uid);
      const refund = await rpcRefund(pgA, analysisId, attemptNumber, 'cross_day_refund_test');
      assert(refund.result === 'refunded', 'the refund still succeeds and records the event after the simulated rollover', refund.result);
      const afterRefund = await getCount(admin, uid);
      assert(afterRefund === beforeRefund, 'the new period\'s counter is NOT decremented — the reservation belonged to an already-rolled-over period', `before=${beforeRefund} after=${afterRefund}`);
    }

    console.log('\n6. Stale pending recovery (3-minute window) correctly advances attempt_number');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      assert(attemptNumber === 1, 'setup: fresh key starts at attempt 1');
      // Backdate the claim past the 3-minute exclusion window (test-only, direct admin mutation —
      // the function itself never backdates anything; this models real elapsed time).
      await admin.query(`UPDATE resume_analyses SET created_at = now() - interval '4 minutes' WHERE id = $1`, [analysisId]);
      const reclaim = await rpcClaim(pgA, versionId);
      assert(reclaim.wrote === true && reclaim.attempt_number === 2, 'a stale (>3min) pending claim is correctly reclaimed, advancing to attempt 2', JSON.stringify(reclaim));
      const afterReclaim = await getAnalysisRow(admin, analysisId);
      assert(Date.now() - afterReclaim.createdAt.getTime() < 10_000, 'case 1-3/1-5: created_at is refreshed to ~now on the stale-pending reclaim, not left at the 4-minute-old backdated value', afterReclaim.createdAt.toISOString());

      const staleReserve = await rpcReserve(pgA, analysisId, 1);
      assert(staleReserve.result === 'stale_attempt', 'reserving against the superseded attempt 1 is rejected as stale');
      const freshReserve = await rpcReserve(pgA, analysisId, 2);
      assert(freshReserve.result === 'reserved', 'reserving against the current attempt 2 succeeds', freshReserve.result);
    }

    console.log('\n9. Case 1-2: an active (not yet expired) pending claim is rejected WITHOUT changing attempt_number or created_at');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { versionId, analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const before = await getAnalysisRow(admin, analysisId);
      assert(before.attemptNumber === 1, 'setup: fresh key starts at attempt 1');
      // A second caller (pgB, same uid -- the double-click/second-tab case) tries to claim the
      // SAME key while the first claim is still well inside its 3-minute live window.
      const second = await rpcClaim(pgB, versionId);
      assert(second.wrote === false, 'the second, immediate claim attempt is rejected (an active pending claim is not stolen)', JSON.stringify(second));
      const after = await getAnalysisRow(admin, analysisId);
      assert(after.attemptNumber === before.attemptNumber, 'case 1-2: attempt_number is byte-unchanged by the rejected claim', `before=${before.attemptNumber} after=${after.attemptNumber}`);
      assert(after.createdAt.getTime() === before.createdAt.getTime(), 'case 1-2: created_at is byte-unchanged by the rejected claim (no write happened at all)', `before=${before.createdAt.toISOString()} after=${after.createdAt.toISOString()}`);
      assert(attemptNumber === second.attempt_number, 'the rejected call still reports the real, current attempt_number (not a guess)', String(second.attempt_number));
    }

    console.log('\n10. Case 1-4: the created_at refresh actually re-arms the 3-minute window on a just-recovered row');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      // Backdate past the window, same setup as scenario 6, then reclaim it.
      await admin.query(`UPDATE resume_analyses SET created_at = now() - interval '4 minutes' WHERE id = $1`, [analysisId]);
      const recovered = await rpcClaim(pgA, versionId);
      assert(recovered.wrote === true && recovered.attempt_number === 2, 'setup: the stale claim is recovered as attempt 2');
      // Immediately -- not backdated this time -- a THIRD party (pgB) tries to claim the same key.
      // If created_at had NOT been refreshed by the recovery above, this would incorrectly succeed
      // (the row would still look >3min stale). This is the one case that actually exercises why
      // the created_at-refresh fix exists.
      const thirdParty = await rpcClaim(pgB, versionId);
      assert(thirdParty.wrote === false, 'case 1-4: a third claimant arriving immediately after recovery CANNOT reclaim the just-recovered row -- the refreshed created_at correctly protects the new 3-minute window', JSON.stringify(thirdParty));
      assert(thirdParty.attempt_number === 2, 'the rejected third-party call reports the real current attempt (2), not a fabricated one', String(thirdParty.attempt_number));
    }

    console.log('\n11. Case 1-7: a rejected/failed claim creates NO resume_quota_events row at all');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      // Reject a second claim (same shape as scenario 9) -- deliberately never call reserve for
      // either side of this.
      const rejected = await rpcClaim(pgB, versionId);
      assert(rejected.wrote === false, 'setup: the second claim is rejected, exactly as in case 1-2');
      const totalEvents = await getTotalEventCount(admin, analysisId);
      assert(totalEvents === 0, 'case 1-7: zero resume_quota_events rows exist for this analysis -- a rejected claim never reaches reserve_resume_analysis, at the database level, not just by application-layer convention', `found ${totalEvents}`);
    }

    console.log('\n12. Acceptance criterion 6: concurrent reserve AND refund calls for the SAME attempt never diverge counter from event history');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const before = await getCount(admin, uid);
      // Genuinely concurrent: one connection reserves attempt N for the first time while another
      // simultaneously tries to refund that SAME, not-yet-necessarily-reserved attempt. Both valid
      // interleavings (refund loses the race to a not-yet-existing reservation -> no_reservation,
      // or refund runs after reserve has already committed -> refunded) are acceptable; what must
      // never happen is the counter and the event history disagreeing.
      const [reserveResult, refundResult] = await Promise.all([
        rpcReserve(pgA, analysisId, attemptNumber),
        rpcRefund(pgB, analysisId, attemptNumber, 'concurrent_reserve_refund_race'),
      ]);
      assert(reserveResult.result === 'reserved', 'the reserve side of the race always succeeds (nothing could have beaten it to the reservation)', reserveResult.result);
      assert(['no_reservation', 'refunded'].includes(refundResult.result), 'the refund side resolves to one of the two valid interleavings, never an error or a corrupted state', refundResult.result);
      const after = await getCount(admin, uid);
      const reservedEvents = await getEventCount(admin, analysisId, attemptNumber, 'reserved');
      const refundedEvents = await getEventCount(admin, analysisId, attemptNumber, 'refunded');
      assert(reservedEvents === 1, 'exactly one reserved event exists regardless of interleaving', String(reservedEvents));
      if (refundResult.result === 'refunded') {
        assert(refundedEvents === 1 && after === before, 'when the refund wins the interleaving, the counter nets back to its starting value and exactly one refunded event exists', `after=${after} before=${before} refundedEvents=${refundedEvents}`);
      } else {
        assert(refundedEvents === 0 && after === before + 1, 'when the refund loses the interleaving (no_reservation), the counter reflects just the reservation and no refunded event was created', `after=${after} before=${before} refundedEvents=${refundedEvents}`);
      }
    }

    console.log('\n7. A failed event insertion rolls back the ENTIRE transaction, including the counter update');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const r1 = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r1.result === 'reserved', 'setup: reservation succeeds, establishing an existing reserved event');
      const before = await getCount(admin, uid);

      // Deliberately bypass the RPC's own idempotency check (which would normally prevent this)
      // to directly exercise the UNIQUE constraint as the last-resort backstop: one transaction,
      // an UPDATE that would succeed on its own, followed by an INSERT that must fail (duplicate
      // key). Proves the whole transaction aborts atomically, not just the failing statement.
      let threwUniqueViolation = false;
      try {
        await admin.query('BEGIN');
        await admin.query('UPDATE profiles SET daily_resume_analyses_count = daily_resume_analyses_count + 1 WHERE id = $1', [uid]);
        await admin.query(
          `INSERT INTO resume_quota_events (analysis_id, attempt_number, event_type, usage_date, reason) VALUES ($1, $2, 'reserved', current_date, NULL)`,
          [analysisId, attemptNumber]
        );
        await admin.query('COMMIT');
      } catch (err) {
        await admin.query('ROLLBACK');
        threwUniqueViolation = (err as { code?: string }).code === '23505';
      }
      assert(threwUniqueViolation, 'the duplicate event insert fails with a real unique-violation (23505), not silently');
      const after = await getCount(admin, uid);
      assert(after === before, 'the counter UPDATE earlier in the SAME aborted transaction was rolled back too — no partial state survives', `before=${before} after=${after}`);
    }

    console.log('\n8. RLS and privilege enforcement on resume_quota_events + the RPCs themselves');
    {
      const uidB = await freshProfile(admin);
      await asUser(pgB, uidB);
      await asUser(pgAnon, randomUUID(), 'anon');
      let deniedSelect = false;
      try { await pgB.query('SELECT * FROM resume_quota_events LIMIT 1'); } catch (err) { deniedSelect = (err as { code?: string }).code === '42501'; }
      assert(deniedSelect, 'authenticated cannot directly SELECT resume_quota_events (REVOKE + RLS)');

      let deniedInsert = false;
      try {
        await pgB.query(
          `INSERT INTO resume_quota_events (analysis_id, attempt_number, event_type, usage_date, reason) VALUES (gen_random_uuid(), 1, 'reserved', current_date, NULL)`
        );
      } catch (err) { deniedInsert = (err as { code?: string }).code === '42501'; }
      assert(deniedInsert, 'authenticated cannot directly INSERT into resume_quota_events');

      let anonDeniedReserve = false;
      try { await pgAnon.query('SELECT * FROM reserve_resume_analysis($1, $2)', [randomUUID(), 1]); } catch (err) { anonDeniedReserve = (err as { code?: string }).code === '42501'; }
      assert(anonDeniedReserve, 'anon has no EXECUTE grant on reserve_resume_analysis');

      let anonDeniedRefund = false;
      try { await pgAnon.query('SELECT * FROM refund_resume_analysis($1, $2, $3)', [randomUUID(), 1, 'x']); } catch (err) { anonDeniedRefund = (err as { code?: string }).code === '42501'; }
      assert(anonDeniedRefund, 'anon has no EXECUTE grant on refund_resume_analysis');

      const uidReserve = await freshProfile(admin);
      await asUser(pgA, uidReserve);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uidReserve);
      const r = await rpcReserve(pgA, analysisId, attemptNumber);
      assert(r.result === 'reserved', 'authenticated DOES have EXECUTE on reserve_resume_analysis and it behaves correctly end to end');
    }

    // ============================================================================================
    // Migration 041 (Stage 6 ownership-aware finalization fix, 2026-11-02) -- Deep's 8 required
    // regression scenarios, run live against a real PostgreSQL instance. Scenarios 13-15 share one
    // setup shape (claim attempt 1, finalize it to 'unavailable', reclaim as attempt 2) since all
    // three are really the same question -- "can a stale attempt 1 clobber attempt 2's CURRENT
    // state" -- asked against the 3 different states attempt 2 can be in.
    // ============================================================================================

    console.log('\n13. Attempt 1 cannot overwrite attempt 2\'s pending state');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      const reclaim = await rpcClaim(pgA, versionId);
      assert(reclaim.attempt_number === 2, 'setup: reclaimed as attempt 2, currently pending', JSON.stringify(reclaim));
      const staleFinalize = await rpcFinalize(pgA, analysisId, 1, 'success', { stale: true });
      assert(staleFinalize.result === 'stale_attempt', 'the stale attempt-1 finalize is rejected -- attempt 2\'s live pending claim is never clobbered', JSON.stringify(staleFinalize));
      const after = await getAnalysisRow(admin, analysisId);
      assert(after.attemptNumber === 2, 'attempt_number is unchanged by the rejected stale finalize', String(after.attemptNumber));
      const row = await admin.query<{ status: string; result: any }>('SELECT status, result FROM resume_analyses WHERE id = $1', [analysisId]);
      assert(row.rows[0].status === 'pending' && row.rows[0].result === null, 'the row genuinely still shows attempt 2\'s pending state, not the stale attempt\'s content', JSON.stringify(row.rows[0]));
    }

    console.log('\n14. Attempt 1 cannot overwrite attempt 2\'s unavailable state');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      const reclaim = await rpcClaim(pgA, versionId);
      const finalize2 = await rpcFinalize(pgA, analysisId, 2, 'unavailable');
      assert(finalize2.finalized === true, 'setup: attempt 2 finalizes itself to unavailable');
      const staleFinalize = await rpcFinalize(pgA, analysisId, 1, 'success', { stale: true });
      assert(staleFinalize.result === 'stale_attempt', 'the stale attempt-1 finalize is rejected -- attempt 2\'s own unavailable result is never clobbered', JSON.stringify(staleFinalize));
      const row = await admin.query<{ status: string; result: any }>('SELECT status, result FROM resume_analyses WHERE id = $1', [analysisId]);
      assert(row.rows[0].status === 'unavailable' && row.rows[0].result === null, 'the row still shows attempt 2\'s own finalize, untouched', JSON.stringify(row.rows[0]));
    }

    console.log('\n15. Attempt 1 cannot overwrite attempt 2\'s successful result; attempt 2 finalizes correctly');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      await rpcClaim(pgA, versionId);
      const finalize2 = await rpcFinalize(pgA, analysisId, 2, 'success', { real: 'attempt-2-result' });
      assert(finalize2.finalized === true && finalize2.result === 'finalized', 'scenario 16 (attempt 2 finalizes its own result successfully)', JSON.stringify(finalize2));
      const staleFinalize = await rpcFinalize(pgA, analysisId, 1, 'success', { fake: 'stale-attempt-1-result' });
      assert(staleFinalize.result === 'stale_attempt', 'the stale attempt-1 finalize is rejected -- attempt 2\'s successful result is never clobbered', JSON.stringify(staleFinalize));
      const row = await admin.query<{ status: string; result: any }>('SELECT status, result FROM resume_analyses WHERE id = $1', [analysisId]);
      assert(row.rows[0].status === 'success' && row.rows[0].result?.real === 'attempt-2-result', 'the row shows attempt 2\'s own real result, not the stale attempt\'s fake one', JSON.stringify(row.rows[0]));
    }

    console.log('\n17. A stale FAILURE specifically cannot overwrite a newer SUCCESS (the most dangerous direction)');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      await rpcClaim(pgA, versionId);
      await rpcFinalize(pgA, analysisId, 2, 'success', { real: 'genuine-success' });
      // The stale attempt doesn't even need fabricated content here -- an 'unavailable' write,
      // the shape a slow/failed worker would actually send, must still be rejected.
      const staleFailure = await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      assert(staleFailure.result === 'stale_attempt', 'a stale FAILURE arriving late is rejected exactly the same as a stale success would be -- no special case either direction', JSON.stringify(staleFailure));
      const row = await admin.query<{ status: string; result: any }>('SELECT status, result FROM resume_analyses WHERE id = $1', [analysisId]);
      assert(row.rows[0].status === 'success' && row.rows[0].result?.real === 'genuine-success', 'the genuine success survives a late stale failure from an older attempt', JSON.stringify(row.rows[0]));
    }

    console.log('\n18. A stale finalization (success or rejected) never increments attempt_number');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const before = await getAnalysisRow(admin, analysisId);
      const ok = await rpcFinalize(pgA, analysisId, attemptNumber, 'success', { x: 1 });
      assert(ok.finalized === true, 'setup: the real, current finalize succeeds');
      const afterRealFinalize = await getAnalysisRow(admin, analysisId);
      assert(afterRealFinalize.attemptNumber === before.attemptNumber, 'a SUCCESSFUL finalize does not increment attempt_number either -- only claim/reclaim ever does', `before=${before.attemptNumber} after=${afterRealFinalize.attemptNumber}`);
      const staleRetry = await rpcFinalize(pgA, analysisId, attemptNumber, 'unavailable');
      assert(staleRetry.result === 'stale_attempt', 'a second finalize for the same (now already-finalized) attempt is itself rejected as stale (status is no longer pending)');
      const afterStale = await getAnalysisRow(admin, analysisId);
      assert(afterStale.attemptNumber === before.attemptNumber, 'the rejected stale retry also never increments attempt_number', `before=${before.attemptNumber} after=${afterStale.attemptNumber}`);
    }

    console.log('\n19. Concurrent finalization and reclaim preserve a single valid owner');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA, uid);
      // Backdate the still-'pending' claim past the 3-minute window WITHOUT finalizing it first --
      // this models the exact scenario Deep named: attempt 1's own (slow) worker is genuinely
      // still about to finalize for real, while ANOTHER caller now sees the row as abandoned and
      // tries to reclaim it, at the same moment.
      await admin.query(`UPDATE resume_analyses SET created_at = now() - interval '4 minutes' WHERE id = $1`, [analysisId]);
      const [finalizeOutcome, reclaimOutcome] = await Promise.all([
        rpcFinalize(pgA, analysisId, 1, 'success', { from: 'attempt-1-slow-worker' }),
        rpcClaim(pgB, versionId),
      ]);
      // Both orderings are valid (whichever acquires the row's FOR UPDATE lock first) -- what must
      // never happen is BOTH succeeding, or a corrupted/mixed final state.
      const finalizeWon = finalizeOutcome.result === 'finalized';
      const reclaimWon = reclaimOutcome.wrote === true;
      assert(finalizeWon !== reclaimWon, 'exactly one side of the race wins, never both and never neither', JSON.stringify({ finalizeOutcome, reclaimOutcome }));
      const row = await admin.query('SELECT status, attempt_number, result FROM resume_analyses WHERE id = $1', [analysisId]);
      if (finalizeWon) {
        assert(row.rows[0].status === 'success' && row.rows[0].attempt_number === 1, 'when finalize wins the race, the row is attempt 1\'s own genuine success -- the reclaim was correctly rejected by the prior-success-clobber guard', JSON.stringify(row.rows[0]));
      } else {
        assert(row.rows[0].status === 'pending' && row.rows[0].attempt_number === 2, 'when reclaim wins the race, the row is attempt 2\'s fresh pending claim -- the stale finalize was correctly rejected as stale_attempt', JSON.stringify(row.rows[0]));
      }
    }

    console.log('\n20. Existing successful-result protection remains intact under the trimmed claim function');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid); await asUser(pgB, uid);
      const { versionId, analysisId, attemptNumber } = await createVersionAndClaim(pgA, uid);
      const finalize1 = await rpcFinalize(pgA, analysisId, attemptNumber, 'success', { protected: true });
      assert(finalize1.finalized === true, 'setup: attempt 1 finalizes to success');
      const reclaimAttempt = await rpcClaim(pgB, versionId);
      assert(reclaimAttempt.wrote === false, 'a new claim attempt on an already-successful row is rejected by upsert_resume_analysis\'s own (unchanged) prior-success-clobber guard', JSON.stringify(reclaimAttempt));
      assert(reclaimAttempt.attempt_number === attemptNumber, 'the rejected claim reports the real, unchanged attempt_number of the successful row');
      const row = await admin.query<{ status: string; result: any }>('SELECT status, result FROM resume_analyses WHERE id = $1', [analysisId]);
      assert(row.rows[0].status === 'success' && row.rows[0].result?.protected === true, 'the successful result is completely untouched');
    }

    console.log(`\n${'='.repeat(78)}`);
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(78));
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await pgA?.end().catch(() => {});
    await pgB?.end().catch(() => {});
    await pgAnon?.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exitCode = 2; });

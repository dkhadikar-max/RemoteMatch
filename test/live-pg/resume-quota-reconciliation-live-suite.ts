/**
 * Resume Intelligence (PR B) — LIVE PostgreSQL validation of migration 042's durable
 * reconciliation sweep (reconcile_resume_quota_orphans()).
 *
 * Same safety discipline as the other test/live-pg/*.ts files (live-pg-guards.ts: host denylist
 * + exact confirmation string + a marker row this run's own 00-bootstrap.sql wrote).
 *
 * NOT covered here: a candidate that hits a genuinely unexpected SQL-level error, exercising the
 * function's own EXCEPTION WHEN OTHERS block. Manufacturing a real, safe, unexpected error for
 * exactly one specific candidate (without corrupting the disposable instance in some other way)
 * proved impractical -- every "break one candidate" approach tried either got caught gracefully
 * by the function's own already-handled branches (profile_not_found/already_refunded) or required
 * invasive schema changes outside this migration's scope. That per-candidate isolation rests on
 * PL/pgSQL's own well-established EXCEPTION-block/implicit-savepoint semantics, confirmed present
 * and correctly shaped by the static suite instead.
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

async function freshProfile(admin: Client, planTier: 'free' | 'pro' = 'free'): Promise<string> {
  const uid = randomUUID();
  await admin.query('INSERT INTO profiles (id, plan_tier) VALUES ($1, $2)', [uid, planTier]);
  return uid;
}
async function asUser(client: Client, uid: string): Promise<void> {
  await client.query(`SET request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}'`);
  await client.query('SET ROLE authenticated');
}
async function rpcClaim(client: Client, versionId: string): Promise<{ id: string; wrote: boolean; attempt_number: number }> {
  const res = await client.query('SELECT * FROM upsert_resume_analysis($1,$2,$3,$4,$5)', [versionId, 'general', null, '', 'reconcile-live-test-v1']);
  return res.rows[0] as unknown as { id: string; wrote: boolean; attempt_number: number };
}
async function rpcFinalize(client: Client, analysisId: string, expectedAttemptNumber: number, status: 'success' | 'unavailable'): Promise<{ finalized: boolean; result: string }> {
  const res = await client.query('SELECT * FROM finalize_resume_analysis($1,$2,$3,$4,$5,$6,$7,$8,$9)', [analysisId, expectedAttemptNumber, status, null, false, null, null, null, null]);
  return res.rows[0] as unknown as { finalized: boolean; result: string };
}
async function rpcReserve(client: Client, analysisId: string, attemptNumber: number): Promise<{ result: string }> {
  const res = await client.query('SELECT * FROM reserve_resume_analysis($1, $2)', [analysisId, attemptNumber]);
  return res.rows[0].reserve_resume_analysis as { result: string };
}
async function createVersionAndClaim(client: Client): Promise<{ versionId: string; analysisId: string; attemptNumber: number }> {
  const content = `Reconcile live test resume ${randomUUID()}`;
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
/** The real application calls reconcile_resume_quota_orphans() via Supabase's service-role key,
 *  which PostgREST authenticates by setting request.jwt.claims to a JWT whose role claim is
 *  'service_role' -- auth.role() (the GUC-based mechanism every RPC in this project checks, not
 *  the raw Postgres ROLE) reads exactly that. `admin` here is a plain postgres superuser
 *  connection with NO jwt claims GUC set at all by default, so it must be set explicitly to
 *  faithfully reproduce the real caller's identity, same as asUser() does for authenticated/anon. */
async function asServiceRole(admin: Client): Promise<void> {
  await admin.query(`SET request.jwt.claims = '${JSON.stringify({ role: 'service_role' })}'`);
}
async function sweep(admin: Client, dryRun = false): Promise<Array<{ analysis_id: string; attempt_number: number; reconciled: boolean; detail: string }>> {
  const res = await admin.query<{ analysis_id: string; attempt_number: number; reconciled: boolean; detail: string }>('SELECT * FROM reconcile_resume_quota_orphans($1)', [dryRun]);
  return res.rows;
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
  try {
    await admin.connect();
    await asServiceRole(admin);
    const markerRes = await admin.query('SELECT run_tag, profile_id FROM public._resume_pr_b_live_audit_run WHERE run_tag = $1 LIMIT 1', [runTag]);
    const markerRow = (markerRes.rows[0] as unknown as MarkerRow | undefined) ?? null;
    const preflight = runAllPreflightChecks({ url, confirmValue: confirm, markerRow, expectedRunTag: runTag });
    if (!preflight.ok) { console.error(preflight.reason); process.exitCode = 2; return; }

    console.log('='.repeat(78));
    console.log('RESUME INTELLIGENCE (PR B) — LIVE QUOTA RECONCILIATION VALIDATION (migration 042)');
    console.log('='.repeat(78));

    pgA = new Client({ connectionString: url });
    await pgA.connect();

    console.log('\n1. service_role-only gate: authenticated and anon are both rejected');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      let deniedAuthenticated = false;
      try { await pgA.query('SELECT * FROM reconcile_resume_quota_orphans($1)', [true]); } catch (err) { deniedAuthenticated = (err as { code?: string }).code === '42501'; }
      assert(deniedAuthenticated, 'an authenticated caller is rejected with 42501, never allowed to run the sweep');

      await pgA.query(`SET request.jwt.claims = '${JSON.stringify({ sub: randomUUID(), role: 'anon' })}'`);
      await pgA.query('SET ROLE anon');
      let deniedAnon = false;
      try { await pgA.query('SELECT * FROM reconcile_resume_quota_orphans($1)', [true]); } catch (err) { deniedAnon = (err as { code?: string }).code === '42501'; }
      assert(deniedAnon, 'anon is rejected too (no EXECUTE grant at all, in addition to the in-function check)');
    }

    console.log('\n2. Branch (a): a superseded attempt is reconciled, no grace period needed');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA);
      const r1 = await rpcReserve(pgA, analysisId, 1);
      assert(r1.result === 'reserved', 'setup: attempt 1 reserved');
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      const reclaim = await rpcClaim(pgA, versionId);
      assert(reclaim.attempt_number === 2, 'setup: reclaimed as attempt 2 (immediately — no backdating needed for branch (a))');

      const before = await getCount(admin, uid);
      const rows = await sweep(admin, false);
      const mine = rows.filter((r) => r.analysis_id === analysisId);
      assert(mine.length === 1 && mine[0].reconciled === true, 'the superseded attempt 1 reservation is reconciled by the sweep', JSON.stringify(mine));
      const after = await getCount(admin, uid);
      assert(after === before - 1, 'the counter is decremented by the reconciliation', `before=${before} after=${after}`);
      const event = await admin.query(`SELECT reason FROM resume_quota_events WHERE analysis_id = $1 AND attempt_number = 1 AND event_type = 'refunded'`, [analysisId]);
      assert(event.rows[0]?.reason === 'reconciliation_sweep', 'the refund event is tagged with reason=reconciliation_sweep, distinguishing it from an application-triggered refund', JSON.stringify(event.rows));
    }

    console.log('\n3. Branch (b): a terminally-failed CURRENT attempt is reconciled only once past its 10-minute grace period');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA);
      await rpcReserve(pgA, analysisId, attemptNumber);
      await rpcFinalize(pgA, analysisId, attemptNumber, 'unavailable');

      const freshRows = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(freshRows.length === 0, 'a just-failed attempt, still inside its 10-minute grace period, is NOT yet eligible — avoids racing an in-flight finalize that could still arrive');

      await admin.query(`UPDATE resume_analyses SET updated_at = now() - interval '11 minutes' WHERE id = $1`, [analysisId]);
      const before = await getCount(admin, uid);
      const lateRows = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(lateRows.length === 1 && lateRows[0].reconciled === true, 'once past the 10-minute grace period, the same terminally-failed attempt IS reconciled', JSON.stringify(lateRows));
      const after = await getCount(admin, uid);
      assert(after === before - 1, 'the counter is decremented', `before=${before} after=${after}`);
    }

    console.log('\n4. Branch (c): an abandoned still-pending attempt is reconciled only past its 60-minute window');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA);
      await rpcReserve(pgA, analysisId, attemptNumber);

      await admin.query(`UPDATE resume_analyses SET created_at = now() - interval '4 minutes' WHERE id = $1`, [analysisId]);
      const stillTooFresh = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(stillTooFresh.length === 0, 'a pending claim only 4 minutes old (past the 3-minute RECLAIM window, but nowhere near the sweep\'s own 60-minute window) is NOT yet eligible for reconciliation', JSON.stringify(stillTooFresh));

      await admin.query(`UPDATE resume_analyses SET created_at = now() - interval '61 minutes' WHERE id = $1`, [analysisId]);
      const before = await getCount(admin, uid);
      const nowEligible = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(nowEligible.length === 1 && nowEligible[0].reconciled === true, 'past 60 minutes, the abandoned pending attempt is reconciled', JSON.stringify(nowEligible));
      const after = await getCount(admin, uid);
      assert(after === before - 1, 'the counter is decremented', `before=${before} after=${after}`);
    }

    console.log('\n5. A successful attempt is NEVER touched by the sweep, no matter how old');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { analysisId, attemptNumber } = await createVersionAndClaim(pgA);
      await rpcReserve(pgA, analysisId, attemptNumber);
      await rpcFinalize(pgA, analysisId, attemptNumber, 'success');
      await admin.query(`UPDATE resume_analyses SET updated_at = now() - interval '999 minutes', created_at = now() - interval '999 minutes' WHERE id = $1`, [analysisId]);

      const before = await getCount(admin, uid);
      const rows = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(rows.length === 0, 'a successful attempt is never a candidate at all, regardless of age', JSON.stringify(rows));
      const after = await getCount(admin, uid);
      assert(after === before, 'the counter is completely untouched for a success', `before=${before} after=${after}`);
    }

    console.log('\n6. Dry-run mode reports candidates but writes nothing');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA);
      await rpcReserve(pgA, analysisId, 1);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      await rpcClaim(pgA, versionId); // supersedes attempt 1 -- branch (a), no grace period

      const before = await getCount(admin, uid);
      const dryRows = (await sweep(admin, true)).filter((r) => r.analysis_id === analysisId);
      assert(dryRows.length === 1 && dryRows[0].reconciled === false && dryRows[0].detail === 'dry_run', 'dry-run reports the candidate without marking it reconciled', JSON.stringify(dryRows));
      const afterDryRun = await getCount(admin, uid);
      assert(afterDryRun === before, 'the counter is completely unchanged after a dry run', `before=${before} after=${afterDryRun}`);
      const eventCheck = await admin.query(`SELECT count(*)::int AS n FROM resume_quota_events WHERE analysis_id = $1 AND event_type = 'refunded'`, [analysisId]);
      assert(eventCheck.rows[0].n === 0, 'no refunded event is inserted by a dry run either', JSON.stringify(eventCheck.rows));

      // Confirm the SAME candidate is then genuinely reconciled by a real (non-dry-run) sweep.
      const realRows = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(realRows.length === 1 && realRows[0].reconciled === true, 'the same candidate IS reconciled once dry_run is turned off', JSON.stringify(realRows));
    }

    console.log('\n7. Idempotent: running the sweep twice never double-refunds');
    {
      const uid = await freshProfile(admin);
      await asUser(pgA, uid);
      const { versionId, analysisId } = await createVersionAndClaim(pgA);
      await rpcReserve(pgA, analysisId, 1);
      await rpcFinalize(pgA, analysisId, 1, 'unavailable');
      await rpcClaim(pgA, versionId);

      const before = await getCount(admin, uid);
      const firstRun = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(firstRun.length === 1 && firstRun[0].reconciled === true, 'first sweep run reconciles the candidate');
      const afterFirst = await getCount(admin, uid);
      assert(afterFirst === before - 1, 'counter decremented exactly once by the first run', `before=${before} after=${afterFirst}`);

      const secondRun = (await sweep(admin, false)).filter((r) => r.analysis_id === analysisId);
      assert(secondRun.length === 0, 'a second sweep run no longer finds this candidate at all -- it already has a refunded event, so it fails the orphan definition itself (not just an already_refunded report)', JSON.stringify(secondRun));
      const afterSecond = await getCount(admin, uid);
      assert(afterSecond === afterFirst, 'the counter is NOT decremented a second time', `afterFirst=${afterFirst} afterSecond=${afterSecond}`);
    }

    console.log(`\n${'='.repeat(78)}`);
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(78));
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await pgA?.end().catch(() => {});
    await admin.end().catch(() => {});
  }
}

main().catch((err) => { console.error(err); process.exitCode = 2; });

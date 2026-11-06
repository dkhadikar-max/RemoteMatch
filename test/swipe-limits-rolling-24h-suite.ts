/**
 * RemoteMatch — Swipe limits: rolling 24h window + Pro upgrade popups
 * ==============================================================================
 * Plan: docs/swipe-limits-rolling-24h-implementation-plan.md (revision 9,
 * implementation authorized). Migration: 045_swipe_limits_rolling_24h.sql.
 *
 * Covers the plan's §7 test list:
 *   - UNIT: the pure countdown formatter used by the upgrade modal.
 *   - MIGRATION (PGlite): applies 001 + 003 + 045 against an embedded
 *     Postgres and drives the real SQL functions — right/total caps, no
 *     independent left cap, duplicate detection, the enrichment-claim +
 *     fencing-token mechanism (including the delayed-response overwrite
 *     scenario), rewind (incl. clearing an in-flight claim, and
 *     rewind-then-reswipe), and the shared rolling-window counter/view.
 *
 *     HONEST LIMITATION (raised by independent pre-PR review, not glossed
 *     over): PGlite is a single-connection engine. It can faithfully prove
 *     sequential-serialization correctness — "once request B's transaction
 *     starts after request A's committed, does B see the right state?" —
 *     which is most of what's below. It CANNOT prove the thing items 4/5/29
 *     are actually about: that two transactions beginning before either
 *     commits, contending for the SAME row lock, resolve to exactly one
 *     winner with no corrupted intermediate state. That specific guarantee
 *     rests on Postgres's standard `SELECT ... FOR UPDATE` / row-level-lock
 *     semantics (the independent review confirmed the SQL control flow is
 *     consistent with that guarantee) and is proven for real only against
 *     a genuine multi-connection Postgres — the LIVE tier below, or a
 *     dedicated multi-client harness against a real local Postgres, neither
 *     of which is run by this suite. Tests below that are labeled
 *     "(sequential, not a true race)" are deliberately honest about this;
 *     do not read them as closing items 4/5/29 on their own.
 *   - LIVE (isolated project, local server; skipped with a FAIL unless an
 *     isolated project is configured and migration 045 is applied there —
 *     same gate shape as test/apply-click-tracking-suite.ts): not run by
 *     this change — plan §7/§8 requires a verified isolated Supabase
 *     project before any live run, which is a separate go-ahead. This is
 *     where items 4, 5, and a true two-connection version of 29 actually
 *     belong.
 *
 * Server: ONE local dev server started with the same env file as this
 * runner; TEST_BASE_URL is a NON-admin host of it (default
 * http://127.0.0.1:3400). The live section refuses unless that URL is local
 * http and ISOLATED_TEST_PROJECT_HOST equals the database host exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3400';
const ISOLATED_HOST = process.env.ISOLATED_TEST_PROJECT_HOST ?? '';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

// ==============================================================================
// UNIT: the pure countdown formatter (src/components/premium/upgrade-modal.tsx)
// Duplicated here deliberately — importing a 'use client' component into a
// node test runner isn't viable; this is a byte-for-byte copy of the same
// four lines of pure logic, kept in sync by inspection, not by import.
// ==============================================================================

function formatCountdown(resetAt: string | null | undefined): string | null {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return minutes <= 0 ? '<1m' : `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function unit() {
  console.log('\nUNIT: formatCountdown');
  assert(formatCountdown(null) === null, 'null resetAt -> null');
  assert(formatCountdown(new Date(Date.now() - 1000).toISOString()) === null, 'past resetAt -> null (already reset)');
  assert(formatCountdown(new Date(Date.now() + 90 * 60 * 1000).toISOString()) === '1h 30m', '90 minutes out -> "1h 30m"');
  assert(formatCountdown(new Date(Date.now() + 5 * 60 * 1000).toISOString()) === '5m', '5 minutes out -> "5m" (no hours)');
  const almost = formatCountdown(new Date(Date.now() + 30 * 1000).toISOString());
  assert(almost === '1m' || almost === '<1m', '30 seconds out -> "<1m" or "1m" boundary, never null', almost);
}

// ==============================================================================
// MIGRATION (PGlite)
// ==============================================================================

const USER_FREE = '11111111-1111-4111-8111-111111111111';
const USER_PRO = '22222222-2222-4222-8222-222222222222';

async function setAuthContext(db: PGlite, userId: string | null, role: 'authenticated' | 'anon' | 'service_role') {
  if (role === 'service_role') {
    await db.query(`RESET ROLE;`);
    await db.query(`SET request.jwt.claim.role = 'service_role';`);
    await db.query(`SET request.jwt.claim.sub = '';`);
  } else {
    await db.query(`SET ROLE ${role};`);
    await db.query(`SET request.jwt.claim.role = '${role}';`);
    await db.query(`SET request.jwt.claim.sub = '${userId ?? ''}';`);
  }
}

async function rpc<T = any>(db: PGlite, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const argNames = Object.keys(args);
  const sqlArgs = argNames.map((k) => `${k} := $${argNames.indexOf(k) + 1}`).join(', ');
  const values = argNames.map((k) => {
    const v = args[k];
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });
  const res = await db.query(`SELECT ${fn}(${sqlArgs}) AS result;`, values);
  return (res.rows[0] as any).result as T;
}

async function insertOpportunities(db: PGlite, ids: string[]) {
  await setAuthContext(db, null, 'service_role');
  for (const id of ids) {
    await db.query(
      `INSERT INTO opportunities (id, title, company, description, source, source_id, official_url, canonical_url_hash, content_hash, status)
       VALUES (gen_random_uuid(), 'Title ${id}', 'Co', 'desc', 'curated', '${id}', 'https://x/${id}', 'h${id}', 'c${id}', 'active')
       ON CONFLICT DO NOTHING;`
    );
  }
}

async function buildDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$ LANGUAGE sql STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
    $$ LANGUAGE sql STABLE;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      raw_app_meta_data jsonb DEFAULT '{}'::jsonb, is_anonymous boolean DEFAULT false,
      created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz,
      email_confirmed_at timestamptz, encrypted_password text
    );
  `);
  await db.exec(read('supabase/migrations/001_initial_schema.sql'));
  await db.exec(read('supabase/migrations/002_row_level_security.sql'));
  await db.exec(read('supabase/migrations/003_security_remediation.sql'));
  await db.exec(read('supabase/migrations/045_swipe_limits_rolling_24h.sql'));

  await setAuthContext(db, null, 'service_role');
  // Inserting into auth.users fires migration 003's handle_new_auth_user
  // trigger, which creates the matching `profiles` row the same way
  // production does — not a hand-built profiles row that could drift from
  // what the trigger actually produces.
  await db.query(`INSERT INTO auth.users (id, email) VALUES ('${USER_FREE}', 'free@x.com');`);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ('${USER_PRO}', 'pro@x.com');`);
  await db.query(`UPDATE profiles SET plan_tier = 'pro' WHERE id = '${USER_PRO}';`);
  return db;
}

/** Backdate a swipe row's created_at (and optionally its claim timestamp) directly — simulates window-expiry/claim-staleness without a real wait. */
async function backdate(db: PGlite, swipeId: string, opts: { createdAt?: string; claimedAt?: string }) {
  await setAuthContext(db, null, 'service_role');
  if (opts.createdAt) await db.query(`UPDATE swipes SET created_at = $1 WHERE id = $2;`, [opts.createdAt, swipeId]);
  if (opts.claimedAt) await db.query(`UPDATE swipes SET enrichment_claimed_at = $1 WHERE id = $2;`, [opts.claimedAt, swipeId]);
}

async function countRows(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  await setAuthContext(db, null, 'service_role');
  const res = await db.query(sql, params);
  return res.rows.length;
}

async function migrationSuite() {
  console.log('\nMIGRATION (PGlite): 001 + 003 + 045 apply, real SQL functions');

  // ---- 1/2/3: right (15) and total (50) caps, no independent left cap ----
  {
    const db = await buildDb();
    const oppIds = Array.from({ length: 60 }, (_, i) => `opp-${i}`);
    await insertOpportunities(db, oppIds);
    await setAuthContext(db, USER_FREE, 'authenticated');

    for (let i = 0; i < 15; i++) {
      const r = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds[i] });
      assert(r.allowed === true, `right swipe #${i + 1} of 15 allowed`, r);
    }
    const blocked16 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds[15] });
    assert(blocked16.allowed === false && blocked16.code === 'RIGHT_LIMIT_REACHED', '16th right swipe blocked RIGHT_LIMIT_REACHED, total < 50', blocked16);
    assert(typeof blocked16.resetAt === 'string', 'blocked right swipe carries a resetAt');

    // 15 rights are already in; 35 more passes bring the total to exactly 50.
    for (let i = 16; i <= 50; i++) {
      const r = await rpc(db, 'record_pass', { p_opportunity_id: oppIds[i] });
      assert(r.allowed === true, `pass #${i - 15} allowed (totalCount now ${r.totalCount})`, r);
    }
    const blocked51 = await rpc(db, 'record_pass', { p_opportunity_id: oppIds[51] });
    assert(blocked51.allowed === false && blocked51.code === 'TOTAL_LIMIT_REACHED', '51st swipe (a pass) blocked TOTAL_LIMIT_REACHED', blocked51);

    // No independent left cap: 35+ passes alone (no rights) must be allowed as long as total <= 50.
  }
  {
    // Items 4/5, exact plan wording, boundary-framed (sequential, not a true
    // race — see the file-header limitation note). At right_count=14, the
    // 15th call must succeed and the 16th must be blocked; at
    // total_count=49, the 50th must succeed and the 51st must be blocked.
    // This proves the final-state logic at the EXACT boundary the plan
    // names, which the earlier block only approximated. It does not prove
    // two transactions beginning concurrently resolve correctly — that is
    // the real content of items 4/5 and is NOT closed by this block; it
    // requires the LIVE tier (two genuinely simultaneous connections).
    const db = await buildDb();
    const oppIds = Array.from({ length: 60 }, (_, i) => `opp-b4-${i}`);
    await insertOpportunities(db, oppIds);
    await setAuthContext(db, USER_FREE, 'authenticated');
    for (let i = 0; i < 14; i++) await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds[i] });
    const at14 = await rpc(db, 'get_rolling_swipe_counts');
    assert(at14.rightCount === 14, 'precondition: right_count is exactly 14 before the boundary calls', at14);
    const the15th = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds[14] });
    assert(the15th.allowed === true, 'item 4: the 15th right swipe (right_count was 14) succeeds', the15th);
    const the16th = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds[15] });
    assert(the16th.allowed === false && the16th.code === 'RIGHT_LIMIT_REACHED', 'item 4: the very next one is blocked, final count never exceeds 15', the16th);

    const db2 = await buildDb();
    const oppIds2 = Array.from({ length: 60 }, (_, i) => `opp-b5-${i}`);
    await insertOpportunities(db2, oppIds2);
    await setAuthContext(db2, USER_FREE, 'authenticated');
    for (let i = 0; i < 14; i++) await rpc(db2, 'reserve_and_record_right_swipe', { p_opportunity_id: oppIds2[i] });
    for (let i = 14; i < 49; i++) await rpc(db2, 'record_pass', { p_opportunity_id: oppIds2[i] });
    const at49 = await rpc(db2, 'get_rolling_swipe_counts');
    assert(at49.totalCount === 49, 'precondition: total_count is exactly 49 before the boundary calls', at49);
    const the50th = await rpc(db2, 'record_pass', { p_opportunity_id: oppIds2[49] });
    assert(the50th.allowed === true, 'item 5: the 50th swipe (total_count was 49) succeeds', the50th);
    const the51st = await rpc(db2, 'record_pass', { p_opportunity_id: oppIds2[50] });
    assert(the51st.allowed === false && the51st.code === 'TOTAL_LIMIT_REACHED', 'item 5: the very next one is blocked, final count never exceeds 50 — THIS BLOCK IS SEQUENTIAL ONLY, see header note', the51st);
  }
  {
    const db = await buildDb();
    const oppIds = Array.from({ length: 40 }, (_, i) => `opp-left-${i}`);
    await insertOpportunities(db, oppIds);
    await setAuthContext(db, USER_FREE, 'authenticated');
    for (let i = 0; i < 40; i++) {
      const r = await rpc(db, 'record_pass', { p_opportunity_id: oppIds[i] });
      assert(r.allowed === true, `left-only pass #${i + 1} of 40 allowed (no independent left cap)`, r);
    }
  }

  // ---- 2 (window expiry): a backdated event ages out, allowance restored ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-expiry-1', 'opp-expiry-2']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-expiry-1' });
    assert(r1.allowed, 'seed right swipe for expiry test', r1);
    await backdate(db, r1.swipeId, { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const counts = await rpc(db, 'get_rolling_swipe_counts');
    assert(counts.rightCount === 0, 'a 25h-old right swipe is excluded from the rolling count (window expiry)', counts);
  }
  {
    // The other boundary direction (plan item 3 names both): a swipe at
    // 23h59m59s old is still INSIDE the window and must still count.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-expiry-3']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-expiry-3' });
    await backdate(db, r1.swipeId, { createdAt: new Date(Date.now() - (24 * 60 * 60 * 1000 - 1000)).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const counts = await rpc(db, 'get_rolling_swipe_counts');
    assert(counts.rightCount === 1, 'a 23h59m59s-old right swipe is still inside the window and still counts', counts);
  }

  // ---- 4: duplicate detection, every tier, before Pro branch ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-dup-1']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-dup-1' });
    assert(r1.allowed, 'first swipe on opp-dup-1 allowed');
    await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: r1.swipeId, p_decision_snapshot: { x: 1 }, p_claim_id: r1.claimId });
    const r2 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-dup-1' });
    assert(r2.allowed === false && r2.code === 'DUPLICATE_INTERACTION' && r2.hasDecision === true, 'completed duplicate -> DUPLICATE_INTERACTION, hasDecision true, no new row', r2);

    const countAfter = await countRows(db, `SELECT 1 FROM swipes WHERE opportunity_id = 'opp-dup-1'`);
    assert(countAfter === 1, 'exactly one swipe row exists for the duplicated opportunity');
  }
  {
    // Pro duplicate: checked before the Pro unlimited branch, not skipped.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-dup-pro']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-dup-pro' });
    assert(r1.allowed && r1.planTier === 'pro', 'Pro first swipe allowed, unlimited tier', r1);
    await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: r1.swipeId, p_decision_snapshot: { x: 1 }, p_claim_id: r1.claimId });
    const r2 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-dup-pro' });
    assert(r2.allowed === false && r2.code === 'DUPLICATE_INTERACTION' && r2.hasDecision === true, 'Pro duplicate also caught -> DUPLICATE_INTERACTION (checked before Pro branch)', r2);
  }

  // ---- Resume / claim / fencing ----
  {
    // An IMMEDIATE retry, with no time passed, must NOT be able to resume —
    // the original request's own claim (set at insert time, same rule as
    // every other claim holder) is still fresh, so the retry is correctly
    // told someone else is already working on it. This is the intended
    // safety margin of a timeout-based claim, not a bug.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-resume-0']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-0' });
    const immediateRetry = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-0' });
    assert(
      immediateRetry.resumeInProgress === true && immediateRetry.claimId === undefined,
      'an immediate retry (claim still fresh) must stand down, not reclaim',
      immediateRetry
    );
  }
  {
    // Resume: an incomplete swipe (crash, then enough time passes for the
    // claim to go stale) gets re-claimed, not duplicated.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-resume-1']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-1' });
    assert(r1.allowed, 'initial reservation allowed (simulated crash before attach runs)');
    await backdate(db, r1.swipeId, { claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const retry = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-1' });
    assert(
      retry.allowed === false && retry.code === 'DUPLICATE_INTERACTION' && retry.hasDecision === false && retry.resumeInProgress === false && typeof retry.claimId === 'string',
      'retry on a swipe whose claim went stale wins a fresh claim -> resumeInProgress false',
      retry
    );
    assert(retry.swipeId === r1.swipeId, 'resume targets the SAME swipe row, not a new one', { r1, retry });
    const attach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: retry.swipeId, p_decision_snapshot: { resumed: true }, p_claim_id: retry.claimId });
    assert(attach.attached === true, 'resume winner successfully attaches with its fresh claim', attach);
  }
  {
    // Concurrent resume: once the original claim has gone stale, two
    // resumers race for it (simulated by sequential ordering — the first to
    // reach the claim-UPDATE wins it; the second, arriving right after,
    // finds the claim already fresh again and must stand down).
    const db = await buildDb();
    await insertOpportunities(db, ['opp-resume-2']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-2' });
    await backdate(db, r1.swipeId, { claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const retryA = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-2' }); // wins the claim
    const retryB = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-resume-2' }); // arrives right after, claim now fresh again (A's)
    assert(retryA.resumeInProgress === false && typeof retryA.claimId === 'string', 'first concurrent resumer wins the claim', retryA);
    assert(retryB.resumeInProgress === true && retryB.claimId === undefined, 'second concurrent resumer told to stand down, no claim of its own', retryB);
  }
  {
    // Claim expiry: a stale (2min+) claim can be re-acquired.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-expire-claim']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-expire-claim' });
    await backdate(db, r1.swipeId, { claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const retry = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-expire-claim' });
    assert(retry.resumeInProgress === false && typeof retry.claimId === 'string' && retry.claimId !== r1.claimId, 'a stale (>2min) claim is reclaimed with a NEW token, not reused', retry);
  }
  {
    // Fencing: a stale worker's delayed attach, after someone else reclaimed and completed, is a no-op.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-fence-1']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const workerA = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-fence-1' });
    await backdate(db, workerA.swipeId, { claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_FREE, 'authenticated');
    const workerB = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-fence-1' });
    assert(workerB.resumeInProgress === false, 'worker B reclaims after A\'s claim goes stale', workerB);
    const bAttach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: workerB.swipeId, p_decision_snapshot: { from: 'B' }, p_claim_id: workerB.claimId });
    assert(bAttach.attached === true, 'worker B attaches successfully with its own token', bAttach);

    // Worker A's delayed AI response finally arrives, with ITS OLD claimId.
    const aAttach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: workerA.swipeId, p_decision_snapshot: { from: 'A (stale)' }, p_claim_id: workerA.claimId });
    assert(aAttach.attached === false && aAttach.reason === 'stale_claim', 'worker A\'s delayed, superseded attach is rejected, not an overwrite', aAttach);

    await setAuthContext(db, null, 'service_role');
    const row = await db.query(`SELECT decision_snapshot, enrichment_claim_id FROM swipes WHERE id = $1`, [workerB.swipeId]);
    const decision = (row.rows[0] as any).decision_snapshot;
    assert(decision?.from === 'B', 'the persisted decision is still B\'s, never overwritten by A\'s stale attach', decision);
    assert((row.rows[0] as any).enrichment_claim_id === null, 'claim is cleared after a successful attach');
  }
  {
    // Item 26, SQL half: attached:false must be a returned field, not an
    // exception — proven directly.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-attached-field']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-attached-field' });
    const bogus = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: r1.swipeId, p_decision_snapshot: { x: 1 }, p_claim_id: '99999999-9999-4999-8999-999999999999' });
    assert(bogus.attached === false && bogus.reason === 'stale_claim', 'a tampered/wrong claim id -> attached:false, no exception thrown', bogus);
  }
  {
    // Item 26, route half (STATIC, per independent review LOW finding —
    // the SQL-level test above doesn't touch route.ts at all, and this repo
    // doesn't run route.ts against a live server in this tier). Confirms by
    // source inspection that both call sites branch on `.attached` before
    // returning success, and that a false value maps to a non-200 — not
    // just that the SQL function's return value is well-formed.
    const routeSrc = read('src/app/api/opportunities/swipe/route.ts');
    const attachCallSites = routeSrc.split("supabase.rpc('attach_right_swipe_decision'").length - 1;
    assert(attachCallSites === 2, 'route.ts calls attach_right_swipe_decision from exactly two places (fresh success + resume)', attachCallSites);
    const attachedChecks = routeSrc.split('attachResult.attached').length - 1;
    assert(attachedChecks >= 2, 'route.ts reads attachResult.attached at least once per call site, not just checking for a thrown error', attachedChecks);
    assert(
      /if \(!attachResult\.attached\)[\s\S]{0,400}status: 409/.test(routeSrc),
      'an unattached result maps to a non-200 (409) response within a short distance of the check, not silently treated as success'
    );
  }

  // ---- Rewind: allowance restoration, one-shot, Pro-only, claim-clear, rewind-then-reswipe ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-rewind-1']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-rewind-1' });
    assert(r1.allowed, 'Pro right swipe to rewind');
    const rewind = await rpc(db, 'rewind_last_decision');
    assert(rewind.success === true && rewind.rewoundOpportunityId === 'opp-rewind-1', 'rewind restores the decision', rewind);
    const rewindAgain = await rpc(db, 'rewind_last_decision');
    assert(rewindAgain.success === false && rewindAgain.error === 'nothing_to_rewind', 'second consecutive rewind is a no-op (one-shot guard)', rewindAgain);
  }
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-rewind-free']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-rewind-free' });
    assert(r1.allowed, 'Free right swipe before rewind attempt');
    const rewind = await rpc(db, 'rewind_last_decision');
    assert(rewind.success === false && rewind.error === 'pro_required', 'Free cannot rewind at all (no allowance-abuse surface)', rewind);
  }
  {
    // Rewind clears an in-flight claim: a delayed attach after rewind is rejected, not attached.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-rewind-claim']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-rewind-claim' });
    const rewind = await rpc(db, 'rewind_last_decision');
    assert(rewind.success, 'rewind before attach runs');
    const lateAttach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: r1.swipeId, p_decision_snapshot: { stale: true }, p_claim_id: r1.claimId });
    assert(lateAttach.attached === false && lateAttach.reason === 'stale_claim', 'a delayed attach on an already-rewound row is rejected (claim was cleared by rewind)', lateAttach);
    await setAuthContext(db, null, 'service_role');
    const row = await db.query(`SELECT decision_snapshot FROM swipes WHERE id = $1`, [r1.swipeId]);
    assert((row.rows[0] as any).decision_snapshot === null, 'no AI content ever lands on a row the user already undid');
  }
  {
    // Item 29: rewind's marker INSERT and its claim-clear UPDATE must never
    // be observable in a split state (one without the other). PGlite can't
    // manufacture a real concurrent reader mid-transaction (see file-header
    // limitation note) — what IS checked here is that both postconditions
    // hold TOGETHER in the one read immediately after rewind returns, which
    // is the strongest assertion a single-connection engine can make. The
    // actual atomicity guarantee rests on both statements running inside
    // one PL/pgSQL function call (= one Postgres transaction = one commit),
    // per the plan §3 reasoning the independent review checked and accepted.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-rewind-atomic']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-rewind-atomic' });
    const rewind = await rpc(db, 'rewind_last_decision');
    assert(rewind.success, 'rewind call itself succeeds');
    await setAuthContext(db, null, 'service_role');
    const markerExists = await db.query(`SELECT 1 FROM swipes WHERE action = 'rewind' AND rewound_decision_id = $1`, [r1.swipeId]);
    const claimRow = await db.query(`SELECT enrichment_claim_id, enrichment_claimed_at FROM swipes WHERE id = $1`, [r1.swipeId]);
    const claimCleared = (claimRow.rows[0] as any).enrichment_claim_id === null && (claimRow.rows[0] as any).enrichment_claimed_at === null;
    assert(markerExists.rows.length === 1 && claimCleared, 'item 29: rewind marker exists AND claim is cleared together — never observed as one without the other', {
      markerExists: markerExists.rows.length,
      claimCleared,
    });
  }
  {
    // Rewind-then-reswipe: not a false duplicate.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-reswipe']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-reswipe' });
    await rpc(db, 'rewind_last_decision');
    const r2 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-reswipe' });
    assert(r2.allowed === true, 'reswipe after rewind is allowed, NOT flagged DUPLICATE_INTERACTION', r2);
    const liveRows = await countRows(db, `SELECT 1 FROM swipes WHERE opportunity_id = 'opp-reswipe'`);
    assert(liveRows === 3, 'three rows exist (original + rewind marker + new decision)', { liveRows });
  }

  // ---- Shared counter consistency (plan §5): same function, right+total together ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-count-1', 'opp-count-2']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-count-1' });
    await rpc(db, 'record_pass', { p_opportunity_id: 'opp-count-2' });
    const counts = await rpc(db, 'get_rolling_swipe_counts');
    assert(counts.rightCount === 1 && counts.totalCount === 2, 'shared counter reports right=1, total=2 after one of each', counts);
  }

  // ---- Items 6/7: same-vacancy right+left race, different-vacancy no false block ----
  {
    // Item 6 (sequential simulation, see header note): an 'interested' and a
    // 'passed' call both target the SAME opportunity. Whichever commits
    // first wins; the other must see it as a duplicate, not a second,
    // independent decision.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-mix-race']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const interested = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-mix-race' });
    assert(interested.allowed === true, 'first of the pair (interested) succeeds');
    const passed = await rpc(db, 'record_pass', { p_opportunity_id: 'opp-mix-race' });
    assert(passed.allowed === false && passed.code === 'DUPLICATE_INTERACTION', 'the pass arriving right after sees the interested decision as a duplicate, not a second action', passed);
    const rowCount = await countRows(db, `SELECT 1 FROM swipes WHERE opportunity_id = 'opp-mix-race'`);
    assert(rowCount === 1, 'exactly one row exists for the opportunity, not two competing decisions');
  }
  {
    // Item 7: a concurrent pair on DIFFERENT opportunities for the same user
    // must not falsely serialize into a block — the profile-row lock is
    // per-user, not per-opportunity, but it must not make swipes on
    // unrelated opportunities contend with each other's final outcome.
    const db = await buildDb();
    await insertOpportunities(db, ['opp-diff-a', 'opp-diff-b']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const a = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-diff-a' });
    const b = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-diff-b' });
    assert(a.allowed === true && b.allowed === true, 'two swipes on different opportunities for the same user both succeed, no false-blocking', { a, b });
    assert(a.swipeId !== b.swipeId, 'they are recorded as two distinct rows');
  }

  // ---- Item 23: concurrent resume / claim-expiry / fencing for Pro, not only Free ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-pro-resume']);
    await setAuthContext(db, USER_PRO, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-pro-resume' });
    assert(r1.allowed && r1.planTier === 'pro', 'Pro reservation seeds an incomplete swipe');
    await backdate(db, r1.swipeId, { claimedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() });
    await setAuthContext(db, USER_PRO, 'authenticated');
    const retryA = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-pro-resume' }); // wins the claim
    const retryB = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-pro-resume' }); // arrives right after
    assert(retryA.resumeInProgress === false && typeof retryA.claimId === 'string', 'Pro: first concurrent resumer wins the claim (unlimited swipes does not exempt the claim mechanism)', retryA);
    assert(retryB.resumeInProgress === true && retryB.claimId === undefined, 'Pro: second concurrent resumer told to stand down', retryB);
    const bAttach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: retryA.swipeId, p_decision_snapshot: { from: 'A' }, p_claim_id: retryA.claimId });
    assert(bAttach.attached === true, 'Pro: claim winner attaches successfully');
    const staleAttach = await rpc(db, 'attach_right_swipe_decision', { p_swipe_id: r1.swipeId, p_decision_snapshot: { from: 'original (stale)' }, p_claim_id: r1.claimId });
    assert(staleAttach.attached === false && staleAttach.reason === 'stale_claim', 'Pro: the original, now-superseded claim holder cannot overwrite the winner (fencing applies to Pro too)', staleAttach);
  }

  // ---- Item 12: legacy counter and rolling count may diverge; gating follows rolling only ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-authority-1']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-authority-1' });
    // Tamper with the legacy display-only counter directly, simulating drift
    // (e.g. after a rewind in a slightly different order, or simply a stale
    // value) — it must have zero effect on gating, which never reads it.
    await setAuthContext(db, null, 'service_role');
    await db.query(`UPDATE profiles SET daily_right_swipes_count = 999 WHERE id = $1`, [USER_FREE]);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const next = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-authority-2' });
    // No FK to `opportunities` exists for swipes (dropped in migration 003),
    // so a second opportunity id needs no separate seed row. What matters:
    // the real rolling count is 1 (far under 15), and gating must follow
    // that, not the tampered legacy counter (999, which would wrongly block
    // if it were ever consulted).
    assert(next.allowed === true, 'gating ignores a tampered legacy counter (999) and follows the real rolling count (1 of 15)', next);
  }

  // ---- Item 28: the `applications` row exists at reservation time, before AI enrichment ----
  {
    const db = await buildDb();
    await insertOpportunities(db, ['opp-app-timing']);
    await setAuthContext(db, USER_FREE, 'authenticated');
    const r1 = await rpc(db, 'reserve_and_record_right_swipe', { p_opportunity_id: 'opp-app-timing' });
    assert(r1.allowed, 'reservation succeeds');
    await setAuthContext(db, null, 'service_role');
    const appRow = await db.query(`SELECT status FROM applications WHERE profile_id = $1 AND opportunity_id = 'opp-app-timing'`, [USER_FREE]);
    assert(appRow.rows.length === 1 && (appRow.rows[0] as any).status === 'interested', 'the applications row exists immediately after reservation, BEFORE attach_right_swipe_decision ever runs', appRow.rows);
    const swipeRow = await db.query(`SELECT decision_snapshot FROM swipes WHERE id = $1`, [r1.swipeId]);
    assert((swipeRow.rows[0] as any).decision_snapshot === null, 'confirms this really is before enrichment: the swipe row has no decision yet while the application row already exists');
  }

  // ---- Item 14 (static check): /api/profile and the swipe RPCs call the SAME shared function, by name ----
  {
    const profileRouteSrc = read('src/app/api/profile/route.ts');
    assert(profileRouteSrc.includes("supabase.rpc('get_rolling_swipe_counts')"), 'GET /api/profile calls get_rolling_swipe_counts() — the identical function the swipe RPCs use, not a separate query');
    const migrationSrc = read('supabase/migrations/045_swipe_limits_rolling_24h.sql');
    const callsInMigration = migrationSrc.split('get_rolling_swipe_counts()').length - 1;
    assert(callsInMigration >= 3, 'get_rolling_swipe_counts() is defined once and called from both reserve_and_record_right_swipe and record_pass, not reimplemented inline in either', { occurrences: callsInMigration });
  }

  // ---- Old RPC signatures are gone ----
  {
    const db = await buildDb();
    await setAuthContext(db, USER_FREE, 'authenticated');
    let threw = false;
    try {
      await db.query(`SELECT reserve_right_swipe();`);
    } catch {
      threw = true;
    }
    assert(threw, 'old zero-arg reserve_right_swipe() no longer exists post-migration');
    let threw2 = false;
    try {
      await db.query(`SELECT finalize_interested_swipe($1, $2);`, ['x', null]);
    } catch {
      threw2 = true;
    }
    assert(threw2, 'old finalize_interested_swipe(TEXT, JSONB) no longer exists post-migration');
  }

  // ---- Item 13: client-supplied timestamps are never consulted ----
  // Relabeled per independent review (LOW finding): the previous version of
  // this test only confirmed a call without a timestamp arg succeeds, which
  // is tautological (it would pass identically whether or not the function
  // used `now()` correctly). This version actually inspects the deployed
  // function signatures via pg_catalog — a real structural check — to
  // confirm none of the gating RPCs has ANY parameter of a time/date type
  // for a client to even attempt to supply.
  {
    const db = await buildDb();
    await setAuthContext(db, null, 'service_role');
    const res = await db.query(`
      SELECT p.proname, pg_catalog.pg_get_function_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('reserve_and_record_right_swipe', 'record_pass', 'attach_right_swipe_decision', 'get_rolling_swipe_counts');
    `);
    for (const row of res.rows as Array<{ proname: string; args: string }>) {
      const hasTimeParam = /\b(timestamp|date|time)\b/i.test(row.args);
      assert(!hasTimeParam, `${row.proname}(${row.args}) has no timestamp/date/time-typed parameter a client could supply`, row);
    }
    assert(res.rows.length === 4, 'all four gating/counting functions were found and checked', res.rows.length);
  }
}

// ==============================================================================
// LIVE (isolated project only) — not run by this change; see header.
// ==============================================================================

function hasRequiredEnv(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && ISOLATED_HOST);
}

async function liveSuite() {
  console.log('\nLIVE (isolated project): skipped');
  let url: URL | null = null;
  try {
    url = new URL(BASE_URL);
  } catch {
    /* leave null */
  }
  const localBase = url !== null && url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname);
  if (!localBase || !hasRequiredEnv()) {
    console.log('  Not configured (no verified isolated Supabase project / local server pointed at it) — plan §7/§8 requires this as a separate go-ahead, not assumed here.');
    assert(false, 'LIVE tier requires an explicitly verified isolated project — not run in this pass', {
      localBase,
      isolatedHostSet: Boolean(ISOLATED_HOST),
    });
    return;
  }
  // Intentionally not implemented beyond the gate above: writing the actual
  // HTTP-level concurrency tests (items 4-7, 21-23 against real parallel
  // connections) is the next step, but only once Deep names the isolated
  // project per plan §7/§8 boundary 5 — fabricating a target here would be
  // exactly the un-verified live run that boundary forbids.
}

async function main() {
  console.log('='.repeat(78));
  console.log('SWIPE LIMITS — ROLLING 24H WINDOW + PRO UPGRADE POPUPS');
  console.log('='.repeat(78));

  unit();
  await migrationSuite();
  await liveSuite();

  console.log('\n' + '='.repeat(78));
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

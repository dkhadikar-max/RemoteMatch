/**
 * RemoteMatch — apply_clicked / match_analyzed funnel events (migration 034)
 * ==============================================================================
 * Proves:
 *   - UNIT: the validator accepts apply_clicked (opportunity_id + one of four
 *     surfaces) and match_analyzed (opportunity_id), rejects a missing or
 *     unknown surface, a surface on any other event, and extra fields; both
 *     need a session; the four existing events are unchanged.
 *   - STATIC: every Apply link to an employer records apply_clicked with its
 *     own surface, without blocking the navigation; the match page records
 *     match_analyzed once the analysis is set; the writer only sends `surface`
 *     when present (old events keep working before 034 is applied); the
 *     staging dashboard no longer carries hardcoded funnel numbers.
 *   - MIGRATION (PGlite): 001 + 031 + 034 apply; the six event types insert;
 *     apply_clicked without a surface, a surface on another event, an unknown
 *     surface and an unknown event type are all rejected; 034 is idempotent
 *     and also replaces an event_type CHECK that has a different name (the
 *     old hand-made production table).
 *   - LIVE (isolated project, local server; skipped with a FAIL unless 034 is
 *     applied there): signed-in apply_clicked / match_analyzed → 201 with the
 *     row's profile_id taken from the session; signed out → 401; bad surface
 *     → 400; landing_viewed still works. Cleanup deletes every row and user.
 *
 * Server: ONE local dev server started with the same env file as this runner;
 * TEST_BASE_URL is a NON-admin host of it (default http://127.0.0.1:3400).
 * The live section refuses unless that URL is local http and
 * ISOLATED_TEST_PROJECT_HOST equals the database host exactly.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { adminClient, hasRequiredEnv, newVerifiedSession } from './helpers/verified-session';
import { validateFunnelEventBody, funnelEventRequiresAuth, isFunnelEventType } from '../src/lib/funnel/events';

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

let safetyPassed = false;
const createdUsers: string[] = [];
const anonIds: string[] = [];

function unit() {
  console.log('\nUNIT: validateFunnelEventBody');
  const opp = 'opp-remotive-123';
  assert(isFunnelEventType('apply_clicked') && isFunnelEventType('match_analyzed'), 'apply_clicked and match_analyzed are event types');
  assert(funnelEventRequiresAuth('apply_clicked') && funnelEventRequiresAuth('match_analyzed'), 'both require a signed-in session');
  for (const surface of ['feed_card', 'match_view', 'job_modal', 'job_page']) {
    const v = validateFunnelEventBody('apply_clicked', { event_type: 'apply_clicked', opportunity_id: opp, surface });
    assert(v.ok && v.fields.surface === surface && v.fields.opportunity_id === opp, `apply_clicked with surface ${surface} → ok`, v);
  }
  assert(!validateFunnelEventBody('apply_clicked', { opportunity_id: opp }).ok, 'apply_clicked without a surface → rejected');
  assert(!validateFunnelEventBody('apply_clicked', { surface: 'feed_card' }).ok, 'apply_clicked without an opportunity_id → rejected');
  assert(!validateFunnelEventBody('apply_clicked', { opportunity_id: opp, surface: 'homepage' }).ok, 'apply_clicked with an unknown surface → rejected');
  assert(!validateFunnelEventBody('apply_clicked', { opportunity_id: 'job-1', surface: 'feed_card' }).ok, 'apply_clicked with a non-canonical opportunity_id → rejected');
  assert(!validateFunnelEventBody('apply_clicked', { opportunity_id: opp, surface: 'feed_card', note: 'x' }).ok, 'apply_clicked with an extra field → rejected');
  const m = validateFunnelEventBody('match_analyzed', { opportunity_id: opp });
  assert(m.ok && m.fields.opportunity_id === opp && m.fields.surface === undefined, 'match_analyzed with opportunity_id → ok, no surface');
  assert(!validateFunnelEventBody('match_analyzed', { opportunity_id: opp, surface: 'match_view' }).ok, 'match_analyzed with a surface → rejected');
  assert(!validateFunnelEventBody('job_viewed', { opportunity_id: opp, surface: 'feed_card' }).ok, 'job_viewed with a surface → rejected (existing events unchanged)');
  assert(validateFunnelEventBody('landing_viewed', { anonymous_id: 'abcdef12-3456' }).ok && !funnelEventRequiresAuth('landing_viewed'), 'landing_viewed still accepted signed out');
}

function staticChecks() {
  console.log('\nSTATIC: wiring');
  const card = read('src/components/feed/job-card.tsx');
  assert(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);\s*trackApplyClick\(opportunity\.id, 'feed_card'\);/.test(card), 'feed card Apply → trackApplyClick(opportunity.id, "feed_card"), still stops propagation');
  const modal = read('src/components/feed/job-details-modal.tsx');
  assert(/onClick=\{\(\) => trackApplyClick\(opportunity\.id, 'job_modal'\)\}/.test(modal), 'job modal "Official Listing" → trackApplyClick(opportunity.id, "job_modal")');
  const view = read('src/components/match/match-analysis-view.tsx');
  assert(/trackApplyClick\(opportunity\.id, 'match_view'\);\s*window\.open\(opportunity\.officialUrl/.test(view), 'match view Apply → trackApplyClick(opportunity.id, "match_view") before window.open');
  const jobPage = read('src/app/remote-jobs/view/[id]/page.tsx');
  assert((jobPage.match(/<TrackedApplyLink\s+href=\{job\.officialUrl\}\s+opportunityId=\{job\.id\}/g) ?? []).length === 2, 'public job page: both Apply links are TrackedApplyLink with opportunityId={job.id}');
  assert(!/<a\s+href=\{job\.officialUrl\}/.test(jobPage), 'public job page: no untracked Apply link left');
  const tracked = read('src/components/seo/tracked-apply-link.tsx');
  assert(/^'use client';/.test(tracked) && /trackApplyClick\(opportunityId, 'job_page'\)/.test(tracked) && /target="_blank"/.test(tracked) && /rel="noopener noreferrer"/.test(tracked), 'TrackedApplyLink is a client component recording "job_page", same target/rel as before');
  const client = read('src/lib/funnel/client.ts');
  const fn = client.slice(client.indexOf('export function trackApplyClick'));
  assert(/keepalive: true/.test(fn) && /\.catch\(/.test(fn) && !/await /.test(fn), 'trackApplyClick: keepalive, failures swallowed, never awaited (navigation is not delayed)');
  const matchPage = read('src/app/match/[jobId]/page.tsx');
  assert(/setMatch\(matchRes\);[\s\S]{0,300}recordFunnelEventClient\('match_analyzed', \{ opportunity_id: opp\.id \}\)/.test(matchPage), 'match page records match_analyzed right after the analysis is set');
  const events = read('src/lib/funnel/events.ts');
  assert(/\.\.\.\(fields\.surface !== undefined \? \{ surface: fields\.surface \} : \{\}\)/.test(events) && !/surface: fields\.surface \?\? null/.test(events), 'writer sends surface only when present (existing events work before 034)');
  const staging = read('src/app/api/staging/metrics/route.ts');
  assert(!/applyClicked|matchAnalyzed|interestedSwipes|scoreBins|northStar|funnel:/.test(staging), 'staging metrics route no longer returns hardcoded funnel/north-star/calibration numbers');
  const stagingPage = read('src/app/staging/page.tsx');
  assert(!/data\.funnel|data\.metrics|data\.calibration/.test(stagingPage) && /Not measured here/.test(stagingPage), 'staging page shows "Not measured here" instead of those numbers');
}

async function migration() {
  console.log('\nMIGRATION (PGlite): 001 + 031 + 034');
  // PGlite needs a few hundred MB of WebAssembly memory; on a machine also
  // running the dev server it can fail to start. SKIP_PGLITE=1 runs the
  // other sections and says so — the section is skipped, never passed.
  if (process.env.SKIP_PGLITE === '1') {
    console.log('  – SKIP: SKIP_PGLITE=1 — migration section not run');
    return;
  }
  const mig = (f: string) => read(`supabase/migrations/${f}`);
  const fresh = async () => {
    const db = new PGlite();
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULL::uuid $$ LANGUAGE sql STABLE;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT 'service_role'::text $$ LANGUAGE sql STABLE;
    `);
    await db.exec(mig('001_initial_schema.sql'));
    return db;
  };
  const tryInsert = async (db: PGlite, eventType: string, surface: string | null) => {
    try {
      await db.query(`INSERT INTO funnel_events (event_type, opportunity_id, surface) VALUES ($1, 'opp-remotive-1', $2)`, [eventType, surface]);
      return true;
    } catch {
      return false;
    }
  };

  const db = await fresh();
  await db.exec(mig('031_funnel_events.sql'));
  await db.exec(mig('034_funnel_apply_click.sql'));
  assert(true, '001 → 031 → 034 apply cleanly');
  await db.exec(mig('034_funnel_apply_click.sql'));
  assert(true, '034 applied a second time without error (idempotent)');
  for (const t of ['landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed', 'match_analyzed']) {
    assert(await tryInsert(db, t, null), `${t} without a surface → inserts`);
  }
  for (const s of ['feed_card', 'match_view', 'job_modal', 'job_page']) {
    assert(await tryInsert(db, 'apply_clicked', s), `apply_clicked with surface ${s} → inserts`);
  }
  assert(!(await tryInsert(db, 'apply_clicked', null)), 'apply_clicked without a surface → rejected by the database');
  assert(!(await tryInsert(db, 'job_viewed', 'feed_card')), 'a surface on another event → rejected by the database');
  assert(!(await tryInsert(db, 'apply_clicked', 'homepage')), 'an unknown surface → rejected by the database');
  assert(!(await tryInsert(db, 'application_submitted', null)), 'an unknown event type → rejected by the database');
  const checks = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'funnel_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%landing_viewed%'`);
  assert(checks.rows[0].n === 1, 'exactly one event_type CHECK remains after two runs', checks.rows[0]);
  const rls = await db.query<{ r: boolean; f: boolean }>(`SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'funnel_events'`);
  assert(rls.rows[0].r && rls.rows[0].f, 'RLS still enabled and forced');
  await db.close();

  // The old production table was created by hand: its event_type CHECK may have any name.
  const db2 = await fresh();
  await db2.exec(mig('031_funnel_events.sql'));
  await db2.exec(`
    ALTER TABLE funnel_events DROP CONSTRAINT funnel_events_event_type_check;
    ALTER TABLE funnel_events ADD CONSTRAINT some_hand_made_name
      CHECK (event_type IN ('landing_viewed', 'signup_attributed', 'feed_viewed', 'job_viewed'));
  `);
  await db2.exec(mig('034_funnel_apply_click.sql'));
  assert(await tryInsert(db2, 'apply_clicked', 'feed_card'), 'a differently-named old event_type CHECK is replaced too');
  await db2.close();
}

async function post(body: Record<string, unknown>, token?: string) {
  const r = await fetch(`${BASE_URL}/api/funnel/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function live() {
  let u: URL;
  try { u = new URL(BASE_URL); } catch { assert(false, 'TEST_BASE_URL is a valid URL'); return; }
  if (u.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(u.hostname)) { assert(false, 'TEST_BASE_URL must be a local http server'); return; }
  if (!hasRequiredEnv()) { assert(false, 'Supabase env complete'); return; }
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  if (!ISOLATED_HOST || host !== ISOLATED_HOST) { assert(false, 'ISOLATED_TEST_PROJECT_HOST equals the database host'); return; }
  safetyPassed = true;
  const db = adminClient();

  console.log('\nLIVE (isolated project): POST /api/funnel/event');
  const probe = await db.from('funnel_events').select('surface').limit(1);
  if (probe.error) {
    assert(false, 'migration 034 is applied on the isolated project (funnel_events.surface exists) — apply it there, then rerun', probe.error.message);
    return;
  }
  const user = await newVerifiedSession();
  createdUsers.push(user.userId);
  const opp = 'opp-remotive-apply-click-suite';

  assert((await post({ event_type: 'apply_clicked', opportunity_id: opp, surface: 'feed_card' })) === 401, 'signed-out apply_clicked → 401');
  assert((await post({ event_type: 'apply_clicked', opportunity_id: opp, surface: 'homepage' }, user.token)) === 400, 'bad surface → 400');
  assert((await post({ event_type: 'apply_clicked', opportunity_id: opp, surface: 'feed_card', profile_id: '00000000-0000-4000-8000-000000000000' }, user.token)) === 400, 'a client-supplied profile_id → 400');
  assert((await post({ event_type: 'apply_clicked', opportunity_id: opp, surface: 'job_page' }, user.token)) === 201, 'signed-in apply_clicked → 201');
  assert((await post({ event_type: 'match_analyzed', opportunity_id: opp }, user.token)) === 201, 'signed-in match_analyzed → 201');
  const anon = `apply-suite-${Date.now()}`;
  anonIds.push(anon);
  assert((await post({ event_type: 'landing_viewed', anonymous_id: anon })) === 201, 'landing_viewed signed out still → 201');

  const { data: rows, error } = await db.from('funnel_events').select('event_type, profile_id, opportunity_id, surface').eq('profile_id', user.userId).order('event_type');
  assert(!error && rows?.length === 2, 'exactly two rows were written for the user', { error: error?.message, n: rows?.length });
  const click = rows?.find((r) => r.event_type === 'apply_clicked');
  const analyzed = rows?.find((r) => r.event_type === 'match_analyzed');
  assert(click?.surface === 'job_page' && click?.opportunity_id === opp && click?.profile_id === user.userId, 'apply_clicked row: surface, opportunity_id and the session\'s profile_id', click);
  assert(analyzed?.surface === null && analyzed?.opportunity_id === opp, 'match_analyzed row: no surface', analyzed);
}

let cleanupFailures = 0;
async function cleanup() {
  console.log('\nCLEANUP');
  if (!safetyPassed) {
    console.log('  live safety checks did not pass — no database cleanup attempted (nothing was created)');
    return;
  }
  const db = adminClient();
  if (createdUsers.length) {
    const { error } = await db.from('funnel_events').delete().in('profile_id', createdUsers);
    if (error) { cleanupFailures++; console.log(`  user funnel rows: NOT deleted — ${error.message}`); }
  }
  if (anonIds.length) {
    const { error } = await db.from('funnel_events').delete().in('anonymous_id', anonIds);
    if (error) { cleanupFailures++; console.log(`  anonymous funnel rows: NOT deleted — ${error.message}`); }
  }
  for (const id of createdUsers) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) { cleanupFailures++; console.log(`  user ${id}: NOT deleted — ${error.message}`); }
  }
  const left = await Promise.all([
    createdUsers.length ? db.from('funnel_events').select('id', { count: 'exact', head: true }).in('profile_id', createdUsers) : Promise.resolve({ count: 0, error: null }),
    anonIds.length ? db.from('funnel_events').select('id', { count: 'exact', head: true }).in('anonymous_id', anonIds) : Promise.resolve({ count: 0, error: null }),
    createdUsers.length ? db.from('profiles').select('id', { count: 'exact', head: true }).in('id', createdUsers) : Promise.resolve({ count: 0, error: null }),
  ]);
  const counts = left.map((r) => r.count);
  if (left.some((r) => r.error) || counts.some((n) => n !== 0)) {
    cleanupFailures++;
    console.log(`  leftover check FAILED: ${JSON.stringify(counts)}`);
  } else {
    console.log('  leftover check: 0 user funnel rows, 0 anonymous funnel rows, 0 profiles');
  }
}

(async () => {
  console.log('='.repeat(78));
  console.log('APPLY-CLICK / MATCH-ANALYZED FUNNEL EVENTS (MIGRATION 034)');
  console.log('='.repeat(78));
  try {
    unit();
    staticChecks();
    await migration();
    await live();
  } catch (err) {
    console.error('Suite crashed:', err);
    failed++;
  } finally {
    await cleanup().catch((err) => {
      cleanupFailures++;
      console.error('Cleanup crashed:', err);
    });
    if (cleanupFailures > 0) console.error(`\nCLEANUP INCOMPLETE: ${cleanupFailures} step(s) failed — test resources may remain.`);
    console.log(`\n${passed} passed, ${failed} failed, ${cleanupFailures} cleanup failure(s).`);
    process.exitCode = failed > 0 || cleanupFailures > 0 ? 1 : 0;
  }
})();

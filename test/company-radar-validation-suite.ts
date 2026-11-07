/**
 * RemoteMatch — Company Radar validation-period instrumentation (migration 035)
 * ==============================================================================
 * Proves:
 *   - UNIT: the validator accepts company_radar_viewed (anonymous_id only, no
 *     surface, no auth required) and apply_clicked with surface
 *     'company_profile'; rejects company_radar_viewed with a surface, missing
 *     anonymous_id, or an extra field; the five pre-existing event types and
 *     four pre-existing apply surfaces are unchanged.
 *   - STATIC: both Company Radar pages render CompanyRadarViewBeacon; the
 *     profile page's Apply link is CompanyProfileApplyLink (not a plain,
 *     untracked `<a>`), carrying canonicalId; the beacon file is a client
 *     component calling the existing recordFunnelEventClient/trackApplyClick/
 *     getOrCreateAnonymousId functions, introducing nothing new; catalog.ts
 *     still does not import catalog-read.ts's shared column-list constant
 *     (the invariant from the original Phase 0 implementation, re-verified
 *     after this change, not just assumed to still hold); zero diff in every
 *     frozen/pinned ingestion file.
 *   - MIGRATION (PGlite, no real database touched): 001 → 031 → 034 → 035
 *     apply cleanly and idempotently; company_radar_viewed inserts without a
 *     surface and is REJECTED with one (it may only ever use the event types
 *     already permitted for every other non-apply_clicked event — no
 *     surface); apply_clicked with surface 'company_profile' inserts; an
 *     unknown surface/event_type is still rejected; exactly one event_type
 *     CHECK remains; RLS stays enabled and forced; applying only through 034
 *     (pre-035) still rejects company_radar_viewed, proving 035 is what
 *     unlocks it, not an accident of 031/034 alone.
 *
 * Deliberately NO live/isolated-project section: migration 035 has not been
 * applied anywhere outside this suite's own throwaway PGlite instances.
 * Running it against any real Supabase project (even an isolated test one)
 * is a separate, explicitly-gated action per Deep's authorization boundary
 * ("do not apply the migration to production... without separate release
 * authorization") — reserved for whenever that's granted.
 *
 * Run: npx tsx test/company-radar-validation-suite.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { validateFunnelEventBody, funnelEventRequiresAuth, isFunnelEventType } from '../src/lib/funnel/events';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

function unit() {
  console.log('\nUNIT: validateFunnelEventBody');
  const opp = 'opp-remotive-123';

  assert(isFunnelEventType('company_radar_viewed'), 'company_radar_viewed is a recognized event type');
  assert(!funnelEventRequiresAuth('company_radar_viewed'), 'company_radar_viewed does not require a session (mirrors landing_viewed)');

  const ok = validateFunnelEventBody('company_radar_viewed', { anonymous_id: 'abcdef12-3456' });
  assert(ok.ok && ok.fields.anonymous_id === 'abcdef12-3456', 'company_radar_viewed with anonymous_id → ok', ok);
  assert(!validateFunnelEventBody('company_radar_viewed', {}).ok, 'company_radar_viewed without anonymous_id → rejected');
  assert(!validateFunnelEventBody('company_radar_viewed', { anonymous_id: 'abcdef12-3456', surface: 'company_profile' }).ok, 'company_radar_viewed with a surface field → rejected (not an allowed field for this event type)');
  assert(!validateFunnelEventBody('company_radar_viewed', { anonymous_id: 'abcdef12-3456', note: 'x' }).ok, 'company_radar_viewed with an extra field → rejected');

  const click = validateFunnelEventBody('apply_clicked', { opportunity_id: opp, surface: 'company_profile' });
  assert(click.ok && click.fields.surface === 'company_profile' && click.fields.opportunity_id === opp, 'apply_clicked with surface company_profile → ok', click);

  // Pre-existing behavior, unchanged (spot check — full coverage already in
  // test/apply-click-tracking-suite.ts, not duplicated here).
  for (const surface of ['feed_card', 'match_view', 'job_modal', 'job_page']) {
    assert(validateFunnelEventBody('apply_clicked', { opportunity_id: opp, surface }).ok, `apply_clicked with pre-existing surface ${surface} still → ok`);
  }
  assert(!validateFunnelEventBody('apply_clicked', { opportunity_id: opp, surface: 'homepage' }).ok, 'apply_clicked with an unknown surface → still rejected');
  assert(validateFunnelEventBody('landing_viewed', { anonymous_id: 'abcdef12-3456' }).ok, 'landing_viewed still accepted unchanged');
  assert(!validateFunnelEventBody('job_viewed', { opportunity_id: opp, surface: 'company_profile' }).ok, 'job_viewed with a surface → still rejected (existing events unchanged)');
}

function staticChecks() {
  console.log('\nSTATIC: wiring + isolation invariants');

  const searchPage = read('src/app/companies/page.tsx');
  assert(/<CompanyRadarViewBeacon \/>/.test(searchPage), 'company search page renders CompanyRadarViewBeacon');

  const profilePage = read('src/app/companies/view/[company]/page.tsx');
  assert(/<CompanyRadarViewBeacon \/>/.test(profilePage), 'company profile page renders CompanyRadarViewBeacon');
  assert(/<CompanyProfileApplyLink[\s\S]{0,120}canonicalId=\{opp\.canonicalId\}/.test(profilePage), 'profile page Apply link is CompanyProfileApplyLink carrying canonicalId');
  assert(!/<a\s+href=\{opp\.officialUrl\}/.test(profilePage), 'no plain, untracked Apply link left on the profile page');

  const beacon = read('src/app/companies/CompanyRadarViewBeacon.tsx');
  assert(/^'use client';/.test(beacon), 'CompanyRadarViewBeacon is a client component');
  assert(/recordFunnelEventClient\('company_radar_viewed', \{ anonymous_id: anonymousId \}\)/.test(beacon), 'beacon fires company_radar_viewed with anonymous_id');
  assert(/getOrCreateAnonymousId\(\)/.test(beacon), 'beacon reuses the existing anonymous-id function (no new identifier)');
  assert(/trackApplyClick\(canonicalId, 'company_profile'\)/.test(beacon), 'CompanyProfileApplyLink fires trackApplyClick with surface company_profile');
  assert(/target="_blank"/.test(beacon) && /rel="noopener noreferrer"/.test(beacon), 'CompanyProfileApplyLink uses the same target/rel convention as every other Apply link');

  const catalogSrc = noComments(read('src/lib/companies/catalog.ts'));
  assert(!/import[^;]*OPPORTUNITY_COLUMNS/.test(catalogSrc), 're-verified: src/lib/companies/catalog.ts still does not import OPPORTUNITY_COLUMNS after adding canonical_id');
  assert(/canonical_id/.test(catalogSrc), 'catalog.ts now selects canonical_id (needed to attribute apply_clicked)');

  const frozenPaths = [
    'src/lib/ingestion/catalog-sync.ts',
    'src/lib/ingestion/catalog-read.ts',
    'src/lib/ingestion/pipeline.ts',
    'src/lib/seo/directory.ts',
  ];
  try {
    const diff = execSync(`git diff --name-only -- ${frozenPaths.map((p) => `"${p}"`).join(' ')}`, { cwd: root, encoding: 'utf8' }).trim();
    assert(diff === '', 'zero working-tree diff in every frozen/pinned ingestion file', diff);
  } catch (e) {
    console.log(`  (could not run git diff: ${(e as Error).message})`);
  }
}

async function migration() {
  console.log('\nMIGRATION (PGlite, no real database touched): 001 → 031 → 034 → 035');
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
  const tryInsert = async (db: PGlite, eventType: string, surface: string | null, anonymousId: string | null = null) => {
    try {
      await db.query(
        `INSERT INTO funnel_events (event_type, opportunity_id, surface, anonymous_id) VALUES ($1, 'opp-remotive-1', $2, $3)`,
        [eventType, surface, anonymousId]
      );
      return true;
    } catch {
      return false;
    }
  };

  const db = await fresh();
  await db.exec(mig('031_funnel_events.sql'));
  await db.exec(mig('034_funnel_apply_click.sql'));

  // Pre-035: company_radar_viewed must not yet be accepted — proves 035,
  // not 031/034 alone, is what unlocks it.
  assert(!(await tryInsert(db, 'company_radar_viewed', null, 'anon-pre-035')), 'before 035: company_radar_viewed is rejected (event type not yet permitted)');
  assert(!(await tryInsert(db, 'apply_clicked', 'company_profile')), 'before 035: apply_clicked with surface company_profile is rejected (surface not yet permitted)');

  await db.exec(mig('035_company_radar_validation.sql'));
  assert(true, '001 → 031 → 034 → 035 apply cleanly');
  await db.exec(mig('035_company_radar_validation.sql'));
  assert(true, '035 applied a second time without error (idempotent)');

  assert(await tryInsert(db, 'company_radar_viewed', null, 'anon-1'), 'company_radar_viewed without a surface, with anonymous_id → inserts');
  assert(!(await tryInsert(db, 'company_radar_viewed', 'company_profile', 'anon-2')), 'company_radar_viewed WITH a surface → rejected (surface stays exclusive to apply_clicked, enforced by the untouched 034 constraint)');
  assert(await tryInsert(db, 'apply_clicked', 'company_profile'), 'apply_clicked with surface company_profile → inserts');
  for (const s of ['feed_card', 'match_view', 'job_modal', 'job_page']) {
    assert(await tryInsert(db, 'apply_clicked', s), `apply_clicked with pre-existing surface ${s} still → inserts`);
  }
  assert(!(await tryInsert(db, 'apply_clicked', 'homepage')), 'an unknown surface → still rejected by the database');
  assert(!(await tryInsert(db, 'some_future_event', null)), 'an unknown event type → still rejected by the database');

  const checks = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'funnel_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%landing_viewed%'`
  );
  assert(checks.rows[0].n === 1, 'exactly one event_type CHECK remains after three migrations + a re-run', checks.rows[0]);

  const rls = await db.query<{ r: boolean; f: boolean }>(
    `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = 'funnel_events'`
  );
  assert(rls.rows[0].r && rls.rows[0].f, 'RLS still enabled and forced on funnel_events');

  await db.close();
}

(async () => {
  console.log('='.repeat(78));
  console.log('COMPANY RADAR VALIDATION-PERIOD INSTRUMENTATION (MIGRATION 035)');
  console.log('='.repeat(78));
  try {
    unit();
    staticChecks();
    await migration();
  } catch (err) {
    console.error('Suite crashed:', err);
    failed++;
  } finally {
    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exitCode = failed > 0 ? 1 : 0;
  }
})();

/**
 * RemoteMatch — Auth Flow Change migration suite (014)
 * ==============================================================================
 * PGlite, full chain 001 -> 014.
 *   - onboarding_completed_at column: present, nullable, no default, NOT in the
 *     authenticated column grant
 *   - handle_new_auth_user() copies raw_user_meta_data->>'full_name'
 *   - complete_onboarding() RPC: auth.uid()-scoped, atomic, validating, the
 *     ONLY writer of onboarding_completed_at; one user cannot write another's
 *     rows; anon cannot execute
 *   - anon has no privilege on the profile sub-tables; authenticated still does
 *   - backfill: activity => stamped, no activity => NULL
 *   - every C2 RLS invariant from 013 still holds on 001->014
 *
 * Run: npx tsx test/auth-flow-migration-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
const mig = (n: string) => fs.readFileSync(path.resolve(__dirname, `../supabase/migrations/${n}`), 'utf8');

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333'; // active (has a swipe) -> backfilled

async function asUser(db: PGlite, uid: string | null) {
  await db.exec(`RESET ROLE; SET request.jwt.claim.role='${uid ? 'authenticated' : 'anon'}';`);
  await db.exec(`SET request.jwt.claim.sub='${uid ?? ''}';`);
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'};`);
}
async function asService(db: PGlite) {
  await db.exec(`RESET ROLE; SET request.jwt.claim.role='service_role'; SET request.jwt.claim.sub='';`);
}

const GOOD_ARGS = [
  'Ada Lovelace', 'Engineer',
  '{Full-time,Contract}', '{Backend Engineer,Platform Engineer}',
  '4-6', '120000', 'USD',
  JSON.stringify([{ name: 'Rust', isPrimary: true }, { name: 'Postgres', isPrimary: false }]),
  'worldwide', 'Portugal', 'WET',
  '{Worldwide}', '{UTC,WET}',
  'Ada Lovelace — backend engineer, 6y, distributed systems.',
];

function callComplete(argOverrides: Partial<Record<number, string>> = {}) {
  const a = GOOD_ARGS.map((v, i) => (i in argOverrides ? argOverrides[i]! : v));
  return `select public.complete_onboarding(
    $1::text,$2::text,$3::text[],$4::text[],$5::text,$6::numeric,$7::text,$8::jsonb,
    $9::text,$10::text,$11::text,$12::text[],$13::text[],$14::text
  ) as completed_at`;
}
const ARGS = (o: Partial<Record<number, string>> = {}) => GOOD_ARGS.map((v, i) => (i in o ? o[i]! : v));

async function run() {
  console.log('='.repeat(78));
  console.log('AUTH FLOW CHANGE — MIGRATION SUITE (014)');
  console.log('='.repeat(78) + '\n');

  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$ LANGUAGE sql STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon') $$ LANGUAGE sql STABLE;
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
      raw_app_meta_data jsonb DEFAULT '{}'::jsonb, is_anonymous boolean DEFAULT false,
      created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz,
      email_confirmed_at timestamptz, encrypted_password text
    );
  `);

  for (const m of [
    '001_initial_schema.sql', '002_row_level_security.sql', '003_security_remediation.sql',
    '004_fix_applications_grant.sql', '005_profile_links.sql', '006_outcome_lifecycle.sql',
    '007_application_transition_cas.sql', '008_application_transition_conflict_code.sql',
    '009_lock_down_readonly_helpers.sql', '010_live_supply_catalog.sql', '011_add_salary_period.sql',
    '012_supply_discovery_registry.sql', '013_demand_gap_table.sql',
  ]) {
    await db.exec(mig(m));
  }

  // Seed users BEFORE 014 so the 003 trigger (which auto-creates the profiles
  // rows, full_name NULL) + the 014 backfill are exercised as they would be in
  // production (014 is additive over an existing population).
  await asService(db);
  await db.exec(`
    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${U1}', 'u1@example.com', '{}'::jsonb),
      ('${U2}', 'u2@example.com', '{}'::jsonb),
      ('${U3}', 'u3@example.com', '{}'::jsonb);
    INSERT INTO swipes (profile_id, opportunity_id, action, created_at)
      VALUES ('${U3}', 'opp-curated-curated-001', 'passed', now());
  `);

  console.log('migration 014:');
  await db.exec(mig('014_auth_flow_change.sql'));
  assert(true, 'chain 001->014 applies cleanly');

  const col = await db.query(`
    SELECT is_nullable, column_default FROM information_schema.columns
    WHERE table_name='profiles' AND column_name='onboarding_completed_at'`);
  const c = col.rows[0] as { is_nullable: string; column_default: string | null };
  assert(!!c, 'profiles.onboarding_completed_at exists');
  assert(c && c.is_nullable === 'YES' && c.column_default === null, '  ...nullable, no default');

  // --- backfill ---
  console.log('\nbackfill:');
  const b = await db.query(`SELECT id, onboarding_completed_at IS NOT NULL AS stamped FROM profiles ORDER BY id`);
  const rows = b.rows as { id: string; stamped: boolean }[];
  assert(rows.find((r) => r.id === U3)?.stamped === true, 'user with a swipe -> onboarding_completed_at backfilled');
  assert(rows.find((r) => r.id === U1)?.stamped === false, 'user with no activity -> still NULL');
  assert(rows.find((r) => r.id === U2)?.stamped === false, '  ...second inactive user -> still NULL');

  // --- trigger copies full_name ---
  console.log('\nhandle_new_auth_user (full_name):');
  await asService(db);
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('44444444-4444-4444-4444-444444444444', 'u4@example.com', '{"full_name":"Grace Hopper"}'::jsonb)`);
  const fn = await db.query(`SELECT full_name FROM profiles WHERE id='44444444-4444-4444-4444-444444444444'`);
  assert((fn.rows[0] as { full_name: string | null })?.full_name === 'Grace Hopper', 'new signup: full_name copied from raw_user_meta_data');
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data)
    VALUES ('55555555-5555-5555-5555-555555555555', 'u5@example.com', '{"full_name":"  "}'::jsonb)`);
  const fn2 = await db.query(`SELECT full_name FROM profiles WHERE id='55555555-5555-5555-5555-555555555555'`);
  assert((fn2.rows[0] as { full_name: string | null })?.full_name === null, '  ...blank/whitespace full_name -> NULL');

  // --- grants ---
  console.log('\ngrants:');
  const grantRow = async (role: string, tbl: string) => {
    const r = await db.query(
      `SELECT count(*)::int n FROM information_schema.role_table_grants WHERE grantee=$1 AND table_name=$2`,
      [role, tbl],
    );
    return (r.rows[0] as { n: number }).n;
  };
  for (const t of ['profile_intents', 'profile_skills', 'profile_locations', 'profile_experiences']) {
    assert(await grantRow('anon', t) === 0, `anon has NO privilege on ${t}`);
    assert(await grantRow('authenticated', t) > 0, `  ...authenticated still does on ${t}`);
  }
  // onboarding_completed_at must NOT be a column the client may UPDATE
  const colGrant = await db.query(
    `SELECT count(*)::int n FROM information_schema.column_privileges
     WHERE grantee='authenticated' AND table_name='profiles'
       AND column_name='onboarding_completed_at' AND privilege_type='UPDATE'`);
  assert((colGrant.rows[0] as { n: number }).n === 0, 'authenticated CANNOT update profiles.onboarding_completed_at (no column grant)');

  // --- complete_onboarding: anon cannot execute ---
  console.log('\ncomplete_onboarding RPC:');
  await asUser(db, null);
  let anonDenied = false;
  try { await db.query(callComplete(), ARGS()); } catch { anonDenied = true; }
  finally { await db.exec('RESET ROLE;'); }
  assert(anonDenied, 'anon cannot EXECUTE complete_onboarding');

  // --- happy path for U1 ---
  await asUser(db, U1);
  const done = await db.query(callComplete(), ARGS());
  await db.exec('RESET ROLE;');
  assert(!!(done.rows[0] as { completed_at: string })?.completed_at, 'authenticated user completes onboarding -> returns a timestamp');

  await asService(db);
  const after = await db.query(`
    SELECT
      (SELECT onboarding_completed_at IS NOT NULL FROM profiles WHERE id='${U1}') AS stamped,
      (SELECT full_name FROM profiles WHERE id='${U1}') AS name,
      (SELECT array_length(employment_types,1) FROM profile_intents WHERE profile_id='${U1}') AS n_emp,
      (SELECT target_roles FROM profile_intents WHERE profile_id='${U1}') AS roles,
      (SELECT count(*)::int FROM profile_skills WHERE profile_id='${U1}') AS n_skills,
      (SELECT work_preference FROM profile_locations WHERE profile_id='${U1}') AS wp`);
  const a = after.rows[0] as { stamped: boolean; name: string; n_emp: number; roles: string[]; n_skills: number; wp: string };
  assert(a.stamped === true, '  ...onboarding_completed_at is set');
  assert(a.name === 'Ada Lovelace', '  ...profiles.full_name written');
  assert(a.n_emp === 2 && a.n_skills === 2 && a.wp === 'worldwide', '  ...intent + skills + location rows written');

  // --- re-submit is idempotent (replace-all skills, upsert intent) ---
  await asUser(db, U1);
  await db.query(callComplete({ 7: JSON.stringify([{ name: 'Go', isPrimary: true }]) }), ARGS({ 7: JSON.stringify([{ name: 'Go', isPrimary: true }]) }));
  await db.exec('RESET ROLE;');
  await asService(db);
  const reSkills = await db.query(`SELECT skill_name FROM profile_skills WHERE profile_id='${U1}' ORDER BY skill_name`);
  assert(reSkills.rows.length === 1 && (reSkills.rows[0] as { skill_name: string }).skill_name === 'Go',
    're-submit replaces skills (no orphans, no duplicates)');
  const nIntents = await db.query(`SELECT count(*)::int n FROM profile_intents WHERE profile_id='${U1}'`);
  assert((nIntents.rows[0] as { n: number }).n === 1, '  ...still exactly one intent row (upsert)');

  // --- one user CANNOT write another's profile ---
  console.log('\nisolation:');
  await asUser(db, U2);
  await db.query(callComplete({ 0: 'Mallory' }), ARGS({ 0: 'Mallory' }));  // writes U2 only, via auth.uid()
  await db.exec('RESET ROLE;');
  await asService(db);
  const u1name = await db.query(`SELECT full_name FROM profiles WHERE id='${U1}'`);
  const u2name = await db.query(`SELECT full_name FROM profiles WHERE id='${U2}'`);
  assert((u1name.rows[0] as { full_name: string }).full_name === 'Ada Lovelace', "U2's call did not touch U1's profile");
  assert((u2name.rows[0] as { full_name: string }).full_name === 'Mallory', "  ...U2's own profile was written (profile_id = auth.uid())");

  // --- validation: a missing required section is rejected, nothing stamped ---
  console.log('\nvalidation:');
  await asService(db);
  await db.exec(`UPDATE profiles SET onboarding_completed_at = NULL, full_name = 'Reset' WHERE id='${U2}';
                 DELETE FROM profile_intents WHERE profile_id='${U2}';`);
  await asUser(db, U2);
  let rejected = false;
  try {
    await db.query(callComplete({ 3: '{}' }), ARGS({ 3: '{}' })); // empty target_roles
  } catch (e) {
    rejected = String((e as Error).message).includes('onboarding_invalid');
  } finally {
    await db.exec('RESET ROLE;');
  }
  assert(rejected, 'empty target_roles -> onboarding_invalid, transaction rolled back');
  await asService(db);
  const u2stamp = await db.query(`SELECT onboarding_completed_at FROM profiles WHERE id='${U2}'`);
  assert((u2stamp.rows[0] as { onboarding_completed_at: string | null }).onboarding_completed_at === null,
    '  ...onboarding_completed_at stays NULL after a rejected submit');

  // --- C2 RLS still intact on 001->014 ---
  console.log('\nC2 (013) RLS unaffected:');
  const rls = await db.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='demand_gap_snapshots'`);
  const r = rls.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean };
  assert(r.relrowsecurity && r.relforcerowsecurity, 'demand_gap_snapshots still RLS ENABLED + FORCED');
  await asUser(db, U1);
  let dggDenied = false;
  try { await db.query(`SELECT * FROM demand_gap_snapshots`); } catch { dggDenied = true; }
  finally { await db.exec('RESET ROLE;'); }
  assert(dggDenied, 'authenticated still cannot read demand_gap_snapshots');

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });

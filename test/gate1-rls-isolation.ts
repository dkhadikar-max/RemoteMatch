/**
 * RemoteMatch (BYN Architecture) — Gate 1: Supabase RLS & Multi-Tenant Isolation
 * Verifies that User A is technically unable to SELECT, INSERT, UPDATE, or DELETE
 * User B's private records through the client/API across all 9 data domains.
 * Also verifies opportunity table security and event immutability.
 */

import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const OPP_1 = '33333333-3333-4333-8333-333333333333';
const APP_B = '44444444-4444-4444-8444-444444444444';
const APP_A = '55555555-5555-4555-8555-555555555555';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

async function setAuthContext(db: PGlite, userId: string | null, role: 'authenticated' | 'anon' | 'service_role') {
  if (role === 'service_role') {
    await db.query(`RESET ROLE;`);
    await db.query(`SET request.jwt.claim.role = 'service_role';`);
    await db.query(`SET request.jwt.claim.sub = '';`);
  } else {
    await db.query(`SET ROLE ${role};`);
    await db.query(`SET request.jwt.claim.role = '${role}';`);
    if (userId) {
      await db.query(`SET request.jwt.claim.sub = '${userId}';`);
    } else {
      await db.query(`SET request.jwt.claim.sub = '';`);
    }
  }
}

async function runGate1() {
  console.log('============================================================');
  console.log('GATE 1: SUPABASE RLS & MULTI-TENANT ISOLATION SUITE');
  console.log('Testing Postgres Row Level Security Semantics');
  console.log('============================================================\n');

  const db = new PGlite();

  // 1. Setup Supabase Auth Mock Functions
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$ LANGUAGE sql STABLE;

    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
    $$ LANGUAGE sql STABLE;
  `);

  // 2. Load and Apply 001_initial_schema.sql
  const schemaPath = path.resolve(__dirname, '../supabase/migrations/001_initial_schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await db.exec(schemaSql);

  // 3. Load and Apply 002_row_level_security.sql
  const rlsPath = path.resolve(__dirname, '../supabase/migrations/002_row_level_security.sql');
  const rlsSql = fs.readFileSync(rlsPath, 'utf8');
  await db.exec(rlsSql);

  console.log('Database schema and RLS policies successfully applied.\n');

  // Seed Opportunities as service_role
  await setAuthContext(db, null, 'service_role');
  await db.query(`
    INSERT INTO opportunities (
      id, title, company, description, source, source_id, official_url,
      canonical_url_hash, content_hash, status
    ) VALUES (
      '${OPP_1}', 'Senior Distributed Systems Engineer', 'CloudScale Inc',
      'High scale infra engineer role', 'curated', 'c-1', 'https://cloudscale.io/jobs/1',
      'urlhash1', 'contenthash1', 'active'
    );
  `);

  // --- SECTION 1: USER B CREATES PRIVATE RECORDS ---
  console.log('--- SECTION 1: Seed User B Private Workspace ---');
  await setAuthContext(db, USER_B, 'authenticated');

  await db.exec(`
    INSERT INTO profiles (id, email, full_name, headline, raw_resume_text)
    VALUES ('${USER_B}', 'user.b@target.org', 'Bob Vance', 'Lead Architect', 'Bob Secret Resume with 15 years experience at Vault Corp.');

    INSERT INTO profile_skills (id, profile_id, skill_name, years_used)
    VALUES (gen_random_uuid(), '${USER_B}', 'Rust', 8);

    INSERT INTO profile_experiences (id, profile_id, company, role_title)
    VALUES (gen_random_uuid(), '${USER_B}', 'Vault Corp', 'Staff Engineer');

    INSERT INTO swipes (profile_id, opportunity_id, action)
    VALUES ('${USER_B}', '${OPP_1}', 'interested');

    INSERT INTO matches (profile_id, opportunity_id, fit_score, why_this_job)
    VALUES ('${USER_B}', '${OPP_1}', 94, 'Direct alignment with distributed systems track record.');

    INSERT INTO applications (id, profile_id, opportunity_id, status, notes)
    VALUES ('${APP_B}', '${USER_B}', '${OPP_1}', 'interview', 'Confidential Interview round with VP of Eng scheduled for Thursday.');

    INSERT INTO application_events (application_id, event_type, event_payload)
    VALUES ('${APP_B}', 'interview_scheduled', '{"round": "tech_deep_dive"}');

    INSERT INTO generated_materials (application_id, material_type, tone, content)
    VALUES ('${APP_B}', 'cover_letter', 'confident', 'Confidential Cover Letter detailing proprietary systems built at Vault Corp.');
  `);
  console.log('User B records populated successfully.\n');

  // --- SECTION 2: USER A ATTEMPTS CROSS-TENANT ACCESS ---
  console.log('--- SECTION 2: User A Cross-Tenant Isolation Tests (Expect 0 Rows / Rejection) ---');
  await setAuthContext(db, USER_A, 'authenticated');

  // Test 1: User A cannot SELECT User B's profile
  const userBProfile = await db.query(`SELECT * FROM profiles WHERE id = '${USER_B}'`);
  assert(userBProfile.rows.length === 0, 'User A cannot SELECT User B profile (0 rows returned)');

  // Test 2: User A cannot read User B's raw resume
  const userBResume = await db.query(`SELECT raw_resume_text FROM profiles WHERE id = '${USER_B}'`);
  assert(userBResume.rows.length === 0, 'User A cannot read User B raw resume text');

  // Test 3: User A forged UPDATE on User B's profile
  const updateBProfile = await db.query(`UPDATE profiles SET headline = 'HACKED' WHERE id = '${USER_B}'`);
  assert(updateBProfile.rowCount === 0, 'Forged UPDATE on User B profile affects 0 rows');

  // Verify headline was not changed
  await setAuthContext(db, null, 'service_role');
  const verifyB = await db.query(`SELECT headline FROM profiles WHERE id = '${USER_B}'`);
  assert((verifyB.rows[0] as any)?.headline === 'Lead Architect', 'User B profile remains uncorrupted');
  await setAuthContext(db, USER_A, 'authenticated');

  // Test 4: User A forged DELETE on User B's profile
  const deleteBProfile = await db.query(`DELETE FROM profiles WHERE id = '${USER_B}'`);
  assert(deleteBProfile.rowCount === 0, 'Forged DELETE on User B profile deletes 0 rows');

  // Test 5: User A forged INSERT of profile claiming User B's ID
  let insertForgedProfileFailed = false;
  try {
    await db.query(`INSERT INTO profiles (id, email, full_name) VALUES ('${USER_B}', 'attacker@evil.com', 'Fake Profile')`);
  } catch (err) {
    insertForgedProfileFailed = true;
  }
  assert(insertForgedProfileFailed, 'Forged INSERT with User B ID rejected by WITH CHECK policy');

  // Test 6: User A cannot view User B's skills or experiences
  const userBSkills = await db.query(`SELECT * FROM profile_skills WHERE profile_id = '${USER_B}'`);
  assert(userBSkills.rows.length === 0, 'User A cannot SELECT User B skills (0 rows returned)');

  const userBExp = await db.query(`SELECT * FROM profile_experiences WHERE profile_id = '${USER_B}'`);
  assert(userBExp.rows.length === 0, 'User A cannot SELECT User B experiences (0 rows returned)');

  // Test 7: User A cannot insert forged skill for User B
  let insertForgedSkillFailed = false;
  try {
    await db.query(`INSERT INTO profile_skills (profile_id, skill_name) VALUES ('${USER_B}', 'HackerSkill')`);
  } catch {
    insertForgedSkillFailed = true;
  }
  assert(insertForgedSkillFailed, 'User A cannot INSERT skills belonging to User B');

  // Test 8: User A cannot view User B's swipes or matches
  const userBSwipes = await db.query(`SELECT * FROM swipes WHERE profile_id = '${USER_B}'`);
  assert(userBSwipes.rows.length === 0, 'User A cannot SELECT User B swipes');

  const userBMatches = await db.query(`SELECT * FROM matches WHERE profile_id = '${USER_B}'`);
  assert(userBMatches.rows.length === 0, 'User A cannot SELECT User B matches or fit scores');

  // Test 9: User A cannot view User B's applications or notes
  const userBApps = await db.query(`SELECT * FROM applications WHERE profile_id = '${USER_B}'`);
  assert(userBApps.rows.length === 0, 'User A cannot SELECT User B applications');

  const userBNotes = await db.query(`SELECT notes FROM applications WHERE id = '${APP_B}'`);
  assert(userBNotes.rows.length === 0, 'User A cannot read User B confidential interview notes');

  // Test 10: User A forged UPDATE on User B's application
  const updateBApp = await db.query(`UPDATE applications SET notes = 'TAMPERED NOTE' WHERE id = '${APP_B}'`);
  assert(updateBApp.rowCount === 0, 'Forged UPDATE on User B application affects 0 rows');

  // Test 11: User A forged ownership theft on application
  const stealApp = await db.query(`UPDATE applications SET profile_id = '${USER_A}' WHERE id = '${APP_B}'`);
  assert(stealApp.rowCount === 0, 'Forged ownership theft of application affects 0 rows');

  // Test 12: User A cannot view User B's generated materials (cover letters)
  const userBMaterials = await db.query(`SELECT * FROM generated_materials WHERE application_id = '${APP_B}'`);
  assert(userBMaterials.rows.length === 0, 'User A cannot SELECT User B generated cover letters or materials');

  // Test 13: User A cannot view User B's application events
  const userBEvents = await db.query(`SELECT * FROM application_events WHERE application_id = '${APP_B}'`);
  assert(userBEvents.rows.length === 0, 'User A cannot SELECT User B application events');

  // Test 14: User A cannot inject fake events into User B's application
  let injectFakeEventFailed = false;
  try {
    await db.query(`
      INSERT INTO application_events (application_id, event_type, event_payload)
      VALUES ('${APP_B}', 'offer_received', '{"salary": 500000}')
    `);
  } catch {
    injectFakeEventFailed = true;
  }
  assert(injectFakeEventFailed, 'User A cannot inject fake events into User B application');

  // --- SECTION 3: USER A LEGITIMATE CRUD ON OWN DATA ---
  console.log('\n--- SECTION 3: User A Legitimate CRUD on Own Data ---');

  // Create User A profile
  await db.query(`
    INSERT INTO profiles (id, email, full_name, headline)
    VALUES ('${USER_A}', 'alice@example.com', 'Alice Smith', 'Full Stack Developer');
  `);
  const aliceProfile = await db.query(`SELECT * FROM profiles WHERE id = '${USER_A}'`);
  assert(aliceProfile.rows.length === 1, 'User A can INSERT and SELECT own profile');

  // User A updates own profile
  await db.query(`UPDATE profiles SET headline = 'Senior Full Stack' WHERE id = '${USER_A}'`);
  const aliceUpdated = await db.query(`SELECT headline FROM profiles WHERE id = '${USER_A}'`);
  assert((aliceUpdated.rows[0] as any)?.headline === 'Senior Full Stack', 'User A can UPDATE own profile');

  // User A creates application
  await db.query(`
    INSERT INTO applications (id, profile_id, opportunity_id, status, notes)
    VALUES ('${APP_A}', '${USER_A}', '${OPP_1}', 'applied', 'Submitted official application form.');
  `);
  const aliceApp = await db.query(`SELECT * FROM applications WHERE id = '${APP_A}'`);
  assert(aliceApp.rows.length === 1 && (aliceApp.rows[0] as any)?.notes === 'Submitted official application form.', 'User A can create and read own application');

  // User A creates event
  await db.query(`
    INSERT INTO application_events (application_id, event_type, event_payload)
    VALUES ('${APP_A}', 'feedback_submitted', '{"did_apply": "applied"}');
  `);
  const aliceEvents = await db.query(`SELECT * FROM application_events WHERE application_id = '${APP_A}'`);
  assert(aliceEvents.rows.length === 1, 'User A can insert and read own application events');

  // User A creates and reads generated materials
  await db.query(`
    INSERT INTO generated_materials (application_id, material_type, tone, content)
    VALUES ('${APP_A}', 'cover_letter', 'confident', 'Alice cover letter for CloudScale');
  `);
  const aliceMaterials = await db.query(`SELECT * FROM generated_materials WHERE application_id = '${APP_A}'`);
  assert(aliceMaterials.rows.length === 1, 'User A can create and read own generated materials');

  // --- SECTION 4: EVENT IMMUTABILITY & OPPORTUNITY ACCESS CONTROL ---
  console.log('\n--- SECTION 4: Event Immutability & Opportunity Security ---');

  // Test 15: User A attempts to UPDATE own application event (Forbidden by policy)
  const updateOwnEvent = await db.query(`
    UPDATE application_events SET event_type = 'offer_received' WHERE application_id = '${APP_A}'
  `);
  assert(updateOwnEvent.rowCount === 0, 'User A CANNOT UPDATE application events (Events are immutable, 0 rows updated)');

  // Test 16: User A attempts to DELETE own application event (Forbidden by policy)
  const deleteOwnEvent = await db.query(`
    DELETE FROM application_events WHERE application_id = '${APP_A}'
  `);
  assert(deleteOwnEvent.rowCount === 0, 'User A CANNOT DELETE application events (Events are immutable, 0 rows deleted)');

  // Test 17: User A can read active opportunities
  const activeOpps = await db.query(`SELECT * FROM opportunities WHERE id = '${OPP_1}'`);
  assert(activeOpps.rows.length === 1, 'User A can SELECT active opportunities');

  // Test 18: User A cannot mutate opportunities
  const updateOpp = await db.query(`UPDATE opportunities SET status = 'expired' WHERE id = '${OPP_1}'`);
  assert(updateOpp.rowCount === 0, 'User A CANNOT UPDATE opportunities (Mutations restricted, 0 rows updated)');

  let insertOppFailed = false;
  try {
    await db.query(`
      INSERT INTO opportunities (title, company, description, source, source_id, official_url, canonical_url_hash, content_hash)
      VALUES ('Fake Job', 'Evil Corp', 'Hacked', 'user', 'u-1', 'https://evil.com', 'h1', 'h2')
    `);
  } catch {
    insertOppFailed = true;
  }
  assert(insertOppFailed, 'User A CANNOT INSERT into opportunities (Reserved for service_role)');

  // Test 19: service_role can ingest opportunities
  await setAuthContext(db, null, 'service_role');
  await db.query(`
    INSERT INTO opportunities (
      title, company, description, source, source_id, official_url,
      canonical_url_hash, content_hash, status
    ) VALUES (
      'Service Ingested Job', 'Verified Corp', 'Legit role', 'jobicy', 'j-100',
      'https://verified.io/job/100', 'hash100', 'content100', 'active'
    );
  `);
  const serviceCheck = await db.query(`SELECT * FROM opportunities WHERE source_id = 'j-100'`);
  assert(serviceCheck.rows.length === 1, 'service_role CAN ingest opportunities into canonical supply');

  console.log('\n============================================================');
  console.log(`GATE 1 AUDIT RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runGate1().catch((err) => {
  console.error('Fatal error running Gate 1 suite:', err);
  process.exit(1);
});

/**
 * RemoteMatch — interested swipe scores the swiper's OWN profile (gate 0)
 * ==============================================================================
 * POST /api/opportunities/swipe used to score every interested swipe, and
 * write every Application Kit, against the `localStore` demo fixture — the
 * same seeded person for every user. Proves:
 *   - STATIC: the route reads the profile with loadServerProfile(), never
 *     localStore, and stamps profileSource/profileUsable on the snapshot.
 *   - LIVE: two users with different real profiles swipe the SAME job. Each
 *     snapshot's fitScore equals the frozen engine run on THAT user's own
 *     server profile; the two differ; each cover letter names its own user
 *     and never the other user or the demo fixture person.
 *   - LIVE: a user with no skill and no target role still gets the swipe
 *     saved, but with no score and no kit (profileUsable=false).
 *
 * Server: ONE local dev server started with the same env file as this runner
 * (no OPENAI_API_KEY, so kits use the deterministic fallback). TEST_BASE_URL
 * is a NON-admin host of it (default http://127.0.0.1:3400). The live section
 * refuses (and the run FAILS, exit 1) unless that URL is local http and
 * ISOLATED_TEST_PROJECT_HOST equals the database host exactly.
 *
 * Cleanup (always): deletes every user created (profile rows, swipes and
 * applications cascade) and the seeded opportunity, then verifies none remain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, hasRequiredEnv, newVerifiedSession, type TestSession } from './helpers/verified-session';
import { loadServerProfile } from '../src/lib/profile/server-profile';
import { generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { getActiveOpportunityByCanonicalId } from '../src/lib/ingestion/catalog-read';
import { localStore } from '../src/lib/db/mock-seed';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3400';
const ISOLATED_HOST = process.env.ISOLATED_TEST_PROJECT_HOST ?? '';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

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
function refuse(reason: string) {
  console.log(`\nRefusing to run live checks: ${reason}`);
  failed++;
}

let safetyPassed = false;
const createdUsers: string[] = [];
let seededOpportunityRowId: string | null = null;
/** swipes/applications key on the canonical 'opp-<source>-<source_id>' text, not the row uuid (migration 003). */
let seededCanonicalId: string | null = null;

async function newUser(): Promise<TestSession> {
  const s = await newVerifiedSession();
  createdUsers.push(s.userId);
  return s;
}

async function giveProfile(db: SupabaseClient, userId: string, p: { fullName: string; skills: string[]; roles: string[] }) {
  const { error: e1 } = await db.from('profiles').update({ full_name: p.fullName }).eq('id', userId);
  if (e1) throw new Error(`profiles.full_name: ${e1.message}`);
  if (p.skills.length) {
    const { error } = await db.from('profile_skills').insert(p.skills.map((skill_name) => ({ profile_id: userId, skill_name })));
    if (error) throw new Error(`profile_skills: ${error.message}`);
  }
  const { error: e2 } = await db.from('profile_intents').upsert({ profile_id: userId, target_roles: p.roles }, { onConflict: 'profile_id' });
  if (e2) throw new Error(`profile_intents: ${e2.message}`);
  const { error: e3 } = await db.from('profile_locations').upsert({ profile_id: userId, work_preference: 'worldwide' }, { onConflict: 'profile_id' });
  if (e3) throw new Error(`profile_locations: ${e3.message}`);
}

async function swipe(token: string, opportunityId: string) {
  const r = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ opportunityId, action: 'interested' }),
  });
  let body: any = {};
  try { body = JSON.parse(await r.text()); } catch { /* non-JSON */ }
  return { status: r.status, body };
}

async function snapshotFor(db: SupabaseClient, userId: string): Promise<Record<string, any> | null> {
  const { data, error } = await db
    .from('swipes')
    .select('decision_snapshot')
    .eq('profile_id', userId)
    .eq('opportunity_id', seededCanonicalId!)
    .maybeSingle();
  if (error) throw new Error(`swipes read: ${error.message}`);
  return (data?.decision_snapshot as Record<string, any>) ?? null;
}

async function run() {
  console.log('='.repeat(78));
  console.log('SWIPE — SCORES THE SWIPER\'S OWN PROFILE (GATE 0)');
  console.log('='.repeat(78));

  console.log('\nSTATIC: POST /api/opportunities/swipe');
  const src = readFileSync(join(__dirname, '../src/app/api/opportunities/swipe/route.ts'), 'utf8');
  assert(!/from '@\/lib\/db\/mock-seed'/.test(src) && !/localStore\.getProfile\(\)/.test(src), 'the route no longer imports or reads the localStore demo fixture');
  assert(/loadServerProfile\(supabase, auth\.user\)/.test(src), 'the route reads the profile with loadServerProfile(supabase, auth.user)');
  assert(/isUsableProfile\(profile\)/.test(src), 'the route checks the profile is usable before scoring');
  assert(/profileSource: 'server'/.test(src) && /profileUsable,/.test(src), 'the snapshot records profileSource and profileUsable');

  // ---------------------------------------------------------------- SAFETY
  let u: URL;
  try { u = new URL(BASE_URL); } catch { return refuse('TEST_BASE_URL is not a valid URL.'); }
  if (u.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(u.hostname)) return refuse('TEST_BASE_URL must be a local http server.');
  if (!hasRequiredEnv()) return refuse('Supabase env incomplete.');
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  if (!ISOLATED_HOST || host !== ISOLATED_HOST) return refuse('ISOLATED_TEST_PROJECT_HOST must equal the database host.');
  safetyPassed = true;
  const db = adminClient();

  // ---------------------------------------------------------------- SEED
  console.log('\nSEED: one active job, three users');
  const sourceId = `gate0-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data: oppRow, error: oppErr } = await db
    .from('opportunities')
    .insert({
      source: 'remotive',
      source_id: sourceId,
      type: 'job',
      title: 'Senior Rust Platform Engineer',
      company: `Gate0 Test Co (${sourceId})`,
      description: `${'We build infrastructure in Rust on Kubernetes with Terraform. '.repeat(4)} ${sourceId}`,
      required_skills: ['Rust', 'Kubernetes', 'Terraform'],
      source_url: 'https://example.com',
      official_url: 'https://example.com',
      canonical_url_hash: `hash-${sourceId}`,
      content_hash: `content-${sourceId}`,
      employment_type: 'Full-time',
      remote_type: 'Worldwide',
      eligible_countries: [],
      excluded_countries: [],
      timezone_requirements: [],
      explicit_remote_scope: 'explicit_worldwide',
      status: 'active',
      posted_at: new Date().toISOString(),
      first_seen_at: new Date().toISOString(),
      last_seen_in_feed_at: new Date().toISOString(),
      consecutive_absences: 0,
    })
    .select('id, canonical_id')
    .single();
  if (oppErr || !oppRow) throw new Error(`could not seed the opportunity: ${oppErr?.message}`);
  seededOpportunityRowId = oppRow.id as string;
  const canonicalId = oppRow.canonical_id as string;
  seededCanonicalId = canonicalId;

  const a = await newUser();
  const b = await newUser();
  const c = await newUser();
  await giveProfile(db, a.userId, { fullName: 'Gate0 Rustacean', skills: ['Rust', 'Kubernetes', 'Terraform'], roles: ['Platform Engineer'] });
  await giveProfile(db, b.userId, { fullName: 'Gate0 Designer', skills: ['Figma', 'User Research'], roles: ['Product Designer'] });
  await giveProfile(db, c.userId, { fullName: '', skills: [], roles: [] });

  // What the frozen engine says for each user's OWN server profile, read the
  // same way the route reads it (their own RLS-scoped client).
  const opp = await getActiveOpportunityByCanonicalId(a.client, canonicalId);
  if (!opp) throw new Error('seeded opportunity is not readable as active');
  const expectedA = generateRuleBasedMatchAnalysis(await loadServerProfile(a.client, { id: a.userId, email: a.email }), opp).fitScore;
  const expectedB = generateRuleBasedMatchAnalysis(await loadServerProfile(b.client, { id: b.userId, email: b.email }), opp).fitScore;
  const fixtureName = localStore.getProfile().fullName;
  assert(expectedA !== expectedB, 'precondition: the two real profiles score differently on this job', { expectedA, expectedB });

  // ---------------------------------------------------------------- LIVE
  console.log('\nLIVE: each swipe is scored and written for the swiper');
  const ra = await swipe(a.token, canonicalId);
  const rb = await swipe(b.token, canonicalId);
  assert(ra.status === 200 && ra.body.success === true, 'user A interested swipe → 200', ra.status);
  assert(rb.status === 200 && rb.body.success === true, 'user B interested swipe → 200', rb.status);
  const sa = await snapshotFor(db, a.userId);
  const sb = await snapshotFor(db, b.userId);
  assert(sa?.profileSource === 'server' && sa?.profileUsable === true, 'A snapshot: profileSource=server, profileUsable=true', { profileSource: sa?.profileSource, profileUsable: sa?.profileUsable });
  assert(sb?.profileSource === 'server' && sb?.profileUsable === true, 'B snapshot: profileSource=server, profileUsable=true', { profileSource: sb?.profileSource, profileUsable: sb?.profileUsable });
  assert(sa?.fitScore === expectedA, 'A fitScore equals the engine run on A\'s own profile', { got: sa?.fitScore, expectedA });
  assert(sb?.fitScore === expectedB, 'B fitScore equals the engine run on B\'s own profile', { got: sb?.fitScore, expectedB });
  assert(sa?.fitScore !== sb?.fitScore, 'A and B got different scores for the same job', { a: sa?.fitScore, b: sb?.fitScore });
  const la = String(sa?.coverLetter ?? '');
  const lb = String(sb?.coverLetter ?? '');
  assert(la.includes('Gate0 Rustacean') && !la.includes('Gate0 Designer'), 'A\'s cover letter names A, not B');
  assert(lb.includes('Gate0 Designer') && !lb.includes('Gate0 Rustacean'), 'B\'s cover letter names B, not A');
  assert(!!fixtureName && !la.includes(fixtureName) && !lb.includes(fixtureName), `neither cover letter names the demo fixture person ("${fixtureName}")`);

  console.log('\nLIVE: an unusable profile is saved without a score');
  const rc = await swipe(c.token, canonicalId);
  assert(rc.status === 200 && rc.body.success === true, 'user C (no skill, no role) interested swipe → 200, still saved', rc.status);
  const sc = await snapshotFor(db, c.userId);
  assert(sc?.profileSource === 'server' && sc?.profileUsable === false, 'C snapshot: profileUsable=false', { profileUsable: sc?.profileUsable });
  assert(sc?.fitScore === null && sc?.fitBadge === null && sc?.isEligible === null, 'C snapshot: no fitScore, fitBadge or isEligible', { fitScore: sc?.fitScore });
  assert(sc?.coverLetter === null && sc?.resumeTweaks === null, 'C snapshot: no Application Kit');
  const { data: appC } = await db.from('applications').select('status').eq('profile_id', c.userId).eq('opportunity_id', seededCanonicalId!).maybeSingle();
  assert(appC?.status === 'interested', 'C still gets an "interested" application row', appC);
}

let cleanupFailures = 0;
async function cleanup() {
  console.log('\nCLEANUP');
  if (!safetyPassed) {
    console.log('  safety checks did not pass — no database cleanup attempted (nothing was created)');
    return;
  }
  const db = adminClient();
  let deleted = 0;
  for (const id of createdUsers) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) { cleanupFailures++; console.log(`  user ${id}: NOT deleted — ${error.message}`); } else deleted++;
  }
  console.log(`  deleted ${deleted}/${createdUsers.length} test users`);
  if (seededOpportunityRowId) {
    const { error } = await db.from('opportunities').delete().eq('id', seededOpportunityRowId);
    if (error) { cleanupFailures++; console.log(`  opportunity: NOT deleted — ${error.message}`); }
  }
  const checks = await Promise.all([
    createdUsers.length ? db.from('profiles').select('id', { count: 'exact', head: true }).in('id', createdUsers) : Promise.resolve({ count: 0, error: null }),
    createdUsers.length ? db.from('swipes').select('id', { count: 'exact', head: true }).in('profile_id', createdUsers) : Promise.resolve({ count: 0, error: null }),
    seededOpportunityRowId ? db.from('opportunities').select('id', { count: 'exact', head: true }).eq('id', seededOpportunityRowId) : Promise.resolve({ count: 0, error: null }),
  ]);
  const left = { profiles: checks[0].count, swipes: checks[1].count, opportunities: checks[2].count };
  if (checks.some((r) => r.error) || Object.values(left).some((n) => n !== 0)) {
    cleanupFailures++;
    console.log(`  leftover check FAILED: ${JSON.stringify(left)}`);
  } else {
    console.log('  leftover check: 0 profiles, 0 swipes, 0 opportunities');
  }
}

run()
  .catch((err) => {
    console.error('Suite crashed:', err);
    failed++;
  })
  .finally(async () => {
    await cleanup().catch((err) => {
      cleanupFailures++;
      console.error('Cleanup crashed:', err);
    });
    if (cleanupFailures > 0) console.error(`\nCLEANUP INCOMPLETE: ${cleanupFailures} step(s) failed — test resources may remain.`);
    console.log(`\n${passed} passed, ${failed} failed, ${cleanupFailures} cleanup failure(s).`);
    process.exitCode = failed > 0 || cleanupFailures > 0 ? 1 : 0;
  });

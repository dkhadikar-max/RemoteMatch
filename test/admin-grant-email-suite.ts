/**
 * RemoteMatch — admin grant (POST /api/admin/admins) email resolution suite
 * ==============================================================================
 * The grant route resolves the target account from an admin-typed email with
 * ILIKE. Unescaped, "_" and "%" in that email are wildcards, so a grant for
 * "a_b@…" could land on "axb@…". Proves:
 *   - UNIT: likeLiteral() escapes \, % and _ (and nothing else).
 *   - STATIC: the route escapes before .ilike(), reads at most 2 rows, keeps
 *     only exact (lowercased) matches, and answers 404 for none / 409 for more
 *     than one — never maybeSingle() on a pattern.
 *   - LIVE: with a decoy account "…-axb@…" present, a grant for the
 *     non-existent "…-a_b@…" (or "…-a%b@…") → 404 and grants nobody; once
 *     "…-a_b@…" exists, granting it (typed in upper case) → 200 for exactly
 *     that account, and the decoy is still not an admin.
 *
 * Server: ONE local dev server started with the same env file as this runner
 * plus ADMIN_HOST_OVERRIDE=<admin host:port>; TEST_ADMIN_BASE_URL is that
 * admin host (default http://localhost:3400). The live section refuses (and
 * the run FAILS, exit 1) unless the URL is local http and
 * ISOLATED_TEST_PROJECT_HOST equals the database host exactly.
 *
 * Cleanup (always): deletes the audit rows written by the suite's admin and
 * every user it created (admin_users rows cascade), then verifies none remain.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { adminClient, hasRequiredEnv, newVerifiedSession } from './helpers/verified-session';
import { likeLiteral } from '../src/lib/supabase/query-helpers';

const ADMIN_BASE_URL = process.env.TEST_ADMIN_BASE_URL || 'http://localhost:3400';
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
let testAdminId: string | null = null;

async function userWithEmail(email: string) {
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { data, error } = await adminClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`create user: ${error?.message}`);
  createdUsers.push(data.user.id);
  return data.user.id;
}
async function grant(token: string, email: string) {
  const r = await fetch(`${ADMIN_BASE_URL}/api/admin/admins`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ email }),
  });
  let body: any = {};
  try { body = JSON.parse(await r.text()); } catch { /* non-JSON */ }
  return { status: r.status, body };
}
async function isAdmin(id: string) {
  const { data, error } = await adminClient().from('admin_users').select('id, revoked_at').eq('id', id).maybeSingle();
  if (error) throw new Error(`admin_users read: ${error.message}`);
  return !!data && data.revoked_at === null;
}

async function run() {
  console.log('='.repeat(78));
  console.log('ADMIN GRANT — EMAIL RESOLUTION SUITE');
  console.log('='.repeat(78));

  console.log('\nUNIT: likeLiteral');
  assert(likeLiteral('a_b@example.com') === 'a\\_b@example.com', '"_" is escaped');
  assert(likeLiteral('a%b@example.com') === 'a\\%b@example.com', '"%" is escaped');
  assert(likeLiteral('a\\b@example.com') === 'a\\\\b@example.com', '"\\" is escaped');
  assert(likeLiteral('first.last+tag@example.com') === 'first.last+tag@example.com', 'ordinary email characters are untouched');

  console.log('\nSTATIC: POST /api/admin/admins');
  const src = readFileSync(join(__dirname, '../src/app/api/admin/admins/route.ts'), 'utf8');
  assert(/\.ilike\('email', likeLiteral\(email\)\)/.test(src), 'the email is escaped before .ilike()');
  assert(!/\.ilike\('email', email\)/.test(src), 'no unescaped .ilike() on the raw email');
  assert(/\.limit\(2\)/.test(src) && !/maybeSingle\(\)/.test(src), 'reads at most 2 rows; no maybeSingle() on a pattern');
  assert(/\.toLowerCase\(\) === email/.test(src), 'keeps only exact lowercased matches');
  assert(/exact\.length === 0[\s\S]{0,200}status: 404/.test(src), 'no exact match → 404');
  assert(/exact\.length > 1[\s\S]{0,200}nothing was changed[\s\S]{0,40}status: 409/.test(src), 'more than one exact match → 409, nothing changed');
  assert(src.indexOf('.upsert(') > src.indexOf('exact.length > 1'), 'both refusals happen before the admin_users upsert');

  // ---------------------------------------------------------------- SAFETY
  let u: URL;
  try { u = new URL(ADMIN_BASE_URL); } catch { return refuse('TEST_ADMIN_BASE_URL is not a valid URL.'); }
  if (u.protocol !== 'http:' || !LOCAL_HOSTNAMES.has(u.hostname)) return refuse('TEST_ADMIN_BASE_URL must be a local http server.');
  if (!hasRequiredEnv()) return refuse('Supabase env incomplete.');
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  if (!ISOLATED_HOST || host !== ISOLATED_HOST) return refuse('ISOLATED_TEST_PROJECT_HOST must equal the database host.');
  safetyPassed = true;
  const db = adminClient();

  // ---------------------------------------------------------------- LIVE
  console.log('\nLIVE: wildcard emails resolve only to themselves');
  const admin = await newVerifiedSession();
  createdUsers.push(admin.userId);
  testAdminId = admin.userId;
  const { error: mkErr } = await db.from('admin_users').insert({ id: admin.userId, email: admin.email, granted_by: 'admin-grant-email-suite' });
  if (mkErr) throw new Error(`could not create the suite's test admin: ${mkErr.message}`);

  const tag = `remotematch-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const decoyId = await userWithEmail(`${tag}-axb@example.com`);

  const underscore = await grant(admin.token, `${tag}-a_b@example.com`);
  assert(underscore.status === 404, '"_" email with only a look-alike account present → 404', underscore);
  const percent = await grant(admin.token, `${tag}-a%b@example.com`);
  assert(percent.status === 404, '"%" email with only a look-alike account present → 404', percent);
  const star = await grant(admin.token, `${tag}-a*b@example.com`);
  assert(star.status === 404, '"*" email with only a look-alike account present → 404', star);
  assert(!(await isAdmin(decoyId)), 'the look-alike account was not made an admin');

  const realId = await userWithEmail(`${tag}-a_b@example.com`);
  const exact = await grant(admin.token, `${tag}-A_B@EXAMPLE.COM`);
  assert(exact.status === 200 && exact.body.id === realId, 'the real "_" account (typed in upper case) → 200, resolved to exactly it', exact);
  assert(await isAdmin(realId), 'the real account is now an admin');
  assert(!(await isAdmin(decoyId)), 'the look-alike account is still not an admin');
}

let cleanupFailures = 0;
async function cleanup() {
  console.log('\nCLEANUP');
  if (!safetyPassed) {
    console.log('  safety checks did not pass — no database cleanup attempted (nothing was created)');
    return;
  }
  const db = adminClient();
  if (testAdminId) {
    const { error } = await db.from('admin_audit_log').delete().eq('admin_id', testAdminId);
    if (error) { cleanupFailures++; console.log(`  audit rows: NOT deleted — ${error.message}`); }
  }
  let deleted = 0;
  for (const id of createdUsers) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error) { cleanupFailures++; console.log(`  user ${id}: NOT deleted — ${error.message}`); } else deleted++;
  }
  console.log(`  deleted ${deleted}/${createdUsers.length} test users`);
  if (createdUsers.length === 0) return;
  const [adm, aud, prof] = await Promise.all([
    db.from('admin_users').select('id', { count: 'exact', head: true }).in('id', createdUsers),
    db.from('admin_audit_log').select('id', { count: 'exact', head: true }).in('target_id', createdUsers),
    db.from('profiles').select('id', { count: 'exact', head: true }).in('id', createdUsers),
  ]);
  const left = { admins: adm.count, audit: aud.count, profiles: prof.count };
  if (adm.error || aud.error || prof.error || left.admins !== 0 || left.audit !== 0 || left.profiles !== 0) {
    cleanupFailures++;
    console.log(`  leftover check FAILED: ${JSON.stringify(left)}`);
  } else {
    console.log('  leftover check: 0 admin rows, 0 audit rows, 0 profiles');
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

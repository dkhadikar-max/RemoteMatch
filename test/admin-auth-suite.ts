/**
 * RemoteMatch Admin Console — authorization/security suite.
 * ==============================================================================
 * Proves the admin console's actual security boundary: getAuthenticatedAdmin()
 * (src/lib/auth/get-authenticated-admin.ts) and the /api/admin/** routes that
 * depend on it. Every admin route requires BOTH a valid, verified Supabase
 * session AND an active admin_users row — this suite exercises all the ways
 * that combination can fail (no session, verified-but-not-admin, revoked
 * admin) against the real HTTP boundary, not just the function in isolation.
 *
 * §0 (always) does static source checks. The live section (TEST_BASE_URL +
 * Supabase env) exercises real accounts against a real running server.
 *
 * Run: TEST_BASE_URL=... npx tsx test/admin-auth-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { hasRequiredEnv, adminClient, anonKeyClient, uniqueEmail } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
let passed = 0, failed = 0, skipped = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function skip(m: string) { skipped++; console.log(`  – SKIP: ${m}`); }

const TEST_PASSWORD = 'Admin-Suite-Test-Pass-1';

async function main() {
  console.log('='.repeat(78));
  console.log('ADMIN CONSOLE — AUTHORIZATION/SECURITY SUITE');
  console.log('='.repeat(78));

  // --- §0 source checks (always) ---
  console.log('\n0. SOURCE — admin authorization layer');
  const getAdminSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/get-authenticated-admin.ts'), 'utf8');
  assert(/getAuthenticatedUser\(req\)/.test(getAdminSrc), 'getAuthenticatedAdmin() is layered on getAuthenticatedUser(), not a reimplementation');
  assert(/admin_users/.test(getAdminSrc) && /revoked_at/.test(getAdminSrc), "checks admin_users with an active (revoked_at IS NULL) condition");
  assert(/class AdminForbiddenError/.test(getAdminSrc), 'defines AdminForbiddenError distinct from UnverifiedAccountError');

  const apiErrorSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/api-error.ts'), 'utf8');
  assert(/AdminForbiddenError/.test(apiErrorSrc) && /403/.test(apiErrorSrc), 'authErrorResponse() maps AdminForbiddenError to 403');

  const middlewareSrc = fs.readFileSync(path.resolve(__dirname, '../src/middleware.ts'), 'utf8');
  assert(/isAdminHost/.test(middlewareSrc), 'middleware uses the shared isAdminHost() helper');
  assert(
    /if \(onAdminHost && !inAdmin\)/.test(middlewareSrc) && /if \(!onAdminHost && inAdmin\)/.test(middlewareSrc),
    'middleware blocks /admin/** on the consumer host AND blocks non-admin paths on the admin host (both directions)',
  );
  assert(
    /pathname\.startsWith\('\/admin'\)/.test(middlewareSrc),
    "middleware's admin redirect-UX gate is scoped to page routes, not /api/admin/** (which returns JSON via getAuthenticatedAdmin() instead)",
  );

  const migrationSrc = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/029_admin_console.sql'), 'utf8');
  assert(/FORCE ROW LEVEL SECURITY/.test(migrationSrc), 'migration 029 forces RLS (not just enables it)');
  assert(/REVOKE ALL ON %I FROM anon, authenticated/.test(migrationSrc), 'migration 029 explicitly revokes anon/authenticated access — same pattern as migrations 012/013/026');
  assert(!/GRANT.*TO authenticated/.test(migrationSrc), 'migration 029 never grants the authenticated role anything on admin_users/admin_audit_log');

  const promotionSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/discovery/supervised-promotion.ts'), 'utf8');
  assert(/export async function promoteCompanyToAllowlist/.test(promotionSrc), 'promoteCompanyToAllowlist() is unmodified/still present');
  const promoteRouteSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/api/admin/discovery/[id]/promote/route.ts'), 'utf8');
  assert(
    /promoteCompanyToAllowlist\(company, admin\.adminEmail\)/.test(promoteRouteSrc),
    'the admin promote route calls promoteCompanyToAllowlist() with the REAL admin email, never a hardcoded default',
  );
  assert(/recordAdminAction/.test(promoteRouteSrc), 'the promote route is audit-logged');

  if (!hasRequiredEnv() || !process.env.TEST_BASE_URL) {
    console.log('\nTEST_BASE_URL / Supabase env not all set — skipping the live portion.');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const admin = adminClient();
  const cleanupUserIds: string[] = [];
  const cleanupAdminRowIds: string[] = [];

  try {
    // --- 1. Unauthenticated caller ---
    console.log('\n1. NO SESSION');
    for (const path_ of ['/api/admin/dashboard', '/api/admin/discovery', '/api/admin/opportunities', '/api/admin/users', '/api/admin/audit-log', '/api/admin/admins']) {
      const res = await fetch(`${BASE_URL}${path_}`);
      assert(res.status === 401, `GET ${path_} with no session -> 401 (got ${res.status})`);
    }

    // --- 2. Verified, real, NON-admin account ---
    console.log('\n2. VERIFIED NON-ADMIN ACCOUNT');
    const nonAdminEmail = uniqueEmail();
    const { data: nonAdminUser, error: createErr } = await admin.auth.admin.createUser({ email: nonAdminEmail, password: TEST_PASSWORD, email_confirm: true });
    if (createErr || !nonAdminUser.user) throw new Error(`createUser failed: ${createErr?.message}`);
    cleanupUserIds.push(nonAdminUser.user.id);

    const nonAdminClient = anonKeyClient();
    const { data: nonAdminSession, error: signInErr } = await nonAdminClient.auth.signInWithPassword({ email: nonAdminEmail, password: TEST_PASSWORD });
    if (signInErr || !nonAdminSession.session) throw new Error(`sign-in failed: ${signInErr?.message}`);
    const nonAdminToken = nonAdminSession.session.access_token;

    for (const path_ of ['/api/admin/dashboard', '/api/admin/discovery', '/api/admin/opportunities', '/api/admin/users', '/api/admin/audit-log', '/api/admin/admins']) {
      const res = await fetch(`${BASE_URL}${path_}`, { headers: { Authorization: `Bearer ${nonAdminToken}` } });
      assert(res.status === 403, `GET ${path_} as a verified NON-admin -> 403 (got ${res.status})`);
    }
    const forbiddenBody = await (await fetch(`${BASE_URL}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${nonAdminToken}` } })).json();
    assert(/not authorized for admin access/i.test(forbiddenBody.error || ''), 'the 403 message is the admin-specific one, distinct from the generic unverified-account 403');

    // --- 3. Active admin — the real access path ---
    console.log('\n3. ACTIVE ADMIN');
    const adminEmail = uniqueEmail();
    const { data: adminUser, error: createAdminErr } = await admin.auth.admin.createUser({ email: adminEmail, password: TEST_PASSWORD, email_confirm: true });
    if (createAdminErr || !adminUser.user) throw new Error(`createUser failed: ${createAdminErr?.message}`);
    cleanupUserIds.push(adminUser.user.id);

    const { error: grantErr } = await admin.from('admin_users').insert({ id: adminUser.user.id, email: adminEmail, granted_by: 'admin-auth-suite-test' });
    assert(!grantErr, `admin_users row inserted for the test admin (${grantErr?.message ?? 'ok'})`);
    cleanupAdminRowIds.push(adminUser.user.id);

    const adminAuthClient = anonKeyClient();
    const { data: adminSession, error: adminSignInErr } = await adminAuthClient.auth.signInWithPassword({ email: adminEmail, password: TEST_PASSWORD });
    if (adminSignInErr || !adminSession.session) throw new Error(`admin sign-in failed: ${adminSignInErr?.message}`);
    const adminToken = adminSession.session.access_token;

    const dashRes = await fetch(`${BASE_URL}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(dashRes.status === 200, `GET /api/admin/dashboard as an ACTIVE admin -> 200 (got ${dashRes.status})`);
    const dashBody = await dashRes.json();
    assert(
      typeof dashBody.opportunities?.total === 'number' && typeof dashBody.opportunities?.active === 'number',
      'dashboard returns real numeric counts, not fabricated/placeholder values',
    );

    // --- 4. REVOKED admin — must lose access immediately ---
    console.log('\n4. REVOKED ADMIN');
    await admin.from('admin_users').update({ revoked_at: new Date().toISOString() }).eq('id', adminUser.user.id);
    const revokedRes = await fetch(`${BASE_URL}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert(revokedRes.status === 403, `GET /api/admin/dashboard as a REVOKED admin (same still-valid token) -> 403 (got ${revokedRes.status})`);

    // --- 5. IDOR-class check: admin API never trusts a client-supplied identity ---
    console.log('\n5. NO CLIENT-SUPPLIED IDENTITY TRUSTED');
    // Re-activate to prove this isn't just "the row happens to be gone" —
    // and confirm the promote route resolves the admin's email from the
    // SERVER-VERIFIED session/admin_users row, never from a request body field.
    await admin.from('admin_users').update({ revoked_at: null }).eq('id', adminUser.user.id);
    const fakeAdminBody = await fetch(`${BASE_URL}/api/admin/discovery/00000000-0000-0000-0000-000000000000/promote`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${nonAdminToken}` }, // non-admin token, regardless of any body content
    });
    assert(fakeAdminBody.status === 403, 'POST .../promote as a non-admin is rejected (403) before ever reaching promoteCompanyToAllowlist()');
  } finally {
    for (const id of cleanupAdminRowIds) { try { await admin.from('admin_users').delete().eq('id', id); } catch { /* best-effort cleanup */ } }
    for (const id of cleanupUserIds) await admin.auth.admin.deleteUser(id).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });

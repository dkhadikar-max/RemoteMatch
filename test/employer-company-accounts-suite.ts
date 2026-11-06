/**
 * Direct Employer Supply, Phase 1 — employer company accounts suite.
 * ==============================================================================
 * Proves the real security boundary of the new feature: getAuthenticatedEmployer()
 * (src/lib/auth/get-authenticated-employer.ts), the companies/company_members
 * RLS (migration 044), and the /api/employer/** + /api/admin/company-verifications/**
 * routes built on them.
 *
 * §0 (always) does static source checks. The live section (TEST_BASE_URL +
 * Supabase env) exercises real accounts against a real running server, and
 * cleans up every row/user it creates.
 *
 * Run: TEST_BASE_URL=... npx tsx test/employer-company-accounts-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import ws from 'ws';
import { createClient } from '@supabase/supabase-js';
import { hasRequiredEnv, adminClient, anonKeyClient, newVerifiedSession, uniqueEmail } from './helpers/verified-session';
import { normalizeDomain } from '../src/app/api/employer/register/route';
import { escapeLikeWildcards } from '../src/app/api/admin/company-verifications/route';
import { TRANSITIONS } from '../src/app/api/admin/company-verifications/[id]/route';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
let passed = 0, failed = 0, skipped = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function skip(m: string) { skipped++; console.log(`  – SKIP: ${m}`); }

function uniqueDomain(): string {
  return `remotematch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;
}

async function main() {
  console.log('='.repeat(78));
  console.log('DIRECT EMPLOYER SUPPLY, PHASE 1 — EMPLOYER COMPANY ACCOUNTS SUITE');
  console.log('='.repeat(78));

  // --- §0 source checks (always) ---
  console.log('\n0. SOURCE — employer authorization layer + schema');
  const gateSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/get-authenticated-employer.ts'), 'utf8');
  assert(/getAuthenticatedUser\(req\)/.test(gateSrc), 'getAuthenticatedEmployer() is layered on getAuthenticatedUser(), not a reimplementation');
  assert(/company_members/.test(gateSrc) && /status.*active/.test(gateSrc), "checks company_members with an active (status = 'active') condition");
  assert(/class EmployerForbiddenError/.test(gateSrc), 'defines EmployerForbiddenError distinct from AdminForbiddenError/UnverifiedAccountError');
  assert(/getSupabaseAdminClient/.test(gateSrc), 'membership check uses the service-role client, not the caller\'s own session client');

  const apiErrorSrc = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/api-error.ts'), 'utf8');
  assert(/EmployerForbiddenError/.test(apiErrorSrc) && /404/.test(apiErrorSrc), 'authErrorResponse() maps EmployerForbiddenError to 404 (Phase 1 plan Q7), not 403');

  const migrationSrc = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/044_employer_company_accounts.sql'), 'utf8');
  assert(/FORCE ROW LEVEL SECURITY/.test(migrationSrc), 'migration 044 forces RLS (not just enables it) on the new tables');
  assert(/REVOKE ALL ON %I FROM anon, authenticated/.test(migrationSrc), 'migration 044 explicitly revokes anon/authenticated access');
  assert(!/GRANT.*TO authenticated/.test(migrationSrc), 'migration 044 never grants the authenticated role anything on companies/company_members');
  assert(/uq_companies_official_domain/.test(migrationSrc) && /lower\(official_domain\)/.test(migrationSrc), 'exact-domain duplicate detection is a case-insensitive unique index (Phase 1 plan Q3)');

  // Strip SQL line-comments before this check — the migration's own header
  // comment and COMMENT ON TABLE both contain the literal prose string
  // "UNIQUE(profile_id)" while explaining that no such constraint exists,
  // which a plain text-wide regex would otherwise false-positive on (found
  // during the 2026-11-05 audit). Only real SQL statements are scanned here.
  const migrationSqlOnly = migrationSrc
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  assert(!/UNIQUE\s*\(\s*profile_id\s*\)/.test(migrationSqlOnly), 'no UNIQUE(profile_id) on company_members — one profile may belong to multiple companies (Q4)');

  const registerSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/api/employer/register/route.ts'), 'utf8');
  assert(/23505/.test(registerSrc), 'register route reports the domain-uniqueness conflict as 409 (or a recoverable 200 — see below), not a generic 500');

  // 2026-11-06 review finding #2: registration must be atomic (one Postgres
  // transaction, not two sequential inserts with a compensating delete),
  // AND a lost-response retry by the SAME caller must recover their
  // existing company rather than dead-ending behind a 409.
  const registerMigrationSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/migrations/045_employer_register_transaction.sql'),
    'utf8'
  );
  assert(/CREATE OR REPLACE FUNCTION public\.register_employer_company/.test(registerMigrationSrc), 'migration 045 defines register_employer_company() as a single Postgres function (one transaction for both inserts)');
  assert(/REVOKE ALL ON FUNCTION public\.register_employer_company FROM PUBLIC, anon, authenticated/.test(registerMigrationSrc), 'register_employer_company() is revoked from anon/authenticated — service-role only, no end-user session can call it directly');
  assert(/role,?\s*\n?\s*representative_name/.test(registerMigrationSrc) && /'owner'/.test(registerMigrationSrc), "the function inserts the registering caller's company_members row with role='owner'");
  assert(/admin\.rpc\('register_employer_company'/.test(registerSrc), 'the register route calls the atomic RPC, not two separate .from().insert() calls');
  assert(!/\.from\('companies'\)\s*\n?\s*\.delete\(\)/.test(registerSrc), 'no compensating-delete rollback logic remains in the route (the RPC makes it unnecessary — either both rows exist or neither does)');
  assert(/alreadyRegistered/.test(registerSrc) && /existingMembership/.test(registerSrc), "a unique-domain conflict checks whether the SAME caller already owns that company and recovers it instead of a bare 409 (lost-response retry recovery)");

  // 2026-11-05 review finding #2: normalizeDomain() unit tests — a real
  // import + call, not a source-text regex, since this is a pure function.
  console.log('\n0b. UNIT — normalizeDomain() rejects non-public-domain-shaped input');
  assert(normalizeDomain('acme') === null, 'a bare single-label host ("acme") is rejected');
  assert(normalizeDomain('localhost') === null, '"localhost" alone is rejected');
  assert(normalizeDomain('http://127.0.0.1/') === null, 'an IPv4 literal is rejected');
  assert(normalizeDomain('http://[::1]/') === null, 'an IPv6 literal is rejected');
  assert(normalizeDomain('test.local') === null, 'a reserved non-public TLD ("local") is rejected');
  assert(normalizeDomain('not a url') === null, 'an unparseable string is rejected');
  assert(normalizeDomain('https://www.Acme-Corp.io/careers') === 'acme-corp.io', 'a real-shaped domain is normalized: lowercased, www.-stripped, path dropped');
  assert(normalizeDomain('sub.domain.co.uk') === 'sub.domain.co.uk', 'a multi-label real domain is accepted unchanged');

  const adminDetailSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/app/api/admin/company-verifications/[id]/route.ts'),
    'utf8'
  );
  assert(/if \(!reason\)/.test(adminDetailSrc), 'admin verification-status PATCH requires a non-empty reason');

  // 2026-11-06 review finding #1 (raised twice — round 1's `audit.ok`
  // check only made a failed audit write VISIBLE, not ATOMIC with the
  // status transition): both writes now happen inside ONE Postgres
  // function call (migration 047), not two separate client-side writes.
  const transitionMigrationSrc = fs.readFileSync(
    path.resolve(__dirname, '../supabase/migrations/047_company_verification_transition_audit.sql'),
    'utf8'
  );
  assert(/CREATE OR REPLACE FUNCTION public\.transition_company_verification_with_audit/.test(transitionMigrationSrc), 'migration 047 defines transition_company_verification_with_audit() as a single Postgres function');
  assert(/REVOKE ALL ON FUNCTION public\.transition_company_verification_with_audit FROM PUBLIC, anon, authenticated/.test(transitionMigrationSrc), 'transition_company_verification_with_audit() is service-role only');
  assert(/INSERT INTO admin_audit_log/.test(transitionMigrationSrc), 'the function inserts the admin_audit_log row itself, in the same transaction as the companies UPDATE');
  assert(/IF NOT FOUND THEN/.test(transitionMigrationSrc) && /RETURN QUERY SELECT false, NULL::text/.test(transitionMigrationSrc), 'a lost compare-and-swap race returns transitioned=false and never reaches the INSERT INTO admin_audit_log below it');
  assert(/db\.rpc\('transition_company_verification_with_audit'/.test(adminDetailSrc), 'the route calls the atomic RPC, not two separate client-side writes');
  assert(!/\.from\('companies'\)\s*\n?\s*\.update\(/.test(adminDetailSrc), 'no direct .from(\'companies\').update() call remains in the route (the RPC does the write now)');
  assert(
    !/import\s*\{[^}]*recordAdminAction/.test(adminDetailSrc) && !/await recordAdminAction\(/.test(adminDetailSrc),
    'recordAdminAction() is no longer imported or called from this route (the RPC writes admin_audit_log directly, atomically) — mentioned only in comments explaining the history'
  );

  // 2026-11-05 review finding #4: a genuine DB/query error on the
  // membership lookup must not be folded into "not a member".
  assert(/must\(/.test(gateSrc) && /from\('company_members'\)/.test(gateSrc), 'the membership lookup is wrapped in must() so a real query error throws instead of being treated as "no member"');

  // 2026-11-06 review finding #6: a `null` body, a non-object body, or a
  // non-string `reason` must be rejected with a controlled 400 before
  // reaching `.trim()` — not an unhandled TypeError -> 500.
  assert(/rawBody === null \|\| typeof rawBody !== 'object'/.test(adminDetailSrc), 'rejects a null or non-object request body with a controlled 400');
  assert(/typeof body\.reason !== 'string'/.test(adminDetailSrc), 'rejects a non-string reason with a controlled 400, before .trim() is ever called on it');

  // 2026-11-06 review finding #3: Object.hasOwn(), not the `in` operator,
  // so an inherited Object.prototype property (toString, constructor,
  // __proto__) cannot pass action validation and reach TRANSITIONS[action]
  // as an unintended inherited value.
  assert(/Object\.hasOwn\(TRANSITIONS, rawAction\)/.test(adminDetailSrc), 'action validation uses Object.hasOwn(), not the `in` operator (which also matches inherited Object.prototype properties)');
  console.log('\n0d. UNIT — TRANSITIONS rejects inherited Object.prototype property names');
  for (const inherited of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert(!Object.hasOwn(TRANSITIONS, inherited), `Object.hasOwn(TRANSITIONS, '${inherited}') is false (the \`in\` operator this replaces would have returned true)`);
    // eslint-disable-next-line no-prototype-builtins
    assert((inherited in TRANSITIONS) === true, `sanity check: '${inherited}' DOES exist via \`in\` (proving the old check would have let it through) — got ${inherited in TRANSITIONS}`);
  }
  for (const real of Object.keys(TRANSITIONS)) {
    assert(Object.hasOwn(TRANSITIONS, real), `Object.hasOwn(TRANSITIONS, '${real}') is true for every real action`);
  }

  const adminListSrc = fs.readFileSync(path.resolve(__dirname, '../src/app/api/admin/company-verifications/route.ts'), 'utf8');
  // 2026-11-05 review finding #5: both source-presence AND a real unit test
  // of the escaping function (imported directly, same pattern as
  // normalizeDomain above).
  assert(/escapeLikeWildcards\(q\)/.test(adminListSrc) && /escapeLikeWildcards\(domain\)/.test(adminListSrc), 'both q and domain search params are passed through escapeLikeWildcards() before being embedded in an ilike pattern');
  console.log('\n0c. UNIT — escapeLikeWildcards() escapes SQL LIKE metacharacters');
  assert(escapeLikeWildcards('50% Co') === '50\\% Co', 'a literal % is escaped to \\%');
  assert(escapeLikeWildcards('a_b') === 'a\\_b', 'a literal _ is escaped to \\_');
  assert(escapeLikeWildcards('a\\b') === 'a\\\\b', 'a literal backslash is escaped first (so escaping % / _ never introduces a new unescaped backslash)');

  if (!hasRequiredEnv() || !process.env.TEST_BASE_URL) {
    console.log('\nTEST_BASE_URL / Supabase env not all set — skipping the live portion.');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  console.log('\n1. LIVE — registration, ownership, cross-tenant isolation, duplicate detection, admin review');
  const admin = adminClient();
  const cleanupCompanyIds: string[] = [];
  const cleanupUserIds: string[] = [];
  const cleanupAdminRowIds: string[] = [];
  let adminAuditRowCreated = false;

  try {
    const sessionA = await newVerifiedSession();
    const sessionB = await newVerifiedSession();
    cleanupUserIds.push(sessionA.userId, sessionB.userId);

    const domain = uniqueDomain();
    const registerPayload = {
      legalName: 'Acme Test Co',
      officialWebsite: `https://${domain}`,
      businessEmail: 'hr@example.com',
      countryOfRegistration: 'Testland',
      representativeName: 'A. Tester',
      representativeDesignation: 'Head of Talent',
      representativeRelationship: 'Employee',
    };

    // 1a. Registration creates a pending company owned by the registering caller.
    const registerRes = await fetch(`${BASE_URL}/api/employer/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionA.token}` },
      body: JSON.stringify(registerPayload),
    });
    const registerBody = await registerRes.json();
    assert(registerRes.status === 201, `registration succeeds (got ${registerRes.status}: ${JSON.stringify(registerBody)})`);
    assert(registerBody.verificationStatus === 'pending', 'a freshly registered company starts verification_status=pending');
    const companyId = registerBody.companyId as string;
    if (companyId) cleanupCompanyIds.push(companyId);

    // 1b. The owner can read their own company.
    const ownerGet = await fetch(`${BASE_URL}/api/employer/companies/${companyId}`, {
      headers: { Authorization: `Bearer ${sessionA.token}` },
    });
    const ownerGetBody = await ownerGet.json();
    assert(ownerGet.status === 200 && ownerGetBody.role === 'owner', `registering caller reads their own company as role=owner (got ${ownerGet.status})`);

    // 1c. A non-member gets 404, never 403 or the record itself (Q7).
    const nonMemberGet = await fetch(`${BASE_URL}/api/employer/companies/${companyId}`, {
      headers: { Authorization: `Bearer ${sessionB.token}` },
    });
    assert(nonMemberGet.status === 404, `a non-member request for someone else's company is 404 (got ${nonMemberGet.status})`);

    // 1d. Owner can edit a cosmetic field; identity fields are untouched.
    const patchRes = await fetch(`${BASE_URL}/api/employer/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionA.token}` },
      body: JSON.stringify({ headquarters: 'Testville' }),
    });
    const patchBody = await patchRes.json();
    assert(patchRes.status === 200 && patchBody.company?.headquarters === 'Testville', `owner can PATCH a cosmetic field (got ${patchRes.status})`);
    assert(patchBody.company?.official_domain === domain, 'PATCH never changes official_domain');

    // 1e. A non-member cannot edit it either.
    const nonMemberPatch = await fetch(`${BASE_URL}/api/employer/companies/${companyId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionB.token}` },
      body: JSON.stringify({ headquarters: 'Hijacked' }),
    });
    assert(nonMemberPatch.status === 404, `a non-member PATCH is also 404 (got ${nonMemberPatch.status})`);

    // 1f. Duplicate-domain registration by a different account is rejected (Q3).
    const dupRes = await fetch(`${BASE_URL}/api/employer/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionB.token}` },
      body: JSON.stringify({ ...registerPayload, legalName: 'Acme Test Co (Impersonator)' }),
    });
    assert(dupRes.status === 409, `registering the same official_domain twice is rejected 409 (got ${dupRes.status})`);

    // 1g. Same domain, different case, is still caught (case-insensitive index).
    const dupCaseRes = await fetch(`${BASE_URL}/api/employer/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionB.token}` },
      body: JSON.stringify({ ...registerPayload, officialWebsite: `https://${domain.toUpperCase()}` }),
    });
    assert(dupCaseRes.status === 409, `a different-case duplicate of the same domain is also rejected 409 (got ${dupCaseRes.status})`);

    // 1h. 2026-11-06 review finding #2, lost-response-retry recovery: the
    // SAME caller re-submitting the exact same registration (simulating a
    // retry after a lost HTTP response) gets their EXISTING company back,
    // not a bare 409.
    const retryRes = await fetch(`${BASE_URL}/api/employer/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionA.token}` },
      body: JSON.stringify(registerPayload),
    });
    const retryBody = await retryRes.json();
    assert(
      retryRes.status === 200 && retryBody.companyId === companyId && retryBody.alreadyRegistered === true,
      `the original registrant retrying the same registration recovers their existing company (got status ${retryRes.status}, companyId match ${retryBody.companyId === companyId}, alreadyRegistered ${retryBody.alreadyRegistered})`
    );

    // --- Admin review path ---
    const adminEmail = uniqueEmail();
    const { data: adminUser, error: adminCreateErr } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: `Admin-Test-${Math.random().toString(36).slice(2)}-1`,
      email_confirm: true,
    });
    assert(!adminCreateErr && Boolean(adminUser?.user), `test admin account created (${adminCreateErr?.message ?? 'ok'})`);
    cleanupUserIds.push(adminUser!.user!.id);

    const { error: grantErr } = await admin.from('admin_users').insert({ id: adminUser!.user!.id, email: adminEmail, granted_by: 'employer-company-accounts-suite-test' });
    assert(!grantErr, `admin_users row inserted for the test admin (${grantErr?.message ?? 'ok'})`);
    cleanupAdminRowIds.push(adminUser!.user!.id);

    // A session is derived via generateLink + verifyOtp rather than a stored
    // password — createUser() above was never given a password callers can
    // sign in with again, matching this suite's own ephemeral-admin shape.
    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: adminEmail,
    });
    assert(!linkErr, `could derive an admin session via generateLink (${linkErr?.message ?? 'ok'})`);

    let adminToken: string | null = null;
    if (linkData?.properties?.hashed_token) {
      const verifyClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: ws as unknown as typeof WebSocket },
      });
      const { data: verified } = await verifyClient.auth.verifyOtp({
        type: 'magiclink',
        token_hash: linkData.properties.hashed_token,
      });
      adminToken = verified?.session?.access_token ?? null;
    }

    if (!adminToken) {
      skip('could not derive a live admin session token — skipping the admin-HTTP checks (RLS/audit-log checks below still run)');
    } else {
      const listRes = await fetch(`${BASE_URL}/api/admin/company-verifications?verificationStatus=pending`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listBody = await listRes.json();
      assert(listRes.status === 200 && (listBody.companies ?? []).some((c: { id: string }) => c.id === companyId), `admin list includes the pending test company (got ${listRes.status})`);

      // 2026-11-05 review finding #3, live concurrency check: fire two
      // competing transitions at the same pending company truly
      // concurrently (Promise.all, not sequentially) and assert the
      // compare-and-swap lets exactly one win, never both.
      const [concurrentVerifyRes, concurrentRejectRes] = await Promise.all([
        fetch(`${BASE_URL}/api/admin/company-verifications/${companyId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ action: 'verify', reason: 'Suite: concurrency race — verify side' }),
        }),
        fetch(`${BASE_URL}/api/admin/company-verifications/${companyId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ action: 'reject', reason: 'Suite: concurrency race — reject side' }),
        }),
      ]);
      const concurrentStatuses = [concurrentVerifyRes.status, concurrentRejectRes.status].sort();
      assert(
        concurrentStatuses[0] === 200 && concurrentStatuses[1] === 409,
        `exactly one of two concurrent competing transitions (verify vs reject) on the same pending company wins (got statuses ${concurrentStatuses.join(',')})`
      );
      const { data: raceAuditRows } = await admin
        .from('admin_audit_log')
        .select('action')
        .eq('target_type', 'company')
        .eq('target_id', companyId)
        .in('action', ['company_verify', 'company_reject']);
      assert((raceAuditRows ?? []).length === 1, `exactly one audit-log row exists for the race, not one per request (got ${(raceAuditRows ?? []).length})`);
      adminAuditRowCreated = true;
      // Whichever side won, restore to 'pending' so the rest of this
      // section's scripted sequence (which assumes pending) still holds.
      await admin.from('companies').update({ verification_status: 'pending' }).eq('id', companyId);

      const noReasonRes = await fetch(`${BASE_URL}/api/admin/company-verifications/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ action: 'verify' }),
      });
      assert(noReasonRes.status === 400, `admin verify without a reason is rejected 400 (got ${noReasonRes.status})`);

      const verifyRes = await fetch(`${BASE_URL}/api/admin/company-verifications/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ action: 'verify', reason: 'Suite: manually verified for test' }),
      });
      const verifyBody = await verifyRes.json();
      assert(verifyRes.status === 200 && verifyBody.verificationStatus === 'verified', `admin verify transitions pending -> verified (got ${verifyRes.status})`);
      adminAuditRowCreated = true;

      const { data: auditRows } = await admin
        .from('admin_audit_log')
        .select('action, target_type, target_id, reason')
        .eq('target_type', 'company')
        .eq('target_id', companyId)
        .eq('action', 'company_verify');
      assert((auditRows ?? []).length > 0, 'the verify action is recorded in admin_audit_log with target_type=company');

      // An already-verified company cannot be re-verified from the same action.
      const reVerifyRes = await fetch(`${BASE_URL}/api/admin/company-verifications/${companyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ action: 'verify', reason: 'should not apply twice' }),
      });
      assert(reVerifyRes.status === 409, `re-verifying an already-verified company is rejected 409 (got ${reVerifyRes.status})`);
    }

    // --- RLS deny-by-default, directly against the tables ---
    console.log('\n2. LIVE — RLS deny-by-default on companies/company_members');
    const anonClient = anonKeyClient();
    const { data: anonCompanies, error: anonErr } = await anonClient.from('companies').select('id').limit(1);
    assert((anonCompanies ?? []).length === 0 || Boolean(anonErr), 'anon client cannot read companies');
    const { data: anonMembers, error: anonMemErr } = await anonClient.from('company_members').select('id').limit(1);
    assert((anonMembers ?? []).length === 0 || Boolean(anonMemErr), 'anon client cannot read company_members');

    const { data: ownSessionCompanies, error: ownSessionErr } = await sessionA.client.from('companies').select('id').eq('id', companyId).limit(1);
    assert((ownSessionCompanies ?? []).length === 0 || Boolean(ownSessionErr), "the OWNER's own session client (not service-role) still cannot read companies directly — every read goes through getAuthenticatedEmployer()'s service-role lookup, never a client-side RLS self-read");

    const { data: serviceCompanies, error: serviceErr } = await admin.from('companies').select('id').eq('id', companyId).limit(1);
    assert(!serviceErr && (serviceCompanies ?? []).length === 1, 'service-role client has full read access');
  } finally {
    console.log('\nCleanup…');
    for (const id of cleanupCompanyIds) {
      try { await admin.from('company_members').delete().eq('company_id', id); } catch { /* best-effort */ }
      if (adminAuditRowCreated) {
        try { await admin.from('admin_audit_log').delete().eq('target_type', 'company').eq('target_id', id); } catch { /* best-effort */ }
      }
      try { await admin.from('companies').delete().eq('id', id); } catch { /* best-effort */ }
    }
    for (const id of cleanupAdminRowIds) {
      try { await admin.from('admin_users').delete().eq('id', id); } catch { /* best-effort */ }
    }
    for (const id of cleanupUserIds) {
      try { await admin.auth.admin.deleteUser(id); } catch { /* best-effort */ }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});

/**
 * Direct Employer Supply, Phase 1 (migrations 044, 045, 047) — isolated-project
 * concurrency/atomicity suite. Extends test/employer-company-accounts-suite.ts
 * with the two angles that suite's sequential/single-actor design cannot cover:
 *
 *   1. TRUE concurrent same-domain registration by two DIFFERENT real callers
 *      (Promise.all, not sequential requests) — proves the unique index +
 *      single-transaction RPC actually serialize under real concurrency, not
 *      just "a second sequential attempt sees 409".
 *   2. Registration ATOMICITY under a genuine second-insert failure — calls
 *      register_employer_company() directly with a NOT-NULL violation on
 *      company_members, so the companies insert has already "happened"
 *      inside the transaction before the failure, and checks the whole
 *      transaction rolled back (no orphan companies row).
 *   3. Two DIFFERENT admin identities racing a transition on the same
 *      company (not one admin firing two requests) — a distinct race
 *      surface from the single-admin race already covered elsewhere.
 *
 * Requires: TEST_BASE_URL (a running server, started against this same
 * isolated project) + NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY
 * / SUPABASE_SERVICE_ROLE_KEY all pointed at an EXPLICITLY ISOLATED Supabase
 * test project. Never run against production — this suite creates and
 * deletes real auth users, companies, and company_members rows.
 *
 * Run: TEST_BASE_URL=... TEST_ADMIN_HOST=... npx tsx test/employer-company-accounts-concurrency-isolated-suite.ts
 */
import * as http from 'http';
import { hasRequiredEnv, adminClient, newVerifiedSession, uniqueEmail } from './helpers/verified-session';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const ADMIN_HOST = process.env.TEST_ADMIN_HOST || new URL(BASE_URL).host;

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }

function uniqueDomain(): string {
  return `remotematch-concurrency-test-${Date.now()}-${Math.random().toString(36).slice(2)}.example.com`;
}

function httpJson(
  reqPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}
): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${BASE_URL}${reqPath}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}), ...(init.host ? { Host: init.host } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: unknown = null;
          try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function registerPayload(domain: string) {
  return JSON.stringify({
    legalName: 'Concurrency Test Co',
    officialWebsite: `https://${domain}`,
    officialDomain: domain,
    businessEmail: `hr@${domain}`,
    countryOfRegistration: 'US',
    registrationNumber: 'TEST-12345',
    linkedinUrl: 'https://linkedin.com/company/concurrency-test',
    industry: 'Information Technology & Software',
    companySize: '11-50',
    description: 'Isolated-project concurrency/atomicity test fixture.',
    headquarters: 'Remote',
    representativeName: 'Test Rep',
    representativeDesignation: 'HR Manager',
    representativeRelationship: 'employee',
  });
}

async function main() {
  console.log('='.repeat(78));
  console.log('DIRECT EMPLOYER SUPPLY — CONCURRENCY / ATOMICITY SUITE (isolated project only)');
  console.log('='.repeat(78));

  if (!hasRequiredEnv() || !process.env.TEST_BASE_URL) {
    console.error('TEST_BASE_URL / Supabase env not all set — this suite requires a live isolated project and refuses to silently no-op.');
    process.exitCode = 1;
    return;
  }

  const admin = adminClient();
  const cleanupUserIds: string[] = [];
  const cleanupCompanyIds: string[] = [];
  const cleanupAdminRowIds: string[] = [];

  try {
    // --- 1. TRUE concurrent same-domain registration (two different callers) ---
    console.log('\n1. Two different callers register the SAME domain truly concurrently');
    const domain = uniqueDomain();
    const sessionA = await newVerifiedSession();
    const sessionB = await newVerifiedSession();
    cleanupUserIds.push(sessionA.userId, sessionB.userId);

    const [resA, resB] = await Promise.all([
      httpJson('/api/employer/register', { method: 'POST', headers: { Authorization: `Bearer ${sessionA.token}` }, body: registerPayload(domain) }),
      httpJson('/api/employer/register', { method: 'POST', headers: { Authorization: `Bearer ${sessionB.token}` }, body: registerPayload(domain) }),
    ]);
    const statuses = [resA.status, resB.status].sort();
    assert(statuses[0] === 201 && statuses[1] === 409, `exactly one concurrent registration for the same domain succeeds (got ${statuses.join(',')})`);

    const winner = resA.status === 201 ? resA : resB;
    const winnerBody = winner.body as { companyId: string };
    if (winnerBody?.companyId) cleanupCompanyIds.push(winnerBody.companyId);

    const { data: domainRows } = await admin.from('companies').select('id').eq('official_domain', domain);
    assert((domainRows ?? []).length === 1, `exactly one companies row exists for the contested domain afterward (got ${(domainRows ?? []).length})`);

    const { data: memberRows } = await admin.from('company_members').select('id').eq('company_id', winnerBody.companyId);
    assert((memberRows ?? []).length === 1, 'the winning company has exactly one owner member row (no duplicate/partial writes from the losing side)');

    // --- 2. Registration ATOMICITY under a genuine second-insert failure ---
    console.log('\n2. register_employer_company() rolls back fully when the SECOND insert fails');
    const sessionC = await newVerifiedSession();
    cleanupUserIds.push(sessionC.userId);
    const atomicityDomain = uniqueDomain();

    // representative_name is NOT NULL on company_members with no default —
    // passing null here lets the companies insert succeed first, then fails
    // on the company_members insert, inside the same function call.
    const { error: rpcErr } = await admin.rpc('register_employer_company', {
      p_legal_name: 'Atomicity Test Co',
      p_official_website: `https://${atomicityDomain}`,
      p_official_domain: atomicityDomain,
      p_business_email: `hr@${atomicityDomain}`,
      p_country_of_registration: 'US',
      p_registration_number: 'TEST-ATOMIC',
      p_linkedin_url: 'https://linkedin.com/company/atomicity-test',
      p_industry: 'Technology',
      p_company_size: '11-50',
      p_description: 'Atomicity test fixture.',
      p_headquarters: 'Remote',
      p_created_by: sessionC.userId,
      p_representative_name: null, // forces the second INSERT to fail (NOT NULL)
      p_representative_designation: 'HR Manager',
      p_representative_relationship: 'employee',
    });
    assert(Boolean(rpcErr), `direct RPC call with a NOT-NULL violation on the second insert fails as expected (${rpcErr?.message ?? 'no error -- BUG'})`);

    const { data: orphanRows } = await admin.from('companies').select('id').eq('official_domain', atomicityDomain);
    assert((orphanRows ?? []).length === 0, `no orphan companies row survives the rolled-back transaction (found ${(orphanRows ?? []).length})`);

    // --- 3. Two DIFFERENT admin identities racing a transition on one company ---
    console.log('\n3. Two different admin accounts race a transition on the same company (not one admin, two requests)');
    const raceDomain = uniqueDomain();
    const sessionD = await newVerifiedSession();
    cleanupUserIds.push(sessionD.userId);
    const regRes = await httpJson('/api/employer/register', { method: 'POST', headers: { Authorization: `Bearer ${sessionD.token}` }, body: registerPayload(raceDomain) });
    assert(regRes.status === 201, `fixture company registered for the multi-admin race (got ${regRes.status})`);
    const raceCompanyId = (regRes.body as { companyId: string }).companyId;
    cleanupCompanyIds.push(raceCompanyId);

    const makeAdmin = async (): Promise<{ userId: string; token: string }> => {
      const email = uniqueEmail();
      const { data: u, error: ce } = await admin.auth.admin.createUser({ email, password: `Admin-${Math.random().toString(36).slice(2)}-1`, email_confirm: true });
      if (ce || !u?.user) throw new Error(`createUser failed: ${ce?.message}`);
      cleanupUserIds.push(u.user.id);
      const { error: grantErr } = await admin.from('admin_users').insert({ id: u.user.id, email, granted_by: 'employer-concurrency-isolated-suite-test' });
      if (grantErr) throw new Error(`admin_users insert failed: ${grantErr.message}`);
      cleanupAdminRowIds.push(u.user.id);
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
      if (linkErr || !linkData?.properties?.hashed_token) throw new Error(`generateLink failed: ${linkErr?.message}`);
      const verifyClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: ws as unknown as typeof WebSocket },
      });
      const { data: verified } = await verifyClient.auth.verifyOtp({ type: 'magiclink', token_hash: linkData.properties.hashed_token });
      const token = verified?.session?.access_token;
      if (!token) throw new Error('could not derive admin session token');
      return { userId: u.user.id, token };
    };

    const [adminX, adminY] = await Promise.all([makeAdmin(), makeAdmin()]);

    const [verifyRes, rejectRes] = await Promise.all([
      httpJson(`/api/admin/company-verifications/${raceCompanyId}`, {
        method: 'PATCH', host: ADMIN_HOST,
        headers: { Authorization: `Bearer ${adminX.token}` },
        body: JSON.stringify({ action: 'verify', reason: 'Multi-admin race — admin X' }),
      }),
      httpJson(`/api/admin/company-verifications/${raceCompanyId}`, {
        method: 'PATCH', host: ADMIN_HOST,
        headers: { Authorization: `Bearer ${adminY.token}` },
        body: JSON.stringify({ action: 'reject', reason: 'Multi-admin race — admin Y' }),
      }),
    ]);
    const raceStatuses = [verifyRes.status, rejectRes.status].sort();
    assert(raceStatuses[0] === 200 && raceStatuses[1] === 409, `exactly one of two DIFFERENT admins racing a transition wins (got ${raceStatuses.join(',')})`);

    const { data: raceAudit } = await admin
      .from('admin_audit_log')
      .select('action, admin_id')
      .eq('target_type', 'company')
      .eq('target_id', raceCompanyId);
    assert((raceAudit ?? []).length === 1, `exactly one audit-log row for the multi-admin race, attributed to one real admin actor (got ${(raceAudit ?? []).length})`);
  } finally {
    console.log('\nCleanup…');
    for (const id of cleanupCompanyIds) {
      try { await admin.from('company_members').delete().eq('company_id', id); } catch { /* best-effort */ }
      try { await admin.from('admin_audit_log').delete().eq('target_type', 'company').eq('target_id', id); } catch { /* best-effort */ }
      try { await admin.from('companies').delete().eq('id', id); } catch { /* best-effort */ }
    }
    for (const id of cleanupAdminRowIds) {
      try { await admin.from('admin_users').delete().eq('id', id); } catch { /* best-effort */ }
    }
    for (const id of cleanupUserIds) {
      try { await admin.auth.admin.deleteUser(id); } catch { /* best-effort */ }
    }
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Suite crashed:', err);
  process.exitCode = 1;
});

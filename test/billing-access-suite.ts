/**
 * RemoteMatch — admin-controlled Pro purchase access (migration 033) suite
 * ==============================================================================
 * Proves:
 *   - STATIC: every billing-access route authorizes with getAuthenticatedAdmin()
 *     before touching data; the subscription route checks the deployment
 *     allowlist, then the admin grant, before the mock branch and before any
 *     Razorpay call; migration 033 has no SECURITY DEFINER and no dynamic SQL.
 *   - UNIT: hasActivePurchaseGrant() fails closed (error / throw / no row).
 *   - PREFLIGHT: billing_access_security_report() matches the expected RLS,
 *     grants, policy definitions and function privileges EXACTLY; any
 *     difference, or no report at all, refuses every later check (exit 1).
 *   - DENIAL: anon and signed-in clients can neither read nor write the three
 *     tables nor call the three functions.
 *   - ADMIN API: 401 signed out, 403 for a non-admin, 404 on the consumer host;
 *     grant/revoke by email, idempotent, audit-logged; revoked admin refused.
 *   - ATOMICITY: a failure after the audit insert rolls the audit row back
 *     (non-existent target account; note that breaks the table CHECK).
 *   - FUNCTION AUTHORIZATION: the grant function itself refuses a caller id
 *     that is not an active admin, before writing anything.
 *   - CONCURRENCY: N parallel grants (then revokes) → exactly one change and
 *     exactly one audit row.
 *   - COMBINATION (subscription route): purchase needs deployment allowlist
 *     AND an active grant, for the allowlist mode the server was started in.
 *
 * Servers: ONE local dev server started with the same env files as this
 * runner plus ADMIN_HOST_OVERRIDE=<admin host:port>. TEST_BASE_URL is the
 * consumer host (default http://127.0.0.1:3400), TEST_ADMIN_BASE_URL the admin
 * host (default http://localhost:3400). Both must be http: and local.
 *
 * Safety — every infra check refuses (and the run FAILS, exit 1) unless the
 * URLs are local, ISOLATED_TEST_PROJECT_HOST equals the database host
 * exactly, and Razorpay config is complete rzp_test_ or entirely absent.
 *
 * Run once per mode (as test/razorpay-allowlist-suite.ts):
 *   open | closed | list (ALLOWED_ID) | mock (list, no RAZORPAY_* keys)
 *
 * Cleanup (always; every item attempted; ANY failure exits 1): cancels every
 * Razorpay test subscription created, deletes every audit row written by the
 * suite's admin, and deletes every user created (their access rows and admin
 * row cascade). Then verifies none of it remains.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, anonKeyClient, hasRequiredEnv, newVerifiedSession, uniqueEmail } from './helpers/verified-session';
import { hasActivePurchaseGrant } from '../src/lib/billing/purchase-access';
import { parsePurchaseAllowlist } from '../src/lib/razorpay';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3400';
const ADMIN_BASE_URL = process.env.TEST_ADMIN_BASE_URL || 'http://localhost:3400';
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const PLAN_ID = process.env.RAZORPAY_PRO_PLAN_ID ?? '';
const ISOLATED_HOST = process.env.ISOLATED_TEST_PROJECT_HOST ?? '';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const MOCK = !KEY_ID && !KEY_SECRET && !PLAN_ID && !WEBHOOK_SECRET;
/** Same fixed id as the allowlist suite, so the same allowlist env file applies. */
const ALLOWED_ID = '0a11ed00-0000-4000-8000-000000000001';
/** Never a real account: used only to prove a failed grant leaves no audit row. */
const NONEXISTENT_ID = 'b111ed00-0000-4000-8000-00000000dead';
const TABLES = ['admin_audit_log', 'admin_users', 'billing_purchase_access'];
const FUNCTIONS = ['admin_grant_purchase_access', 'admin_revoke_purchase_access', 'billing_access_security_report'];
const SERVICE_ROLE_EXPR = "(auth.role() = 'service_role'::text)";

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
/**
 * Structural equality for values read back from jsonb. jsonb does not keep
 * object key order, so string comparison could reject a correct database.
 * Still strict: every key and value must match, no key may be missing or
 * extra, and arrays (policies, roles — ordered in the report) compare in order.
 */
const same = (actual: unknown, expected: unknown) => isDeepStrictEqual(actual, expected);
/** Exact expected function settings (pg_proc.proconfig). */
const EXPECTED_CONFIG: Record<string, string[]> = {
  admin_grant_purchase_access: ['search_path=public, pg_temp'],
  admin_revoke_purchase_access: ['search_path=public, pg_temp'],
  billing_access_security_report: ['search_path=pg_catalog, pg_temp'],
};
function refuse(reason: string) {
  console.log(`\nRefusing to run infra checks: ${reason}`);
  failed++;
}

let safetyPassed = false;
const createdUsers: string[] = [];
const createdSubscriptions: string[] = [];
let testAdminId: string | null = null;
const trackSub = (id: unknown) => {
  if (typeof id === 'string' && id.startsWith('sub_') && !createdSubscriptions.includes(id)) createdSubscriptions.push(id);
};
const rzpAuth = () => `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

async function newUser() {
  const s = await newVerifiedSession();
  createdUsers.push(s.userId);
  return s;
}
async function userWithId(id: string) {
  const email = uniqueEmail();
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await adminClient().auth.admin.createUser({ id, email, password, email_confirm: true });
  if (error) throw new Error(`create user ${id}: ${error.message}`);
  createdUsers.push(id);
  const client = anonKeyClient();
  const { data, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2 || !data.session) throw new Error(`sign in ${id}: ${e2?.message}`);
  return { userId: id, email, token: data.session.access_token, client };
}
async function call(base: string, method: string, path: string, token?: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. middleware 404) */ }
  return { status: r.status, body: json };
}
const adminApi = (method: string, path: string, token?: string, body?: unknown) => call(ADMIN_BASE_URL, method, path, token, body);
async function auditRows(targetId: string, action?: string) {
  let q = adminClient().from('admin_audit_log').select('id, action, admin_id, before_state, after_state, reason').eq('target_id', targetId);
  if (action) q = q.eq('action', action);
  const { data, error } = await q;
  if (error) throw new Error(`audit read: ${error.message}`);
  return data ?? [];
}
async function accessRow(userId: string) {
  const { data, error } = await adminClient().from('billing_purchase_access').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(`access read: ${error.message}`);
  return data as any;
}
async function rzpSubsFor(userId: string, sinceSec: number) {
  const r = await fetch(`https://api.razorpay.com/v1/subscriptions?from=${sinceSec}&count=100`, { headers: { Authorization: rzpAuth() } });
  const j: any = await r.json();
  const ids = (j.items ?? []).filter((s: any) => s.notes?.userId === userId).map((s: any) => s.id as string);
  ids.forEach(trackSub);
  return { status: r.status, ids };
}

/** Exported handler bodies of a route file, keyed by method. */
function handlers(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\b/g;
  const starts: { m: string; i: number }[] = [];
  for (let m; (m = re.exec(src)); ) starts.push({ m: m[1], i: m.index });
  starts.forEach((s, k) => (out[s.m] = src.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : undefined)));
  return out;
}
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** Minimal stand-in for the query chain hasActivePurchaseGrant() uses. */
function fakeDb(result: () => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  const chain: any = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: result };
  return { from: () => chain } as unknown as SupabaseClient;
}

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — ADMIN-CONTROLLED PURCHASE ACCESS SUITE');
  console.log('='.repeat(78));

  // ---------------------------------------------------------------- STATIC
  console.log('\nSTATIC');
  const root = process.cwd();
  const listSrc = readFileSync(join(root, 'src/app/api/admin/billing-access/route.ts'), 'utf8');
  const itemSrc = readFileSync(join(root, 'src/app/api/admin/billing-access/[id]/route.ts'), 'utf8');
  for (const [file, src, methods] of [['billing-access/route.ts', listSrc, ['GET', 'POST']], ['billing-access/[id]/route.ts', itemSrc, ['DELETE']]] as const) {
    const h = handlers(src);
    assert(Object.keys(h).sort().join() === [...methods].sort().join(), `${file}: exports exactly ${methods.join(', ')}`, Object.keys(h));
    for (const m of methods) {
      const body = h[m] ?? '';
      const auth = body.indexOf('getAuthenticatedAdmin(req)');
      const firstData = Math.min(...['getSupabaseAdminClient(', 'changePurchaseAccess(', 'req.json(', 'req.text('].map((t) => (body.indexOf(t) < 0 ? Infinity : body.indexOf(t))));
      assert(auth >= 0 && auth < firstData, `${file} ${m}: getAuthenticatedAdmin() runs before any body read or data access`);
    }
  }
  assert(/const \{ id \} = await params;/.test(itemSrc) && !/params\.id/.test(itemSrc),
    'billing-access/[id]/route.ts: awaits params (works whether Next passes an object or a Promise) and never reads params.id directly');
  const subSrc = readFileSync(join(root, 'src/app/api/razorpay/subscription/route.ts'), 'utf8');
  const at = (s: string) => subSrc.indexOf(s);
  assert(
    at('isPurchaseAllowed(purchaseAllowlist') > 0 &&
      at('isPurchaseAllowed(purchaseAllowlist') < at('hasActivePurchaseGrant(admin, user.id)') &&
      at('hasActivePurchaseGrant(admin, user.id)') < at('if (!isRazorpayConfigured)') &&
      at('if (!isRazorpayConfigured)') < at('createSubscription('),
    'subscription route: deployment allowlist → admin grant → mock branch → Razorpay, in that order'
  );
  const mig = readFileSync(join(root, 'supabase/migrations/033_billing_purchase_access.sql'), 'utf8');
  const sql = mig.replace(/--.*$/gm, '');
  assert(!/SECURITY\s+DEFINER/i.test(sql), 'migration 033: no SECURITY DEFINER function');
  assert(!/\bEXECUTE\s+(format|'|\$|\w+\s*\()/i.test(sql.replace(/GRANT\s+EXECUTE/gi, '')), 'migration 033: no dynamic SQL (no EXECUTE statement)');
  for (const f of FUNCTIONS) {
    assert(new RegExp(`REVOKE ALL ON FUNCTION ${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`).test(sql), `migration 033: EXECUTE on ${f} revoked from PUBLIC, anon, authenticated`);
  }
  const clientImporters = walk(join(root, 'src')).filter((p) => {
    const s = readFileSync(p, 'utf8');
    return /^['"]use client['"]/m.test(s) && /billing\/purchase-access/.test(s);
  });
  assert(clientImporters.length === 0, 'no client component imports the purchase-access module', clientImporters);

  // ---------------------------------------------------------------- UNIT
  console.log('\nUNIT: hasActivePurchaseGrant fails closed');
  const quiet = console.error;
  console.error = () => {};
  const rErr = await hasActivePurchaseGrant(fakeDb(async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } })), ALLOWED_ID);
  const rThrow = await hasActivePurchaseGrant(fakeDb(async () => { throw new Error('network down'); }), ALLOWED_ID);
  console.error = quiet;
  assert(rErr === false, 'missing table / query error → no access');
  assert(rThrow === false, 'thrown exception → no access');
  assert((await hasActivePurchaseGrant(fakeDb(async () => ({ data: null, error: null })), ALLOWED_ID)) === false, 'no active row → no access');
  assert((await hasActivePurchaseGrant(fakeDb(async () => ({ data: { user_id: ALLOWED_ID }, error: null })), ALLOWED_ID)) === true, 'active row → access');

  console.log('\nUNIT: the preflight comparison');
  assert(same({ select: false, insert: false }, { insert: false, select: false }), 'key order does not matter (jsonb reorders keys)');
  assert(!same({ select: false }, { select: false, insert: false }), 'a missing key fails');
  assert(!same({ select: false, insert: false, extra: false }, { select: false, insert: false }), 'an extra key fails');
  assert(!same({ select: true }, { select: false }), 'a different value fails');
  assert(!same({ select: 'false' }, { select: false }), 'a different type fails');
  assert(!same(['anon', 'public'], ['public', 'anon']), 'array order still matters');
  assert(!same(undefined, { select: false }), 'a missing section fails');

  // ---------------------------------------------------------------- SAFETY
  for (const [name, raw] of [['TEST_BASE_URL', BASE_URL], ['TEST_ADMIN_BASE_URL', ADMIN_BASE_URL]] as const) {
    let u: URL;
    try { u = new URL(raw); } catch { return refuse(`${name} is not a valid URL.`); }
    if (u.protocol !== 'http:') return refuse(`${name} must use http: (got "${u.protocol}").`);
    if (!LOCAL_HOSTNAMES.has(u.hostname)) return refuse(`${name} must be a local server (got host "${u.hostname}").`);
  }
  if (new URL(BASE_URL).host === new URL(ADMIN_BASE_URL).host) return refuse('TEST_BASE_URL and TEST_ADMIN_BASE_URL must be different hosts.');
  if (!hasRequiredEnv()) return refuse('Supabase env incomplete.');
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  if (!ISOLATED_HOST || host !== ISOLATED_HOST) return refuse('ISOLATED_TEST_PROJECT_HOST must equal the database host.');
  if (!MOCK && (!KEY_ID.startsWith('rzp_test_') || !KEY_SECRET || !WEBHOOK_SECRET || !PLAN_ID)) {
    return refuse('Razorpay env must be complete with a rzp_test_ key (or entirely absent for mock mode).');
  }
  safetyPassed = true;
  const db = adminClient();
  const mode = parsePurchaseAllowlist(process.env.RAZORPAY_ALLOWLIST_USER_IDS).mode;

  // ---------------------------------------------------------------- PREFLIGHT
  console.log(`\nPREFLIGHT: billing_access_security_report (DB ${host})`);
  const { data: report, error: reportErr } = await db.rpc('billing_access_security_report');
  if (reportErr || !report) return refuse(`security report unavailable: ${reportErr?.code ?? ''} ${reportErr?.message ?? 'empty'}`);
  const noPriv = { select: false, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false };
  const tables: any[] = (report as any).tables ?? [];
  let preflightOk = true;
  const check = (ok: boolean, msg: string, detail?: unknown) => {
    assert(ok, msg, detail);
    if (!ok) preflightOk = false;
  };
  check(tables.map((t) => t.table).join() === TABLES.join(), 'report covers exactly the three tables', tables.map((t) => t.table));
  for (const t of tables) {
    check(t.rls_enabled === true && t.rls_forced === true, `${t.table}: RLS enabled and forced`);
    check(same(t.privileges?.anon, noPriv), `${t.table}: anon holds no table privilege`, t.privileges?.anon);
    check(same(t.privileges?.authenticated, noPriv), `${t.table}: authenticated holds no table privilege`, t.privileges?.authenticated);
    const noColPriv = { select: false, insert: false, update: false, references: false };
    check(same(t.column_privileges?.anon, noColPriv), `${t.table}: anon holds no column privilege`, t.column_privileges?.anon);
    check(same(t.column_privileges?.authenticated, noColPriv), `${t.table}: authenticated holds no column privilege`, t.column_privileges?.authenticated);
    const expected = [{
      name: `${t.table}_service_role_all`, command: '*', permissive: true, roles: ['public'],
      using: SERVICE_ROLE_EXPR, with_check: SERVICE_ROLE_EXPR,
    }];
    check(same(t.policies, expected), `${t.table}: exactly one policy, service_role-only, with the expected definition`, t.policies);
  }
  const fns: any[] = (report as any).functions ?? [];
  check(fns.map((f) => f.function).join() === FUNCTIONS.join(), 'report covers exactly the three functions', fns.map((f) => f.function));
  for (const f of fns) {
    check(f.security_definer === false, `${f.function}: SECURITY INVOKER`);
    check(
      same(f.execute, { public: false, anon: false, authenticated: false, service_role: true }),
      `${f.function}: EXECUTE for service_role only`, f.execute
    );
    check(same(f.config, EXPECTED_CONFIG[f.function]), `${f.function}: settings are exactly ${JSON.stringify(EXPECTED_CONFIG[f.function])}`, f.config);
    check(f.owner === 'postgres', `${f.function}: owned by postgres`, f.owner);
  }
  check(fns.find((f) => f.function === 'billing_access_security_report')?.volatility === 's', 'billing_access_security_report is STABLE (read-only)');
  if (!preflightOk) return refuse('the live security configuration differs from the expected one — fix it before testing anything else.');

  // ---------------------------------------------------------------- DENIAL
  console.log('\nDENIAL: anon and signed-in clients cannot touch the tables or functions');
  const outsider = await newUser();
  const clients: [string, SupabaseClient][] = [['anon', anonKeyClient()], ['signed-in user', outsider.client]];
  const before = (await db.from('billing_purchase_access').select('user_id', { count: 'exact', head: true })).count;
  for (const [who, c] of clients) {
    for (const t of TABLES) {
      const r = await c.from(t).select('*').limit(1);
      assert(!!r.error && (r.data ?? []).length === 0, `${who}: SELECT on ${t} refused`, r.error?.code);
    }
    const ins = await c.from('billing_purchase_access').insert({ user_id: outsider.userId, granted_by_admin_id: outsider.userId, granted_by_email: 'self' });
    assert(!!ins.error, `${who}: cannot INSERT a purchase grant (own or anyone's)`, ins.error?.code);
    const upd = await c.from('billing_purchase_access').update({ revoked_at: null }).eq('user_id', outsider.userId);
    assert(!!upd.error, `${who}: cannot UPDATE purchase grants`, upd.error?.code);
    const del = await c.from('admin_audit_log').delete().eq('target_id', outsider.userId);
    assert(!!del.error, `${who}: cannot DELETE audit rows`, del.error?.code);
    const adm = await c.from('admin_users').insert({ id: outsider.userId, email: 'self@example.com' });
    assert(!!adm.error, `${who}: cannot make itself an admin`, adm.error?.code);
    const g = await c.rpc('admin_grant_purchase_access', { p_target_user_id: outsider.userId, p_admin_id: outsider.userId, p_admin_email: 'self', p_note: null });
    assert(!!g.error, `${who}: cannot call admin_grant_purchase_access`, g.error?.code);
    const rv = await c.rpc('admin_revoke_purchase_access', { p_target_user_id: outsider.userId, p_admin_id: outsider.userId, p_admin_email: 'self', p_note: null });
    assert(!!rv.error, `${who}: cannot call admin_revoke_purchase_access`, rv.error?.code);
    const rep = await c.rpc('billing_access_security_report');
    assert(!!rep.error, `${who}: cannot call billing_access_security_report`, rep.error?.code);
  }
  const after = (await db.from('billing_purchase_access').select('user_id', { count: 'exact', head: true })).count;
  assert(before === after && (await accessRow(outsider.userId)) === null, 'no denied attempt changed anything', { before, after });

  // ---------------------------------------------------------------- ADMIN API
  console.log('\nADMIN API: authorization');
  for (const [m, p, b] of [['GET', '/api/admin/billing-access', undefined], ['POST', '/api/admin/billing-access', { email: outsider.email }], ['DELETE', `/api/admin/billing-access/${outsider.userId}`, undefined]] as const) {
    const anon = await adminApi(m, p, undefined, b);
    assert(anon.status === 401, `${m} ${p.replace(outsider.userId, ':id')} signed out → 401`, anon.status);
    const user = await adminApi(m, p, outsider.token, b);
    assert(user.status === 403, `${m} ${p.replace(outsider.userId, ':id')} as a verified non-admin → 403`, user.status);
    const consumer = await call(BASE_URL, m, p, outsider.token, b);
    assert(consumer.status === 404, `${m} ${p.replace(outsider.userId, ':id')} on the consumer host → 404`, consumer.status);
  }
  assert((await accessRow(outsider.userId)) === null, 'the refused calls granted nothing');

  // The suite's own admin (removed in cleanup; its admin_users row cascades).
  const adminUser = await newUser();
  testAdminId = adminUser.userId;
  const { error: mkAdminErr } = await db.from('admin_users').insert({ id: adminUser.userId, email: adminUser.email, granted_by: 'billing-access-suite' });
  if (mkAdminErr) throw new Error(`could not create the suite's test admin: ${mkAdminErr.message}`);

  console.log('\nADMIN API: grant / revoke');
  const target = await newUser();
  const g1 = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: target.email, note: 'suite grant' });
  assert(g1.status === 200 && g1.body.changed === true && g1.body.userId === target.userId, 'grant by email → 200, changed, resolved to the right account', g1);
  const row1 = await accessRow(target.userId);
  assert(row1?.revoked_at === null && row1?.granted_by_admin_id === adminUser.userId && row1?.granted_by_email === adminUser.email, 'access row active, attributed to the acting admin', row1);
  let audits = await auditRows(target.userId);
  assert(audits.length === 1 && audits[0].action === 'purchase_access_grant' && audits[0].admin_id === adminUser.userId && audits[0].reason === 'suite grant',
    'exactly one purchase_access_grant audit row, with the admin and note', audits);
  const g2 = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: target.email.toUpperCase() });
  assert(g2.status === 200 && g2.body.changed === false, 'repeat grant (email in other case) → 200, changed=false', g2);
  assert((await auditRows(target.userId)).length === 1, 'repeat grant writes no audit row');
  const list = await adminApi('GET', '/api/admin/billing-access', adminUser.token);
  const listed = (list.body.access ?? []).find((r: any) => r.user_id === target.userId);
  assert(list.status === 200 && listed?.active === true && listed?.email === target.email && list.body.deploymentAllowlist?.mode === mode,
    'GET lists the grant with its email, and the deployment allowlist mode', { status: list.status, listed, dm: list.body.deploymentAllowlist });
  assert(JSON.stringify(Object.keys(list.body.deploymentAllowlist ?? {})) === '["mode"]',
    'GET reports only the deployment allowlist mode, never its ids', list.body.deploymentAllowlist);

  const wild = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: 'remotematch-test-%@example.com' });
  assert(wild.status === 404, 'an email containing a LIKE wildcard matches only itself → 404', wild);
  const unknown = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: `nobody-${Date.now()}@example.com` });
  assert(unknown.status === 404, 'unknown email → 404', unknown.status);
  const noEmail = await adminApi('POST', '/api/admin/billing-access', adminUser.token, {});
  assert(noEmail.status === 400, 'missing email → 400', noEmail.status);
  const longNote = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: target.email, note: 'x'.repeat(501) });
  assert(longNote.status === 400, 'note over 500 characters → 400', longNote.status);
  const badId = await adminApi('DELETE', '/api/admin/billing-access/not-a-uuid', adminUser.token);
  assert(badId.status === 400, 'revoke with a malformed id → 400', badId.status);

  const r1 = await adminApi('DELETE', `/api/admin/billing-access/${target.userId}`, adminUser.token);
  assert(r1.status === 200 && r1.body.changed === true, 'valid revoke reaches the revoke function (route params read correctly) → 200, changed', r1);
  const row2 = await accessRow(target.userId);
  assert(row2?.revoked_at !== null && row2?.revoked_by_admin_id === adminUser.userId, 'access row soft-revoked (kept), attributed', row2);
  const r2 = await adminApi('DELETE', `/api/admin/billing-access/${target.userId}`, adminUser.token);
  assert(r2.status === 200 && r2.body.changed === false, 'repeat revoke → 200, changed=false', r2);
  audits = await auditRows(target.userId);
  assert(audits.length === 2 && audits.filter((a) => a.action === 'purchase_access_revoke').length === 1, 'exactly one revoke audit row added; none for the repeat', audits.map((a) => a.action));
  const regrant = await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: target.email });
  const row3 = await accessRow(target.userId);
  assert(regrant.body.changed === true && row3?.revoked_at === null && row3?.revoked_by_admin_id === null, 're-grant after revoke reactivates the row');
  assert((await auditRows(target.userId, 'purchase_access_grant')).length === 2, 're-grant writes its own audit row');

  // ---------------------------------------------------------------- ATOMICITY
  console.log('\nATOMICITY: a failure after the audit insert rolls the audit row back');
  const fk = await db.rpc('admin_grant_purchase_access', { p_target_user_id: NONEXISTENT_ID, p_admin_id: adminUser.userId, p_admin_email: adminUser.email, p_note: null });
  assert(fk.error?.code === '23503', 'grant to an account that does not exist fails (foreign key)', fk.error?.code);
  assert((await auditRows(NONEXISTENT_ID)).length === 0 && (await accessRow(NONEXISTENT_ID)) === null, '…and leaves neither an audit row nor an access row');
  const t2 = await newUser();
  const chk = await db.rpc('admin_grant_purchase_access', { p_target_user_id: t2.userId, p_admin_id: adminUser.userId, p_admin_email: adminUser.email, p_note: 'y'.repeat(501) });
  assert(chk.error?.code === '23514', 'grant whose note breaks the table CHECK fails', chk.error?.code);
  assert((await auditRows(t2.userId)).length === 0 && (await accessRow(t2.userId)) === null, '…and leaves neither an audit row nor an access row');

  // Not a rollback case: the active-admin check runs BEFORE the audit insert,
  // so this proves the function's own authorization, not atomicity.
  console.log('\nFUNCTION AUTHORIZATION: the database function re-checks the acting admin');
  const noAdmin = await db.rpc('admin_grant_purchase_access', { p_target_user_id: t2.userId, p_admin_id: outsider.userId, p_admin_email: outsider.email, p_note: null });
  assert(noAdmin.error?.code === '42501', 'the function itself refuses a caller id that is not an active admin', noAdmin.error?.code);
  assert((await auditRows(t2.userId)).length === 0 && (await accessRow(t2.userId)) === null, '…and changes nothing');

  // ---------------------------------------------------------------- CONCURRENCY
  console.log('\nCONCURRENCY: parallel grants, then parallel revokes, for one user');
  const t3 = await newUser();
  const N = 8;
  const grants = await Promise.all(Array.from({ length: N }, () => adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: t3.email })));
  assert(grants.every((r) => r.status === 200), `${N} parallel grants all → 200`, grants.map((r) => r.status));
  assert(grants.filter((r) => r.body.changed === true).length === 1, 'exactly one of them reports changed=true', grants.map((r) => r.body.changed));
  assert((await auditRows(t3.userId, 'purchase_access_grant')).length === 1, 'exactly one grant audit row');
  const revokes = await Promise.all(Array.from({ length: N }, () => adminApi('DELETE', `/api/admin/billing-access/${t3.userId}`, adminUser.token)));
  assert(revokes.every((r) => r.status === 200) && revokes.filter((r) => r.body.changed === true).length === 1,
    `${N} parallel revokes → all 200, exactly one changed`, revokes.map((r) => [r.status, r.body.changed]));
  assert((await auditRows(t3.userId, 'purchase_access_revoke')).length === 1, 'exactly one revoke audit row');

  // ---------------------------------------------------------------- REVOKED ADMIN
  console.log('\nREVOKED ADMIN');
  const ex = await newUser();
  await db.from('admin_users').insert({ id: ex.userId, email: ex.email, granted_by: 'billing-access-suite', revoked_at: new Date().toISOString() });
  const exCall = await adminApi('POST', '/api/admin/billing-access', ex.token, { email: t2.email });
  assert(exCall.status === 403 && (await accessRow(t2.userId)) === null, 'a revoked admin is refused (403) and grants nothing', exCall.status);

  // ---------------------------------------------------------------- COMBINATION
  console.log(`\nCOMBINATION (server allowlist mode '${mode}'${MOCK ? ', mock — no Razorpay keys' : ''})`);
  if (MOCK && mode !== 'list') return refuse("mock mode must be run with a 'list' allowlist.");
  const since = Math.floor(Date.now() / 1000) - 5;
  const A = await userWithId(ALLOWED_ID); // in the 'list' allowlist
  const B = await newUser(); // never in any allowlist
  const sub = (token: string) => call(BASE_URL, 'POST', '/api/razorpay/subscription', token);
  const unavailable = (r: { status: number; body: any }) => r.status === 503 && /aren't available/i.test(r.body.error ?? '') && r.body.isMock !== true && !r.body.subscriptionId;
  const started = (r: { status: number; body: any }) => r.status === 200 && (MOCK ? r.body.isMock === true : typeof r.body.subscriptionId === 'string');
  const nothingFor = async (userId: string, label: string) => {
    const p = (await db.from('profiles').select('razorpay_subscription_id, razorpay_subscription_status, plan_tier').eq('id', userId).single()).data as any;
    const subs = MOCK ? { status: 200, ids: [] } : await rzpSubsFor(userId, since);
    assert(p?.razorpay_subscription_id === null && p?.razorpay_subscription_status === null && p?.plan_tier === 'free' && subs.status === 200 && subs.ids.length === 0,
      `${label}: nothing created (no Razorpay subscription, profile untouched)`, { p, subs });
  };

  const a0 = await sub(A.token);
  trackSub(a0.body.subscriptionId);
  assert(unavailable(a0), 'no grant → 503 generic, in every mode (default closed)', a0);
  await nothingFor(A.userId, 'no grant');

  await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: A.email });
  const a1 = await sub(A.token);
  trackSub(a1.body.subscriptionId);
  if (mode === 'closed') {
    assert(unavailable(a1), 'closed deployment allowlist + grant → 503 (the kill switch wins)', a1);
    await nothingFor(A.userId, 'closed + grant');
  } else {
    assert(started(a1), `${mode} deployment allowlist (user permitted) + grant → purchase starts`, a1);
  }

  await adminApi('POST', '/api/admin/billing-access', adminUser.token, { email: B.email });
  const b1 = await sub(B.token);
  trackSub(b1.body.subscriptionId);
  if (mode === 'open') {
    assert(started(b1), 'unset deployment allowlist + grant → purchase starts', b1);
  } else {
    assert(unavailable(b1), `${mode} deployment allowlist that does not list the user + grant → 503`, b1);
    await nothingFor(B.userId, `${mode} (unlisted) + grant`);
  }

  await adminApi('DELETE', `/api/admin/billing-access/${A.userId}`, adminUser.token);
  const subsBefore = MOCK ? 0 : (await rzpSubsFor(A.userId, since)).ids.length;
  const a2 = await sub(A.token);
  trackSub(a2.body.subscriptionId);
  const subsAfter = MOCK ? 0 : (await rzpSubsFor(A.userId, since)).ids.length;
  assert(unavailable(a2) && subsAfter === subsBefore, 'after revoke → 503 again, and no new subscription is created', { a2, subsBefore, subsAfter });
}

let cleanupFailures = 0;

async function cleanup() {
  console.log('\nCLEANUP (best effort — every step attempted; any failure fails the run)');
  if (createdSubscriptions.length && !(safetyPassed && KEY_ID.startsWith('rzp_test_'))) {
    cleanupFailures += createdSubscriptions.length;
    console.log(`  ${createdSubscriptions.length} subscription(s) NOT cancelled — test-mode config not verified`);
  } else {
    for (const id of createdSubscriptions) {
      try {
        const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${id}/cancel`, {
          method: 'POST',
          headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancel_at_cycle_end: false }),
        });
        const j: any = await r.json().catch(() => null);
        if (r.ok && j?.id === id && j?.status === 'cancelled') console.log(`  subscription ${id}: cancelled`);
        else {
          cleanupFailures++;
          console.log(`  subscription ${id}: NOT cancelled — HTTP ${r.status} ${j?.error?.description ?? `status=${j?.status ?? '?'}`}`);
        }
      } catch (err) {
        cleanupFailures++;
        console.log(`  subscription ${id}: NOT cancelled — ${(err as Error).message}`);
      }
    }
  }
  if (!safetyPassed) {
    console.log('  safety checks did not pass — no database cleanup attempted (nothing was created)');
    return;
  }
  let db: SupabaseClient;
  try {
    db = adminClient();
  } catch (err) {
    cleanupFailures += createdUsers.length + 1;
    console.log(`  admin client unavailable — nothing deleted: ${(err as Error).message}`);
    return;
  }
  // Audit rows first (admin_audit_log has no foreign keys, so they would
  // otherwise outlive the users). Every row this suite writes is by its admin.
  if (testAdminId) {
    try {
      const { error } = await db.from('admin_audit_log').delete().eq('admin_id', testAdminId);
      if (error) throw new Error(error.message);
    } catch (err) {
      cleanupFailures++;
      console.log(`  audit rows: NOT deleted — ${(err as Error).message}`);
    }
  }
  let deleted = 0;
  for (const id of createdUsers) {
    try {
      const { error } = await db.auth.admin.deleteUser(id);
      if (error) throw new Error(error.message);
      deleted++;
    } catch (err) {
      cleanupFailures++;
      console.log(`  user ${id}: NOT deleted — ${(err as Error).message}`);
    }
  }
  console.log(`  deleted ${deleted}/${createdUsers.length} test users; ${createdSubscriptions.length} test subscriptions attempted`);
  // Verify, independently, that nothing the suite wrote remains.
  try {
    const ids = [...createdUsers, NONEXISTENT_ID];
    const [acc, adm, aud] = await Promise.all([
      db.from('billing_purchase_access').select('user_id', { count: 'exact', head: true }).in('user_id', ids),
      db.from('admin_users').select('id', { count: 'exact', head: true }).in('id', ids),
      db.from('admin_audit_log').select('id', { count: 'exact', head: true }).in('target_id', ids),
    ]);
    const left = { access: acc.count, admins: adm.count, audit: aud.count };
    if (acc.error || adm.error || aud.error || left.access !== 0 || left.admins !== 0 || left.audit !== 0) {
      cleanupFailures++;
      console.log(`  leftover check FAILED: ${JSON.stringify(left)} ${acc.error?.message ?? adm.error?.message ?? aud.error?.message ?? ''}`);
    } else {
      console.log('  leftover check: 0 access rows, 0 admin rows, 0 audit rows');
    }
  } catch (err) {
    cleanupFailures++;
    console.log(`  leftover check could not run — ${(err as Error).message}`);
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

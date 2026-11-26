/**
 * Admin console ACCURACY suite.
 * ==============================================================================
 * Guards the defects the admin console shipped with (found by the Phase A
 * audit, 2026-09-19):
 *   1. Query errors swallowed into zeros / HTTP 200 (a missing C6 table
 *      showed as "0 candidates").
 *   2. PostgREST's silent 1,000-row cap turning breakdowns into samples
 *      (jobsBySource / jobsByRemoteScope summed to exactly 1000 of ~6,200).
 *   3. sync-health hard-coding C1/C3 as "manual / not on a Railway cron".
 *   4. "Awaiting review" counting the wrong pipeline stage.
 *   5. A database error reported as "not found" (404).
 *
 * Sections:
 *   1. helper unit tests (pure — includes a simulated server row cap)
 *   2. static source rules over every admin route/page (keep it from regressing)
 *   3. real-infra: route handlers invoked DIRECTLY with a real bearer token
 *      for a disposable admin (no dev server is started, so nothing here can
 *      emit a funnel event). Self-skips without Supabase env.
 *
 * Run: npx tsx --env-file=.env.local test/admin-accuracy-suite.ts
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';

import { must, mustCount, fetchAllRows, isMissingRelation, QueryError } from '../src/lib/supabase/query-helpers';
import { runSections } from '../src/lib/admin/sections';
import { authErrorResponse } from '../src/lib/auth/api-error';
import { AdminForbiddenError } from '../src/lib/auth/get-authenticated-admin';
import { UnauthenticatedError, UnverifiedAccountError } from '../src/lib/auth/get-authenticated-user';
import { hasRequiredEnv, newVerifiedSession, adminClient, TestSession } from './helpers/verified-session';

/** The admin-forbidden 403's message (src/lib/auth/api-error.ts) — distinct from the unverified-account 403. */
const ADMIN_FORBIDDEN_MESSAGE = /not authorized for admin access/i;

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };
const ROOT = path.join(__dirname, '..');

function walk(dir: string, match: (f: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, match, out);
    else if (match(full)) out.push(full);
  }
  return out;
}

/** Code only — a comment that DESCRIBES an old bug must not trip a rule that
 *  forbids the bug in code. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

async function throwsQueryError(fn: () => unknown | Promise<unknown>): Promise<QueryError | null> {
  try { await fn(); } catch (e) { return e instanceof QueryError ? e : null; }
  return null;
}

async function run() {
  console.log('='.repeat(78));
  console.log('ADMIN CONSOLE ACCURACY');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. HELPER UNIT TESTS');
  // ==========================================================================
  {
    const ok = { data: [1], error: null };
    assert(must(ok, 'x') === ok, 'must() returns a successful result untouched');
    const e = await throwsQueryError(() => must({ data: null, error: { message: 'boom', code: 'X1' } }, 'tbl'));
    assert(e !== null && e.code === 'X1' && e.message.includes('tbl') && e.message.includes('boom'), 'must() throws a QueryError carrying label, message and code');

    assert(mustCount({ count: 7, error: null }, 'c') === 7, 'mustCount() returns the number');
    assert((await throwsQueryError(() => mustCount({ count: null, error: null }, 'c'))) !== null, 'mustCount() treats a null count as a FAILURE, never as zero');
    assert((await throwsQueryError(() => mustCount({ count: null, error: { message: 'no table' } }, 'c'))) !== null, 'mustCount() throws on a query error');

    assert(isMissingRelation({ message: 'Could not find the table \'public.x\' in the schema cache', code: 'PGRST205' }), 'isMissingRelation: PGRST205');
    assert(isMissingRelation({ message: 'relation "x" does not exist' }), 'isMissingRelation: "does not exist" message');
    assert(!isMissingRelation({ message: 'permission denied for table x', code: '42501' }), 'isMissingRelation: a permission error is NOT a missing table');
    assert(!isMissingRelation(null), 'isMissingRelation: null is false');

    // A fake PostgREST that silently caps every response at `serverCap` rows.
    const makeServer = (total: number, serverCap: number) => {
      const all = Array.from({ length: total }, (_, i) => ({ id: String(i + 1).padStart(6, '0'), n: i }));
      let calls = 0;
      const fetchPage = async (afterId: string | null, pageSize: number) => {
        calls++;
        const rows = all.filter((r) => (afterId === null ? true : r.id > afterId)).slice(0, Math.min(pageSize, serverCap));
        return { data: rows, error: null };
      };
      return { fetchPage, calls: () => calls, all };
    };

    const s1 = makeServer(2500, 1000);
    const rows1 = await fetchAllRows<{ id: string }>(s1.fetchPage, { label: 't' });
    assert(rows1.length === 2500 && new Set(rows1.map((r) => r.id)).size === 2500, `fetchAllRows reads all 2,500 rows across a 1,000-row server cap, no duplicates (${rows1.length})`);

    const s2 = makeServer(2500, 500);
    const rows2 = await fetchAllRows<{ id: string }>(s2.fetchPage, { label: 't', pageSize: 1000 });
    assert(rows2.length === 2500, `fetchAllRows is still complete when the server cap (500) is LOWER than the page size — it ends on an empty page, not a short one (${rows2.length})`);

    const s3 = makeServer(0, 1000);
    assert((await fetchAllRows<{ id: string }>(s3.fetchPage, { label: 't' })).length === 0, 'fetchAllRows on an empty table returns []');

    let n = 0;
    const flaky = async (afterId: string | null) => {
      n++;
      if (n === 2) return { data: null, error: { message: 'connection reset', code: 'XX000' } };
      return { data: Array.from({ length: 3 }, (_, i) => ({ id: `${afterId ?? 'a'}${i}` })), error: null };
    };
    assert((await throwsQueryError(() => fetchAllRows<{ id: string }>(flaky, { label: 'flaky', pageSize: 3 }))) !== null, 'fetchAllRows THROWS if any page fails — it never returns a partial result as if complete');

    const runaway = async (afterId: string | null) => ({ data: [{ id: `${afterId ?? ''}x` }], error: null });
    assert((await throwsQueryError(() => fetchAllRows<{ id: string }>(runaway, { label: 'r', pageSize: 1, maxRows: 5 }))) !== null, 'fetchAllRows refuses to run past its safety limit');

    const sec = await runSections({
      good: async () => 42,
      bad: async () => { throw new QueryError('supply_discovered_companies', 'Could not find the table in the schema cache', 'PGRST205'); },
      alsoGood: async () => 'ok',
    });
    assert(sec.values.good === 42 && sec.values.alsoGood === 'ok' && sec.values.bad === undefined, 'runSections: a failing section does not affect its siblings, and has NO value');
    assert(sec.failed.length === 1 && sec.failed[0].section === 'bad' && sec.failed[0].message.includes('schema cache'), 'runSections: the failure is reported with the real message');

    // The two 403s must be told apart by message, because the revoke-route authorization test below relies on it.
    const forbiddenRes = authErrorResponse(new AdminForbiddenError());
    const unverifiedRes = authErrorResponse(new UnverifiedAccountError());
    const unauthRes = authErrorResponse(new UnauthenticatedError());
    const forbiddenMsg = (await forbiddenRes!.json()).error as string;
    const unverifiedMsg = (await unverifiedRes!.json()).error as string;
    assert(forbiddenRes!.status === 403 && unverifiedRes!.status === 403, 'authErrorResponse: admin-forbidden and unverified-account are BOTH 403 (status alone cannot tell them apart)');
    assert(ADMIN_FORBIDDEN_MESSAGE.test(forbiddenMsg) && !ADMIN_FORBIDDEN_MESSAGE.test(unverifiedMsg), 'authErrorResponse: the admin-forbidden message matches the revoke test\'s pattern and the unverified-account message does NOT');
    assert(unauthRes!.status === 401, 'authErrorResponse: an unauthenticated caller is 401');
  }

  // ==========================================================================
  console.log('\n2. STATIC RULES over every admin route and page');
  // ==========================================================================
  {
    const routeFiles = walk(path.join(ROOT, 'src/app/api/admin'), (f) => f.endsWith('route.ts'));
    // The reviewed inventory of admin API routes, by path (not just a count): the loop below applies the error-handling
    // rules to every discovered route, so a route that escapes discovery — or a new one added without review — must
    // fail here. 15 original routes (admin console, #3) + the 2 billing-access routes (purchase access, PR #23).
    // Adding or removing an admin route means editing this list on purpose.
    const EXPECTED_ADMIN_ROUTES = [
      'admins/[id]', 'admins', 'audit-log', 'billing-access/[id]', 'billing-access', 'dashboard',
      'discovery/[id]/promote', 'discovery/[id]/reject', 'discovery', 'employers',
      'opportunities/[id]', 'opportunities', 'sources', 'sync-health', 'translation', 'users/[id]', 'users',
    ].sort();
    const foundRoutes = routeFiles
      .map((f) => path.relative(path.join(ROOT, 'src/app/api/admin'), f).replace(/\\/g, '/').replace(/\/route\.ts$/, ''))
      .sort();
    const missingRoutes = EXPECTED_ADMIN_ROUTES.filter((r) => !foundRoutes.includes(r));
    const unexpectedRoutes = foundRoutes.filter((r) => !EXPECTED_ADMIN_ROUTES.includes(r));
    assert(
      missingRoutes.length === 0 && unexpectedRoutes.length === 0 && foundRoutes.length === 17,
      `the admin route inventory is exactly the 17 reviewed routes (found ${foundRoutes.length})`,
      `missing: [${missingRoutes.join(', ')}] unexpected: [${unexpectedRoutes.join(', ')}]`,
    );

    const HANDLES_ERRORS = /\bmust\(|\bmustCount\(|\bfetchAllRows\(|\brunSections\(|if \(error\)|if \(upsertErr\)|if \(updateErr\)|if \(sourceErr\)/;
    for (const f of routeFiles) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      if (!src.includes(".from('")) continue;
      assert(HANDLES_ERRORS.test(src), `${rel}: every route that queries the database handles query errors`);
      assert(!/\.single\(\)/.test(src), `${rel}: no .single() (it turns any database error into a "not found")`);
    }

    const dashboard = stripComments(fs.readFileSync(path.join(ROOT, 'src/app/api/admin/dashboard/route.ts'), 'utf8'));
    assert(!/discoveryByStageRaw|opportunitiesBySourceRaw|opportunitiesByRemoteTypeRaw/.test(dashboard), 'dashboard: the old un-ranged, error-ignoring breakdown queries are gone');
    assert(/fetchAllRows/.test(dashboard) && /mustCount/.test(dashboard), 'dashboard: uses the paginated + error-checking helpers');
    assert(/awaitingReview: byStage\['qualified_remote'\]/.test(dashboard), 'dashboard: "awaiting review" is the qualified_remote stage (what the Discovery page lets an admin act on)');
    assert(/partialFailureResponse/.test(dashboard), 'dashboard: failures produce an explicit partial-failure response, not zeros');

    const sync = stripComments(fs.readFileSync(path.join(ROOT, 'src/app/api/admin/sync-health/route.ts'), 'utf8'));
    assert(!/cadence:\s*'manual'/.test(sync), "sync-health: no pipeline hard-codes cadence: 'manual'");
    assert(!/not on a configured Railway cron/.test(sync), 'sync-health: the false "not on a configured Railway cron" claim is gone');
    assert(/migration 026/.test(sync) && /'unavailable'/.test(sync), 'sync-health: C6 reports unavailable and names migration 026 when the table is absent');
    // The cadence constant moved with the status rules into src/lib/admin/sync-status.ts (admin cleanup PR); the
    // route must still use it, and the rule file must still expect 6 hours.
    const syncRules = fs.readFileSync(path.join(ROOT, 'src/lib/admin/sync-status.ts'), 'utf8');
    assert(/EXPECTED_INTERVAL_HOURS\s*=\s*6/.test(syncRules) && /EXPECTED_INTERVAL_HOURS/.test(sync), 'sync-health: expects the 6-hour cadence');

    // Revoke ordering: a nonexistent target is a 404 BEFORE the last-admin lockout guard (409) can fire. Pinned
    // statically so a revert is caught on any database, including one that happens to hold several admins.
    const revokeRoute = stripComments(fs.readFileSync(path.join(ROOT, 'src/app/api/admin/admins/[id]/route.ts'), 'utf8'));
    const iNotFound = revokeRoute.indexOf('if (!before)');
    const iLastAdmin = revokeRoute.indexOf('activeCount <= 1');
    assert(iNotFound > 0 && iLastAdmin > 0 && iNotFound < iLastAdmin, 'admins/[id]: the target-exists check (404) runs before the last-admin guard (409)');
    assert(/getAuthenticatedAdmin\(req\)/.test(revokeRoute) && /Cannot revoke the last remaining active admin/.test(revokeRoute) && /admin_revoke/.test(revokeRoute), 'admins/[id]: still authenticates the caller, keeps the last-admin guard and audit-logs the revoke');

    const syncPage = fs.readFileSync(path.join(ROOT, 'src/app/admin/(dashboard)/sync-health/page.tsx'), 'utf8');
    assert(!/not a bug, it reflects that no pipeline/.test(syncPage) && !/Manual \/ not scheduled/.test(syncPage), 'sync-health page: the false "manual" explanation is gone');

    const pageFiles = walk(path.join(ROOT, 'src/app/admin/(dashboard)'), (f) => f.endsWith('page.tsx'));
    for (const f of pageFiles) {
      const src = fs.readFileSync(f, 'utf8');
      const rel = path.relative(ROOT, f).replace(/\\/g, '/');
      assert(!/throw new Error\(`Request failed \(\$\{res\.status\}\)`\)/.test(src), `${rel}: does not hide the failure reason behind a bare "Request failed (500)"`);
    }
  }

  // ==========================================================================
  console.log('\n3. REAL-INFRA — route handlers vs live data (self-skips without env)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();
    let session: TestSession | null = null;
    let extraSession: TestSession | null = null; // second disposable admin for the revoke success path
    let nonAdminSession: TestSession | null = null; // verified account WITHOUT an admin row, for the revoke 403 check
    try {
      session = await newVerifiedSession();
      await admin.from('admin_users').insert({ id: session.userId, email: session.email, granted_by: 'admin-accuracy-suite' });

      const call = async (handlerImport: Promise<any>, method: string, url: string, opts: { token?: string | null; params?: any; body?: unknown } = {}) => {
        const mod = await handlerImport;
        const token = opts.token === undefined ? session!.token : opts.token;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token) headers.authorization = `Bearer ${token}`;
        const req = new NextRequest(`http://localhost${url}`, { method, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
        const res = await mod[method](req, { params: opts.params ?? {} });
        let json: any = null;
        try { json = await res.json(); } catch { /* none */ }
        return { status: res.status as number, json };
      };
      const dash = () => import('../src/app/api/admin/dashboard/route');
      const sync = () => import('../src/app/api/admin/sync-health/route');
      const trans = () => import('../src/app/api/admin/translation/route');
      const usersList = () => import('../src/app/api/admin/users/route');
      const userOne = () => import('../src/app/api/admin/users/[id]/route');
      const oppOne = () => import('../src/app/api/admin/opportunities/[id]/route');
      const adminOne = () => import('../src/app/api/admin/admins/[id]/route');
      const promote = () => import('../src/app/api/admin/discovery/[id]/promote/route');
      const reject = () => import('../src/app/api/admin/discovery/[id]/reject/route');

      const NIL = '00000000-0000-0000-0000-000000000000';
      const TOL = 60; // the 6-hourly ingestion job may write mid-test

      // Ground truth, read independently of the routes under test.
      const activeHead = (await admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('status', 'active')).count ?? 0;
      const probe = await admin.from('supply_discovered_companies').select('id').limit(1);
      const c6TablePresent = !probe.error;
      console.log(`  (ground truth: ${activeHead} active opportunities; C6 staging table ${c6TablePresent ? 'PRESENT' : 'ABSENT'})`);

      // ---- auth still enforced ----
      for (const [name, imp, url] of [['dashboard', dash, '/api/admin/dashboard'], ['sync-health', sync, '/api/admin/sync-health'], ['translation', trans, '/api/admin/translation'], ['users', usersList, '/api/admin/users']] as const) {
        const r = await call(imp(), 'GET', url, { token: 'not-a-real-token' });
        assert(r.status === 401, `${name}: an invalid token is still rejected with 401 (got ${r.status})`);
      }

      // ---- dashboard ----
      {
        const r = await call(dash(), 'GET', '/api/admin/dashboard');
        const body = r.status === 200 ? r.json : r.json?.partial;
        assert(!!body?.opportunities && typeof body.opportunities.active === 'number', `dashboard: reports an active count (status ${r.status})`);
        const active = body.opportunities.active as number;
        const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
        assert(sum(body.jobsBySource) === active, `dashboard: jobsBySource sums to the active headline (${sum(body.jobsBySource)} = ${active})`);
        assert(sum(body.jobsByRemoteScope) === active, `dashboard: jobsByRemoteScope sums to the active headline (${sum(body.jobsByRemoteScope)} = ${active})`);
        assert(body.opportunities.fresh48h <= active, 'dashboard: fresh48h never exceeds active');
        assert(Math.abs(active - activeHead) <= TOL, `dashboard: the headline matches an independent count of the table (${active} vs ${activeHead})`);
        if (activeHead > 1000) assert(active > 1000, `dashboard: NOT truncated at the 1,000-row cap (${active} rows > 1000)`);
        if (c6TablePresent) {
          assert(r.status === 200 && !!body.discovery, 'dashboard: with the C6 table present, discovery is reported and the response is 200');
        } else {
          assert(r.status === 500, `dashboard: with the C6 table ABSENT the response is an explicit 500, not a 200 with zeros (got ${r.status})`);
          assert(Array.isArray(r.json?.failedSections) && r.json.failedSections.some((f: any) => f.section === 'discovery' && /schema cache|does not exist/i.test(f.message)), 'dashboard: failedSections names discovery with the real database message');
          assert(body.discovery === undefined, 'dashboard: the failed discovery section has NO value (never a fabricated 0)');
        }
      }

      // ---- sync-health ----
      {
        const r = await call(sync(), 'GET', '/api/admin/sync-health');
        const body = r.status === 200 ? r.json : r.json?.partial;
        const pipes: any[] = body?.pipelines ?? [];
        const byId = Object.fromEntries(pipes.map((p) => [p.id, p]));
        assert(pipes.length === 3 && !!byId.c1_c3 && !!byId.c5 && !!byId.c6, `sync-health: reports C1/C3, C5 and C6 (${pipes.map((p) => p.id).join(',')})`);
        assert(byId.c1_c3.cadence !== 'manual' && !/not on a configured Railway cron/.test(byId.c1_c3.note), 'sync-health: C1/C3 is NOT reported as manual / unscheduled');
        assert(byId.c1_c3.expectedIntervalHours === 6, 'sync-health: C1/C3 expects the 6-hour cadence');
        assert(['healthy', 'degraded', 'stale', 'no_evidence', 'recent_activity', 'not_scheduled'].includes(byId.c1_c3.status), `sync-health: C1/C3 has a derived status (${byId.c1_c3.status})`);
        assert(byId.c1_c3.status !== 'healthy' || (byId.c1_c3.enabled === true && String(byId.c1_c3.cadence).includes('6h')), `sync-health: a healthy C1/C3 reads as running on the observed 6h cadence ("${byId.c1_c3.cadence}")`);
        assert(byId.c5.cadence === 'not scheduled' && ['not_scheduled', 'recent_activity'].includes(byId.c5.status) && byId.c5.enabled === false, `sync-health: C5 is reported as unscheduled (${byId.c5.status})`);
        if (c6TablePresent) {
          assert(byId.c6.status === 'not_scheduled', 'sync-health: C6 with its table present is reported as not scheduled');
        } else {
          assert(byId.c6.status === 'unavailable' && byId.c6.recordsDiscovered === null && /migration 026/.test(byId.c6.note), 'sync-health: C6 is UNAVAILABLE (records null, migration 026 named) — not "0 records"');
          assert(r.status === 200, `sync-health: a missing C6 table is a REPORTED state, not a request failure (got ${r.status})`);
        }
      }

      // ---- translation: exact and complete ----
      {
        const r = await call(trans(), 'GET', '/api/admin/translation');
        assert(r.status === 200, `translation: 200 (got ${r.status})`);
        const total = Object.values(r.json.byStatus as Record<string, number>).reduce((a, b) => a + b, 0);
        assert(total === r.json.activeTotal, `translation: the status breakdown sums to activeTotal (${total} = ${r.json.activeTotal})`);
        assert(Math.abs(r.json.activeTotal - activeHead) <= TOL, `translation: covers the whole active catalog, not a 1,000-row sample (${r.json.activeTotal} vs ${activeHead})`);
      }

      // ---- users list ----
      {
        const r = await call(usersList(), 'GET', '/api/admin/users');
        assert(r.status === 200 && Array.isArray(r.json.users) && r.json.users.every((u: any) => typeof u.swipeCount === 'number' && typeof u.applicationCount === 'number'), 'users: the directory returns complete numeric activity counts');
      }

      // ---- database errors are no longer reported as "not found" ----
      {
        let r = await call(userOne(), 'GET', '/api/admin/users/not-a-uuid', { params: { id: 'not-a-uuid' } });
        assert(r.status === 500 && !!r.json?.detail, `users/[id]: a malformed id is a database ERROR (500 with detail), no longer masked as "User not found" (got ${r.status})`);
        r = await call(userOne(), 'GET', `/api/admin/users/${NIL}`, { params: { id: NIL } });
        assert(r.status === 404, `users/[id]: a well-formed id that matches nothing is still a genuine 404 (got ${r.status})`);

        r = await call(oppOne(), 'GET', '/api/admin/opportunities/not-a-uuid', { params: { id: 'not-a-uuid' } });
        assert(r.status === 500 && !!r.json?.detail, `opportunities/[id]: a database error is a 500 with detail, not "Opportunity not found" (got ${r.status})`);
        r = await call(oppOne(), 'GET', `/api/admin/opportunities/${NIL}`, { params: { id: NIL } });
        assert(r.status === 404, `opportunities/[id]: a genuinely missing opportunity is a 404 (got ${r.status})`);

        r = await call(adminOne(), 'DELETE', `/api/admin/admins/${NIL}`, { params: { id: NIL } });
        assert(r.status === 404, `admins/[id]: revoking a nonexistent admin is a 404 and mutates nothing (got ${r.status})`);
        r = await call(adminOne(), 'DELETE', '/api/admin/admins/not-a-uuid', { params: { id: 'not-a-uuid' } });
        assert(r.status === 500 && !!r.json?.detail, `admins/[id]: a database error is a 500 with detail, not "Admin not found" (got ${r.status})`);

        // ---- revoke: 404 (missing) → 409 (last admin) → success. Uses ONLY this suite's own disposable admins and
        //      never mutates anyone else's row; the 409 case runs only when the suite's admin really is the sole
        //      active one (it is on a fresh/isolated database) and says so when it cannot.
        {
          const adminRows = async () => (await admin.from('admin_users').select('id', { count: 'exact', head: true })).count ?? 0;
          const revokeAudits = async (targetId: string) => (await admin.from('admin_audit_log').select('id', { count: 'exact', head: true }).eq('action', 'admin_revoke').eq('target_id', targetId)).count ?? 0;
          const othersActive = async () => (await admin.from('admin_users').select('id', { count: 'exact', head: true }).is('revoked_at', null).neq('id', session!.userId)).count ?? 0;

          // (0) authentication + authorization still guard the route. The target is the suite's OWN admin, so if either
          //     guard ever failed the call would act on a real row — and the checks below prove it did not.
          const selfId = session!.userId;
          // An INVALID bearer token is exercised here. A request with NO Authorization header is deliberately not: it takes
          // the cookie-session path, and next/headers cookies() throws outside a real request scope (these handlers are
          // called in-process), which would be a harness artifact, not the route's behaviour. "No session → 401" for the
          // shared getAuthenticatedAdmin() is proven over real HTTP by test/admin-auth-suite.ts on the six GET admin
          // routes; this DELETE handler is not itself in that HTTP loop.
          r = await call(adminOne(), 'DELETE', `/api/admin/admins/${selfId}`, { token: 'not-a-real-token', params: { id: selfId } });
          assert(r.status === 401, `admins/[id]: DELETE with an invalid token → 401 (got ${r.status})`);
          nonAdminSession = await newVerifiedSession();
          r = await call(adminOne(), 'DELETE', `/api/admin/admins/${selfId}`, { token: nonAdminSession.token, params: { id: selfId } });
          // Status AND message: an unverified-account 403 has the same status ("a verified account is required"), so a
          // status-only check could pass for the wrong reason. This pins the admin-forbidden rejection specifically.
          assert(r.status === 403 && ADMIN_FORBIDDEN_MESSAGE.test(r.json?.error ?? ''), `admins/[id]: DELETE as a verified NON-admin → 403 with the admin-forbidden message (got ${r.status} "${r.json?.error ?? ''}")`);
          const { data: untouched } = await admin.from('admin_users').select('revoked_at').eq('id', selfId).maybeSingle();
          assert(untouched?.revoked_at === null && (await revokeAudits(selfId)) === 0, 'admins/[id]: the rejected (401/403) attempts mutated nothing and wrote no audit record');

          // (1) nonexistent target → 404, whatever the admin count; nothing mutated, nothing audited
          const rowsBefore = await adminRows();
          r = await call(adminOne(), 'DELETE', `/api/admin/admins/${NIL}`, { params: { id: NIL } });
          assert(r.status === 404 && /not found/i.test(r.json?.error ?? ''), `admins/[id]: nonexistent target → 404 "not found", never the last-admin 409 (got ${r.status})`);
          assert((await adminRows()) === rowsBefore && (await revokeAudits(NIL)) === 0, 'admins/[id]: the 404 mutated no admin row and wrote no audit record');

          // (2) existing target that is the last active admin → 409, and it stays active
          const others = await othersActive();
          if (others === 0) {
            r = await call(adminOne(), 'DELETE', `/api/admin/admins/${session!.userId}`, { params: { id: session!.userId } });
            assert(r.status === 409 && /last remaining active admin/i.test(r.json?.error ?? ''), `admins/[id]: existing target that is the last active admin → 409 (got ${r.status})`);
            const { data: still } = await admin.from('admin_users').select('revoked_at').eq('id', session!.userId).maybeSingle();
            assert(still?.revoked_at === null && (await revokeAudits(session!.userId)) === 0, 'admins/[id]: the refused revoke left the admin active and wrote no audit record');
          } else {
            skip(`admins/[id]: last-admin 409 not exercised — this database has ${others} other active admin(s) and the suite will not touch their rows`);
          }

          // (3) existing, revocable target (needs a second active admin → the suite creates its own) → success
          extraSession = await newVerifiedSession();
          await admin.from('admin_users').insert({ id: extraSession.userId, email: extraSession.email, granted_by: 'admin-accuracy-suite' });
          r = await call(adminOne(), 'DELETE', `/api/admin/admins/${extraSession.userId}`, { params: { id: extraSession.userId } });
          assert(r.status === 200 && r.json?.revoked === true, `admins/[id]: existing revocable target → 200 { revoked: true } (got ${r.status})`);
          const { data: revoked } = await admin.from('admin_users').select('revoked_at').eq('id', extraSession.userId).maybeSingle();
          assert(!!revoked?.revoked_at, 'admins/[id]: the target is soft-revoked (revoked_at set, row kept)');
          assert((await revokeAudits(extraSession.userId)) === 1, 'admins/[id]: the revoke was audit-logged exactly once');
          const { data: caller } = await admin.from('admin_users').select('revoked_at').eq('id', session!.userId).maybeSingle();
          assert(caller?.revoked_at === null, 'admins/[id]: the revoking admin is still active');
        }

        // Discovery mutation routes against the C6 table: with it absent the
        // lookup itself FAILS, and must say so instead of reading "not found".
        const pr = await call(promote(), 'POST', `/api/admin/discovery/${NIL}/promote`, { params: { id: NIL } });
        const rj = await call(reject(), 'POST', `/api/admin/discovery/${NIL}/reject`, { params: { id: NIL }, body: { reason: 'accuracy-suite probe (nothing to reject)' } });
        if (c6TablePresent) {
          assert(pr.status === 404 && rj.status === 404, `discovery promote/reject: an unknown candidate is a 404 when the table exists (${pr.status}/${rj.status})`);
        } else {
          assert(pr.status === 500 && /schema cache|does not exist/i.test(pr.json?.detail ?? ''), `discovery promote: with the C6 table absent it is a 500 naming the database error, not "not found" (got ${pr.status})`);
          assert(rj.status === 500 && /schema cache|does not exist/i.test(rj.json?.detail ?? ''), `discovery reject: with the C6 table absent it is a 500 naming the database error, not "not found" (got ${rj.status})`);
        }
      }
    } finally {
      if (nonAdminSession) {
        await admin.auth.admin.deleteUser(nonAdminSession.userId).catch(() => {});
        const { data: gone } = await admin.auth.admin.getUserById(nonAdminSession.userId);
        assert(!gone?.user, 'cleanup: the disposable non-admin account is gone');
      }
      if (extraSession) {
        // remove the audit rows this run wrote for its own disposable target, then the target itself
        await admin.from('admin_audit_log').delete().eq('target_id', extraSession.userId);
        await admin.from('admin_users').delete().eq('id', extraSession.userId);
        await admin.auth.admin.deleteUser(extraSession.userId).catch(() => {});
        const { data: left2 } = await admin.from('admin_users').select('id').eq('id', extraSession.userId);
        const { data: leftAudit } = await admin.from('admin_audit_log').select('id').eq('target_id', extraSession.userId);
        assert((!left2 || left2.length === 0) && (!leftAudit || leftAudit.length === 0), 'cleanup: the second disposable admin and its audit rows are gone');
      }
      if (session) {
        await admin.from('admin_users').delete().eq('id', session.userId);
        await admin.auth.admin.deleteUser(session.userId).catch(() => {});
        const { data: left } = await admin.from('admin_users').select('id').eq('id', session.userId);
        assert(!left || left.length === 0, 'cleanup: the disposable admin membership is gone');
      }
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running admin-accuracy suite:', e); process.exit(1); });

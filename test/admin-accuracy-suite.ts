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
import { hasRequiredEnv, newVerifiedSession, adminClient, TestSession } from './helpers/verified-session';

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
  }

  // ==========================================================================
  console.log('\n2. STATIC RULES over every admin route and page');
  // ==========================================================================
  {
    const routeFiles = walk(path.join(ROOT, 'src/app/api/admin'), (f) => f.endsWith('route.ts'));
    assert(routeFiles.length === 15, `found all 15 admin routes (${routeFiles.length})`);

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
    assert(/EXPECTED_INTERVAL_HOURS\s*=\s*6/.test(sync), 'sync-health: expects the 6-hour cadence');

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
        assert(['healthy', 'degraded', 'stale', 'no_evidence'].includes(byId.c1_c3.status), `sync-health: C1/C3 has a derived status (${byId.c1_c3.status})`);
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

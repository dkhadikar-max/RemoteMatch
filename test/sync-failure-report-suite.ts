/**
 * Catalog sync route — failure observability.
 * ==============================================================================
 * A scheduled POST /api/opportunities/sync returned HTTP 500 (cron log:
 * `curl: (22) ... error: 500`, which hides the body) and the route logged
 * nothing, so nobody could tell WHY. The route now logs one redacted line and
 * returns the same run id + failing stage in the JSON body.
 *
 * Part A pins the pure helper (redaction, error description, never throwing).
 * Part B runs the REAL route handler with only the database/network-touching
 * modules mocked, to prove: auth (401) and the success response are unchanged,
 * every failure stage is reported, the status stays 500, and no secret ever
 * reaches a log line or a response.
 *
 * Pure (no network, no DB). Run: npx tsx test/sync-failure-report-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, describeSyncFailure, newSyncRunId } from '../src/lib/ingestion/sync-failure-report';

// ---- Part B plumbing: stub ONLY the modules the route imports that touch the DB / providers ----
const SECRET = 'test-ingest-secret-value-123456';
const SERVICE_KEY = 'test-service-role-key-abcdefghij';
process.env.INGESTION_SYNC_SECRET = SECRET;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

interface Mocks {
  sync: () => Promise<unknown>;
  revalidate: () => Promise<unknown>;
  translate: () => Promise<unknown>;
  reconcile: () => Promise<unknown>;
  calls: string[];
}
const mocks: Mocks = { sync: async () => ({}), revalidate: async () => ({}), translate: async () => ({}), reconcile: async () => ({}), calls: [] };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = NodeModule._load;
NodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request.endsWith('/ingestion/catalog-sync')) {
    return {
      syncOpportunitiesToCatalog: async () => { mocks.calls.push('sync'); return mocks.sync(); },
      revalidateStaleLinks: async () => { mocks.calls.push('revalidate'); return mocks.revalidate(); },
      reconcileCrossProviderDuplicates: async () => { mocks.calls.push('reconcile'); return mocks.reconcile(); },
      verifyIngestionSecret: (h: string | null) => h === `Bearer ${SECRET}`,
    };
  }
  if (request.endsWith('/translation/translate-pending')) return { translatePendingOpportunities: async () => { mocks.calls.push('translate'); return mocks.translate(); } };
  if (request.endsWith('/ingestion/catalog-caches')) return { invalidateCatalogCaches: () => { mocks.calls.push('invalidate'); } };
  return originalLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST } = require('../src/app/api/opportunities/sync/route') as { POST: (req: Request) => Promise<Response> };
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { NextRequest } = require('next/server') as { NextRequest: new (url: string, init?: RequestInit) => Request };

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const allOutput: string[] = [];
async function call(opts: { auth?: string | null; action?: string } = {}) {
  const logs: string[] = [], errors: string[] = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
  mocks.calls = [];
  try {
    const headers: Record<string, string> = {};
    const auth = opts.auth === undefined ? `Bearer ${SECRET}` : opts.auth;
    if (auth) headers.Authorization = auth;
    const url = `http://localhost/api/opportunities/sync${opts.action ? `?action=${opts.action}` : ''}`;
    const res = await POST(new NextRequest(url, { method: 'POST', headers }));
    const body = await res.json();
    allOutput.push(...logs, ...errors, JSON.stringify(body));
    return { status: res.status, body, logs, errors, calls: [...mocks.calls] };
  } finally { console.log = origLog; console.error = origErr; }
}
const okSummary = { providerOutcomes: [{ sourceKey: 'a', success: true, jobCount: 3 }, { sourceKey: 'b', success: false, jobCount: 0, error: 'x' }], newJobsVerifiedActive: 1 };

async function run() {
  console.log('='.repeat(78));
  console.log('SYNC ROUTE — failure observability');
  console.log('='.repeat(78));

  console.log('\nA1. redactSecrets(): secrets are removed, ordinary messages are not touched');
  {
    const env = { INGESTION_SYNC_SECRET: 'abcd1234efgh5678', SERPAPI_KEY: 'serp-key-value-9999', CATALOG_SYNC_MODE: 'shadow-long-value', SHORT_SECRET: 'abc', HOME: '/home/user/x' };
    const r = (s: string) => redactSecrets(s, env);
    assert(!r('failed with abcd1234efgh5678 here').includes('abcd1234efgh5678'), "an env var whose NAME looks secret has its VALUE redacted");
    assert(!r('x serp-key-value-9999 y').includes('serp-key-value-9999'), 'any *_KEY env value is redacted');
    assert(r('mode is shadow-long-value').includes('shadow-long-value'), 'a NON-secret env var value (CATALOG_SYNC_MODE) is left alone');
    assert(r('flag abc set').includes('abc'), 'a short value (< 8 chars) is never treated as a secret, so "true"/"1" are not blanked out');
    assert(!/Bearer\s+abc123def456ghi789/.test(r('Authorization: Bearer abc123def456ghi789 rejected')) && !r('Authorization: Bearer abc123def456ghi789 rejected').includes('abc123def456ghi789'), 'Authorization: Bearer <token> is redacted');
    assert(!r('X-Internal-Secret: sup3rs3cretvalue rejected').includes('sup3rs3cretvalue'), 'X-Internal-Secret header value is redacted');
    assert(!r('request https://x.test/api?api_key=KEYVALUE12345&q=1 failed').includes('KEYVALUE12345') && r('request https://x.test/api?api_key=KEYVALUE12345&q=1 failed').includes('&q=1'), 'api_key=... in a URL is redacted but the rest of the URL survives');
    assert(!r('{"token":"tok_live_abcdefgh"}').includes('tok_live_abcdefgh'), 'a JSON "token" field is redacted');
    assert(!r('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890 end').includes('eyJhbGci'), 'a JWT is redacted');
    assert(!r('key sk-abcdefghijklmnopqrstuvwxyz0123 end').includes('sk-abcdefghijklmnop'), 'an OpenAI-style sk- key is redacted');
    assert(!r('key AIzaSyA1234567890abcdefghijklmnopq end').includes('AIzaSyA12345'), 'a Google AIza key is redacted');
    assert(!r('key sb_secret_abcdef123456 end').includes('sb_secret_abcdef123456'), 'a Supabase sb_secret_ key is redacted');
    assert(!r('postgres://user:hunter2pass@db.example.com/x').includes('hunter2pass'), 'credentials embedded in a URL are redacted');
    for (const m of [
      'Supabase admin client is not configured — cannot sync the catalog.',
      "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
      'duplicate key value violates unique constraint "uq_source_source_id"',
      'column "translation_status" does not exist',
      "Cannot read properties of undefined (reading 'trim')",
      'fetch failed: ECONNRESET at https://himalayas.app/jobs/api?limit=20',
    ]) assert(r(m) === m, `ordinary message is untouched: ${m.slice(0, 48)}…`);
    assert(redactSecrets('', env) === '' && redactSecrets(undefined as unknown as string, env) === '', 'empty / non-string input does not throw');
  }

  console.log('\nA2. describeSyncFailure(): describes any thrown value, never throws');
  {
    const e = new Error('boom');
    const f = describeSyncFailure(e, 'abc12345', 'catalog_sync');
    assert(f.report.name === 'Error' && f.report.message === 'boom' && f.report.stage === 'catalog_sync' && f.report.runId === 'abc12345', 'an Error is described with name, message, stage and run id');
    assert(f.body.success === false && f.body.error === 'boom' && f.body.runId === 'abc12345' && f.body.stage === 'catalog_sync', 'the body carries error, runId and stage (the existing `error` key is kept)');
    assert(f.logLine.startsWith('[sync abc12345] FAILED ') && f.logLine.includes('"stage":"catalog_sync"'), 'the log line starts with the searchable [sync <runId>] prefix and includes the stage');
    assert(!f.logLine.includes('\n'), 'the log line is a single line');
    const pg = describeSyncFailure({ message: 'relation "supply_sources" does not exist', code: '42P01', details: 'd', hint: 'h' }, 'r1', 'catalog_sync');
    assert(pg.report.code === '42P01' && pg.report.message.includes('supply_sources'), 'a Postgres/PostgREST-shaped error object keeps its code and message');
    assert(describeSyncFailure('plain string', 'r', 's').report.message === 'plain string', 'a thrown string is described');
    assert(typeof describeSyncFailure(null, 'r', 's').body.error === 'string' && describeSyncFailure(undefined, 'r', 's').body.error.length > 0, 'null / undefined throw does not break it');
    const circular: Record<string, unknown> = {}; circular.self = circular;
    let threw = false; let out; try { out = describeSyncFailure(circular, 'r', 's'); } catch { threw = true; }
    assert(!threw && typeof out?.body.error === 'string', 'a circular object does not make it throw');
    assert(!(() => { try { describeSyncFailure(Symbol('x') as unknown, 'r', 's'); return false; } catch { return true; } })(), 'a thrown Symbol does not make it throw');
    const long = describeSyncFailure(new Error('x'.repeat(5000)), 'r', 's').report.message;
    assert(long.length < 700 && long.includes('[truncated]'), 'a huge message is truncated');
    const stack = describeSyncFailure(Object.assign(new Error('s'), { stack: 'Error: s\n' + Array.from({ length: 30 }, (_, i) => `    at fn${i} (file${i}.ts:1:1)`).join('\n') }), 'r', 's').report.stack ?? '';
    assert(stack.split(' | ').length <= 6, 'the stack is limited to the first few frames');
    const withCause = describeSyncFailure(new Error('outer', { cause: new Error('inner reason') }), 'r', 's').report;
    assert(withCause.cause === 'inner reason', 'an Error `cause` is included');
    const leaky = describeSyncFailure(new Error(`bad Authorization: Bearer ${SECRET} and key ${SERVICE_KEY}`), 'r', 's');
    assert(!JSON.stringify(leaky).includes(SECRET) && !leaky.logLine.includes(SERVICE_KEY), 'secrets in an error message never reach the log line or body (env values scanned from process.env)');
    const ids = new Set(Array.from({ length: 200 }, () => newSyncRunId()));
    assert(Array.from(ids).every((i) => /^[0-9a-f]{8}$/.test(i)) && ids.size === 200, 'run ids are 8 hex chars and unique across 200 draws');
  }

  // Review finding on PR #20: `name` and `code` were copied into the report raw, so a secret in either reached the
  // log line unredacted and unbounded. Every short field must now be redacted and capped.
  console.log('\nA3. `name`, `code`, run id and stage are redacted and bounded too (review finding)');
  {
    const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const withFields = (name: unknown, code: unknown) => {
      const e: Record<string, unknown> = new Error('ordinary message') as unknown as Record<string, unknown>;
      if (name !== undefined) Object.defineProperty(e, 'name', { value: name, configurable: true, writable: true });
      if (code !== undefined) e.code = code;
      return describeSyncFailure(e, 'abc12345', 'catalog_sync');
    };
    const asText = (f: ReturnType<typeof describeSyncFailure>) => JSON.stringify(f.report) + f.logLine + JSON.stringify(f.body);

    const n = withFields(`AuthError Bearer abcdef1234567890 ${TOKEN}`, undefined);
    assert(!asText(n).includes(TOKEN) && !asText(n).includes('abcdef1234567890'), 'a secret in the error NAME reaches neither the report, the log line nor the body');
    const c = withFields(undefined, `KEY=${TOKEN}`);
    assert(!asText(c).includes(TOKEN), 'a secret in the error CODE reaches neither the report, the log line nor the body');
    assert((n.report.name + c.report.code!).includes('[REDACTED]'), 'the redaction marker is visible in both fields');
    const env = withFields(`Err ${SECRET}`, `C-${SERVICE_KEY}`);
    assert(!asText(env).includes(SECRET) && !asText(env).includes(SERVICE_KEY), 'secret env VALUES placed in name/code are redacted too (not only pattern-shaped tokens)');

    const longName = withFields('N'.repeat(5000), undefined).report.name;
    const longCode = withFields(undefined, 'C'.repeat(5000)).report.code ?? '';
    assert(longName.length <= 80 + 14 && longName.includes('[truncated]'), `an over-long name is clipped (length ${longName.length})`);
    assert(longCode.length <= 40 + 14 && longCode.includes('[truncated]'), `an over-long code is clipped (length ${longCode.length})`);
    const total = withFields('N'.repeat(5000), 'C'.repeat(5000)).logLine.length;
    assert(total < 1800, `the whole log line stays bounded even with a huge name and code (${total} chars)`);

    assert(!withFields('Bad\nname\r\nwith\tcontrols', 'co\nde').logLine.includes('\n'), 'control characters in name/code cannot break the single-line format');
    assert(withFields(undefined, 42703).report.code === '42703', 'a numeric code (some libraries use numbers) is still reported, as a string');
    assert(withFields(undefined, { toString: () => TOKEN }).report.code === undefined, 'a non-string, non-number code is ignored rather than stringified (no hidden toString leak)');
    assert(withFields({ evil: TOKEN }, undefined).report.name === 'UnknownError' && !withFields({ evil: TOKEN }, undefined).logLine.includes(TOKEN), 'a non-string name falls back to UnknownError instead of being stringified');
    assert(withFields('', undefined).report.name === 'UnknownError', 'an empty name falls back to UnknownError');
    assert(describeSyncFailure('s', 'r', 'st').report.name === 'ThrownString', 'a thrown string still reports ThrownString');

    // Ordinary values must survive unchanged: a redactor that blanks everything would also "pass" the leak checks.
    assert(withFields('TypeError', 'ECONNRESET').report.name === 'TypeError' && withFields('TypeError', 'ECONNRESET').report.code === 'ECONNRESET', 'ordinary values (TypeError / ECONNRESET) pass through unchanged');
    assert(withFields('PostgrestError', '42P01').report.code === '42P01' && withFields('Error', 'PGRST116').report.code === 'PGRST116', 'Postgres / PostgREST codes (42P01, PGRST116) pass through unchanged');
    assert(withFields('SyntaxError', undefined).report.name === 'SyntaxError', 'common error class names are untouched');

    const hostileIds = describeSyncFailure(new Error('x'), `id ${TOKEN} ${'z'.repeat(500)}`, `stage ${TOKEN}`);
    assert(!asText(hostileIds).includes(TOKEN) && hostileIds.report.runId.length <= 16 + 14 && hostileIds.report.stage.length <= 40 + 14, 'even the run id and stage arguments are sanitized and bounded (defense in depth)');
    const normal = describeSyncFailure(new Error('x'), 'abc12345', 'catalog_sync');
    assert(normal.report.runId === 'abc12345' && normal.report.stage === 'catalog_sync' && normal.body.runId === 'abc12345' && normal.body.stage === 'catalog_sync', 'normal run id / stage values are unchanged');
  }

  console.log('\nB1. The real route: authentication is unchanged');
  {
    const none = await call({ auth: null });
    assert(none.status === 401 && none.body.error === 'Unauthorized: internal secret required for catalog sync.', 'no secret -> 401 with the original message');
    const wrong = await call({ auth: 'Bearer wrong' });
    assert(wrong.status === 401, 'wrong secret -> 401');
    assert(none.calls.length === 0 && wrong.calls.length === 0, 'a rejected request runs NOTHING (no sync, translation or reconciliation)');
    assert(none.logs.length === 0 && none.errors.length === 0, 'a rejected request writes no log lines');
    assert(!('runId' in none.body), 'the 401 body has no run id (unchanged)');
  }

  console.log('\nB2. The real route: the success path is unchanged');
  {
    mocks.sync = async () => okSummary; mocks.translate = async () => ({ translated: 2 }); mocks.reconcile = async () => ({ clusters: 0 });
    const r = await call();
    assert(r.status === 200, 'HTTP 200');
    assert(JSON.stringify(r.body) === JSON.stringify({ success: true, action: 'sync', ...okSummary, translation: { translated: 2 }, reconciliation: { clusters: 0 } }), 'the success body is EXACTLY what it was (no runId/stage added)');
    assert(JSON.stringify(r.calls) === JSON.stringify(['sync', 'translate', 'reconcile', 'invalidate']), `the steps still run in the same order (got ${JSON.stringify(r.calls)})`);
    const runId = ((r.logs[0] ?? '').match(/^\[sync ([0-9a-f]{8})\] start action=sync$/) || [])[1];
    assert(!!runId, 'a start line is logged with a run id');
    // main also logs a `[catalog-sync] summary` line between start and done (logCatalogSyncResult), so find the done line by its run id.
    const doneLine = r.logs.find((l: string) => l.startsWith(`[sync ${runId}] done`));
    assert(doneLine === `[sync ${runId}] done providers=1/2`, `a done line with the same run id and provider counts (got "${doneLine}")`);
    assert(r.errors.length === 0, 'nothing is logged as an error on success');
    mocks.sync = async () => ({ providerOutcomes: [{ sourceKey: 'a', success: false, jobCount: 0 }] });
    const none = await call();
    assert(none.calls.includes('sync') && !none.calls.includes('reconcile'), 'when no provider succeeded, reconciliation is still skipped (unchanged)');
    mocks.sync = async () => okSummary;
    mocks.revalidate = async () => ({ checked: 5 });
    const rv = await call({ action: 'revalidate' });
    assert(rv.status === 200 && rv.body.action === 'revalidate' && rv.body.checked === 5 && JSON.stringify(rv.calls) === JSON.stringify(['revalidate', 'invalidate']), '?action=revalidate is unchanged');
  }

  console.log('\nB3. The real route: every failure stage is reported, status stays 500');
  {
    const stages: Array<[string, () => void]> = [
      ['catalog_sync', () => { mocks.sync = async () => { throw new Error('sync exploded'); }; }],
      ['translation', () => { mocks.sync = async () => okSummary; mocks.translate = async () => { throw new TypeError("Cannot read properties of undefined (reading 'trim')"); }; }],
      ['reconciliation', () => { mocks.sync = async () => okSummary; mocks.translate = async () => ({}); mocks.reconcile = async () => { throw new Error('reconcile exploded'); }; }],
    ];
    for (const [stage, arm] of stages) {
      mocks.sync = async () => okSummary; mocks.translate = async () => ({}); mocks.reconcile = async () => ({});
      arm();
      const r = await call();
      const runId = r.body.runId as string;
      assert(r.status === 500, `${stage}: HTTP status is still 500`);
      assert(r.body.success === false && /^[0-9a-f]{8}$/.test(runId) && r.body.stage === stage, `${stage}: the body carries success:false, a run id and stage "${stage}" (got stage "${r.body.stage}")`);
      assert(typeof r.body.error === 'string' && r.body.error.length > 0, `${stage}: the body keeps its \`error\` message`);
      assert(r.errors.length === 1 && r.errors[0].startsWith(`[sync ${runId}] FAILED `) && r.errors[0].includes(`"stage":"${stage}"`), `${stage}: exactly one error line, tagged with the same run id and stage`);
      assert(r.logs[0] === `[sync ${runId}] start action=sync`, `${stage}: the start line carries the same run id, so the two correlate`);
    }
    mocks.sync = async () => okSummary; mocks.translate = async () => ({}); mocks.reconcile = async () => ({});
    mocks.revalidate = async () => { throw new Error('revalidate exploded'); };
    const rv = await call({ action: 'revalidate' });
    assert(rv.status === 500 && rv.body.stage === 'revalidate', 'revalidate: failure is reported with stage "revalidate"');
    mocks.revalidate = async () => ({});

    const noReconcileAfterTranslate = stages[1]; mocks.sync = async () => okSummary; noReconcileAfterTranslate[1]();
    const t = await call();
    assert(!t.calls.includes('reconcile'), 'a translation failure still stops the run before reconciliation (control flow unchanged)');
  }

  console.log('\nB4. Odd thrown values and secrets in failures');
  {
    for (const [label, thrown] of [['a string', 'just a string'], ['null', null], ['an object', { code: 'X1', weird: true }]] as const) {
      mocks.sync = async () => { throw thrown; };
      const r = await call();
      assert(r.status === 500 && typeof r.body.error === 'string' && r.body.error.length > 0 && /^[0-9a-f]{8}$/.test(r.body.runId), `throwing ${label} still gives a 500 with a message and run id`);
    }
    mocks.sync = async () => { throw new Error(`upstream said Authorization: Bearer ${SECRET} and service key ${SERVICE_KEY}`); };
    const r = await call();
    const everything = JSON.stringify(r.body) + r.errors.join('\n') + r.logs.join('\n');
    assert(!everything.includes(SECRET) && !everything.includes(SERVICE_KEY), 'a failure message containing the ingestion secret AND the service-role key leaks neither into the body nor any log line');
    assert((r.errors[0] ?? '').includes('[REDACTED]'), 'the redaction marker is visible, so a reader knows something was removed');

    // Through the real route: a thrown Error whose NAME and CODE carry secrets (the reviewed gap).
    const nasty = Object.assign(new Error('db unavailable'), { code: `KEY=${SECRET}` });
    Object.defineProperty(nasty, 'name', { value: `PoolError ${SERVICE_KEY}`, configurable: true });
    mocks.sync = async () => { throw nasty; };
    const rn = await call();
    const outN = JSON.stringify(rn.body) + rn.errors.join('\n') + rn.logs.join('\n');
    assert(rn.status === 500 && !outN.includes(SECRET) && !outN.includes(SERVICE_KEY), 'a failure whose error NAME and CODE embed both secrets leaks neither into the body nor any log line (real route)');
    assert(rn.errors.length === 1 && rn.errors[0].includes('db unavailable'), 'and the useful part of that failure is still logged');
    mocks.sync = async () => okSummary;
  }

  console.log('\nB5. Across the whole run, no secret or header ever reached any output');
  {
    const blob = allOutput.join('\n');
    assert(!blob.includes(SECRET) && !blob.includes(SERVICE_KEY), 'neither secret value appears in any log line or response captured in this suite');
    assert(!/authorization/i.test(blob.replace(/Authorization: \[REDACTED\]/gi, '')), 'no raw Authorization header text appears in any output');
  }

  console.log('\nC. Source guards on the route (what the tests above cannot prove alone)');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/app/api/opportunities/sync/route.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
    assert(/status:\s*401/.test(code) && code.indexOf('verifyIngestionSecret(authHeader)') < code.indexOf('newSyncRunId()'), 'authentication still happens BEFORE any run id / logging / work');
    assert(/syncOpportunitiesToCatalog\(undefined,\s*\{\s*allowLiveProviderFetch:\s*true\s*\}\)/.test(code), 'the live-fetch authorization is unchanged');
    assert(/\{\s*status:\s*500\s*\}/.test(code) && !/status:\s*(502|503)/.test(code), 'the failure status is still 500');
    assert(!/console\.(log|error|warn)\([^)]*(authHeader|req\.headers|process\.env)/.test(code), 'the route never logs the auth header, request headers or env');
    const idx = (s: string) => code.indexOf(s);
    assert(idx("stage = 'catalog_sync'") < idx('syncOpportunitiesToCatalog(') && idx("stage = 'translation'") < idx('translatePendingOpportunities(') && idx("stage = 'reconciliation'") < idx('reconcileCrossProviderDuplicates()'), 'each stage marker is set immediately before the step it names');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error('Fatal error running sync-failure-report-suite:', e); process.exit(1); });

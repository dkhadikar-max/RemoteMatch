/**
 * RemoteMatch — catalog-sync run log (observability only)
 * ==============================================================================
 * The sync route's HTTP response carries the Item 1b `lifecycle` report, but Railway's edge cuts that request at ~5 minutes while
 * the translation pass that follows runs ~14, so the report never reaches the cron log. src/lib/ingestion/lifecycle-log.ts turns
 * the finished summary into a few structured log lines that the route prints BEFORE the translation pass.
 *
 * What this proves:
 *   1. a realistic report (shaped exactly like the shadow body captured in Railway, 2026-10-21 12:06Z) yields one summary line, one
 *      lifecycle line and one line per source, each `[catalog-sync] <kind> <JSON>`, single-line, bounded, carrying the fields an
 *      S3 (observe) review needs: would-write counts, wouldExpire / wouldRetire, unregisteredSources, windowHours, gapRisk;
 *   2. shadowPlanError is logged (truncated, scrubbed); no summary / lifecycle (legacy mode) is handled;
 *   3. robustness: never throws on hostile input (cycles, throwing getters, NaN, huge arrays/strings/sources, 3,000 fuzz objects),
 *      every line stays single-line and under MAX_LINE_CHARS, input is never mutated, token-like strings are scrubbed;
 *   4. the sink: a throwing sink can never fail the caller; the default sink is console.log;
 *   5. the route: the log call exists exactly once, inside POST's try block, AFTER syncOpportunitiesToCatalog() and BEFORE
 *      translatePendingOpportunities(), not in the revalidate branch, and the response body is unchanged;
 *   6. the helper is pure: no imports, no env, no network, no database; catalog-sync*.ts are untouched.
 *
 * Run: npx tsx test/lifecycle-log-suite.ts     (no env, no network, no DB)
 */
import fs from 'fs';
import path from 'path';
import { formatCatalogSyncLog, logCatalogSyncResult, scrub, line, LOG_PREFIX, MAX_LINE_CHARS, MAX_TEXT_CHARS } from '../src/lib/ingestion/lifecycle-log';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const parse = (l: string): { kind: string; body: any } | null => {
  const m = l.match(/^\[catalog-sync\] (\w+) (\{.*\})$/);
  if (!m) return null;
  try { return { kind: m[1], body: JSON.parse(m[2]) }; } catch { return null; }
};
const wellFormed = (l: string) => typeof l === 'string' && !/[\r\n]/.test(l) && l.length <= MAX_LINE_CHARS && parse(l) !== null;

// A report shaped like the real shadow body captured in Railway (cycle 2026-10-21 12:06Z), values copied from it.
const src = (o: Record<string, unknown>) => ({ coverage: 'windowed', floor: null, fetched: 0, keysLookedUp: 0, activeScanned: 0, present: 0, unobservable: 0, legacyCountersInflated: 0, windowHours: null, newestAgeHours: null, gapMarginHours: null, gapRisk: false, employerScopes: null, incremented: 0, expired: 0, retired: 0, wouldExpire: 0, wouldRetire: 0, held: null, ...o });
const realistic = () => ({
  success: true, action: 'sync',
  providerOutcomes: ['remotive', 'arbeitnow', 'jobicy', 'weworkremotely', 'himalayas', 'remoteok', 'greenhouse', 'lever', 'ashby'].map((s, i) => ({ sourceKey: s, success: true, jobCount: [10, 17, 50, 92, 1500, 99, 4022, 474, 587][i] })),
  newJobsVerifiedActive: 153, newJobsVerifiedExpired: 1, newJobsVerificationErrored: 0, reappearedVerifiedActive: 0, reappearedVerifiedExpired: 0,
  refreshedExistingActive: 20, absenceIncremented: 483, expiredByAbsence: 198, draftCount: 0, explicitlyExpiredCount: 0,
  lifecycle: {
    mode: 'shadow', applied: false, durationMs: 6930, phaseTimingsMs: { registryPreflight: 59, lookupExisting: 2108, planUpserts: 21, absenceScan: 4442, unknownBacklog: 184 },
    deadlineMs: 240000, deadlineReached: false, requests: 84,
    bySource: {
      remotive: src({ fetched: 10, keysLookedUp: 10, activeScanned: 10, present: 10, windowHours: 719.13, newestAgeHours: 91.98, gapMarginHours: 621.15 }),
      arbeitnow: src({ fetched: 17, keysLookedUp: 17, activeScanned: 29, present: 9, windowHours: 33.52, newestAgeHours: 1.04, gapMarginHours: 26.48, wouldExpire: 8 }),
      jobicy: src({ fetched: 50, keysLookedUp: 50, activeScanned: 100, present: 50, unobservable: 50, legacyCountersInflated: 50, windowHours: 8.88, newestAgeHours: 7.37, gapMarginHours: -4.49, gapRisk: true }),
      weworkremotely: src({ coverage: 'exempt', fetched: 92, keysLookedUp: 92, activeScanned: 107, present: 91, unobservable: 16, legacyCountersInflated: 16 }),
      himalayas: src({ floor: '2026-10-20T16:59:25.000Z', fetched: 1376, keysLookedUp: 1376, activeScanned: 9910, present: 1168, unobservable: 8689, legacyCountersInflated: 2826, windowHours: 19.06, newestAgeHours: 1.59, gapMarginHours: 11.47, wouldExpire: 5, wouldRetire: 64 }),
      greenhouse: src({ coverage: 'complete', fetched: 3232, keysLookedUp: 66, activeScanned: 123, present: 119, employerScopes: { observable: 14, unobservable: 0, unobservableRows: 0 }, wouldExpire: 2 }),
      lever: src({ coverage: 'complete', fetched: 305, keysLookedUp: 1, activeScanned: 2, present: 2, employerScopes: { observable: 6, unobservable: 0, unobservableRows: 0 } }),
      ashby: src({ coverage: 'complete', fetched: 539, keysLookedUp: 17, activeScanned: 32, present: 32, employerScopes: { observable: 9, unobservable: 0, unobservableRows: 0 } }),
    },
    unregisteredSources: [{ source: 'remoteok', fetched: 96, skippedInserts: 96 }], unobservableScopes: [], employerEvidence: 'bookkeeping',
    gapRiskSources: ['jobicy'], lookupsSkippedByGate: 3992, existingRowsResolved: 1475, gateSkipped: 3992,
    inserts: { planned: 154, written: 0, conflicts: 0 }, touched: 0, contentUpdated: 0,
    verification: { queued: 0, active: 0, expired: 0, errored: 0, deferred: 0, requeuedUnknown: 0, backlogQueued: 0 }, writeFailures: 0,
    errors: [{ op: 'unregistered-source(remoteok)', count: 96, sample: 'source "remoteok" is not in supply_platforms (opportunities.source FK) — 96 fetched job(s) cannot be stored and were not attempted' }],
  },
  translation: { examined: 154 }, reconciliation: { activeRowsScanned: 1000 },
});

console.log('\n1. A realistic shadow report');
{
  const lines = formatCatalogSyncLog(realistic());
  const kinds = lines.map((l) => parse(l)?.kind);
  assert(lines.length === 10, 'one summary + one lifecycle + eight source lines (remotive..ashby; remoteok is unregistered so has no bySource entry)', `got ${lines.length}`);
  assert(lines.every(wellFormed), 'every line is `[catalog-sync] <kind> <JSON>`, single-line and under the size cap', lines.filter((l) => !wellFormed(l)).join('|').slice(0, 200));
  assert(kinds[0] === 'summary' && kinds[1] === 'lifecycle' && kinds.slice(2).every((k) => k === 'source'), 'order: summary, lifecycle, then sources');
  const life = parse(lines[1])!.body;
  assert(life.mode === 'shadow' && life.applied === false && life.durationMs === 6930 && life.requests === 84 && life.deadlineReached === false, 'lifecycle carries mode / applied / duration / requests / deadlineReached');
  assert(life.inserts.planned === 154 && life.inserts.written === 0 && life.inserts.conflicts === 0 && life.touched === 0 && life.contentUpdated === 0 && life.writeFailures === 0, 'lifecycle carries the would-write counts (inserts planned/written/conflicts, touched, contentUpdated, writeFailures)');
  assert(JSON.stringify(life.unregisteredSources) === JSON.stringify([{ source: 'remoteok', fetched: 96, skippedInserts: 96 }]), 'unregisteredSources is logged (remoteok 96 / 96)');
  assert(JSON.stringify(life.gapRiskSources) === JSON.stringify(['jobicy']) && life.employerEvidence === 'bookkeeping', 'gapRiskSources and employerEvidence are logged');
  assert(life.phaseTimingsMs.absenceScan === 4442 && life.verification.queued === 0 && life.errorCount === 1 && life.errors[0].op === 'unregistered-source(remoteok)' && life.errors[0].count === 96, 'phase timings, verification counts and the errors list are logged');
  const by = Object.fromEntries(lines.slice(2).map((l) => { const b = parse(l)!.body; return [b.source, b]; }));
  assert(by.himalayas.wouldExpire === 5 && by.himalayas.wouldRetire === 64 && by.himalayas.windowHours === 19.06 && by.himalayas.unobservable === 8689 && by.himalayas.legacyCountersInflated === 2826, 'himalayas line: wouldExpire 5, wouldRetire 64, windowHours 19.06, unobservable, legacyCountersInflated');
  assert(by.jobicy.gapRisk === true && by.jobicy.gapMarginHours === -4.49 && by.arbeitnow.wouldExpire === 8 && by.greenhouse.wouldExpire === 2, 'jobicy gapRisk/gapMargin, arbeitnow and greenhouse wouldExpire');
  assert(by.greenhouse.coverage === 'complete' && by.greenhouse.employerScopes.observable === 14 && by.weworkremotely.coverage === 'exempt' && by.himalayas.floor === '2026-10-20T16:59:25.000Z', 'coverage, employerScopes and floor are logged');
  const sum = parse(lines[0])!.body;
  assert(sum.expiredByAbsence === 198 && sum.absenceIncremented === 483 && sum.newJobsVerifiedActive === 153 && sum.hasLifecycle === true && sum.providers.length === 9 && sum.providers[4].source === 'himalayas' && sum.providers[4].jobs === 1500, 'summary line: legacy write counters (expiredByAbsence 198 ...) and per-provider fetch outcomes');
  const total = lines.reduce((n, l) => n + l.length, 0);
  assert(total < 6000, `the whole report is small (${total} chars across ${lines.length} lines)`);
  assert(!lines.join('\n').includes('translation') && !lines.join('\n').includes('reconciliation'), 'only sync-owned fields are logged (translation / reconciliation blocks are not dumped)');
}

console.log('\n2. Shadow plan error, legacy mode, missing parts');
{
  const err = formatCatalogSyncLog({ providerOutcomes: [], shadowPlanError: 'relation "x" does not exist\nSecond line' });
  const e = err.map(parse).find((p) => p?.kind === 'shadow_plan_error');
  assert(!!e && e.body.error.includes('does not exist') && !e.body.error.includes('\n'), 'shadowPlanError is logged on its own line, newline-free');
  assert(err.length === 2 && parse(err[0])!.body.hasLifecycle === false, 'legacy/no-lifecycle result: summary (hasLifecycle=false) + the error line only');
  const big = formatCatalogSyncLog({ shadowPlanError: 'x'.repeat(100000) });
  assert(big.every(wellFormed) && (parse(big.find((l) => l.includes('shadow_plan_error'))!)!.body.error as string).length <= MAX_TEXT_CHARS + 1, 'a 100k-char error is truncated to ~300 chars');
  const legacy = formatCatalogSyncLog({ providerOutcomes: [{ sourceKey: 'a', success: false, jobCount: 0, error: 'timeout' }], newJobsVerifiedActive: 1 });
  assert(legacy.length === 1 && parse(legacy[0])!.body.providers[0].error === 'timeout' && parse(legacy[0])!.body.providers[0].ok === false, 'a failed provider outcome keeps its (truncated) error text');
  assert(formatCatalogSyncLog({}).length === 1 && formatCatalogSyncLog({ lifecycle: {} }).every(wellFormed), 'empty result / empty lifecycle -> still well-formed lines');
}

console.log('\n3. Scrubbing and bounds');
{
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijk';
  assert(!scrub(`bad ${jwt} end`).includes('eyJhbGci') && !scrub('Authorization: Bearer abc123def').includes('abc123def') && !scrub('apikey=SECRETVALUE1').includes('SECRETVALUE1') && !scrub('token: xyz987').includes('xyz987') && !scrub('sk_live_ABCDEFGH12345').includes('ABCDEFGH12345') && !scrub('whsec_ABCDEFGH12345').includes('ABCDEFGH12345'), 'JWTs, Bearer values, key=value secrets, sk_/whsec_ keys are redacted');
  assert(!scrub('postgres://svc_user:SuperSecretPw@db.example.com:5432/x').includes('SuperSecretPw') && scrub('postgres://svc_user:SuperSecretPw@db.example.com/x').includes('db.example.com'), 'credentials embedded in a URL are redacted (the host is kept)');
  const stub = line('x', { a: 'y'.repeat(5000) });
  assert(stub.length <= MAX_LINE_CHARS && JSON.parse(stub.slice('[catalog-sync] x '.length)).truncated === true && JSON.parse(stub.slice('[catalog-sync] x '.length)).originalChars > 5000, 'line(): a body that cannot be shed falls back to a small `truncated` stub (last-resort guard)');
  const shed = line('x', { keep: 1, big: Array.from({ length: 400 }, (_, i) => 'item-' + i) }, ['big']);
  assert(shed.length <= MAX_LINE_CHARS && JSON.parse(shed.slice('[catalog-sync] x '.length)).keep === 1 && JSON.parse(shed.slice('[catalog-sync] x '.length)).big.count === 400, 'line(): a shed list is replaced by {dropped:true,count:N} and the rest of the body survives');
  const fewErr = realistic(); fewErr.lifecycle.errors = Array.from({ length: 30 }, (_, i) => ({ op: 'op' + i, count: i, sample: 's' + i })) as any;
  const fe = parse(formatCatalogSyncLog(fewErr)[1])!.body;
  assert(fe.errors.length === 8 && fe.errorCount === 30 && fe.errors[7].op === 'op7', 'with 30 short errors exactly the first 8 are logged and errorCount says 30');
  const bigProv = { providerOutcomes: Array.from({ length: 40 }, (_, i) => ({ sourceKey: 'provider-' + i, success: false, jobCount: 0, error: 'e'.repeat(2000) })), newJobsVerifiedActive: 7 };
  const bp = formatCatalogSyncLog(bigProv); const bpb = parse(bp[0]);
  assert(bp.every(wellFormed) && !!bpb && bpb.body.truncated !== true && bpb.body.newJobsVerifiedActive === 7 && bpb.body.providers.count !== undefined, 'a summary with 40 failing providers sheds the provider list but keeps its counters');
  const r = realistic(); (r.lifecycle.errors as any[]).push({ op: 'x', count: 1, sample: `failed with ${jwt} and password=hunter2` });
  const joined = formatCatalogSyncLog(r).join('\n');
  assert(!joined.includes('eyJhbGci') && !joined.includes('hunter2'), 'secrets inside an error sample never reach the log');
  const many = realistic(); many.lifecycle.errors = Array.from({ length: 500 }, (_, i) => ({ op: 'op' + i, count: i, sample: 'y'.repeat(5000) })) as any;
  const ml = formatCatalogSyncLog(many);
  assert(ml.every(wellFormed) && parse(ml[1])!.body.mode === 'shadow' && parse(ml[1])!.body.errorCount === 500 && (parse(ml[1])!.body.errors.length ?? 0) <= 8, '500 errors with 5k-char samples -> the lifecycle line stays within the cap, keeps mode/inserts and the true errorCount (500)');
  const worst = realistic(); (worst.lifecycle as any).unregisteredSources = Array.from({ length: 50 }, (_, i) => ({ source: 'unregistered-source-number-' + i, fetched: 1000 + i, skippedInserts: 1000 + i })); (worst.lifecycle as any).unobservableScopes = Array.from({ length: 50 }, (_, i) => ({ source: 'greenhouse', boardSlug: 'board-with-a-long-name-' + i, reason: 'no-fetch-evidence', activeRows: i })); (worst.lifecycle as any).errors = Array.from({ length: 50 }, (_, i) => ({ op: 'operation-' + 'z'.repeat(70), count: i, code: 'XX000', sample: 'q'.repeat(400) }));
  const wl = formatCatalogSyncLog(worst); const wlife = parse(wl[1]);
  assert(wl.every(wellFormed) && !!wlife && wlife.body.truncated !== true && wlife.body.mode === 'shadow' && wlife.body.inserts.planned === 154 && wlife.body.errorCount === 50, 'worst case (50 unregistered + 50 unobservable + 50 long errors): the line sheds its bulky lists (not the whole line) and keeps the core counts');
  const bs: Record<string, unknown> = {}; for (let i = 0; i < 500; i++) bs['s' + i] = src({ fetched: i });
  const many2 = realistic(); (many2.lifecycle as any).bySource = bs;
  const m2 = formatCatalogSyncLog(many2);
  assert(m2.every(wellFormed) && m2.length === 2 + 20, '500 sources -> at most 20 source lines');
  const nan = realistic(); (nan.lifecycle.bySource.himalayas as any).wouldRetire = NaN; (nan.lifecycle as any).durationMs = Infinity;
  const nl = formatCatalogSyncLog(nan);
  assert(nl.every(wellFormed) && parse(nl[1])!.body.durationMs === null, 'NaN / Infinity become null, never an invalid line');
  const ctl = realistic(); (ctl.lifecycle.errors as any[]).push({ op: 'a\u0000b\u0007c\td', count: 1, sample: 'tab\there\u0001\r\nline' });
  assert(formatCatalogSyncLog(ctl).every(wellFormed), 'control characters in free text cannot break a line');
}

console.log('\n4. Robustness (hostile input never throws)');
{
  const cyc: any = { providerOutcomes: [], lifecycle: { bySource: {}, errors: [] } }; cyc.self = cyc; cyc.lifecycle.self = cyc; cyc.lifecycle.bySource.a = cyc;
  const thrower: any = { get providerOutcomes() { throw new Error('boom'); } };
  const throwerLife: any = { providerOutcomes: [], lifecycle: { get bySource() { throw new Error('boom2'); } } };
  let threw = 0; const run = (v: unknown) => { try { const l = formatCatalogSyncLog(v); if (!Array.isArray(l) || !l.every((x) => typeof x === 'string')) threw++; return l; } catch { threw++; return []; } };
  for (const v of [undefined, null, 0, 'str', [], [1, 2], true, Symbol('s'), () => 1, cyc, thrower, throwerLife, { lifecycle: 'x' }, { lifecycle: [] }, { providerOutcomes: 'x' }, { providerOutcomes: [null, 1, 'a'] }]) run(v);
  assert(threw === 0, '16 hostile shapes (undefined, null, primitives, arrays, cycles, throwing getters) never throw');
  assert(run(thrower).length >= 1 && run(thrower).every((l) => l.startsWith(LOG_PREFIX)), 'a throwing getter yields a log_format_error line, not an exception');
  assert(run(undefined).length === 1 && parse(run(undefined)[0])!.kind === 'log_format_error', 'a non-object result yields exactly one log_format_error line');
  let seed = 1234567; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pool: unknown[] = [0, 1, -1, NaN, Infinity, 1e21, '', 'a', 'x'.repeat(2000), '\n', 'eyJ1234567890.abcdefgh.ijklmnop', null, undefined, true, false, [], {}];
  const gen = (d: number): unknown => { if (d <= 0 || rnd() < 0.3) return pool[Math.floor(rnd() * pool.length)]; if (rnd() < 0.4) return Array.from({ length: Math.floor(rnd() * 4) }, () => gen(d - 1)); const o: Record<string, unknown> = {}; for (const k of ['lifecycle', 'bySource', 'errors', 'inserts', 'verification', 'providerOutcomes', 'unregisteredSources', 'unobservableScopes', 'held', 'employerScopes', 'a', 'mode', 'source', 'sample', 'phaseTimingsMs', 'gapRiskSources', 'shadowPlanError', 'wouldExpire']) if (rnd() < 0.35) o[k] = gen(d - 1); return o; };
  let bad = 0, produced = 0;
  for (let i = 0; i < 3000; i++) { const v = gen(4); try { const ls = formatCatalogSyncLog(v); produced += ls.length; if (!ls.every(wellFormed)) bad++; } catch { bad++; } }
  assert(bad === 0 && produced > 3000, `3,000 fuzz objects: never throw, every line single-line / parseable / under the cap (${produced} lines checked)`);
  const frozen = realistic(); const deepFreeze = (o: any) => { Object.freeze(o); for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); return o; };
  const before = JSON.stringify(frozen); deepFreeze(frozen);
  assert((() => { try { formatCatalogSyncLog(frozen); return JSON.stringify(frozen) === before; } catch { return false; } })(), 'a deep-frozen input is accepted and unchanged (the formatter never mutates)');
  const t0 = Date.now(); for (let i = 0; i < 300; i++) formatCatalogSyncLog(realistic());
  assert(Date.now() - t0 < 2000, '300 full reports format in < 2 s');
}

console.log('\n5. The sink');
{
  let n = 0; const printed = logCatalogSyncResult(realistic(), () => { n++; throw new Error('sink down'); });
  assert(printed === 0 && n === 10, 'a sink that throws on every line: no exception escapes, all 10 lines attempted, 0 reported printed');
  const got: string[] = []; let calls = 0;
  const p2 = logCatalogSyncResult(realistic(), (m) => { calls++; if (calls === 3) throw new Error('once'); got.push(m); });
  assert(p2 === 9 && got.length === 9, 'a sink that fails once: the other 9 lines are still printed');
  assert(logCatalogSyncResult(undefined, () => { throw new Error('x'); }) === 0, 'undefined result + throwing sink: still no exception');
  const orig = console.log; const cap: string[] = []; console.log = (m: unknown) => { cap.push(String(m)); }; let p3 = 0;
  try { p3 = logCatalogSyncResult(realistic()); } finally { console.log = orig; }
  assert(p3 === 10 && cap.length === 10 && cap.every((l) => l.startsWith('[catalog-sync] ')), 'the default sink is console.log');
}

console.log('\n6. The route');
{
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'opportunities', 'sync', 'route.ts'), 'utf8');
  const code = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const count = (s: string, needle: string) => s.split(needle).length - 1;
  const iSync = code.indexOf('syncOpportunitiesToCatalog(undefined'), iLog = code.indexOf('logCatalogSyncResult(result)'), iTr = code.indexOf('translatePendingOpportunities()'), iRec = code.indexOf('reconcileCrossProviderDuplicates()', code.indexOf('const reconciliation'));
  assert(count(code, 'logCatalogSyncResult(') === 1 && iLog > 0, 'the route calls logCatalogSyncResult exactly once');
  assert(iSync > 0 && iSync < iLog && iLog < iTr && iTr < iRec, 'order: syncOpportunitiesToCatalog -> log -> translatePendingOpportunities -> reconcile');
  const block = (from: number): string => { let d = 0; for (let i = from; i < code.length; i++) { if (code[i] === '{') d++; else if (code[i] === '}') { d--; if (d === 0) return code.slice(from, i + 1); } } return ''; };
  const iPost = code.indexOf('export async function POST'), iTry = code.indexOf('try {', iPost);
  const tryBlock = block(iTry);
  assert(iTry > 0 && tryBlock.includes('logCatalogSyncResult(result)') && tryBlock.includes('translatePendingOpportunities()'), 'the log call is inside POST\'s try block (the one whose catch returns the 500)');
  const iRev = code.indexOf("if (action === 'revalidate')"); const revBlock = block(code.indexOf('{', iRev));
  assert(iRev > 0 && revBlock.length > 20 && !revBlock.includes('logCatalogSyncResult'), 'the revalidate branch does not log (unchanged)');
  assert(/^\s*logCatalogSyncResult\(result\);\s*$/m.test(code) && !/await\s+logCatalogSyncResult/.test(code) && !/(if|\?|&&|\|\|)[^\n]*logCatalogSyncResult\(/.test(code), 'the call is a plain, unconditional, non-awaited statement');
  assert(code.includes("return NextResponse.json({ success: true, action: 'sync', ...result, translation, reconciliation });") && code.includes('const result = await syncOpportunitiesToCatalog(undefined, { allowLiveProviderFetch: true });'), 'the response body and the sync call are exactly as before');
  assert(code.includes("import { logCatalogSyncResult } from '@/lib/ingestion/lifecycle-log';"), 'the helper is imported from @/lib/ingestion/lifecycle-log');
}

console.log('\n7. The helper is pure');
{
  const helper = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ingestion', 'lifecycle-log.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert(!/^\s*import\s/m.test(helper) && !/\brequire\(/.test(helper), 'no imports at all (cannot reach the database, the network or the lifecycle code)');
  assert(!/process\.env/.test(helper) && !/\bfetch\(/.test(helper) && !/\bawait\b/.test(helper) && !/supabase/i.test(helper), 'no environment access, no fetch, no await, no Supabase');
  assert(!/console\.(error|warn)/.test(helper) && (helper.match(/console\.log/g) || []).length === 1, 'the only console use is the default sink');
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

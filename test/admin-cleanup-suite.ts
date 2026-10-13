/**
 * RemoteMatch — Admin console cleanup (Sync Health status, lifetime-ingested counter, stray /api/profile)
 * ==============================================================================
 * 1. Sync Health: a recent run is NOT a schedule. "Healthy" requires an observed ~6h cadence; the production case
 *    that was mislabelled (last run 2.5h ago, last two runs 700.3h apart) must read "recent activity, no schedule".
 * 2. Lifetime ingested: no code path ever writes supply_sources.lifetime_jobs_ingested, so the admin view reports it as
 *    null ("not tracked") — never as a fabricated 0.
 * 3. The consumer navbar must not request /api/profile on the admin host (it 404s on every page load / focus).
 *
 * Pure + static; touches no database and no network.
 * Run: npx tsx test/admin-cleanup-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { classifyFeedPipeline } from '../src/lib/admin/sync-status';
import { toSourceView } from '../src/lib/admin/source-view';
import { shouldFetchEntitlement } from '../src/lib/entitlement/should-fetch';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('='.repeat(78));
console.log('ADMIN CONSOLE CLEANUP');
console.log('='.repeat(78));

// ── 1. Sync Health ──────────────────────────────────────────────────────────
console.log('\n1. classifyFeedPipeline');
const prod = classifyFeedPipeline({ ageHours: 2.5, observedIntervalHours: 700.3 });
assert(prod.status === 'recent_activity' && !prod.enabled && !prod.recurring, 'REGRESSION: last run 2.5h ago + last two runs 700.3h apart → recent_activity, NOT healthy', JSON.stringify(prod));
assert(prod.cadence.startsWith('not scheduled'), 'cadence text says "not scheduled"', prod.cadence);
assert(prod.cadence.includes('700.3h'), 'cadence text still shows the observed gap');

const ok = classifyFeedPipeline({ ageHours: 2, observedIntervalHours: 6.1 });
assert(ok.status === 'healthy' && ok.enabled && ok.recurring, 'recurring ~6h cadence + fresh run → healthy');
assert(classifyFeedPipeline({ ageHours: 6.9, observedIntervalHours: 5.5 }).status === 'healthy', 'healthy boundary (6.9h, 5.5h cadence)');
assert(classifyFeedPipeline({ ageHours: 7.1, observedIntervalHours: 6 }).status === 'degraded', 'recurring + one missed run → degraded');
const stale = classifyFeedPipeline({ ageHours: 40, observedIntervalHours: 6 });
assert(stale.status === 'stale' && !stale.enabled, 'recurring cadence but long silence → stale (not enabled)');
assert(classifyFeedPipeline({ ageHours: 1, observedIntervalHours: 7.1 }).status === 'recent_activity', 'cadence just outside tolerance (7.1h) → no schedule evidence');
assert(classifyFeedPipeline({ ageHours: 1, observedIntervalHours: 4.9 }).status === 'recent_activity', 'cadence just outside tolerance (4.9h) → no schedule evidence');
assert(classifyFeedPipeline({ ageHours: 1, observedIntervalHours: null }).status === 'recent_activity', 'only one run observed → recent_activity, never healthy');
const old = classifyFeedPipeline({ ageHours: 700, observedIntervalHours: 700 });
assert(old.status === 'not_scheduled' && !old.enabled, 'old run + no cadence → not_scheduled');
assert(classifyFeedPipeline({ ageHours: null, observedIntervalHours: null }).status === 'no_evidence', 'no run ever → no_evidence');
for (const age of [0, 1, 3, 6, 6.9, 7.1, 12, 13, 14, 100, 700]) {
  for (const iv of [null, 0.5, 3, 5, 5.5, 6, 6.5, 7, 12, 700]) {
    const c = classifyFeedPipeline({ ageHours: age, observedIntervalHours: iv });
    if (c.status === 'healthy' && !(iv !== null && Math.abs(iv - 6) <= 1)) assert(false, `healthy without an observed cadence (age ${age}, interval ${iv})`);
  }
}
assert(true, 'exhaustive grid: "healthy" is never produced without an observed ~6h cadence');

const route = read('src/app/api/admin/sync-health/route.ts');
assert(route.includes('classifyFeedPipeline(') && !/ageHours <= HEALTHY_MAX_AGE_HOURS/.test(route), 'sync-health route uses classifyFeedPipeline (no inline age-only healthy rule)');
const page = read('src/app/admin/(dashboard)/sync-health/page.tsx');
assert(page.includes("not_scheduled: 'Not scheduled'") && page.includes('recent_activity:'), 'sync-health page labels not_scheduled / recent_activity');

// ── 2. Lifetime ingested ────────────────────────────────────────────────────
console.log('\n2. Lifetime ingested');
const row = { id: 's1', status: 'active', consecutive_fetch_failures: 0, last_fetch_attempt_at: new Date().toISOString(), lifetime_jobs_ingested: 0 };
assert(toSourceView(row, Date.now()).lifetime_jobs_ingested === null, 'a row whose DB counter is 0 is reported as null (not tracked), not 0');
assert(toSourceView({ ...row, lifetime_jobs_ingested: 42 }, Date.now()).lifetime_jobs_ingested === null, 'any counter value is ignored — nothing maintains it');
const nowMs = Date.parse('2026-10-13T12:00:00Z');
const hOld = (h: number) => new Date(nowMs - h * 3600 * 1000).toISOString();
assert(toSourceView({ ...row, last_fetch_attempt_at: hOld(1) }, nowMs).health === 'healthy', 'health unchanged: recent attempt → healthy');
assert(toSourceView({ ...row, last_fetch_attempt_at: hOld(100) }, nowMs).health === 'stale', 'health unchanged: active + >72h → stale');
assert(toSourceView({ ...row, last_fetch_attempt_at: hOld(100), status: 'paused' }, nowMs).health === 'healthy', 'health unchanged: paused + >72h → healthy (not stale)');
assert(toSourceView({ ...row, consecutive_fetch_failures: 2 }, nowMs).health === 'failing', 'health unchanged: failures → failing');
assert(toSourceView({ ...row, last_fetch_attempt_at: null }, nowMs).health === 'never_run', 'health unchanged: no attempt → never_run');
const srcRoute = read('src/app/api/admin/sources/route.ts');
assert(!srcRoute.includes("'lifetime_jobs_ingested") && !/lifetime_jobs_ingested,/.test(srcRoute), 'sources route no longer selects the unmaintained column');
const srcPage = read('src/app/admin/(dashboard)/sources/page.tsx');
assert(srcPage.includes('Not tracked') && srcPage.includes('lifetime_jobs_ingested === null'), 'sources page renders "Not tracked" for null');
// ground truth for "nothing writes it": no source/script file assigns the column
const writers: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(e.name)) walk(p); }
    else if (/\.(ts|tsx|sql)$/.test(e.name) && /lifetime_jobs_ingested/.test(fs.readFileSync(p, 'utf8'))) writers.push(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/'));
  }
};
for (const d of ['src', 'scripts', 'supabase']) walk(path.join(__dirname, '..', d));
const allowed = new Set(['supabase/migrations/012_supply_discovery_registry.sql', 'src/lib/ingestion/employer-registry.ts', 'src/lib/admin/source-view.ts', 'src/app/api/admin/sources/route.ts', 'src/app/admin/(dashboard)/sources/page.tsx']);
assert(writers.every((w) => allowed.has(w)), 'no code path writes lifetime_jobs_ingested (only schema default + comments/readers mention it)', writers.filter((w) => !allowed.has(w)).join(', '));

// ── 3. Stray /api/profile ───────────────────────────────────────────────────
console.log('\n3. Navbar entitlement fetch');
assert(shouldFetchEntitlement({ host: 'admin.remotematch.online', sessionPossible: true, hasAuthCookie: true }) === false, 'admin host: never fetches /api/profile (even with a session cookie)');
assert(shouldFetchEntitlement({ host: 'admin.localhost:3100', sessionPossible: true, hasAuthCookie: true }) === false, 'admin host (local form): never fetches');
assert(shouldFetchEntitlement({ host: 'remotematch.online', sessionPossible: true, hasAuthCookie: true }) === true, 'consumer host + session + cookie: still fetches');
assert(shouldFetchEntitlement({ host: 'remotematch.online', sessionPossible: false, hasAuthCookie: true }) === false, 'consumer host on landing/auth page: no fetch (unchanged)');
assert(shouldFetchEntitlement({ host: 'remotematch.online', sessionPossible: true, hasAuthCookie: false }) === false, 'consumer host signed out: no fetch (unchanged)');
assert(shouldFetchEntitlement({ host: 'localhost:3000', sessionPossible: true, hasAuthCookie: true }) === true, 'localhost consumer: fetches (unchanged)');
assert(shouldFetchEntitlement({ host: null, sessionPossible: true, hasAuthCookie: true }) === true, 'unknown host: behaves as consumer (unchanged)');
const navbar = read('src/components/navigation/navbar.tsx');
const refreshBody = navbar.slice(navbar.indexOf('const refresh = useCallback'), navbar.indexOf('[sessionPossible]);'));
const guard = 'if (!shouldFetchEntitlement({ host: window.location.host, sessionPossible, hasAuthCookie: hasAuthCookie() })) {';
assert(refreshBody.includes(guard) && refreshBody.indexOf(guard) < refreshBody.indexOf('fetchServerEntitlement()'), 'navbar refresh() is guarded by shouldFetchEntitlement (exact, unconditional) BEFORE calling fetchServerEntitlement');

// ── frozen areas ────────────────────────────────────────────────────────────
console.log('\n4. Scope');
import { execSync } from 'child_process';
const root = path.join(__dirname, '..');
const sh = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
// Everything this branch changes: tracked diff vs origin/main (committed or not) + untracked files.
const names = Array.from(new Set([...sh('git diff --name-only origin/main'), ...sh('git ls-files --others --exclude-standard')]));
const frozen = ['src/lib/ingestion/', 'src/lib/discovery/', 'supabase/', 'src/app/api/opportunities/', 'src/lib/matching/', 'src/middleware.ts'];
assert(names.every((f) => !frozen.some((x) => f.startsWith(x))), 'working tree touches no ingestion / discovery / schema / opportunities API / matcher / middleware files', names.filter((f) => frozen.some((x) => f.startsWith(x))).join(', '));
assert(!names.some((f) => /api\/admin\/(discovery|opportunities|admins)/.test(f)), 'promotion / rejection / expiry / admin-grant routes untouched');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

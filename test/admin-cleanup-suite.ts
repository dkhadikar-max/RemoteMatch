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
import { classifyFeedPipeline, observeFeedRuns, previousRunCutoffIso, RUN_SEPARATION_MINUTES } from '../src/lib/admin/sync-status';
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

// ── 1b. Run history → status: zero / one / many runs ────────────────────────
// sync-health derives its run history from opportunities.last_seen_in_feed_at: the NEWEST timestamp is the latest run,
// the newest one older than previousRunCutoffIso(latest) is the previous run. These tests drive that derivation + the
// classifier together with fixed timestamps (no database), so a first-ever sync can be shown never to read "healthy".
console.log('\n1b. observeFeedRuns + classifyFeedPipeline (zero / one / many runs)');
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const agoIso = (hours: number) => new Date(NOW - hours * 3600 * 1000).toISOString();
const observe = (latestAgo: number | null, previousAgo: number | null) => {
  const o = observeFeedRuns({ latest: latestAgo === null ? null : agoIso(latestAgo), previous: previousAgo === null ? null : agoIso(previousAgo), nowMs: NOW });
  return { ...o, ...classifyFeedPipeline({ ageHours: o.ageHours, observedIntervalHours: o.observedIntervalHours }) };
};

const zero = observe(null, null);
assert(zero.ageHours === null && zero.observedIntervalHours === null && zero.status === 'no_evidence' && !zero.enabled, 'ZERO runs: no timestamps → no_evidence, not enabled');
assert(observeFeedRuns({ latest: null, previous: agoIso(5), nowMs: NOW }).observedIntervalHours === null, 'ZERO runs: a stray "previous" without a latest run is ignored');

const first = observe(0.1, null);
assert(first.ageHours !== null && Math.abs(first.ageHours - 0.1) < 1e-9 && first.observedIntervalHours === null, 'ONE run: age is derived, interval is null');
assert(first.status === 'recent_activity' && !first.enabled && !first.recurring, 'REGRESSION: a first-ever successful sync reads recent_activity — never healthy, never enabled');
assert(first.cadence.startsWith('not scheduled') && /only one run observed/.test(first.cadence), 'ONE run: cadence says "not scheduled — only one run observed"', first.cadence);
for (const age of [0, 0.1, 1, 3, 6, 6.9]) {
  assert(observe(age, null).status !== 'healthy', `ONE run, ${age}h ago: never "healthy" (${observe(age, null).status})`);
}
assert(observe(30, null).status === 'not_scheduled', 'ONE run, old: not_scheduled');

const two = observe(1, 7);
assert(two.observedIntervalHours === 6, 'MANY runs: two runs 6h apart → observed interval 6');
assert(two.status === 'healthy' && two.enabled && two.recurring && two.cadence.includes('6h'), 'MANY runs: ~6h cadence + fresh run → healthy, enabled, cadence names 6h');
assert(observe(1, 6.5).status === 'healthy' && observe(1, 7.5).status === 'healthy', 'MANY runs: cadence within ±1h tolerance (5.5h / 6.5h apart) → healthy');
assert(observe(1, 8.1).status === 'recent_activity' && observe(1, 5).status === 'recent_activity', 'MANY runs: cadence outside tolerance (7.1h / 4h apart) → recent_activity, not healthy');
const longGap = observe(2.5, 702.8);
assert(longGap.observedIntervalHours === 700.3 && longGap.status === 'recent_activity', 'MANY runs: the production case (700.3h gap) → recent_activity');
assert(observe(8, 14).status === 'degraded' && observe(40, 46).status === 'stale', 'MANY runs: recurring but late → degraded; recurring but silent → stale');
assert(observeFeedRuns({ latest: agoIso(1), previous: new Date(NOW - 1 * 3600 * 1000 - 6.04 * 3600 * 1000).toISOString(), nowMs: NOW }).observedIntervalHours === 6, 'MANY runs: the interval is rounded to one decimal');

assert(RUN_SEPARATION_MINUTES === 90, 'run separation is 90 minutes');
assert(previousRunCutoffIso('2026-10-23T10:00:00.000Z') === '2026-10-23T08:30:00.000Z', 'previous-run cutoff is exactly 90 minutes before the latest activity');

// The route finds runs with two queries: latest = newest last_seen_in_feed_at; previous = newest one STRICTLY OLDER than
// previousRunCutoffIso(latest). This in-memory model has exactly those semantics, so the tests below show what the 90-minute
// rule means for real timestamp patterns — in particular that the tail of ONE long run can never pose as a second run.
const modelRuns = (timestampsAgoHours: number[]) => {
  const ts = timestampsAgoHours.map((h) => NOW - h * 3600 * 1000);
  const latestMs = Math.max(...ts);
  const cutoff = Date.parse(previousRunCutoffIso(new Date(latestMs).toISOString()));
  const older = ts.filter((t) => t < cutoff);
  return observeFeedRuns({ latest: new Date(latestMs).toISOString(), previous: older.length ? new Date(Math.max(...older)).toISOString() : null, nowMs: NOW });
};
const oneRunSpread = modelRuns([0.5, 0.7, 1.0, 1.4, 1.9]); // one run's rows touched across 84 minutes
assert(oneRunSpread.observedIntervalHours === null && classifyFeedPipeline(oneRunSpread).status === 'recent_activity', 'ONE run whose rows span 84 min (< 90): no previous run, so recent_activity — a long run cannot fake a cadence');
assert(modelRuns([1, 2.5]).observedIntervalHours === null, 'activity exactly 90 min before the newest is the SAME run (the cutoff is strict)');
assert(modelRuns([1, 2.5 + 1 / 3600]).observedIntervalHours === 1.5, 'activity 90 min + 1 s before the newest is a different run');
const twoRuns = modelRuns([1, 1.2, 1.4, 7, 7.2, 7.4]); // run A (newest at 1h, spread 24 min) and run B (newest at 7h)
assert(twoRuns.observedIntervalHours === 6 && classifyFeedPipeline(twoRuns).status === 'healthy', 'TWO runs, each spread over ~24 min and 6h apart: interval is newest-to-newest (6h) → healthy');
assert(/\.lt\('last_seen_in_feed_at', beforeIso\)/.test(route) && /newestTimestamp\(admin, previousRunCutoffIso\(latest\)\)/.test(route), 'the route issues exactly that query shape: previous = newest strictly older (.lt) than previousRunCutoffIso(latest)');

// The documented invariant, across every combination: healthy ⇒ enabled AND an observed ~6h cadence named in the text.
let invariantBreaks = 0;
for (const latestAgo of [null, 0, 0.1, 1, 3, 6, 6.9, 7.1, 12, 13.1, 40, 700]) {
  for (const gap of [null, 0.5, 3, 5, 5.5, 6, 6.5, 7, 12, 700.3]) {
    const o = observe(latestAgo, latestAgo === null || gap === null ? null : latestAgo + gap);
    if (o.status === 'healthy' && !(o.enabled && o.recurring && o.cadence.includes('6h') && o.observedIntervalHours !== null)) invariantBreaks++;
    if (gap === null && o.status === 'healthy') invariantBreaks++;
  }
}
assert(invariantBreaks === 0, 'exhaustive grid (zero, one and many runs): "healthy" always implies enabled + an observed 6h cadence, and a single run is never healthy');

assert(/observeFeedRuns\(/.test(route) && /previousRunCutoffIso\(/.test(route) && !/\* 60 \* 1000/.test(route), 'sync-health route derives run history through observeFeedRuns/previousRunCutoffIso (no inline 90-minute arithmetic)');

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

// ── 4. Scope ────────────────────────────────────────────────────────────────
// These guards used to diff the WORKING TREE against origin/main ("everything this branch changes"). That described the
// cleanup PR while it was an open branch; once #6 merged, origin/main == the cleanup, so the same check began failing for
// ANY later branch that legitimately touched supabase/ or an admin route — it no longer protected the cleanup's boundary,
// it just policed whoever was working next. They are replaced by (a) the original assertions pinned to the cleanup PR's
// own immutable merge (the convention resume-honesty-suite / resume-p1-equivalence-suite already use), and (b) forward
// invariants that hold for every branch: migrations are append-only, and the admin mutation routes keep their
// authenticate → act → audit-log shape. Nothing here is deleted without a replacement.
console.log('\n4. Scope');
import { execSync } from 'child_process';
const root = path.join(__dirname, '..');
const sh = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

// A guard that cannot run must FAIL, not skip: "skipped, exit 0" is indistinguishable from "passed" in a summary line
// or a CI status. If a required git ref is unavailable (shallow clone, squash-merged history, never fetched) the guard
// below fails with the underlying git error. To skip knowingly, run with SCOPE_GUARDS_ALLOW_MISSING_REFS=1 — the skip is
// then printed with its reason. (Other suites that pin commits skip silently-with-a-note; this one deliberately does not.)
const ALLOW_MISSING_REFS = process.env.SCOPE_GUARDS_ALLOW_MISSING_REFS === '1';
function guardUnavailable(what: string, cause: unknown) {
  const reason = String((cause as Error)?.message ?? cause).split('\n')[0];
  if (ALLOW_MISSING_REFS) console.log(`  note: ${what} SKIPPED because SCOPE_GUARDS_ALLOW_MISSING_REFS=1 (${reason})`);
  else assert(false, `${what}: a required git ref is unavailable, so this guard cannot run (fetch it — e.g. \`git fetch origin\` — or set SCOPE_GUARDS_ALLOW_MISSING_REFS=1 to skip knowingly)`, reason);
}

// 4a. The cleanup PR's own change set (PR #6 = merge 4c3fc95; net change vs its first parent).
const CLEANUP_PR_MERGE = '4c3fc95';
let cleanupFiles: string[] | null = null;
let cleanupErr: unknown = null;
try {
  // `~1` (first parent), not `^1`: execSync runs through cmd.exe on Windows, where `^` is the escape character and
  // would silently mangle the revision — which would make this guard fail to find a commit that exists.
  execSync(`git cat-file -e ${CLEANUP_PR_MERGE}~1 && git cat-file -e ${CLEANUP_PR_MERGE}`, { cwd: root, stdio: 'ignore' });
  cleanupFiles = sh(`git diff --name-only ${CLEANUP_PR_MERGE}~1 ${CLEANUP_PR_MERGE}`);
} catch (e) { cleanupErr = e; }
if (cleanupFiles === null) {
  guardUnavailable(`cleanup PR file-scope guards (merge commit ${CLEANUP_PR_MERGE})`, cleanupErr);
} else {
  const frozen = ['src/lib/ingestion/', 'src/lib/discovery/', 'supabase/', 'src/app/api/opportunities/', 'src/lib/matching/', 'src/middleware.ts'];
  assert(cleanupFiles.length > 0, `the cleanup PR's change set was read from ${CLEANUP_PR_MERGE} (${cleanupFiles.length} files)`);
  assert(cleanupFiles.every((f) => !frozen.some((x) => f.startsWith(x))), 'the cleanup PR touched no ingestion / discovery / schema / opportunities API / matcher / middleware files', cleanupFiles.filter((f) => frozen.some((x) => f.startsWith(x))).join(', '));
  assert(!cleanupFiles.some((f) => /api\/admin\/(discovery|opportunities|admins)/.test(f)), 'the cleanup PR left the promotion / rejection / expiry / admin-grant routes untouched');
}

// 4b. supabase/ is append-only relative to origin/main: an already-merged migration is never edited, deleted or renamed
// (that would silently diverge a database built from the repo from the one in production), and nothing else under
// supabase/ changes unreviewed. NEW migrations are allowed. supabase/.temp/ is Supabase-CLI scratch state, not schema.
// To amend a migration on purpose, list its path in REVIEWED_SUPABASE_CHANGES with the reason.
const REVIEWED_SUPABASE_CHANGES: string[] = [];
function supabaseViolations(nameStatusLines: string[], reviewed: string[] = REVIEWED_SUPABASE_CHANGES): string[] {
  const bad: string[] = [];
  for (const line of nameStatusLines) {
    const [status, ...paths] = line.split('\t');
    for (const p of paths) {
      if (!p.startsWith('supabase/') || p.startsWith('supabase/.temp/') || reviewed.includes(p)) continue;
      const isNewMigration = p.startsWith('supabase/migrations/') && status === 'A' && paths.length === 1;
      if (!isNewMigration) bad.push(`${status}\t${p}`);
    }
  }
  return bad;
}
assert(supabaseViolations(['A\tsupabase/migrations/099_new.sql']).length === 0, 'guard check: a NEW migration is allowed');
assert(supabaseViolations(['M\tsupabase/.temp/cli-latest']).length === 0, 'guard check: CLI scratch state under supabase/.temp/ is ignored');
assert(supabaseViolations(['M\tsupabase/migrations/029_admin_console.sql']).length === 1, 'guard check: editing a merged migration is flagged');
assert(supabaseViolations(['D\tsupabase/migrations/001_initial_schema.sql']).length === 1, 'guard check: deleting a merged migration is flagged');
assert(supabaseViolations(['R100\tsupabase/migrations/010_a.sql\tsupabase/migrations/010_b.sql']).length === 2, 'guard check: renaming a merged migration is flagged (both paths)');
assert(supabaseViolations(['M\tsupabase/config.toml', 'A\tsupabase/seed.sql']).length === 2, 'guard check: any other change under supabase/ is flagged');
assert(supabaseViolations(['M\tsupabase/migrations/029_admin_console.sql'], ['supabase/migrations/029_admin_console.sql']).length === 0, 'guard check: a deliberately reviewed amendment can be listed');
// Baseline caveats (see also the header of this section): the baseline is the LOCAL origin/main ref, so it is only as
// current as the last `git fetch`. A stale ref fails safe-and-noisily (an already-merged amendment looks like an edit);
// pushing to origin/main moves the baseline, so this protects what is not yet merged, not what already is. `git diff`
// does not list UNTRACKED files, so they are added below as "A" entries (a new untracked migration is allowed; any other
// new file under supabase/ is flagged) — the original branch-relative guard also covered untracked files.
let supabaseNameStatus: string[] | null = null;
let supabaseErr: unknown = null;
try {
  supabaseNameStatus = [
    ...sh('git diff --name-status origin/main -- supabase'),
    ...sh('git ls-files --others --exclude-standard -- supabase').map((p) => `A\t${p}`),
  ];
} catch (e) { supabaseErr = e; }
if (supabaseNameStatus === null) {
  guardUnavailable('supabase/ append-only check (baseline ref origin/main)', supabaseErr);
} else {
  const v = supabaseViolations(supabaseNameStatus);
  assert(v.length === 0, 'supabase/: no merged migration edited/deleted/renamed and nothing else under supabase/ changed vs origin/main', v.join(' | '));
}

// 4c. The admin mutation routes keep their shape: authenticate BEFORE touching the database, act, then audit-log with the
// right closed-vocabulary action; the admin routes never hard-delete a membership or create accounts. This protects the
// behaviour of src/app/api/admin/{admins,discovery,opportunities} whoever edits them — not the files' byte content.
function stripCode(s: string) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); }
function handlerBody(src: string, method: string): string | null {
  const re = new RegExp(`export async function ${method}\\(`);
  const m = re.exec(src);
  if (!m) return null;
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/\nexport async function /);
  return next === -1 ? rest : rest.slice(0, next);
}
function routeViolations(src: string, method: string, opts: { audit?: string; adminsRoute?: boolean }): string[] {
  const out: string[] = [];
  const body = handlerBody(stripCode(src), method);
  if (body === null) return [`no ${method} handler`];
  const auth = body.indexOf('getAuthenticatedAdmin(req)');
  const db = body.indexOf('getSupabaseAdminClient()');
  if (auth === -1) out.push(`${method}: does not call getAuthenticatedAdmin(req)`);
  else if (db !== -1 && auth > db) out.push(`${method}: touches the database before authenticating`);
  if (opts.audit) {
    if (!body.includes('recordAdminAction(')) out.push(`${method}: not audit-logged`);
    if (!body.includes(`action: '${opts.audit}'`)) out.push(`${method}: audit action is not '${opts.audit}'`);
  }
  if (opts.adminsRoute) {
    if (/\.delete\(/.test(body)) out.push(`${method}: hard-deletes (admin memberships are soft-revoked only)`);
    if (/createUser\(/.test(body)) out.push(`${method}: creates accounts`);
  }
  return out;
}
const adminsRoute = read('src/app/api/admin/admins/route.ts');
const adminsIdRoute = read('src/app/api/admin/admins/[id]/route.ts');
const ROUTE_RULES: Array<[string, string, string, { audit?: string; adminsRoute?: boolean }]> = [
  ['admins (list)', adminsRoute, 'GET', { adminsRoute: true }],
  ['admins (grant)', adminsRoute, 'POST', { audit: 'admin_grant', adminsRoute: true }],
  ['admins/[id] (revoke)', adminsIdRoute, 'DELETE', { audit: 'admin_revoke', adminsRoute: true }],
  ['discovery/[id]/promote', read('src/app/api/admin/discovery/[id]/promote/route.ts'), 'POST', { audit: 'c6_promote' }],
  ['discovery/[id]/reject', read('src/app/api/admin/discovery/[id]/reject/route.ts'), 'POST', { audit: 'c6_reject' }],
  ['opportunities/[id] (read)', read('src/app/api/admin/opportunities/[id]/route.ts'), 'GET', {}],
  ['opportunities/[id] (force-expire)', read('src/app/api/admin/opportunities/[id]/route.ts'), 'PATCH', { audit: 'opportunity_force_expire' }],
];
for (const [label, src, method, opts] of ROUTE_RULES) {
  const v = routeViolations(src, method, opts);
  assert(v.length === 0, `${label}: authenticates before the database${opts.audit ? `, audit-logs '${opts.audit}'` : ''}${opts.adminsRoute ? ', no hard delete / no account creation' : ''}`, v.join('; '));
}
assert(/Cannot revoke the last remaining active admin/.test(adminsIdRoute) && /revoked_at: new Date\(\)\.toISOString\(\)/.test(stripCode(adminsIdRoute)), 'admins/[id] (revoke): keeps the last-admin lockout guard and revokes by setting revoked_at');

// …and prove the checker actually fires on each way these routes could be broken (mutated copies of the real source).
const mut = (find: string | RegExp, repl: string) => adminsIdRoute.replace(find, repl);
assert(routeViolations(mut(/getAuthenticatedAdmin\(req\)/g, 'null'), 'DELETE', { audit: 'admin_revoke', adminsRoute: true }).some((m) => /does not call getAuthenticatedAdmin/.test(m)), 'guard check: removing authentication from revoke is flagged');
assert(routeViolations(mut('revoker = await getAuthenticatedAdmin(req);', 'const dbEarly = getSupabaseAdminClient(); revoker = await getAuthenticatedAdmin(req);'), 'DELETE', { audit: 'admin_revoke', adminsRoute: true }).some((m) => /before authenticating/.test(m)), 'guard check: reaching the database before authenticating is flagged');
assert(routeViolations(mut(/await recordAdminAction\(/, 'await Promise.resolve('), 'DELETE', { audit: 'admin_revoke', adminsRoute: true }).some((m) => /not audit-logged/.test(m)), 'guard check: dropping the audit log is flagged');
assert(routeViolations(mut(/await db\.from\('admin_users'\)\.update\(\{ revoked_at: new Date\(\)\.toISOString\(\) \}\)\.eq\('id', params\.id\)/, "await db.from('admin_users').delete().eq('id', params.id)"), 'DELETE', { audit: 'admin_revoke', adminsRoute: true }).some((m) => /hard-deletes/.test(m)), 'guard check: replacing the soft revoke with a hard delete is flagged');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

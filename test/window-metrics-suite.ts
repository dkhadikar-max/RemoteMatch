/**
 * RemoteMatch — Item 1b D-N5: window metrics / gap margin (cadence correction)
 * ==============================================================================
 * windowMetrics() (src/lib/ingestion/catalog-sync-plan.ts) reports, per windowed source, how wide the fetched window is, how old its
 * newest posting is, and `gapMarginHours = windowHours - newestAgeHours - cadence` (negative => postings published between two
 * consecutive runs could fall outside the later run's window). The default cadence is EXPECTED_CADENCE_HOURS: it was 6 (cron every
 * 6h) and is now 3 (Railway `remotematch-sync-cron`: every 3 hours, UTC — a single POST fetches every provider, so one cadence fits all).
 *
 * What this proves (pure functions + static source checks; no env, no network, no database):
 *   1. the constant is 3 and its declaration documents the schedule;
 *   2. positive / zero / negative margins at the default and at explicit cadences; the boundary (margin exactly 0 is NOT a risk);
 *   3. null / missing evidence: no floor => all null; no newest => lag assumed 0 and reported as null; complete / exempt => nulls;
 *   4. the values logged by production for the 2026-10-24 15:00Z cycle (Himalayas: window 5.77h, newest 0.34h => -0.57h at the old
 *      6h cadence, +2.43h at 3h; arbeitnow / jobicy / remotive too) are reproduced from real timestamps;
 *   5. the margin matches an independent statement of the gap condition over a grid (gap  <=>  cadence > window - newestAge);
 *   6. SCOPE: the cadence only feeds reporting. EXPECTED_CADENCE_HOURS / windowMetrics / gapRisk / gapMarginHours are referenced by no
 *      other source file, and inside catalog-sync-plan.ts / catalog-sync-apply.ts only by the reporting code — never by the absence,
 *      expiry, retirement or limiter decisions.
 *
 * Run: npx tsx test/window-metrics-suite.ts
 */
import fs from 'fs';
import path from 'path';
import { windowMetrics, EXPECTED_CADENCE_HOURS } from '../src/lib/ingestion/catalog-sync-plan';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const H = 3_600_000;
const NOW = Date.parse('2026-10-24T15:00:00Z');
const win = (windowH: number, newestH: number | null | undefined, cadence?: number) =>
  windowMetrics({ coverage: 'windowed', floorMs: NOW - windowH * H, newestMs: newestH === null || newestH === undefined ? newestH : NOW - newestH * H } as never, NOW, cadence);
const r2 = (x: number) => Math.round(x * 100) / 100;

console.log('\n1. The constant');
{
  const root = path.join(__dirname, '..');
  const plan = fs.readFileSync(path.join(root, 'src', 'lib', 'ingestion', 'catalog-sync-plan.ts'), 'utf8');
  assert(EXPECTED_CADENCE_HOURS === 3, 'EXPECTED_CADENCE_HOURS is 3');
  assert(/export const EXPECTED_CADENCE_HOURS = 3;/.test(plan), 'the declaration is `export const EXPECTED_CADENCE_HOURS = 3;`');
  const decl = plan.slice(plan.lastIndexOf('/**', plan.indexOf('export const EXPECTED_CADENCE_HOURS')), plan.indexOf('export const EXPECTED_CADENCE_HOURS'));
  assert(/every 3 hours/.test(decl) && /minute 0, UTC/.test(decl) && /remotematch-sync-cron/.test(decl) && /reporting|only feeds/.test(decl), 'its comment names the schedule (remotematch-sync-cron, every 3 hours, minute 0 UTC) and says it only feeds reporting');
  assert(win(10, 2).gapMarginHours === win(10, 2, EXPECTED_CADENCE_HOURS).gapMarginHours && win(10, 2).gapMarginHours === 5, 'the default argument is the constant (10h window, 2h lag => +5h at 3h)');
}

console.log('\n2. Positive / zero / negative margins');
{
  const pos = win(10, 2);
  assert(pos.windowHours === 10 && pos.newestAgeHours === 2 && pos.gapMarginHours === 5 && pos.gapRisk === false, 'positive: 10h window, 2h lag, default 3h cadence => +5h, no risk');
  const zero = win(5, 2);
  assert(zero.gapMarginHours === 0 && zero.gapRisk === false, 'zero: 5h window, 2h lag, 3h cadence => exactly 0 and NOT a risk (the condition is margin < 0)');
  const neg = win(4, 2);
  assert(neg.gapMarginHours === -1 && neg.gapRisk === true, 'negative: 4h window, 2h lag, 3h cadence => -1h, gapRisk');
  const justBelow = win(4.99, 2);
  assert(justBelow.gapMarginHours === -0.01 && justBelow.gapRisk === true, 'just below the boundary (-0.01h) is a risk');
  const justAbove = win(5.01, 2);
  assert(justAbove.gapMarginHours === 0.01 && justAbove.gapRisk === false, 'just above the boundary (+0.01h) is not');
  assert(win(5.9, 3).gapMarginHours === -0.1 && win(5.9, 3).gapRisk === true, 'the lifecycle-suite case: 5.9h window with a 3h lag => -0.1h, gapRisk');
  assert(win(10.68, 3.21).gapMarginHours === 4.47 && win(10.68, 3.21).gapRisk === false, 'the lifecycle-suite case: Cycle-2-shaped 10.68h window / 3.21h lag => +4.47h');
  assert(win(0, 0).gapMarginHours === -3 && win(0, 0).gapRisk === true, 'an empty-width window (floor == now) is -3h');
  const future = windowMetrics({ coverage: 'windowed', floorMs: NOW + 2 * H, newestMs: NOW + 2 * H } as never, NOW);
  assert(future.windowHours === -2 && future.gapRisk === true, 'a floor in the future (clock skew) does not throw and reads as a risk');
}

console.log('\n3. Explicit cadence overrides');
{
  const at3 = win(10, 2, 3), at6 = win(10, 2, 6), at1 = win(10, 2, 1), at0 = win(10, 2, 0);
  assert(at3.gapMarginHours === 5 && at6.gapMarginHours === 2 && at1.gapMarginHours === 7, 'the same window at cadence 3 / 6 / 1 => +5 / +2 / +7');
  assert(at0.gapMarginHours === 8 && at0.gapRisk === false, 'cadence 0 => margin = window - lag');
  assert(win(10, 2, 8.5).gapMarginHours === -0.5 && win(10, 2, 8.5).gapRisk === true, 'a cadence longer than window - lag flips it to a risk (-0.5h)');
  assert(win(7.5, 2, 6).gapMarginHours === -0.5 && win(7.5, 2, 3).gapMarginHours === 2.5, 'the old and new cadence disagree on the same data (7.5h window, 2h lag: risk at 6h, fine at 3h)');
  assert(windowMetrics({ coverage: 'windowed', floorMs: NOW - 10 * H, newestMs: NOW - 2 * H } as never, NOW, undefined).gapMarginHours === 5, 'an explicit `undefined` falls back to the default');
  for (const c of [0.5, 1, 2, 3, 4, 6, 12]) assert(r2(win(10, 2, c).gapMarginHours! - win(10, 2, c + 1).gapMarginHours!) === 1, `margin falls by exactly 1h per extra hour of cadence (${c} -> ${c + 1})`);
}

console.log('\n4. Null / missing evidence');
{
  const noNewest = win(8, null);
  assert(noNewest.newestAgeHours === null && noNewest.gapMarginHours === 5 && noNewest.gapRisk === false, 'newest = null: lag assumed 0, newestAgeHours reported as null (not hidden), margin = 8 - 0 - 3');
  assert(win(8, undefined).newestAgeHours === null && win(8, undefined).gapMarginHours === 5, 'newest = undefined behaves the same');
  assert(win(2, null).gapMarginHours === -1 && win(2, null).gapRisk === true, 'no newest evidence can still be a risk (2h window => -1h)');
  const nulls = (m: ReturnType<typeof windowMetrics>) => m.windowHours === null && m.newestAgeHours === null && m.gapMarginHours === null && m.gapRisk === false;
  assert(nulls(windowMetrics({ coverage: 'windowed', floorMs: null } as never, NOW)) && nulls(windowMetrics({ coverage: 'windowed', floorMs: undefined } as never, NOW)) && nulls(windowMetrics({ coverage: 'windowed' } as never, NOW)), 'windowed with no floor => all null, no risk');
  assert(nulls(windowMetrics({ coverage: 'complete' } as never, NOW)) && nulls(windowMetrics({ coverage: 'exempt' } as never, NOW)), 'complete / exempt => all null, no risk');
  assert(nulls(windowMetrics({ coverage: 'complete', floorMs: NOW - 5 * H, newestMs: NOW - H } as never, NOW)) && nulls(windowMetrics({ coverage: 'exempt', floorMs: NOW - 5 * H } as never, NOW)), 'complete / exempt ignore a floor even if one is supplied');
  assert(nulls(windowMetrics({ coverage: 'windowed', floorMs: null } as never, NOW, 6)), 'an explicit cadence does not turn a no-evidence source into a risk');
  const r = win(5.123456, 2.004999);
  assert(r.windowHours === 5.12 && r.newestAgeHours === 2 && r.gapMarginHours === r2(5.12 - 2 - 3), 'values are rounded to 2 decimals');
}

console.log('\n5. The values production logged for the 2026-10-24 15:00Z cycle (real timestamps, both cadences)');
{
  const asOf = Date.parse('2026-10-24T15:04:01Z');            // = floor + 5.77h: the plan's "now" for that cycle
  const him = (cad?: number) => windowMetrics({ coverage: 'windowed', floorMs: Date.parse('2026-10-24T09:17:49Z'), newestMs: Date.parse('2026-10-24T14:43:35Z') } as never, asOf, cad);
  assert(him().windowHours === 5.77 && him().newestAgeHours === 0.34, 'himalayas from its logged floor 09:17:49Z / newest 14:43:35Z: window 5.77h, newest 0.34h (as logged)');
  assert(him(6).gapMarginHours === -0.57 && him(6).gapRisk === true, 'himalayas at the OLD 6h cadence: -0.57h, gapRisk (as logged)');
  assert(him().gapMarginHours === 2.43 && him().gapRisk === false && him(3).gapMarginHours === 2.43, 'himalayas at the real 3h cadence (new default): +2.43h, no risk');
  const synth = (windowH: number, newestH: number, cad?: number) => windowMetrics({ coverage: 'windowed', floorMs: asOf - windowH * H, newestMs: asOf - newestH * H } as never, asOf, cad);
  assert(synth(36.55, 1.55, 6).gapMarginHours === 29 && synth(36.55, 1.55).gapMarginHours === 32, 'arbeitnow (36.55h / 1.55h): logged +29.0h at 6h, +32.0h at 3h');
  assert(synth(11.31, 4.66, 6).gapMarginHours === 0.65 && synth(11.31, 4.66).gapMarginHours === 3.65, 'jobicy (11.31h / 4.66h): logged +0.65h at 6h, +3.65h at 3h');
  assert(synth(577.81, 44.4, 6).gapMarginHours === 527.41 && synth(577.81, 44.4).gapMarginHours === 530.41, 'remotive (577.81h / 44.4h): logged +527.41h at 6h, +530.41h at 3h');
  // jobicy across the earlier captured cycles (cron was already every 3h): still negative in some even at the true cadence
  const j = [[9.45, 9.2], [10.84, 9.79], [8.58, 4.7], [11.63, 7.74], [8.88, 7.37]].map(([w, n]) => synth(w, n).gapRisk);
  assert(JSON.stringify(j) === JSON.stringify([true, true, false, false, true]), 'jobicy over five earlier captured cycles: still a risk in 3 of 5 at the true 3h cadence (a real signal, not an artefact of the old constant)');
}

console.log('\n6. Independent statement of the gap condition (grid)');
{
  // Two consecutive fetches at T and T+c. Run 1's newest posting is L hours old at T; run 2's window reaches back W hours from T+c.
  // A posting published after run 1's newest and before run 2's floor is never returned: that happens iff c > W - L.
  let n = 0, bad = 0;
  for (let w = 0; w <= 24; w += 0.5) for (let l = 0; l <= 12; l += 0.5) for (const c of [0.5, 1, 3, 6, 12]) {
    const m = win(w, l, c); n++;
    const gap = c > w - l;
    if (m.gapRisk !== gap || m.gapMarginHours !== w - l - c) bad++;
  }
  assert(bad === 0 && n === 49 * 25 * 5, `gapRisk === (cadence > window - lag) and margin === window - lag - cadence on ${n} grid points`);
}

console.log('\n7. Scope: the cadence only feeds reporting');
{
  const root = path.join(__dirname, '..');
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));
  const files = walk(path.join(root, 'src'));
  const TOKENS = /EXPECTED_CADENCE_HOURS|windowMetrics|gapRisk|gapMarginHours/;
  const using = files.filter((f) => TOKENS.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(root, f).replace(/\\/g, '/')).sort();
  assert(JSON.stringify(using) === JSON.stringify(['src/lib/ingestion/catalog-sync-apply.ts', 'src/lib/ingestion/catalog-sync-plan.ts', 'src/lib/ingestion/lifecycle-log.ts']), 'only the plan, the apply report and the log formatter mention the cadence / gap fields', using.join(', '));
  const block = (code: string, from: number): string => { let d = 0, started = false; for (let i = from; i < code.length; i++) { if (code[i] === '{') { d++; started = true; } else if (code[i] === '}') { d--; if (started && d === 0) return code.slice(from, i + 1); } } return ''; };
  const plan = strip(fs.readFileSync(path.join(root, 'src', 'lib', 'ingestion', 'catalog-sync-plan.ts'), 'utf8'));
  const apply = strip(fs.readFileSync(path.join(root, 'src', 'lib', 'ingestion', 'catalog-sync-apply.ts'), 'utf8'));
  const body = (code: string, sig: string) => { const i = code.indexOf(sig); return i < 0 ? '' : block(code, code.indexOf('{', i + sig.length)); };
  for (const fn of ['export function planAbsence(', 'export function planUpserts(', 'export function buildAbsencePlan(']) {
    const b = body(plan, fn);
    if (b === '') continue; // function not present under that name
    assert(!TOKENS.test(b), `${fn.replace('export function ', '').replace('(', '')} (decision code) never reads the cadence or gap fields`);
  }
  const absenceFns = plan.match(/export function (plan[A-Za-z]*)\(/g) ?? [];
  const decisionBodies = absenceFns.map((s) => body(plan, s)).filter(Boolean);
  assert(decisionBodies.length >= 2 && decisionBodies.every((b) => !TOKENS.test(b)), `none of the ${decisionBodies.length} exported plan* functions (incl. planAbsence) reads the cadence or gap fields`);
  const planLines = plan.split('\n').filter((l) => TOKENS.test(l));
  assert(planLines.every((l) => /gapMarginHours|gapRisk|windowMetrics|EXPECTED_CADENCE_HOURS|windowHours/.test(l)) && !/(expireIds|retireIds|incrementByValue|held)/.test(planLines.join('\n')), 'inside catalog-sync-plan.ts the tokens appear only in the WindowMetrics type, windowMetrics() and the report types — not in a decision statement');
  assert(plan.split('EXPECTED_CADENCE_HOURS').length - 1 === 2 && plan.split('windowMetrics').length - 1 === 1, 'in catalog-sync-plan.ts the constant is referenced exactly twice (its declaration and windowMetrics\' default argument) and windowMetrics is defined once — no third reader');
  const baseReport = body(apply, 'function baseReport(');
  const applyOutside = apply.replace(baseReport, '').split('\n').filter((l) => TOKENS.test(l));
  assert(baseReport.length > 100 && /windowMetrics\(cov, Date\.parse\(plan\.nowIso\)\)/.test(baseReport), 'the apply file calls windowMetrics once, in baseReport, with the default cadence (two arguments)');
  assert(applyOutside.every((l) => /^import|^\s*windowMetrics,\s*$|gapRiskSources:/.test(l.trim()) || /gapRisk/.test(l) && /gapRiskSources/.test(l)), 'outside baseReport the apply file only imports windowMetrics and lists gapRiskSources in the report', applyOutside.join(' | ').slice(0, 200));
  assert(!/EXPECTED_CADENCE_HOURS/.test(apply), 'the apply file does not read EXPECTED_CADENCE_HOURS at all');
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

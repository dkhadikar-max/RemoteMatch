/**
 * RemoteMatch — C3 ATS gate: "hybrid needs a remote marker" (policy: hybrid option 2, reading A)
 * ==============================================================================
 * A Greenhouse/Lever/Ashby listing whose LOCATION says "hybrid" is admitted only if the same location string also contains an
 * explicit remote marker ("remote", "remotely", "work from home", "wfh"). The rule lives at the GATE (isGateRejected, and the
 * legacy gate in catalog-sync.ts); the classifiers (remoteType / explicitRemoteScope) are unchanged.
 *
 * What this proves:
 *   1. the policy matrix (kept / rejected / unaffected);
 *   2. GOLDEN REGRESSION: test/fixtures/ats-gate-golden.json holds the decisions of the UNCHANGED gate (origin/main 0280403) for
 *      1,367 real (location, tags) pairs from the 29 registered ATS boards + hostile strings. The new gate may only ADD rejections,
 *      and only for hybrid-without-remote strings (checked against an independent oracle); nothing flips to admitted;
 *   3. exact consistency on every golden entry + 4,000 fuzz strings:  gateRejected  <=>  (scope is 'unknown'  OR  hybrid-without-remote);
 *   4. non-ATS sources are never gated; tags are never read; the flag is optional (absent = old behaviour);
 *   5. planner integration: planUpserts inserts nothing for a hybrid-without-remote ATS job, still plans "Remote, Hybrid, ..." jobs,
 *      and the flag never reaches a planned row or the content fields; the legacy gate applies the same rule (source check).
 *
 * Run: npx tsx test/ats-hybrid-gate-suite.ts     (no env, no network, no DB)
 */
import fs from 'fs';
import path from 'path';
import { normalizeOpportunity, classifyExplicitRemoteScope, isHybridWithoutRemoteMarker } from '../src/lib/ingestion/pipeline';
import { isGateRejected, planUpserts, buildContentFields } from '../src/lib/ingestion/catalog-sync-plan';
import { passesFreshnessGate } from '../src/lib/ingestion/freshness-gate';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ATS = new Set(['greenhouse', 'lever', 'ashby']);
const policy = { atsGated: ATS, passesFreshness: passesFreshnessGate };
const freshIso = () => new Date(Date.now() - 3600e3).toISOString();
const opp = (loc: string, tags: string[] = [], source = 'greenhouse', posted = freshIso()) => normalizeOpportunity({
  sourceId: 'x-1', source, title: 'Role', company: 'Acme', description: 'd'.repeat(400), sourceUrl: 'https://example.com/a', officialUrl: 'https://example.com/a',
  jobType: 'Full-time', locationString: loc, tags, publicationDate: posted,
} as never);
const rejected = (loc: string, tags: string[] = [], source = 'greenhouse') => isGateRejected(opp(loc, tags, source) as never, policy as never);

console.log('='.repeat(78));
console.log('C3 ATS GATE — hybrid needs a remote marker');
console.log('='.repeat(78));

// ---------------------------------------------------------------- 1. matrix
console.log('\n1. Policy matrix (greenhouse, posted 1 h ago)');
const matrix: Array<[string, boolean, string]> = [   // [location, gateRejected, why]
  // KEPT: hybrid + a remote marker
  ['Remote, Hybrid, New York, NY', false, 'Ashby/Lever shape: remote marker present'],
  ['Remote, Hybrid, New York, NY (HQ)', false, 'same, with HQ suffix'],
  ['Hybrid, Remote', false, 'both words'],
  ['Hybrid remote', false, 'both words, space'],
  ['Hybrid - Remote OK', false, 'remote marker'],
  ['Remote-friendly hybrid', false, '"remote-friendly" contains the word remote (literal reading of the policy)'],
  ['Hybrid, Remote-friendly', false, 'same'],
  ['San Francisco, CA, hybrid; Remote, US', false, 'a remote marker anywhere in the string keeps it'],
  ['Hybrid / work from home', false, 'work from home is a remote marker'],
  ['Hybrid - WFH Fridays', false, 'wfh is a remote marker'],
  ['Remotely hybrid', false, '"remotely"'],
  // REJECTED: hybrid and no remote marker
  ['Hybrid', true, 'bare hybrid (342 jobs on the 2026-10-23 snapshot)'],
  ['HYBRID', true, 'case-insensitive'],
  ['hybrid', true, 'lower case'],
  ['Hybrid - New York, NY', true, 'prefix form'],
  ['New York, NY (Hybrid)', true, 'suffix form'],
  ['New York, NY, hybrid', true, 'Lever workplaceType form'],
  ['New York, NY, hybrid, US, New York, NY', true, 'Lever form with country + allLocations'],
  ['San Francisco, CA, hybrid; New York, NY', true, 'multi-office, no remote anywhere'],
  ['Hybrid - London, UK', true, 'rejected even though "uk" alone would have admitted it: a hybrid role is not remote'],
  ['London, United Kingdom, hybrid', true, 'same, spelled out'],
  ['Hybrid - Bangalore, India', true, 'same, India'],
  ['Hybrid - Remote-less', false, '"remote" appears as a word inside "remote-less" -> marker present (literal reading)'],
  ['Hybrid - remotex', true, '"remotex" is not the word remote: no marker'],
  ['Hybrid - unremote', true, '"unremote" is not the word remote: no marker'],
  ['Hybrid - hyperremote', true, '"hyperremote" is not the word remote: no marker'],
  // UNAFFECTED by the new rule (decided by the existing gate)
  ['Remote, US', false, 'no hybrid word; admitted by the US rule'],
  ['Remote — US only', false, 'no hybrid word'],
  ['Remote', true, 'no hybrid word; scope unknown -> rejected by the EXISTING rule (unchanged)'],
  ['New York, NY, onsite', true, 'existing rejection'],
  ['In-Office', true, 'existing rejection'],
  ['hybrid_remote', true, 'underscore: not the word "hybrid"; unknown scope -> existing rejection'],
  ['hybridremote', true, 'not the word hybrid; unknown scope -> existing rejection'],
  ['Hybridge', true, 'not the word hybrid; unknown scope -> existing rejection'],
  ['Híbrido - Madrid', true, 'other languages are not detected by the new rule; unknown scope -> existing rejection'],
  ['Remote-friendly office in Berlin', false, 'no hybrid word; admitted by the existing remote-friendly pattern'],
  ['', true, 'empty -> existing rejection'],
];
for (const [loc, expect, why] of matrix) {
  const got = rejected(loc);
  assert(got === expect, `${JSON.stringify(loc)} -> ${expect ? 'REJECTED' : 'admitted'}   [${why}]`, `got ${got ? 'rejected' : 'admitted'}`);
}
assert(rejected('Hybrid', ['Remote']) === true, "tags are never read: ('Hybrid', tags ['Remote']) is still rejected");
assert(rejected('Remote, Hybrid, NYC', ['Hybrid']) === false, "tags are never read: a 'Hybrid' tag does not reject a remote-marked location");
assert(rejected('Hybrid - New York, NY', ['Engineering']) === true, 'department tags do not rescue a hybrid location');
for (const src of ['lever', 'ashby']) assert(rejected('Hybrid - Chicago', [], src) === true && rejected('Remote, Hybrid, Chicago', [], src) === false, `the rule applies to ${src} as well`);
for (const src of ['himalayas', 'weworkremotely', 'jobicy', 'remotive', 'arbeitnow', 'curated', 'remoteok']) assert(rejected('Hybrid', [], src) === false && rejected('Hybrid - Chicago', [], src) === false, `non-ATS source ${src} is never gated by this rule`);

// ---------------------------------------------------------------- 2. golden regression against the UNCHANGED gate
console.log('\n2. Golden regression against the unchanged gate');
type Golden = { recordedFrom: string; entries: Array<[string, string[], boolean]>; nonAts: Array<[string, string, boolean]> };
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ats-gate-golden.json'), 'utf8')) as Golden;
console.log(`  fixture: ${golden.recordedFrom}; entries: ${golden.entries.length}`);
assert(golden.entries.length >= 1300, 'the golden fixture is the full recorded corpus');
// independent oracle: manual word scan, no shared regex
const isW = (ch: string | undefined) => !!ch && /[a-z0-9_]/.test(ch);
const hasWord = (s: string, w: string) => { for (let i = s.indexOf(w); i >= 0; i = s.indexOf(w, i + 1)) { if (!isW(s[i - 1]) && !isW(s[i + w.length])) return true; } return false; };
const oracleHybridNoRemote = (loc: string) => { const s = (loc || '').toLowerCase(); return hasWord(s, 'hybrid') && !['remote', 'remotely', 'work from home', 'work-from-home', 'wfh'].some((w) => hasWord(s, w)); };
let identical = 0; const newlyRejected: Array<[string, string[]]> = []; const unexpected: string[] = []; let flippedToAdmitted = 0;
for (const [loc, tags, was] of golden.entries) {
  const now = rejected(loc, tags);
  if (now === was) { identical++; continue; }
  if (was && !now) { flippedToAdmitted++; unexpected.push(`FLIPPED TO ADMITTED ${JSON.stringify(loc)}`); continue; }
  if (!was && now && oracleHybridNoRemote(loc)) newlyRejected.push([loc, tags]); else unexpected.push(`${JSON.stringify(loc)} ${JSON.stringify(tags)}: was ${was} now ${now}`);
}
assert(unexpected.length === 0, `every golden decision is identical except the intended newly-rejected set (${unexpected.length} unexpected)`, unexpected.slice(0, 4).join(' | '));
assert(flippedToAdmitted === 0, 'the gate is monotone: nothing rejected before is admitted now');
console.log(`  identical: ${identical}; newly rejected (hybrid, no remote marker): ${newlyRejected.length}`);
assert(newlyRejected.length === 148 && identical === 1219, 'the rule changes EXACTLY 148 of the 735 previously-admitted golden pairs and leaves the other 1,219 identical (pinned: catches any widening or narrowing)', `changed ${newlyRejected.length}, identical ${identical}`);
assert(golden.entries.filter(([, , was]) => !was).length === 735 && golden.entries.filter(([, , was]) => was).length === 632, 'the golden holds 735 admitted + 632 rejected pairs (the no-regression guarantee is not vacuous)');
assert(golden.entries.filter(([, , was]) => was).every(([loc, tags]) => rejected(loc, tags)), 'every string the old gate rejected is still rejected');
assert(golden.entries.filter(([loc]) => !oracleHybridNoRemote(loc)).every(([loc, tags, was]) => rejected(loc, tags) === was), 'every string WITHOUT "hybrid-and-no-remote" has exactly its old decision');
assert(golden.nonAts.length >= 20 && golden.nonAts.every(([s, loc, was]) => rejected(loc, [], s) === was && was === false), 'non-ATS decisions are all "admitted", as before');
console.log('  newly rejected strings (distinct, most frequent first):');
const cnt = new Map<string, number>(); for (const [l] of newlyRejected) cnt.set(l, (cnt.get(l) ?? 0) + 1);
for (const [l, n] of Array.from(cnt.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`    ${n}x ${JSON.stringify(l)}`);

// ---------------------------------------------------------------- 3. exact consistency with the two-part definition
console.log('\n3. gateRejected <=> (scope unknown OR hybrid-without-remote), on golden + fuzz');
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(424242);
const pool = ['Remote', 'remote', 'REMOTE', 'Remotely', 'WFH', 'Work from home', 'work-from-home', 'Hybrid', 'hybrid', 'HYBRID', 'hybrid_remote', 'Hybridge', 'US', 'U.S.', 'US-Remote', 'Remote (US)', 'United States', 'USA', 'Europe', 'UK', 'United Kingdom', 'Canada', 'India',
  'Worldwide', 'Anywhere', 'onsite', 'on-site', 'In-Office', 'office-friendly', 'Flexible location', 'Remote-friendly', 'PST', 'Westlake', 'New York, NY', 'London', 'San Francisco, CA', 'Berlin', 'ünï', '日本語', 'Híbrido', ';', ',', ' - ', '|', '•', '(', ')', ' ', '', '\n', '\t', '.*', '[', '\\'];
const randomString = () => Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => pool[Math.floor(rnd() * pool.length)]).join(rnd() < 0.5 ? ' ' : rnd() < 0.5 ? ', ' : '');
let badDef = 0; const badEx: string[] = [];
const checkDef = (loc: string, tags: string[]) => { const want = classifyExplicitRemoteScope(loc, tags) === 'unknown' || oracleHybridNoRemote(loc); const got = rejected(loc, tags); if (want !== got) { badDef++; if (badEx.length < 4) badEx.push(JSON.stringify(loc)); } };
for (const [loc, tags] of golden.entries) checkDef(loc, tags);
for (let i = 0; i < 4000; i++) checkDef(randomString(), rnd() < 0.3 ? [pool[Math.floor(rnd() * pool.length)]] : []);
assert(badDef === 0, `gate decision equals "scope unknown OR hybrid-without-remote (independent oracle)" on all ${golden.entries.length + 4000} inputs`, badEx.join(' | '));
let helperBad = 0; for (let i = 0; i < 4000; i++) { const s = randomString(); if (isHybridWithoutRemoteMarker(s) !== oracleHybridNoRemote(s)) helperBad++; }
assert(helperBad === 0, 'the helper agrees with the independent word-scan oracle on 4,000 random strings');

// ---------------------------------------------------------------- 4. metamorphic
console.log('\n4. Metamorphic checks over every newly rejected string');
let mBad = 0, mN = 0; const mEx: string[] = [];
const must = (cond: boolean, msg: string) => { mN++; if (!cond) { mBad++; if (mEx.length < 4) mEx.push(msg); } };
for (const [loc, tags] of newlyRejected) {
  must(rejected(loc, tags) === true, 'is rejected: ' + loc);
  must(rejected(`${loc}, Remote`, tags) === rejected(`${loc}, Remote`, tags) && rejected(`${loc}, Remote`, tags) === false, 'appending ", Remote" admits it (marker present): ' + loc);
  must(rejected(`Remote; ${loc}`, tags) === false, 'prefixing "Remote; " admits it: ' + loc);
  must(isHybridWithoutRemoteMarker(loc.replace(/hybrid/gi, 'xxxxxx')) === false, 'removing the word hybrid clears the flag: ' + loc);
}
assert(mBad === 0, `all ${mN} metamorphic checks hold for the ${newlyRejected.length} newly rejected strings`, mEx.join(' | '));

// ---------------------------------------------------------------- 5. integration with the planner + back-compat + legacy gate
console.log('\n5. planUpserts integration, optional flag, legacy gate');
const upsertPolicy = { now: new Date().toISOString(), atsGated: ATS, passesFreshness: passesFreshnessGate, isWeakDescription: (d: string) => (d || '').trim().length < 100, skipsVerification: (s: string) => s === 'curated' };
const mk = (loc: string, id: string) => { const o = opp(loc); return { ...(o as object), sourceId: id } as ReturnType<typeof normalizeOpportunity>; };
const plan = planUpserts([mk('Hybrid - Chicago', 'a'), mk('Remote, Hybrid, Chicago', 'b'), mk('Remote, US', 'c'), mk('Hybrid', 'd'), mk('New York, NY (Hybrid)', 'e')], new Map(), new Map(), upsertPolicy as never);
assert(plan.gateSkipped === 3 && plan.inserts.length === 2, 'planUpserts: 3 hybrid-without-remote jobs gate-skipped, 2 planned for insert', `skipped ${plan.gateSkipped}, inserts ${plan.inserts.length}`);
assert(plan.inserts.map((i) => i.sourceId).sort().join() === 'b,c', 'the planned inserts are exactly the remote-marked hybrid job and the plain US-remote job');
assert(plan.inserts.every((i) => !('hybridWithoutRemoteMarker' in i.row) && !JSON.stringify(i.row).includes('hybridWithoutRemoteMarker')), 'the flag never reaches a planned insert row');
assert(!('hybridWithoutRemoteMarker' in buildContentFields(opp('Remote, Hybrid, X') as never)), 'the flag is not part of the content fields');
const o1 = opp('Hybrid - Chicago') as unknown as Record<string, unknown>; delete o1.hybridWithoutRemoteMarker;
assert(isGateRejected(o1 as never, policy as never) === false, 'a candidate WITHOUT the flag (undefined) behaves as before — backwards compatible');
assert(isGateRejected({ ...o1, hybridWithoutRemoteMarker: true } as never, policy as never) === true && isGateRejected({ ...o1, hybridWithoutRemoteMarker: false } as never, policy as never) === false, 'isGateRejected honours the flag exactly');
assert(isGateRejected({ ...o1, source: 'himalayas', hybridWithoutRemoteMarker: true } as never, policy as never) === false, 'the flag is ignored for non-ATS sources');
assert(isGateRejected({ ...(opp('Hybrid - Chicago') as object), postedAt: new Date(Date.now() - 72 * 3600e3).toISOString() } as never, policy as never) === true, 'staleness still rejects (existing rule unchanged)');
const legacySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ingestion', 'catalog-sync.ts'), 'utf8').replace(/\r\n/g, '\n');
// the exact ATS `if { ... }` block, by BRACE MATCHING (a slice up to the next statement would also contain code placed after the closing brace)
const atsStart = legacySrc.indexOf('if (ATS_SOURCES_WITH_FRESHNESS_GATE.has(opp.source)) {');
const atsOpen = legacySrc.indexOf('{', atsStart);
let depth = 0, atsEnd = atsOpen;
for (let i = atsOpen; i < legacySrc.length; i++) { if (legacySrc[i] === '{') depth++; else if (legacySrc[i] === '}') { depth--; if (depth === 0) { atsEnd = i; break; } } }
const atsBranch = legacySrc.slice(atsOpen, atsEnd + 1);
assert(atsStart > 0 && atsBranch.length > 50 && atsBranch.length < 2000, 'located the legacy ATS gate block by brace matching');
assert(/passesFreshnessGate\(opp\.postedAt\)/.test(atsBranch) && /explicitRemoteScope === 'unknown'/.test(atsBranch) && /hybridWithoutRemoteMarker === true/.test(atsBranch), 'the LEGACY gate (catalog-sync.ts) applies the same three conditions inside the ATS block');
assert((legacySrc.match(/hybridWithoutRemoteMarker/g) || []).length === 1, 'the flag appears exactly once in catalog-sync.ts — inside the ATS block, never applied to other sources');
assert(/if \(opp\.hybridWithoutRemoteMarker === true\) \{\s*continue;\s*\}/.test(atsBranch), 'the legacy hybrid check is a plain `continue` (reject) on a truthy flag, not its negation');
const planSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ingestion', 'catalog-sync-plan.ts'), 'utf8').replace(/\r\n/g, '\n');
assert(/opp\.hybridWithoutRemoteMarker === true/.test(planSrc.slice(planSrc.indexOf('export function isGateRejected'), planSrc.indexOf('export function planUpserts'))), 'the PLANNER gate (isGateRejected) applies the rule');
const pipeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ingestion', 'pipeline.ts'), 'utf8').replace(/\r\n/g, '\n');
assert(/hybridWithoutRemoteMarker: isHybridWithoutRemoteMarker\(raw\.locationString\)/.test(pipeSrc), 'normalizeOpportunity computes the flag from the raw LOCATION only (never tags)');

// ---------------------------------------------------------------- 6. robustness
console.log('\n6. Robustness');
let threw = 0, nondet = 0;
for (let i = 0; i < 4000; i++) { const s = randomString(); try { if (isHybridWithoutRemoteMarker(s) !== isHybridWithoutRemoteMarker(s)) nondet++; rejected(s); } catch { threw++; } }
assert(threw === 0 && nondet === 0, 'never throws and is deterministic on 4,000 random/hostile strings');
assert((() => { try { return isHybridWithoutRemoteMarker('a'.repeat(200000)) === false && isHybridWithoutRemoteMarker('hybrid '.repeat(40000)) === true && isHybridWithoutRemoteMarker('hybrid '.repeat(40000) + 'remote') === false; } catch { return false; } })(), 'very long inputs (200k+ chars) are handled correctly');
assert((() => { const t0 = Date.now(); isHybridWithoutRemoteMarker('hybrid'.repeat(50000)); isHybridWithoutRemoteMarker(('hybrid ' + 'x'.repeat(40)).repeat(5000)); return Date.now() - t0 < 2000; })(), 'no catastrophic regex backtracking (< 2 s)');
assert(isHybridWithoutRemoteMarker(undefined) === false && isHybridWithoutRemoteMarker('') === false && isHybridWithoutRemoteMarker('   ') === false, 'undefined / empty / whitespace -> false');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

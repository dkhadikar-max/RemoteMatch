/**
 * RemoteMatch — US-remote classifier rule: regression + safety suite
 * ==============================================================================
 * The rule (src/lib/ingestion/pipeline.ts, both classifiers): a REMOTE listing that names the US ("Remote U.S.",
 * "US-Remote", "Remote (US)", "Remote, US") and nothing else is `explicit_restricted` / `US` instead of falling through
 * to `unknown` / `Worldwide`. It is additive: it is reached only when no earlier pattern matched.
 *
 * What this proves:
 *   1. the requested matrix (US variants admitted; UK/Australia/Singapore/Canada, multi-country, onsite, bare-country,
 *      city+remote, bare "Remote" all unchanged);
 *   2. GOLDEN REGRESSION: test/fixtures/classifier-us-golden.json holds the outputs of the UNCHANGED classifiers (origin/main
 *      e128f3f) for 1,349 real (location, tags) pairs from all 29 registered ATS boards + hostile strings. Every entry must be
 *      identical now, except the explicit, independently-checked set the rule is meant to change;
 *   3. tags are never read by the new rule; 4. metamorphic safety (removing the remote marker, adding an onsite marker, or
 *      adding another country turns every newly admitted string back to `unknown`); 5. scope/eligibility parity (the two
 *      duplicated implementations agree on every golden entry and 4,000 fuzz strings); 6. determinism / no throw.
 *
 * Run: npx tsx test/classifier-us-remote-suite.ts    (no env, no network, no DB)
 */
import fs from 'fs';
import path from 'path';
import { classifyExplicitRemoteScope as scope, classifyRemoteEligibility as elig } from '../src/lib/ingestion/pipeline';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const out = (loc: string, tags: string[] = []) => { const e = elig(loc, tags); return { scope: scope(loc, tags), type: e.remoteType, countries: e.eligibleCountries }; };

console.log('='.repeat(78));
console.log('US-REMOTE CLASSIFIER RULE — regression + safety');
console.log('='.repeat(78));

// ---------------------------------------------------------------- 1. matrix
console.log('\n1. Requested matrix');
type Row = [string, string, string, string[]];                     // location, scope, remoteType, eligibleCountries
const matrix: Row[] = [
  // NEW: US variants
  ['Remote, Remote, Remote U.S.', 'explicit_restricted', 'US', ['US', 'USA']],
  ['US-Remote', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote (US)', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote, Remote, Remote (US)', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote, US', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote US', 'explicit_restricted', 'US', ['US', 'USA']],
  ['US Remote', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote (U.S.)', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote in the US', 'explicit_restricted', 'US', ['US', 'USA']],
  ['US - Remote', 'explicit_restricted', 'US', ['US', 'USA']],
  ['San Francisco, CA, US; Remote, US', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Chicago, US-Remote', 'explicit_restricted', 'US', ['US', 'USA']],
  ['remote u.s.a.', 'explicit_restricted', 'US', ['US', 'USA']],
  ['REMOTE, US', 'explicit_restricted', 'US', ['US', 'USA']],
  // UNCHANGED: already recognised before
  ['Remote — US only', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote, Remote, United States', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote, Remote, North America', 'explicit_restricted', 'US', ['US', 'USA']],
  ['Remote, Remote, Europe', 'explicit_restricted', 'EU/EEA', ['EU', 'UK', 'EEA']],
  ['Remote in Europe', 'explicit_restricted', 'EU/EEA', ['EU', 'UK', 'EEA']],
  ['Remote, UK', 'explicit_restricted', 'EU/EEA', ['EU', 'UK', 'EEA']],
  ['Remote, Hybrid, London, UK', 'explicit_restricted', 'EU/EEA', ['EU', 'UK', 'EEA']],
  ['Remote-friendly office in Berlin', 'explicit_restricted', 'Specific countries', []],
  ['Remote, India', 'explicit_restricted', 'India', ['India']],
  ['100% remote worldwide', 'explicit_worldwide', 'Worldwide', []],
  ['Remote, Worldwide', 'explicit_worldwide', 'Worldwide', []],
  ['Hybrid', 'explicit_restricted', 'Specific countries', []],
  ['Remote, UTC-8 (PST)', 'explicit_restricted', 'Timezone restricted', []],
  // UNCHANGED: deliberately NOT admitted (this PR is US-only)
  ['Remote, Remote, United Kingdom', 'unknown', 'Worldwide', []],
  ['Remote, United Kingdom', 'unknown', 'Worldwide', []],
  ['Remote, Remote, Australia', 'unknown', 'Worldwide', []],
  ['Remote, Remote, Singapore', 'unknown', 'Worldwide', []],
  ['Remote, Canada', 'unknown', 'Worldwide', []],
  ['Remote - Canada', 'unknown', 'Worldwide', []],
  ['Remote, Brazil', 'unknown', 'Worldwide', []],
  // UNCHANGED: multi-country / ambiguous
  ['Remote, Canada; Remote, US', 'unknown', 'Worldwide', []],
  ['Remote in the US, Remote in Canada', 'unknown', 'Worldwide', []],
  ['Chicago, US-Remote, Canada-Remote', 'unknown', 'Worldwide', []],
  ['US Remote; Chicago, Atlanta, Canada', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, United Kingdom', 'unknown', 'Worldwide', []],
  ['Remote, Canada; Remote, United Kingdom; Remote, United States', 'explicit_restricted', 'US', ['US', 'USA']], // already US via "united states" before this PR
  // UNCHANGED: onsite / no remote marker / ambiguous
  ['New York, NY, onsite', 'unknown', 'Worldwide', []],
  ['Remote, US, onsite', 'unknown', 'Worldwide', []],
  ['US Remote; Austin, TX (in-office)', 'explicit_restricted', 'US', ['US', 'USA']],   // remote segment is clean; the office is a separate segment
  ['In-Office', 'unknown', 'Worldwide', []],
  ['US', 'unknown', 'Worldwide', []],
  ['U.S.', 'unknown', 'Worldwide', []],
  ['United Kingdom', 'unknown', 'Worldwide', []],
  ['Remote', 'unknown', 'Worldwide', []],
  ['Distributed', 'unknown', 'Worldwide', []],
  ['New York, NY, remote', 'unknown', 'Worldwide', []],
  ['London, remote', 'unknown', 'Worldwide', []],
  ['', 'unknown', 'Worldwide', []],
  ['   ', 'unknown', 'Worldwide', []],
];
// the "(in-office)" row above documents a case worth being explicit about: the onsite marker is in a DIFFERENT segment
for (const [loc, s, t, c] of matrix) {
  const o = out(loc);
  assert(o.scope === s && o.type === t && JSON.stringify(o.countries) === JSON.stringify(c), `${JSON.stringify(loc)} -> ${s} / ${t}`, `got ${o.scope} / ${o.type} ${JSON.stringify(o.countries)}`);
}

// ---------------------------------------------------------------- 2. golden regression
console.log('\n2. Golden regression against the UNCHANGED classifiers (1,349 real + hostile pairs)');
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'classifier-us-golden.json'), 'utf8')) as { recordedFrom: string; entries: Array<[string, string[], string, string, string[]]> };
console.log(`  fixture: ${golden.recordedFrom}; entries: ${golden.entries.length}`);
assert(golden.entries.length >= 1300, 'the golden fixture is the full recorded corpus');
// independent oracle for "should the rule have changed this?" — deliberately NOT the production code
const hasRemote = (l: string) => /\b(remote|remotely|work[- ]from[- ]home|wfh)\b/i.test(l);
const hasUs = (l: string) => /\bu\.s\.(a\.)?|\bus\b/i.test(l);
const hasOther = (l: string) => /\b(united kingdom|england|scotland|wales|northern ireland|great britain|canada|mexico|brazil|australia|new zealand|singapore|india|japan|china|korea|israel|germany|france|spain|italy|poland|ireland|netherlands|sweden|apac|latam|asia|africa|worldwide|global|anywhere)\b/i.test(l);
let identical = 0; const changed: Array<[string, string[]]> = []; const unexpected: string[] = [];
for (const [loc, tags, gScope, gType, gCountries] of golden.entries) {
  const o = out(loc, tags);
  const same = o.scope === gScope && o.type === gType && JSON.stringify(o.countries) === JSON.stringify(gCountries);
  if (same) { identical++; continue; }
  const intended = gScope === 'unknown' && gType === 'Worldwide' && o.scope === 'explicit_restricted' && o.type === 'US' && JSON.stringify(o.countries) === JSON.stringify(['US', 'USA'])
    && hasRemote(loc) && hasUs(loc) && !hasOther(loc) && !/\b(on-?site|in[- ]office|office[- ]based)\b/i.test(loc.split(/[;|•]/).filter((s) => hasRemote(s) && hasUs(s)).join(' '));
  if (intended) changed.push([loc, tags]); else unexpected.push(`${JSON.stringify(loc)} ${JSON.stringify(tags)}: ${gScope}/${gType} -> ${o.scope}/${o.type}`);
}
assert(unexpected.length === 0, `REGRESSION: every golden entry is identical except the intended set (${unexpected.length} unexpected)`, unexpected.slice(0, 5).join(' | '));
assert(golden.entries.every(([loc, tags, gScope, gType, gCountries]) => gScope === 'unknown' || (() => { const o = out(loc, tags); return o.scope === gScope && o.type === gType && JSON.stringify(o.countries) === JSON.stringify(gCountries); })()), 'no previously-recognised entry changed (scope, remoteType or eligibleCountries)');
assert(golden.entries.filter(([, , gScope]) => gScope !== 'unknown').length === 600, 'the golden contains 600 previously-recognised entries (598 restricted + 2 worldwide): the no-regression guarantee is not vacuous');
console.log(`  identical: ${identical}; intentionally changed: ${changed.length}`);
assert(changed.length === 119 && identical === 1230, `the rule changes EXACTLY 119 of the 749 previously-unknown entries and leaves the other 1,230 identical (pinned: catches any widening or narrowing)`, `changed ${changed.length}, identical ${identical}`);
assert(changed.every(([loc]) => hasRemote(loc) && hasUs(loc)), 'every changed entry has a remote marker and a US token');
assert(changed.every(([loc]) => !hasOther(loc)), 'no changed entry names another country');
assert(golden.entries.filter(([loc]) => /on-?site|in[- ]office/i.test(loc) && !hasRemote(loc)).every(([loc, tags, s, t]) => { const o = out(loc, tags); return o.scope === s && o.type === t; }), 'onsite-only entries are untouched');
console.log('  changed strings:'); for (const [loc, tags] of changed.slice(0, 200)) console.log('    ' + JSON.stringify(loc) + (tags.length ? ' tags=' + JSON.stringify(tags) : ''));

// ---------------------------------------------------------------- 3. tags are never read by the new rule
console.log('\n3. Tags are not read by the new rule');
assert(out('Remote', ['US']).scope === 'unknown', "('Remote', tags ['US']) stays unknown");
assert(out('', ['Remote US']).scope === 'unknown', "('', tags ['Remote US']) stays unknown");
assert(out('Remote', ['Sales', 'US-Remote']).type === 'Worldwide', "tag 'US-Remote' does not make a US job");
assert(out('Remote, US', ['Canada']).type === 'US', 'a country-looking tag does not veto the location (tags are ignored entirely)');

// ---------------------------------------------------------------- 4. metamorphic safety over every changed string
console.log('\n4. Metamorphic safety over every newly admitted string');
let bad = 0, n = 0;
const must = (loc: string, tags: string[], label: string) => { n++; const o = out(loc, tags); if (!(o.scope === 'unknown' && o.type === 'Worldwide')) { bad++; if (bad <= 5) console.error(`    ✗ ${label}: ${JSON.stringify(loc)} -> ${o.scope}/${o.type}`); } };
// (the onsite-append check applies to single-segment strings only: a separate onsite segment legitimately leaves a clean remote one)
for (const [loc, tags] of changed) {
  must(loc.replace(/remote(ly)?/gi, 'xxxx').replace(/work[- ]from[- ]home|wfh/gi, 'xxxx'), tags, 'remote marker removed');
  if (!/[;|•]/.test(loc)) must(`${loc}, onsite`, tags, 'onsite appended');
  must(`${loc}; Remote, Canada`, tags, 'another country appended');
  must(`${loc}, United Kingdom`, tags, 'UK name appended');
  must(`${loc}, Australia`, tags, 'Australia appended');
}
assert(bad === 0, `all ${n} metamorphic variants of the ${changed.length} newly admitted strings fall back to unknown / Worldwide`, `${bad} violated`);

// ---------------------------------------------------------------- 5. parity (two duplicated implementations agree)
console.log('\n5. Scope / eligibility parity (duplicated implementations)');
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261023);
const pool = ['Remote', 'remote', 'REMOTE', 'Remote,', 'US', 'U.S.', 'U.S.A.', 'us', 'US-Remote', 'Remote (US)', 'United States', 'USA', 'North America', 'Europe', 'UK', 'United Kingdom', 'Canada', 'Australia', 'Singapore',
  'India', 'Germany', 'Poland', 'Worldwide', 'Anywhere', 'Hybrid', 'onsite', 'on-site', 'In-Office', 'office-based', 'WFH', 'work from home', 'PST', 'CET', 'EST', 'Westlake', 'Bucharest', 'timezone', 'contractor only',
  ';', ',', ' - ', '|', '•', '(', ')', 'New York, NY', 'London', 'San Francisco, CA', 'ünï', '日本語', '', ' ', '\n', '\t', '.*', '[', '\\'];
const randomString = () => Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => pool[Math.floor(rnd() * pool.length)]).join(rnd() < 0.5 ? ' ' : '');
const parity = (loc: string, tags: string[]) => {
  const o = out(loc, tags);
  const lhs = o.scope === 'unknown';
  const rhs = o.type === 'Worldwide' && o.scope !== 'explicit_worldwide';
  return lhs === rhs && (o.scope !== 'explicit_restricted' || o.type !== 'Worldwide');
};
let parityBad = 0; const parityBadEx: string[] = [];
for (const [loc, tags] of golden.entries) if (!parity(loc, tags)) { parityBad++; parityBadEx.push(JSON.stringify(loc)); }
for (let i = 0; i < 4000; i++) { const s = randomString(); const tags = rnd() < 0.3 ? [pool[Math.floor(rnd() * pool.length)]] : []; if (!parity(s, tags)) { parityBad++; if (parityBadEx.length < 5) parityBadEx.push(JSON.stringify(s)); } }
assert(parityBad === 0, 'scope=unknown <=> eligibility defaulted to Worldwide, on every golden entry and 4,000 fuzz strings', parityBadEx.slice(0, 5).join(' | '));
assert(matrix.every(([loc, s, t]) => (s === 'unknown') === (t === 'Worldwide' && s !== 'explicit_worldwide')), 'the matrix itself satisfies the parity relation');

// ---------------------------------------------------------------- 6. determinism / robustness
console.log('\n6. Determinism and robustness');
let threw = 0, nondet = 0;
for (let i = 0; i < 4000; i++) {
  const s = randomString();
  try { const a = JSON.stringify(out(s)); const b = JSON.stringify(out(s)); if (a !== b) nondet++; } catch { threw++; }
}
assert(threw === 0, 'never throws on 4,000 random/hostile strings');
assert(nondet === 0, 'deterministic on 4,000 random strings');
assert((() => { try { return out('a'.repeat(200000)).scope === 'unknown' && out('remote '.repeat(40000)).scope === 'unknown'; } catch { return false; } })(), 'very long inputs (200k chars) are handled without error and stay unknown');
assert((() => { const t0 = Date.now(); out('remote us '.repeat(20000)); out(('Remote, ' + 'x'.repeat(50) + '; ').repeat(5000) + 'US'); return Date.now() - t0 < 2000; })(), 'no catastrophic regex backtracking on adversarial inputs (< 2 s)');
assert(scope(undefined) === 'unknown' && elig(undefined).remoteType === 'Worldwide', 'undefined location is unknown / Worldwide');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

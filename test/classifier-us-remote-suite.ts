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
  // UNCHANGED: names that are BOTH a country and a US place veto on purpose (a false reject keeps the old behaviour)
  ['US-SF, US-Seattle, US-NYC, US-Chicago, US-Georgia or US-Remote', 'unknown', 'Worldwide', []],
  ['Remote, US; Atlanta, Georgia', 'unknown', 'Worldwide', []],
  ['Remote, US; Amman, Jordan', 'unknown', 'Worldwide', []],
  // UNCHANGED: countries the previous (77-name) list did not know — now covered
  ['Remote, US; Remote, Jamaica', 'unknown', 'Worldwide', []],
  ['US-Remote, Iceland', 'unknown', 'Worldwide', []],
  ['Remote U.S. or Morocco', 'unknown', 'Worldwide', []],
  ['Qatar; Remote, US', 'unknown', 'Worldwide', []],
  // UNCHANGED: accented / decomposed / non-English country names must veto too (a bypass found in review)
  ['Remote, US; Remote, Côte d’Ivoire', 'unknown', 'Worldwide', []],
  ["Remote, US; Remote, Côte d'Ivoire", 'unknown', 'Worldwide', []],
  ["Remote, US; Remote, Cote d'Ivoire", 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Co\u0302te d’Ivoire', 'unknown', 'Worldwide', []],      // decomposed o + combining circumflex
  ['Remote, US; Remote, São Tomé and Príncipe', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Sao Tome and Principe', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Sa\u0303o Tome\u0301 and Pri\u0301ncipe', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, México', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Me\u0301xico', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Perú', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Panamá', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Brasil', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, España', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Deutschland', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Österreich', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Suisse', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Nederland', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Curaçao', 'unknown', 'Worldwide', []],
  ['Remote, US; Remote, Türkiye', 'unknown', 'Worldwide', []],
  ['Rémote, US', 'unknown', 'Worldwide', []],                                          // the remote MARKER is not accent-folded: stays rejected (conservative)
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
// 118, not 119: with the full country list "Georgia" (a US state AND a country) vetoes, so "...US-Georgia or US-Remote" stays
// rejected. Deliberate: ambiguous names veto, because a false reject is the old behaviour while a false admit mistypes a job.
assert(changed.length === 118 && identical === 1231, `the rule changes EXACTLY 118 of the 749 previously-unknown entries and leaves the other 1,231 identical (pinned: catches any widening or narrowing)`, `changed ${changed.length}, identical ${identical}`);
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

// ---------------------------------------------------------------- 7. the other-country veto list is complete and consistent
console.log('\n7. Other-country veto: every sovereign country vetoes; the two copies are identical');
// A test-owned, independent list (UN members + observers + common aliases). The production list must cover ALL of it.
const COUNTRIES = ['Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus',
  'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Cape Verde', 'Central African Republic',
  'Chad', 'Chile', 'China', 'Colombia', 'Comoros', 'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Djibouti', 'Dominica', 'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador',
  'Equatorial Guinea', 'Eritrea', 'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guyana', 'Haiti',
  'Honduras', 'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait',
  'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands',
  'Mauritania', 'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua',
  'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau', 'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Qatar',
  'Romania', 'Russia', 'Rwanda', 'Saint Kitts', 'Saint Lucia', 'Saint Vincent', 'Samoa', 'San Marino', 'Sao Tome', 'Saudi Arabia', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia',
  'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania',
  'Thailand', 'Timor', 'Togo', 'Tonga', 'Trinidad', 'Tunisia', 'Turkey', 'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican',
  'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe', 'Hong Kong', 'Burma', 'Holland', 'Britain', 'Türkiye', 'England', 'Scotland', 'Wales', 'Northern Ireland'];
const REGIONS = ['Latin America', 'Southeast Asia', 'South Asia', 'Middle East', 'Caribbean', 'Nordics', 'Scandinavia', 'Balkans', 'DACH', 'Benelux', 'APAC', 'LATAM', 'MENA', 'EU', 'EEA', 'Asia', 'Africa', 'Oceania', 'Americas'];
assert(COUNTRIES.length >= 200, `the independent country list has ${COUNTRIES.length} names`);
const shapes = (c: string) => [`Remote, US; Remote, ${c}`, `US-Remote, ${c}`, `${c}; Remote, US`, `Remote U.S. ${c}`, `Remote (US), ${c}`];
const leaked: string[] = [];
for (const c of [...COUNTRIES, ...REGIONS]) for (const s of shapes(c)) if (out(s).type === 'US') leaked.push(s);
assert(leaked.length === 0, `no "US + <other country/region>" string is typed US (${(COUNTRIES.length + REGIONS.length) * 5} strings over ${COUNTRIES.length} countries and ${REGIONS.length} regions)`, leaked.slice(0, 6).join(' | '));
// the production source: both lists present, byte-identical, and each covers every name above
const pipeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'ingestion', 'pipeline.ts'), 'utf8').replace(/\r\n/g, '\n');
const lit = (n: string) => { const m = new RegExp('const ' + n + '\\s*=\\n\\s*(/[^\\n]+/);').exec(pipeSrc); return m ? m[1] : null; };
const litE = lit('ELIGIBILITY_OTHER_COUNTRY_OR_REGION'), litS = lit('SCOPE_OTHER_COUNTRY_OR_REGION');
assert(!!litE && !!litS, 'both veto lists are present in pipeline.ts');
assert(litE === litS, 'the two veto lists are byte-identical (the duplicated rule cannot drift)');
const vetoRe = new RegExp((litE as string).slice(1, (litE as string).lastIndexOf('/')));
const uncovered = [...COUNTRIES, ...REGIONS].filter((c) => !vetoRe.test(c.toLowerCase()));
assert(uncovered.length === 0, 'the production veto list covers every name in the independent list', uncovered.join(', '));
// the two helpers share one body (modulo names)
const bodyOf = (n: string) => { const i = pipeSrc.indexOf('function ' + n + '('); const j = pipeSrc.indexOf('\n}\n', i); return pipeSrc.slice(i, j + 3).replace(/isUsRemoteFor(Eligibility|Scope)/g, 'F').replace(/(ELIGIBILITY|SCOPE)_OTHER/g, 'X_OTHER'); };
assert(bodyOf('isUsRemoteForEligibility') === bodyOf('isUsRemoteForScope') && bodyOf('isUsRemoteForScope').length > 200, 'the two helper functions are identical apart from their names');
// ---- accents, decomposed accents and non-English names (the review bypass) ----
const ACCENTED = ['Côte d’Ivoire', "Côte d'Ivoire", "Cote d'Ivoire", 'São Tomé and Príncipe', 'Sao Tome and Principe', 'México', 'Mexico', 'Perú', 'Panamá', 'Jamáica', 'Cánada', 'Curaçao', 'Réunion', 'Türkiye', 'Turkiye',
  'Brasil', 'España', 'Deutschland', 'Österreich', 'Suisse', 'Schweiz', 'Nederland', 'Italia', 'Polska', 'Belgique', 'Sverige', 'Norge', 'Danmark', 'Suomi', 'Hrvatska', 'Magyarország'];
const accentLeaks: string[] = [];
for (const name of ACCENTED) for (const form of [name.normalize('NFC'), name.normalize('NFD'), name.normalize('NFKD')]) for (const s of shapes(form)) if (out(s).type === 'US') accentLeaks.push(s);
assert(accentLeaks.length === 0, `no accented / decomposed / non-English country name lets a string through as US (${ACCENTED.length} names x 3 Unicode forms x 5 shapes)`, accentLeaks.slice(0, 5).join(' | '));
// property: put a COMBINING ACUTE after every vowel of every country (decomposed) and also its precomposed-where-possible form
const decorated: string[] = [];
for (const c of COUNTRIES) { const d = c.replace(/[aeiou]/gi, (v) => v + '\u0301'); decorated.push(d, d.normalize('NFC')); }
const decoratedLeaks: string[] = [];
for (const d of decorated) for (const s of [`Remote, US; Remote, ${d}`, `US-Remote, ${d}`]) if (out(s).type === 'US') decoratedLeaks.push(s);
assert(decoratedLeaks.length === 0, `accent-decorating every one of ${COUNTRIES.length} countries (decomposed and composed) never lets "US + country" through (${decorated.length * 2} strings)`, decoratedLeaks.slice(0, 4).join(' | '));
const stripAcc = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
const uncoveredAcc = ACCENTED.filter((a) => !(vetoRe.test(a.toLowerCase()) || vetoRe.test(stripAcc(a))));
assert(uncoveredAcc.length === 0, 'the production list (original or accent-stripped) covers every accented / non-English name', uncoveredAcc.join(', '));
assert((pipeSrc.match(/\.normalize\('NFKD'\)\.replace\(\/\[\\u0300-\\u036f\]\/g, ''\)/g) || []).length === 2, 'BOTH classifiers normalize (exactly two accent-stripped veto checks in the source)');
assert(['Remote, US', 'US-Remote', 'Remote (US)'].every((s) => out(s.normalize('NFD')).type === 'US'), 'normalization does not break ordinary US strings (decomposed input still admits)');

// strings with NO other country still admit (the veto is not over-broad for ordinary US text)
assert(['Remote, US', 'US-Remote', 'Remote (US)', 'San Francisco, CA, US; Remote, US', 'New York, NY, remote, US, New York, NY', 'Remote, Remote, Remote U.S.'].every((s) => out(s).type === 'US'), 'ordinary US-only strings (no other country) are still admitted');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

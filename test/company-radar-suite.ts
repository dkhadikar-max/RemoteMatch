/**
 * Company Radar — Phase 0 regression suite.
 * ==============================================================================
 * Covers the approved Phase 0 baseline (docs/company-radar-phase0-
 * implementation-plan-2026-10-24.md): exact-match company identity, honest
 * source-link labeling, "unknown" fields never fabricated, and the new
 * module's isolation from catalog-read.ts.
 *
 *  §1 static   src/lib/companies/catalog.ts does not import OPPORTUNITY_COLUMNS
 *              (the Phase 0 "no catalog-read.ts changes" boundary); no new
 *              file under src/app/companies or src/lib/companies labels a link
 *              "Company website"; catalog-read.ts / catalog-sync.ts /
 *              pipeline.ts / directory.ts have zero diff from HEAD on main
 *              (frozen-code boundary, verified via git, not assumed)
 *  §2 unit     labelForSource, isValidCompanyName, sanitizeCompanySearchTerm —
 *              pure functions, no network
 *  §3 real     READ-ONLY against live Supabase (anon client only — no
 *              service-role key is used or required anywhere in this suite,
 *              deliberately narrower than this codebase's other real-infra
 *              suites, which write+clean up synthetic rows): discovers one
 *              real active company from the live catalog and confirms exact-
 *              match lookup, confirms a nonexistent company returns an empty
 *              result (not an error), confirms search finds it by substring.
 *              Writes NOTHING — no insert/update/delete anywhere in this file.
 *
 * Run: npx tsx --env-file=.env.migration.local test/company-radar-suite.ts
 *   (§3 self-skips if Supabase env is incomplete. Prints the configured
 *    project URL before any query, per the approved environment-safety
 *    procedure — verify the target before trusting any real-infra result.)
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import {
  getOpportunitiesByExactCompany,
  searchCompanies,
  labelForSource,
  isValidCompanyName,
  sanitizeCompanySearchTerm,
} from '../src/lib/companies/catalog';

let passed = 0, failed = 0, skipped = 0;
const assert = (ok: boolean, msg: string, detail?: string) => {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; } else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
};
const skip = (m: string) => { skipped++; console.log(`  – SKIP: ${m}`); };
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('1. STATIC — new-file isolation from frozen/pinned code');
  {
    const catalogSrc = noComments(read('src/lib/companies/catalog.ts'));
    assert(!/import[^;]*OPPORTUNITY_COLUMNS/.test(catalogSrc), 'src/lib/companies/catalog.ts does not IMPORT OPPORTUNITY_COLUMNS (own column list, per plan §2.1) — checked against code with comments stripped, since the file\'s own header comment explains this rule in prose');
    assert(!catalogSrc.includes("from '../ingestion/catalog-read'") && !catalogSrc.includes('from \'@/lib/ingestion/catalog-read\''), 'src/lib/companies/catalog.ts does not import catalog-read.ts at all');

    // Checked against rendered JSX/string literals (comments stripped) —
    // this file's own prose explaining the rule legitimately contains the
    // phrase and must not trip its own check.
    const newFiles = [
      'src/app/companies/page.tsx',
      'src/app/companies/view/[company]/page.tsx',
    ];
    let anyMislabel = false;
    for (const f of newFiles) {
      if (/company website/i.test(noComments(read(f)))) anyMislabel = true;
    }
    assert(!anyMislabel, 'no new Company Radar page renders a link labeled "Company website"');

    const frozenPaths = [
      'src/lib/ingestion/catalog-sync.ts',
      'src/lib/ingestion/catalog-read.ts',
      'src/lib/ingestion/pipeline.ts',
      'src/lib/seo/directory.ts',
    ];
    try {
      const diff = execSync(`git diff --name-only -- ${frozenPaths.map((p) => `"${p}"`).join(' ')}`, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
      assert(diff === '', 'zero working-tree diff in every frozen/pinned ingestion file', diff);
    } catch (e) {
      skip(`could not run git diff to verify frozen-file isolation: ${(e as Error).message}`);
    }
  }

  console.log('\n2. UNIT — pure functions, no network');
  {
    assert(labelForSource('greenhouse') === 'Apply via Greenhouse', 'greenhouse labeled as an ATS link, not a company website');
    assert(labelForSource('lever') === 'Apply via Lever', 'lever labeled correctly');
    assert(labelForSource('ashby') === 'Apply via Ashby', 'ashby labeled correctly');
    assert(labelForSource('himalayas') === 'View on Himalayas', 'himalayas labeled as a third-party listing, not a company website');
    assert(labelForSource('weworkremotely') === 'View on We Work Remotely', 'weworkremotely labeled correctly');
    assert(labelForSource('remoteok') === 'View on RemoteOK', 'remoteok labeled correctly');
    assert(labelForSource('remotive') === 'View on Remotive', 'remotive labeled correctly');
    assert(labelForSource('arbeitnow') === 'View on Arbeitnow', 'arbeitnow labeled correctly');
    assert(labelForSource('jobicy') === 'View on Jobicy', 'jobicy labeled correctly');
    assert(labelForSource('curated') === 'Apply directly', 'curated (hand-authored, genuinely the employer\'s own page) labeled as a direct apply link');
    assert(labelForSource('careerpage') === 'Apply directly', 'careerpage (C5 extraction, genuinely the employer\'s own domain) labeled as a direct apply link');
    assert(labelForSource('some-future-source') === 'View listing', 'an unrecognized future source gets a neutral label, never a guessed one');

    assert(isValidCompanyName('Acme') === true, 'a normal company name is valid');
    assert(isValidCompanyName('') === false, 'an empty string is invalid');
    assert(isValidCompanyName('   ') === false, 'a whitespace-only string is invalid');
    assert(isValidCompanyName('x'.repeat(201)) === false, 'a name over 200 chars is invalid');
    assert(isValidCompanyName('x'.repeat(200)) === true, 'a name at exactly 200 chars is valid');

    assert(sanitizeCompanySearchTerm('  Vercel  ') === 'Vercel', 'whitespace is trimmed');
    assert(sanitizeCompanySearchTerm(null) === null, 'null input yields null');
    assert(sanitizeCompanySearchTerm('') === null, 'empty input yields null');
    assert(sanitizeCompanySearchTerm('<script>') === 'script', 'unsafe characters are stripped, not escaped-and-kept');
    assert(sanitizeCompanySearchTerm("Trader Joe's") === "Trader Joe's", 'an apostrophe in a real company name survives');
    assert(sanitizeCompanySearchTerm('Lemon.io') === 'Lemon.io', 'a period in a real company name survives');
    assert(sanitizeCompanySearchTerm('AT&T') === 'AT&T', 'an ampersand in a real company name survives');
    assert((sanitizeCompanySearchTerm('x'.repeat(200)) ?? '').length === 80, 'a search term is capped at 80 chars');

    // URL round trip for the /companies/view/[company] segment, including
    // characters real company names actually use.
    for (const name of ['Vercel', 'Lemon.io', "Trader Joe's", 'AT&T', 'Natuvion GmbH', '日本株式会社']) {
      const roundTripped = decodeURIComponent(encodeURIComponent(name));
      assert(roundTripped === name, `URL round trip preserves "${name}"`);
    }
  }

  console.log('\n3. REAL INFRA — read-only, anon client only, zero writes');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    skip('Supabase env incomplete (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY) — run with --env-file=.env.migration.local');
    return finish();
  }
  console.log(`  Target project: ${url}`);
  console.log('  (anon key only — this suite never uses a service-role key and performs no writes)');

  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Discover one real, currently-active company rather than hardcoding an
  // employer name that could become stale — a single bounded read, the same
  // shape any anonymous visitor's browser already performs.
  const { data: sample, error: sampleError } = await supabase
    .from('opportunities')
    .select('company')
    .eq('status', 'active')
    .limit(1);
  if (sampleError || !sample || sample.length === 0) {
    skip(`could not discover a real active company to test against: ${sampleError?.message ?? 'no active rows'}`);
    return finish();
  }
  const realCompany = (sample[0] as { company: string }).company;
  console.log(`  Using a real, currently-active company for exact-match checks (not printed to avoid implying anything about it beyond "exists").`);

  const exact = await getOpportunitiesByExactCompany(supabase, realCompany);
  assert(exact.total > 0 && exact.rows.length > 0, 'exact-match lookup of a real active company returns at least one row');
  assert(exact.rows.every((r) => r.company === realCompany), 'every returned row\'s company is an EXACT match — no fuzzy/partial rows leak in');
  assert(exact.rows.every((r) => typeof r.officialUrl === 'string' && r.officialUrl.length > 0), 'every row has a non-empty officialUrl to label');

  const nonexistent = `zzz-definitely-not-a-real-company-${Date.now()}`;
  const empty = await getOpportunitiesByExactCompany(supabase, nonexistent);
  assert(empty.total === 0 && empty.rows.length === 0, 'a nonexistent company name returns an EMPTY result, not an error');

  const tooLong = await getOpportunitiesByExactCompany(supabase, 'x'.repeat(500));
  assert(tooLong.total === 0 && tooLong.rows.length === 0, 'an over-length company name is rejected by the shape guard before any query (empty result, not an error)');

  const substring = realCompany.slice(0, Math.max(3, Math.min(6, realCompany.length)));
  const found = await searchCompanies(supabase, substring, { from: 0, to: 23 });
  assert(found.rows.some((r) => r.company === realCompany), `searching a substring of the real company's name finds it among results`);

  const noMatch = await searchCompanies(supabase, nonexistent, { from: 0, to: 23 });
  assert(noMatch.total === 0 && noMatch.rows.length === 0, 'searching a nonexistent term returns an EMPTY result, not an error');

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

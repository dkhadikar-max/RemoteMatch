/**
 * Directory + category hubs — bounded reads (egress).
 * ==============================================================================
 * /remote-jobs and /remote-jobs/[slug] used to read the WHOLE catalog (all
 * columns, descriptions included) per request. They now read a cached slim
 * index + one page of rows, or answer `?q=` in the database. This suite proves
 * the new path returns the same listings as the old one (where behavior was
 * meant to be preserved), pins the deliberate differences, and MEASURES the
 * requests and bytes.
 *
 *  §1 static    pages no longer read the catalog; pagination + noindex wiring
 *  §2 unit      category rules == a verbatim copy of the OLD rules; pagination,
 *               caching, LRU/TTL, search-term sanitising (injected deps)
 *  §3 real      live Supabase, isolated synthetic rows (cleaned up): membership
 *               and counts match the old full read, search semantics, hostile
 *               input, and measured REST calls / bytes per scenario
 *  §4 http      the running local server renders the pages (self-skips if down)
 *
 * Run: npx tsx --env-file=.env.migration.local test/directory-egress-suite.ts
 */
import fs from 'fs';
import path from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import {
  SEO_CATEGORIES,
  matchesCategory,
  getJobsForCategory,
  searchJobs,
  type SeoCategory,
} from '../src/lib/seo/data';
import {
  DIRECTORY_PAGE_SIZE,
  MAX_DIRECTORY_PAGE,
  parsePageParam,
  buildSearchTerms,
  getHubPage,
  getSearchPage,
  loadHubPage,
  loadSearchPage,
  resetDirectoryCachesForTests,
  type DirectoryDeps,
} from '../src/lib/seo/directory';
import { getActiveOpportunities, getCatalogIndexEntries, searchActiveOpportunitiesPage, SearchTimeoutError, type CatalogIndexEntry } from '../src/lib/ingestion/catalog-read';
import { createLruTtlMap } from '../src/lib/seo/ttl-cache';
import { pageWindow } from '../src/components/seo/Pagination';
import type { CanonicalOpportunity } from '../src/types/byn';

let passed = 0, failed = 0, skipped = 0;
const assert = (ok: boolean, msg: string, detail?: string) => {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; } else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
};
const skip = (m: string) => { skipped++; console.log(`  – SKIP: ${m}`); };
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Stub of the chainable Supabase query builder surface. Covers exactly the five methods
 *  searchActiveOpportunitiesPage calls, verified against its current source (src/lib/ingestion/
 *  catalog-read.ts): .from() once, then .select()/.or()/.order() each called multiple times
 *  (always the same method, chainable), terminating in the one awaited call, .range(), which
 *  resolves to { data, count, error }. If that function ever adds a method this stub lacks, the
 *  call throws "query.X is not a function" — the test fails loudly on the mock, not silently. */
function fakeSearchClient(error: { code: string | null; message: string }): any {
  const builder: any = {
    select: () => builder,
    or: () => builder,
    order: () => builder,
    range: async () => ({ data: null, count: null, error }),
  };
  return { from: () => builder };
}

// ---- the OLD category rules, copied verbatim from the pre-change getJobsForCategory ----
function oldMembers<T extends { title: string; requiredSkills: string[]; remoteType?: string; eligibleCountries?: string[]; experienceRequirement?: string }>(cat: SeoCategory, activeJobs: T[]): T[] {
  if (cat.type === 'location') {
    if (cat.slug === 'worldwide') return activeJobs.filter((j) => j.remoteType === 'Worldwide');
    if (cat.slug === 'united-states') return activeJobs.filter((j) => j.remoteType === 'US' || (j.eligibleCountries ?? []).some((c) => c === 'US' || c === 'USA'));
    if (cat.slug === 'europe') return activeJobs.filter((j) => j.remoteType === 'EU/EEA' || (j.eligibleCountries ?? []).some((c) => c === 'EU' || c === 'UK' || c === 'EEA'));
  }
  if (cat.type === 'seniority') {
    if (cat.slug === 'senior') return activeJobs.filter((j) => j.experienceRequirement === '7-10' || j.title.toLowerCase().includes('senior') || j.title.toLowerCase().includes('lead') || j.title.toLowerCase().includes('staff'));
    if (cat.slug === 'entry-level') return activeJobs.filter((j) => j.experienceRequirement === '0-1' || j.experienceRequirement === '2-3');
  }
  const slugLower = cat.slug.replace('-', ' ');
  return activeJobs.filter((j) => {
    const titleLower = j.title.toLowerCase();
    const skillsLower = (j.requiredSkills || []).map((t) => t.toLowerCase());
    const matchesTag = cat.tags.some((t) => skillsLower.includes(t.toLowerCase()));
    const matchesTitle = titleLower.includes(slugLower) || (slugLower === 'software engineering' && (titleLower.includes('engineer') || titleLower.includes('developer')));
    return matchesTag || matchesTitle;
  });
}

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TITLE_WORDS = ['Senior', 'Staff', 'Lead', 'Junior', 'Engineer', 'Developer', 'Designer', 'Product Manager', 'Data Analyst', 'Marketing Manager', 'Support Specialist', 'Software Engineering', 'Design', 'Data', 'Growth'];
const REMOTE = ['Worldwide', 'US', 'EU/EEA', 'Americas', 'APAC'];
const COUNTRIES = [[], ['US'], ['USA'], ['EU'], ['UK'], ['EEA'], ['DE', 'FR'], ['CA']];
const EXPERIENCE = ['0-1', '2-3', '4-6', '7-10', undefined];

async function main() {
  // ===========================================================================
  console.log('\n1. STATIC');
  const dirPage = noComments(read('src/app/remote-jobs/page.tsx'));
  const catPage = noComments(read('src/app/remote-jobs/[slug]/page.tsx'));
  for (const [name, src] of [['directory page', dirPage], ['category page', catPage]] as const) {
    assert(!/getActiveJobs|getJobsForCategory|searchJobs|getActiveOpportunities|createSupabaseServerClient/.test(src), `${name} no longer reads the catalog (no getActiveJobs/getJobsForCategory/searchJobs/cookie client)`);
    assert(/<Pagination\b/.test(src), `${name} renders pagination`);
    assert(/robots:\s*\{\s*index:\s*false,\s*follow:\s*true\s*\}/.test(src), `${name} marks deep pages noindex,follow`);
    assert(/outOfRange/.test(src) && /notFound\(\)/.test(src), `${name} 404s an out-of-range page`);
  }
  assert(/loadSearchPage/.test(dirPage) && /loadHubPage\(null/.test(dirPage), 'directory uses the search loader for ?q= and the hub loader otherwise');
  assert(/loadHubPage\(category\.slug/.test(catPage), 'category page uses the hub loader');
  assert(/numberOfItems: totalJobs/.test(dirPage) && /numberOfItems: totalJobs/.test(catPage), 'JSON-LD numberOfItems is the TOTAL, with only the page\'s postings listed');
  const dirSrc = noComments(read('src/lib/seo/directory.ts'));
  assert(/CATALOG_INDEX_TTL_MS = 6 \* 60 \* 60 \* 1000/.test(dirSrc), 'the catalog index TTL is 6 hours');
  const relSrc = noComments(read('src/app/remote-jobs/view/[id]/page.tsx'));
  assert(/getRelatedJobs\(/.test(relSrc) && !/getActiveJobs/.test(relSrc), 'related-job reads are still the bounded LIMIT-3 read (preserved)');
  const sm = noComments(read('src/lib/seo/sitemap-data.ts'));
  assert(/getSitemapJobEntries/.test(sm) && /createAsyncTtlCache/.test(sm) && !/getActiveJobs/.test(sm), 'sitemap keeps its slim read + TTL cache (preserved)');

  // ===========================================================================
  console.log('\n2. UNIT');
  // 2a. parsePageParam / buildSearchTerms / pageWindow / LRU
  assert(parsePageParam(undefined) === 1 && parsePageParam('') === 1 && parsePageParam('abc') === 1 && parsePageParam('-3') === 1 && parsePageParam('0') === 1, 'parsePageParam: missing/garbage/zero/negative -> 1');
  assert(parsePageParam('7') === 7 && parsePageParam(['4', '9']) === 4 && parsePageParam('2.5') === 1, 'parsePageParam: integers pass, arrays use the first, decimals -> 1');
  assert(parsePageParam('999999') === MAX_DIRECTORY_PAGE && parsePageParam('99999999999') === 1, `parsePageParam: capped at ${MAX_DIRECTORY_PAGE}; absurdly long digit strings are rejected`);
  assert(buildSearchTerms('  React   TypeScript ').join('|') === 'react|typescript', 'buildSearchTerms: lowercases and splits on whitespace');
  assert(buildSearchTerms('c++ c# .net ci/cd node.js').join('|') === 'c++|c#|.net|ci/cd|node.js', 'buildSearchTerms: keeps the characters real skills use');
  assert(buildSearchTerms('a,b)(c "x" 100% a_b *').join('|') === 'abc|x|100|ab', 'buildSearchTerms: strips filter-grammar and LIKE-wildcard characters (, ( ) " % _ *)');
  assert(buildSearchTerms('a b c d e f g h').length === 5, 'buildSearchTerms: at most 5 terms (lowered from 6 to bound worst-case search cost)');
  assert(buildSearchTerms('x'.repeat(200))[0].length === 40, 'buildSearchTerms: terms are capped at 40 characters');
  assert(buildSearchTerms(undefined).length === 0 && buildSearchTerms('   ').length === 0 && buildSearchTerms('%%%').length === 0, 'buildSearchTerms: empty / whitespace / all-stripped -> no terms');
  assert(pageWindow(1, 1).join() === '1' && pageWindow(1, 5).join() === '1,2,3,gap,5' && pageWindow(50, 100).join() === '1,gap,48,49,50,51,52,gap,100', 'pageWindow: first/last plus a window, with gaps');
  {
    let t = 0;
    const m = createLruTtlMap<number>({ max: 2, ttlMs: 100, now: () => t });
    m.set('a', 1); m.set('b', 2); m.get('a'); m.set('c', 3);
    assert(m.get('b') === undefined && m.get('a') === 1 && m.get('c') === 3 && m.size === 2, 'LRU: evicts the least-recently-used entry at max size');
    t = 100; assert(m.get('a') === undefined, 'LRU: an entry expires at its TTL');
    m.set('x', 1); m.clear(); assert(m.size === 0, 'LRU: clear() empties it');
  }

  // 2b. matchesCategory == the OLD rules, on a synthetic catalog that exercises every branch
  const rnd = mulberry32(20261012);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
  const allTags = SEO_CATEGORIES.flatMap((c) => c.tags);
  const synth = Array.from({ length: 4000 }, (_, i) => ({
    sourceId: `u-${i}`,
    title: `${pick(TITLE_WORDS)} ${pick(TITLE_WORDS)} ${i}`,
    postedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 280) * 86400000 + i).toISOString(),
    requiredSkills: Array.from({ length: Math.floor(rnd() * 4) }, () => { const t = pick(allTags); return rnd() < 0.3 ? t.toLowerCase() : t; }),
    remoteType: pick(REMOTE),
    eligibleCountries: pick(COUNTRIES) as string[],
    experienceRequirement: pick(EXPERIENCE),
  }));
  let allSame = true; const perCat: string[] = [];
  for (const cat of SEO_CATEGORIES) {
    const oldIds = oldMembers(cat, synth).map((j) => j.sourceId).join('|');
    const newIds = synth.filter((j) => matchesCategory(cat, j)).map((j) => j.sourceId).join('|');
    if (oldIds !== newIds) allSame = false;
    perCat.push(`${cat.slug}:${oldMembers(cat, synth).length}`);
  }
  assert(allSame, `matchesCategory() == the old per-category rules for all ${SEO_CATEGORIES.length} hubs on 4,000 synthetic listings`);
  console.log(`  · members per hub: ${perCat.join('  ')}`);
  assert(SEO_CATEGORIES.every((c) => synth.some((j) => matchesCategory(c, j))), 'every hub matched at least one synthetic listing (the equivalence check is not vacuous)');

  // 2c. getHubPage with injected dependencies
  {
    const index: CatalogIndexEntry[] = synth.map((s) => ({ ...s })).sort((a, b) => (a.postedAt < b.postedAt ? 1 : a.postedAt > b.postedAt ? -1 : a.sourceId < b.sourceId ? -1 : 1));
    let indexCalls = 0, rowCalls = 0; let dropOne = false;
    const mkJob = (id: string) => ({ sourceId: id, title: id } as unknown as CanonicalOpportunity);
    const deps: DirectoryDeps = {
      getIndex: async () => { indexCalls++; return index; },
      getRows: async (ids) => { rowCalls++; const out = ids.map(mkJob); return dropOne ? out.slice(1) : out; },
      sliceCache: createLruTtlMap({ max: 50, ttlMs: 60_000 }),
    };
    const p1 = await getHubPage(deps, null, 1);
    assert(p1.total === 4000 && p1.totalPages === Math.ceil(4000 / DIRECTORY_PAGE_SIZE) && p1.jobs.length === DIRECTORY_PAGE_SIZE && p1.page === 1 && !p1.outOfRange, `directory page 1: ${p1.jobs.length} jobs of ${p1.total}, ${p1.totalPages} pages`);
    assert(p1.jobs.map((j) => j.sourceId).join() === index.slice(0, DIRECTORY_PAGE_SIZE).map((e) => e.sourceId).join(), 'page 1 is the NEWEST listings, in order');
    const last = await getHubPage(deps, null, p1.totalPages);
    assert(last.jobs.length === 4000 - (p1.totalPages - 1) * DIRECTORY_PAGE_SIZE && !last.outOfRange, `last page holds the remainder (${last.jobs.length})`);
    const beyond = await getHubPage(deps, null, p1.totalPages + 1);
    assert(beyond.outOfRange && beyond.page === p1.totalPages, 'a page past the end is flagged outOfRange and clamped');
    const calls0 = rowCalls;
    await getHubPage(deps, null, 1); await getHubPage(deps, null, 1);
    assert(rowCalls === calls0, 'a repeated page is served from the slice cache (0 row reads)');
    const cat = SEO_CATEGORIES.find((c) => c.slug === 'worldwide')!;
    const w = await getHubPage(deps, cat, 1);
    assert(w.total === synth.filter((j) => j.remoteType === 'Worldwide').length, 'a category hub counts exactly its members');
    assert(w.jobs.every((j) => synth.find((s) => s.sourceId === j.sourceId)!.remoteType === 'Worldwide'), 'a category page lists only members');
    dropOne = true;
    const partialKey = await getHubPage(deps, SEO_CATEGORIES.find((c) => c.slug === 'senior')!, 1);
    const before = rowCalls; dropOne = false;
    await getHubPage(deps, SEO_CATEGORIES.find((c) => c.slug === 'senior')!, 1);
    assert(partialKey.jobs.length === DIRECTORY_PAGE_SIZE - 1 && rowCalls === before + 1, 'a PARTIAL slice (a row expired since the index) is not cached — the next view re-reads it');
    const empty = await getHubPage({ ...deps, getIndex: async () => [], sliceCache: createLruTtlMap({ max: 5, ttlMs: 1000 }) }, null, 3);
    assert(empty.total === 0 && empty.totalPages === 1 && empty.page === 1 && !empty.outOfRange && empty.jobs.length === 0, 'an empty catalog: 0 jobs, 1 page, not "out of range"');
  }

  // 2d. getSearchPage: a statement-timeout is caught and reported, never silently "0 results";
  // any OTHER error still propagates (not swallowed). The error shape used here is NOT invented —
  // it's the same { message, code: '57014' } this codebase already uses for this exact Postgres
  // error in test/catalog-sync-lifecycle-suite.ts and test/swipe-real-profile-suite.ts, and the
  // message text matches a real production occurrence captured during the preceding investigation.
  // This proves shape fidelity against established precedent, not a live-reproduced timeout —
  // actually triggering one would require an expensive production query, out of scope.
  {
    const lowLevelClient = fakeSearchClient({ message: 'canceling statement due to statement timeout', code: '57014' });
    let lowLevelThrew: unknown = null;
    try { await searchActiveOpportunitiesPage(lowLevelClient, ['engineer'], { from: 0, to: 23 }); } catch (e) { lowLevelThrew = e; }
    assert(lowLevelThrew instanceof SearchTimeoutError, 'searchActiveOpportunitiesPage itself throws SearchTimeoutError (not a generic Error) on SQLSTATE 57014');

    const timeoutClient = fakeSearchClient({ message: 'canceling statement due to statement timeout', code: '57014' });
    const r = await getSearchPage(timeoutClient, 'engineer', 1);
    assert(
      r.searchTimedOut === true && r.jobs.length === 0 && r.total === 0 && r.page === 1 && r.totalPages === 1 && !r.outOfRange,
      'a statement-timeout is reported as searchTimedOut, not a genuine empty-results page'
    );

    const otherErrorClient = fakeSearchClient({ message: 'syntax error', code: '42601' });
    let threw = false;
    try { await getSearchPage(otherErrorClient, 'engineer', 1); } catch (e) { threw = (e as Error).message.includes('syntax error'); }
    assert(threw, 'a non-timeout DB error still throws (never silently hidden as searchTimedOut or empty results)');

    const msgOnlyClient = fakeSearchClient({ message: 'canceling statement due to statement timeout', code: null });
    const r2 = await getSearchPage(msgOnlyClient, 'engineer', 1);
    assert(r2.searchTimedOut === true, 'the message-text fallback also catches a timeout when `code` is absent');

    // Cross-check against the codebase's OWN precedent for this exact error, not a value I chose —
    // same literal object shape test/catalog-sync-lifecycle-suite.ts:386 already uses for 57014.
    const precedentShapedError = { message: 'canceling statement due to statement timeout', code: '57014' };
    const precedentClient = fakeSearchClient(precedentShapedError);
    const r3 = await getSearchPage(precedentClient, 'engineer', 1);
    assert(r3.searchTimedOut === true, 'matches the exact error shape already used elsewhere in this codebase for SQLSTATE 57014 (catalog-sync-lifecycle-suite.ts, swipe-real-profile-suite.ts)');
  }

  // 2e. (reserved — see §2f below for the static checks)

  // 2f. static: the route has a defense-in-depth error boundary, a timed-out search renders
  // branded copy distinct from a genuine "no results" message, and the error boundary's escape
  // hatch does not retry the failing search (no ?q= carried into its "view all jobs" link).
  console.log('\n2f. STATIC — graceful search-timeout handling');
  assert(fs.existsSync(path.resolve(__dirname, '..', 'src/app/remote-jobs/error.tsx')), 'src/app/remote-jobs/error.tsx exists (route-level error boundary)');
  const errSrc = noComments(read('src/app/remote-jobs/error.tsx'));
  assert(/'use client'/.test(errSrc) && /reset\s*\(\s*\)/.test(errSrc), 'the error boundary is a client component that offers reset()');
  assert(!/<html|<body|<Navbar/.test(errSrc), 'the error boundary renders only fallback content — it relies on the root layout (src/app/layout.tsx) for <html>/<body>/<Navbar>, never duplicating them');
  assert(/href="\/remote-jobs"/.test(errSrc) && !/href="\/remote-jobs\?/.test(errSrc), 'the "view all jobs" escape hatch carries no ?q= — it cannot retry the failing search');
  assert(!fs.existsSync(path.resolve(__dirname, '..', 'src/app/remote-jobs/layout.tsx')), 'no route-specific layout overrides the root layout for /remote-jobs, confirming Navbar/globals.css stay in effect around the error fallback');
  const dirPageSrc = noComments(read('src/app/remote-jobs/page.tsx'));
  assert(/searchTimedOut/.test(dirPageSrc) && /took too long/i.test(dirPageSrc), 'a timed-out search renders branded "took too long" copy, checked BEFORE the generic empty-results branch');
  assert(
    dirPageSrc.indexOf('hub?.searchTimedOut') < dirPageSrc.indexOf('No remote jobs found matching'),
    'the timeout branch is checked before the generic "no results" branch, so a timeout can never render as 0 results'
  );

  // ===========================================================================
  console.log('\n3. REAL INFRA — live Supabase, isolated synthetic rows');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) { skip('Supabase env incomplete'); return finish(); }

  const realFetch = globalThis.fetch;
  const net = { calls: 0, bytes: 0 };
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input?.url ?? String(input);
    const res = await realFetch(input, init);
    if (u.includes('/rest/v1/opportunities')) { net.calls++; net.bytes += (await res.clone().arrayBuffer()).byteLength; }
    return res;
  }) as typeof fetch;
  const measure = async <T,>(fn: () => Promise<T>) => { net.calls = 0; net.bytes = 0; const r = await fn(); return { r, calls: net.calls, bytes: net.bytes }; };
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const PREFIX = `dir-egress-${Date.now().toString(36)}-`;
  const N = 2500;
  const rr = mulberry32(777);
  const rp = <T,>(a: readonly T[]) => a[Math.floor(rr() * a.length)];
  const desc = (i: number) => `Listing ${i}. We are hiring remote talent to build and operate distributed systems for customers worldwide. `.repeat(11);
  const ids = Array.from({ length: N }, (_, i) => `${PREFIX}${String(i).padStart(5, '0')}`);
  const mk = (id: string, i: number, over: Record<string, unknown> = {}) => ({
    source: 'remotive', source_id: id, type: 'job', title: `${rp(TITLE_WORDS)} ${rp(TITLE_WORDS)} ${id.slice(-5)}`, company: `Co ${i % 40}`, company_logo: null,
    description: desc(i), source_url: 'https://example.com', official_url: 'https://example.com/apply', canonical_url_hash: `h-${id}`, content_hash: `c-${id}`,
    employment_type: 'Full-time', remote_type: rp(REMOTE), eligible_countries: rp(COUNTRIES), excluded_countries: [], timezone_requirements: [],
    required_skills: Array.from({ length: Math.floor(rr() * 4) }, () => rp(allTags)), experience_requirement: rp(EXPERIENCE) ?? null,
    explicit_remote_scope: 'explicit_worldwide', status: 'active', posted_at: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0, ...over,
  });
  const rows = [
    ...ids.map((id, i) => mk(id, i)),
    mk(`${PREFIX}x-expired`, 1, { status: 'expired' }),
    mk(`${PREFIX}x-de-error`, 2, { source_language: 'de', translation_status: 'error', title: 'Entwickler zebratitle' }),
    mk(`${PREFIX}t-de-ok`, 3, { source_language: 'de', translation_status: 'ok', title: 'Translated zebratitle role' }),
    // search fixtures with a unique word only in ONE field each
    mk(`${PREFIX}s-title`, 4, { title: 'Quokkaword Specialist', company: 'Plain Co', description: desc(4), required_skills: [] }),
    mk(`${PREFIX}s-company`, 5, { title: 'Plain Role', company: 'Quokkaword Industries', description: desc(5), required_skills: [] }),
    mk(`${PREFIX}s-desc`, 6, { title: 'Plain Role Two', company: 'Plain Co', description: 'This role involves quokkaword research. ' + desc(6), required_skills: [] }),
    mk(`${PREFIX}s-skill`, 7, { title: 'Plain Role Three', company: 'Plain Co', description: desc(7), required_skills: ['Quokkaword'] }),
    mk(`${PREFIX}s-skill-lc`, 8, { title: 'Plain Role Four', company: 'Plain Co', description: desc(8), required_skills: ['quokkaword'] }),
  ];
  const visibleIds = new Set([...ids, `${PREFIX}t-de-ok`, `${PREFIX}s-title`, `${PREFIX}s-company`, `${PREFIX}s-desc`, `${PREFIX}s-skill`, `${PREFIX}s-skill-lc`]);
  const mine = <T extends { sourceId: string }>(a: T[]) => a.filter((x) => x.sourceId.startsWith(PREFIX));

  try {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from('opportunities').insert(rows.slice(i, i + 200));
      if (error) { assert(false, `seed batch ${i / 200 + 1}`, error.message); return finish(); }
    }
    assert(true, `seeded ${rows.length} isolated synthetic rows (${N} bulk + expired + untranslated-German + translated-German + 5 single-field search fixtures)`);
    resetDirectoryCachesForTests();

    // --- 3a. index ---
    const idxRun = await measure(() => getCatalogIndexEntries(anon));
    const idxMine = mine(idxRun.r);
    assert(idxMine.length === visibleIds.size && idxMine.every((e) => visibleIds.has(e.sourceId)), `slim index returns exactly the visible listings (${idxMine.length}/${visibleIds.size}); expired and untranslated-German excluded`);
    assert(idxRun.r.every((e, i, a) => i === 0 || a[i - 1].postedAt >= e.postedAt), 'the index is sorted newest first');
    console.log(`  · index read: ${idxRun.calls} REST calls, ${kb(idxRun.bytes)} for ${idxRun.r.length} rows (${(idxRun.bytes / idxRun.r.length).toFixed(0)} B/row uncompressed)`);

    // --- 3b. membership equals the OLD whole-catalog path ---
    const fullRun = await measure(() => getActiveOpportunities(anon, { translationSafe: true }));
    const full = mine(fullRun.r);
    console.log(`  · OLD full-catalog read: ${fullRun.calls} REST calls, ${kb(fullRun.bytes)} for ${fullRun.r.length} rows (${(fullRun.bytes / fullRun.r.length).toFixed(0)} B/row)`);
    assert(full.length === visibleIds.size, `old full read sees the same ${full.length} listings`);
    let membersEqual = true; const bad: string[] = [];
    for (const cat of SEO_CATEGORIES) {
      const a = new Set(idxMine.filter((e) => matchesCategory(cat, e)).map((e) => e.sourceId));
      const b = new Set(oldMembers(cat, full).map((j) => j.sourceId));
      if (a.size !== b.size || Array.from(a).some((x) => !b.has(x))) { membersEqual = false; bad.push(cat.slug); }
    }
    assert(membersEqual, 'for every hub, index-based membership == the old rules over the full rows', bad.join(','));
    const viaOldFn = new Set(mine(await getJobsForCategory('worldwide', anon)).map((j) => j.sourceId));
    const viaIdx = new Set(idxMine.filter((e) => matchesCategory(SEO_CATEGORIES.find((c) => c.slug === 'worldwide')!, e)).map((e) => e.sourceId));
    assert(viaOldFn.size === viaIdx.size && Array.from(viaOldFn).every((x) => viaIdx.has(x)), "the (still exported) getJobsForCategory('worldwide') agrees with the paginated path");

    // --- 3c. measured scenarios ---
    resetDirectoryCachesForTests();
    const cold = await measure(() => loadHubPage(null, '1'));
    assert(!!cold.r && cold.r.jobs.length === DIRECTORY_PAGE_SIZE, `directory page 1 renders ${cold.r?.jobs.length} jobs`);
    console.log(`  · COLD directory page 1: ${cold.calls} REST calls, ${kb(cold.bytes)} (index + one 24-row slice)`);
    const warm1 = await measure(() => loadHubPage(null, '1'));
    assert(warm1.calls === 0 && warm1.bytes === 0, 'WARM directory page 1: 0 REST calls, 0 bytes');
    const warm2 = await measure(() => loadHubPage(null, '2'));
    assert(warm2.calls === 1 && warm2.r!.page === 2, `WARM directory page 2 (new slice): ${warm2.calls} REST call, ${kb(warm2.bytes)}`);
    const catPage = await measure(() => loadHubPage('software-engineering', '1'));
    assert(catPage.calls === 1 && catPage.r!.jobs.length > 0, `category hub page 1: ${catPage.calls} REST call, ${kb(catPage.bytes)} (index already warm)`);
    const search = await measure(() => loadSearchPage('engineer', '1'));
    assert(search.calls === 1 && search.r!.jobs.length === DIRECTORY_PAGE_SIZE, `search ?q=engineer: ${search.calls} REST call, ${kb(search.bytes)}, ${search.r!.total} total matches`);
    const oldPer = fullRun.bytes;
    const bounded = Math.max(warm2.bytes, catPage.bytes, search.bytes);
    console.log(`  · per request: OLD ${kb(oldPer)} -> NEW warm index: ${kb(bounded)} max (${(100 - (bounded / oldPer) * 100).toFixed(1)}% less); cold: ${kb(cold.bytes)} (${(100 - (cold.bytes / oldPer) * 100).toFixed(1)}% less)`);
    assert(bounded < oldPer * 0.02, `a warm page view reads under 2% of what the old path read (${kb(bounded)} vs ${kb(oldPer)})`);
    assert(cold.bytes < oldPer * 0.2, `even a COLD view (index rebuild) reads under 20% of the old path (${kb(cold.bytes)} vs ${kb(oldPer)})`);
    // Extrapolation to the real catalog (labelled as such): the slice is catalog-size independent; the index scales linearly.
    const perRowIdx = idxRun.bytes / idxRun.r.length;
    const slice = Math.max(warm2.bytes, catPage.bytes);
    console.log(`  · EXTRAPOLATED to 23,096 rows (uncompressed): index ≈ ${((perRowIdx * 23096) / 1048576).toFixed(1)} MB per 6h refresh (${(((perRowIdx * 23096) / 1048576) * 4).toFixed(1)} MB/day), page slice ≈ ${kb(slice)} per cache miss, vs ${((fullRun.bytes / fullRun.r.length) * 23096 / 1048576).toFixed(0)} MB per request on the old path`);

    // --- 3d. pagination correctness against the real DB ---
    resetDirectoryCachesForTests();
    const idxAll = idxRun.r;
    const p1 = (await loadHubPage(null, '1'))!;
    assert(p1.total === idxAll.length && p1.totalPages === Math.ceil(idxAll.length / DIRECTORY_PAGE_SIZE), `directory total/pages match the index (${p1.total}/${p1.totalPages})`);
    assert(p1.jobs.map((j) => j.sourceId).join() === idxAll.slice(0, DIRECTORY_PAGE_SIZE).map((e) => e.sourceId).join(), 'page 1 rows are the newest listings, in index order, with full data (description present)');
    assert(p1.jobs.every((j) => j.description.length > 500 && !!j.company && j.status === 'active'), 'page rows are full CanonicalOpportunity objects (cards + JSON-LD can render)');
    const pl = (await loadHubPage(null, String(p1.totalPages)))!;
    assert(pl.jobs.length === idxAll.length - (p1.totalPages - 1) * DIRECTORY_PAGE_SIZE, `the last page holds the remainder (${pl.jobs.length})`);
    const oor = (await loadHubPage(null, String(p1.totalPages + 5)))!;
    assert(oor.outOfRange, 'a page past the end is flagged outOfRange');
    const seen = new Set<string>(); let dup = false;
    for (const pg of [1, 2, 3]) for (const j of (await loadHubPage(null, String(pg)))!.jobs) { if (seen.has(j.sourceId)) dup = true; seen.add(j.sourceId); }
    assert(!dup && seen.size === DIRECTORY_PAGE_SIZE * 3, 'consecutive pages do not repeat listings');

    // --- 3e. search semantics against the old searchJobs ---
    const q1 = (await loadSearchPage('quokkaword', '1'))!;
    const found = new Set(q1.jobs.map((j) => j.sourceId));
    assert(q1.total === 5 && found.size === 5, `a word present in only one field is found in title / company / description / skill tag / lowercase skill tag (${q1.total} of 5)`);
    assert(!found.has(`${PREFIX}x-expired`) && !found.has(`${PREFIX}x-de-error`), 'search never returns expired or untranslated-German listings');
    const z = (await loadSearchPage('zebratitle', '1'))!;
    assert(z.jobs.map((j) => j.sourceId).join() === `${PREFIX}t-de-ok`, 'only the TRANSLATED German listing matches its title word (the untranslated one stays hidden)');
    const eng = (await loadSearchPage('engineer', '1'))!;
    const oldEng = (await searchJobs('engineer', undefined, anon)).filter((j) => j.sourceId.startsWith(PREFIX));
    assert(eng.total === oldEng.length, `?q=engineer total matches the old whole-catalog search (${eng.total} vs ${oldEng.length})`);
    const multi = (await loadSearchPage('senior engineer', '1'))!;
    const oldMulti = (await searchJobs('senior engineer', undefined, anon)).filter((j) => j.sourceId.startsWith(PREFIX));
    assert(multi.total === oldMulti.length, `multi-term search ANDs the terms like the old path (${multi.total} vs ${oldMulti.length})`);
    const none = (await loadSearchPage('nonexistenttermxyz999', '1'))!;
    assert(none.total === 0 && none.jobs.length === 0 && !none.outOfRange, 'a no-match search is an empty, valid page');
    const s2 = (await loadSearchPage('engineer', '2'))!;
    assert(s2.page === 2 && s2.jobs.length > 0 && s2.jobs[0].sourceId !== eng.jobs[0].sourceId, 'search page 2 is a different slice of the same result set');
    assert(eng.jobs.every((j, i, a) => i === 0 || a[i - 1].postedAt >= j.postedAt), 'search results are newest first');
    for (const hostile of ['a,b)(c', '%', '_', '*', 'x"y', "'; drop table opportunities; --", 'title.eq.1,or(id.eq.1', '\\', '😀', '()', ',,,']) {
      let ok = true; let r: any;
      try { r = await loadSearchPage(hostile, '1'); } catch { ok = false; }
      assert(ok && !!r && Array.isArray(r.jobs), `hostile search input is handled safely: ${JSON.stringify(hostile)}`);
    }
    const stillThere = (await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`)).count;
    assert(stillThere === rows.length, 'no hostile input altered the table');

    // --- 3f. the related-job read and the sitemap are unchanged and still bounded ---
    const { getRelatedJobs } = await import('../src/lib/seo/data');
    const rel = await measure(() => getRelatedJobs(anon, ids[0], 3));
    assert(rel.r.length === 3 && rel.calls === 1, `related jobs: still one LIMIT-3 read (${rel.calls} call, ${kb(rel.bytes)})`);
    const { getSitemapEntries: sitemap } = await import('../src/lib/seo/sitemap-data');
    const sm1 = await measure(() => sitemap());
    const sm2 = await measure(() => sitemap());
    assert(sm1.calls >= 1 && sm2.calls === 0, `sitemap: first call ${sm1.calls} REST calls (${kb(sm1.bytes)} for ${idxAll.length} rows), repeat call ${sm2.calls}`);
    assert(sm1.bytes < fullRun.bytes * 0.2, `the sitemap read is under 20% of the old full read (${kb(sm1.bytes)} vs ${kb(fullRun.bytes)})`);

    // --- 4. the running local server renders the pages from bounded reads ---
    console.log('\n4. HTTP — the local dev server');
    const BASE = process.env.TEST_BASE_URL || 'http://localhost:3100';
    let up = true; try { await realFetch(`${BASE}/api/health`); } catch { up = false; }
    if (!up) { skip(`no server reachable at ${BASE}`); }
    else {
      const get = async (p: string) => { const r = await realFetch(`${BASE}${p}`); const t = await r.text(); return { status: r.status, text: t, bytes: Buffer.byteLength(t) }; };
      const d1 = await get('/remote-jobs');
      assert(d1.status === 200 && /Showing 1–24 of \d+ verified positions/.test(d1.text), `GET /remote-jobs -> 200, "Showing 1–24 of N" (HTML ${kb(d1.bytes)})`);
      assert((d1.text.match(/<article/g) || []).length === 24, 'the directory renders exactly 24 cards');
      assert(/rel="next"/.test(d1.text) && /aria-label="Pagination"/.test(d1.text), 'pagination with rel="next" is present');
      assert(!/name="robots" content="[^"]*noindex/.test(d1.text), 'page 1 is indexable');
      const d2 = await get('/remote-jobs?page=2');
      assert(d2.status === 200 && /name="robots" content="[^"]*noindex/.test(d2.text) && /rel="prev"/.test(d2.text), 'GET /remote-jobs?page=2 -> 200, noindex,follow, with a "previous" link');
      assert((await get('/remote-jobs?page=99999')).status === 404, 'an out-of-range page -> 404');
      assert((await get('/remote-jobs?page=abc')).status === 200, 'a garbage page param -> page 1 (200)');
      const dq = await get('/remote-jobs?q=quokkaword');
      assert(dq.status === 200 && /Showing 5 verified positions/.test(dq.text) && /Quokkaword/.test(dq.text), 'GET /remote-jobs?q=quokkaword -> the 5 fixtures');
      assert((await get('/remote-jobs?q=%25%27%22%2C()')).status === 200, 'hostile ?q= renders (200), no 500');
      const c1 = await get('/remote-jobs/software-engineering');
      assert(c1.status === 200 && (c1.text.match(/<article/g) || []).length === 24 && /Showing 1–24 of \d+ verified active positions/.test(c1.text), 'GET /remote-jobs/software-engineering -> 200 with a 24-card first page');
      const cw = await get('/remote-jobs/worldwide?page=2');
      assert(cw.status === 200 && /rel="prev"/.test(cw.text), 'a category page 2 renders');
      assert((await get('/remote-jobs/not-a-category')).status === 404, 'an unknown category -> 404');
      console.log(`  · HTML sizes: directory page 1 ${kb(d1.bytes)}, category page 1 ${kb(c1.bytes)}`);
    }
  } finally {
    const { error } = await admin.from('opportunities').delete().like('source_id', `${PREFIX}%`);
    const { count } = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
    assert(!error && (count ?? 0) === 0, `cleanup: all synthetic rows removed (${count ?? 0} remain)`, error?.message);
    globalThis.fetch = realFetch;
  }

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

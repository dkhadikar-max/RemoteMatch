/**
 * Egress trim — sitemap caching + unused-column removal.
 * ==============================================================================
 * sitemap.xml used to read the WHOLE catalog (every column, descriptions
 * included, ~70 MB uncompressed at ~23k rows) from Supabase on every request.
 * The shared catalog read also selected columns its mapper never uses. This
 * suite pins the fix and proves it changed no behavior:
 *
 *  §1 static    column list == what the mapper reads; sitemap no longer reads
 *               the full catalog; slim read is bounded/ordered/gated
 *  §2 unit      mapper output unchanged; buildSitemap() == a verbatim copy of
 *               the OLD sitemap logic; TTL cache semantics (injected clock)
 *  §3 real      against a live Supabase project, with isolated synthetic rows
 *               (cleaned up): slim read pages correctly across the 1,000-row
 *               boundary, applies the same visibility gates as the full read,
 *               sitemap() hits the DB once per TTL, and byte sizes drop
 *
 * Run: npx tsx --env-file=.env.migration.local test/egress-trim-suite.ts
 *   (§3 self-skips if Supabase env is missing; never point it at a project you
 *    don't mean to write synthetic rows to — it refuses without the service key.)
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import {
  OPPORTUNITY_COLUMNS,
  SITEMAP_COLUMNS,
  rowToCanonicalOpportunity,
  getSitemapJobEntries,
  getActiveOpportunities,
  type SitemapJobEntry,
} from '../src/lib/ingestion/catalog-read';
import { buildSitemap } from '../src/lib/seo/sitemap-build';
import { createAsyncTtlCache } from '../src/lib/seo/ttl-cache';
import { SEO_CATEGORIES, SEO_GUIDE_ARTICLES } from '../src/lib/seo/data';
import { SITE_URL } from '../src/lib/site';

let passed = 0;
let failed = 0;
function assert(ok: boolean, msg: string, detail?: string) {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
}
// CRLF-normalised: this repo's working tree is CRLF on Windows.
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const cols = (s: string) => s.split(',').map((c) => c.trim()).filter(Boolean);

// ---- the OLD sitemap logic, copied verbatim from the pre-change src/app/sitemap.ts ----
// (the only edit: it takes entries instead of full CanonicalOpportunity objects,
//  which expose the same four fields the old code read.)
function oldSitemap(baseUrl: string, activeJobs: SitemapJobEntry[]) {
  const latestJobDate = activeJobs.reduce((latest, j) => {
    const d = new Date(j.postedAt);
    return d > latest ? d : latest;
  }, new Date('2026-03-01T00:00:00Z'));
  const staticRoutes = [
    { url: `${baseUrl}`, lastModified: latestJobDate, changeFrequency: 'daily', priority: 1.0 },
    { url: `${baseUrl}/remote-jobs`, lastModified: latestJobDate, changeFrequency: 'daily', priority: 0.9 },
    { url: `${baseUrl}/guide`, lastModified: new Date('2026-03-08T00:00:00Z'), changeFrequency: 'weekly', priority: 0.8 },
  ];
  const categoryRoutes = SEO_CATEGORIES.map((cat) => {
    const catJobs = activeJobs.filter((j) => {
      const slugLower = cat.slug.replace('-', ' ');
      const titleLower = j.title.toLowerCase();
      const skillsLower = (j.requiredSkills || []).map((t) => t.toLowerCase());
      return cat.tags.some((t) => skillsLower.includes(t.toLowerCase())) || titleLower.includes(slugLower);
    });
    const catDate = catJobs.reduce((latest, j) => {
      const d = new Date(j.postedAt);
      return d > latest ? d : latest;
    }, latestJobDate);
    return { url: `${baseUrl}/remote-jobs/${cat.slug}`, lastModified: catDate, changeFrequency: 'daily', priority: 0.85 };
  });
  const jobRoutes = activeJobs.map((job) => ({
    url: `${baseUrl}/remote-jobs/view/${job.sourceId}`,
    lastModified: new Date(job.postedAt),
    changeFrequency: 'weekly',
    priority: 0.75,
  }));
  const guideRoutes = SEO_GUIDE_ARTICLES.map((article) => ({
    url: `${baseUrl}/guide/${article.slug}`,
    lastModified: new Date(article.publishedDate),
    changeFrequency: 'monthly',
    priority: 0.7,
  }));
  return [...staticRoutes, ...categoryRoutes, ...jobRoutes, ...guideRoutes];
}

// deterministic PRNG so failures reproduce
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  // ===========================================================================
  console.log('\n1. STATIC');
  const catalogSrc = read('src/lib/ingestion/catalog-read.ts');
  const catalog = noComments(catalogSrc);

  // The mapper and the SELECT list must agree exactly.
  const mapperStart = catalog.indexOf('export function rowToCanonicalOpportunity');
  const mapperBody = catalog.slice(mapperStart, catalog.indexOf('\n}\n', mapperStart) + 3);
  const mapperReads = new Set(Array.from(mapperBody.matchAll(/\brow\.([a-z_]+)/g)).map((m) => m[1]));
  const selected = new Set(cols(OPPORTUNITY_COLUMNS));
  const missing = Array.from(mapperReads).filter((c) => !selected.has(c));
  const unused = Array.from(selected).filter((c) => !mapperReads.has(c));
  assert(mapperReads.size >= 30, `parsed the mapper's field reads (${mapperReads.size} fields)`);
  assert(missing.length === 0, 'every field the mapper reads is selected', `missing: ${missing.join(', ')}`);
  assert(unused.length === 0, 'every selected column is read by the mapper (no dead weight on the wire)', `unused: ${unused.join(', ')}`);
  for (const c of ['id', 'source_language', 'original_title', 'original_description', 'translated_at', 'translation_model', 'translated_content_hash', 'translation_status']) {
    assert(!selected.has(c), `OPPORTUNITY_COLUMNS no longer selects \`${c}\``);
  }
  assert(selected.has('description'), 'description is still selected (cards, JSON-LD, search and matching read it)');

  assert(cols(SITEMAP_COLUMNS).join() === 'source_id,title,posted_at,required_skills', 'SITEMAP_COLUMNS is exactly the four fields the sitemap uses');
  assert(!/description/.test(SITEMAP_COLUMNS), 'the sitemap read does not select description');

  const fnStart = catalog.indexOf('export async function getSitemapJobEntries');
  const fnBody = catalog.slice(fnStart, catalog.indexOf('\n}\n', fnStart) + 3);
  assert(/\.select\(SITEMAP_COLUMNS\)/.test(fnBody), 'getSitemapJobEntries selects only SITEMAP_COLUMNS');
  assert(/\.or\(TRANSLATION_SAFE_OR\)\s*\.or\(TRANSLATION_NOT_ERROR_OR\)/.test(fnBody), 'it applies the shared multilingual gate — both clauses, including hiding translation errors — like the full read');
  assert(/\.order\('source'/.test(fnBody) && /\.order\('source_id'/.test(fnBody), 'it pages over a deterministic order (source, source_id)');
  assert(/\.range\(/.test(fnBody) && /while \(true\)/.test(fnBody), 'it pages past the 1,000-row PostgREST cap');
  assert(!/OPPORTUNITY_COLUMNS/.test(fnBody), 'it does not use the full column list');

  const sitemapSrc = noComments(read('src/app/sitemap.ts'));
  assert(/export const dynamic = 'force-dynamic'/.test(sitemapSrc), 'sitemap stays force-dynamic (no build-time DB read)');
  assert(!/getActiveJobs|getActiveOpportunities/.test(sitemapSrc), 'sitemap no longer reads the full catalog');
  assert(/getSitemapJobEntries/.test(sitemapSrc) && /createAsyncTtlCache/.test(sitemapSrc), 'sitemap uses the slim read behind the TTL cache');
  const ttl = Number(/SITEMAP_TTL_MS = (\d+) \* (\d+) \* (\d+) \* (\d+)/.exec(sitemapSrc)?.slice(1).reduce((a, b) => a * Number(b), 1));
  assert(ttl >= 60 * 60 * 1000, `sitemap TTL is at least 1 hour (${ttl / 3600000} h)`);

  // OPPORTUNITY_COLUMNS must not be depended on anywhere else (translate-pending has its own SELECTs).
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const users = walk(path.resolve(__dirname, '..', 'src')).filter((f) => /OPPORTUNITY_COLUMNS/.test(fs.readFileSync(f, 'utf8')));
  assert(users.length === 1 && users[0].endsWith('catalog-read.ts'), 'OPPORTUNITY_COLUMNS is only used inside catalog-read.ts', users.map((u) => path.basename(u)).join(', '));
  const tp = read('src/lib/translation/translate-pending.ts');
  assert(/original_description/.test(tp) && /translation_status/.test(tp), 'the translation pass still reads/writes the translation columns through its own queries');

  // ===========================================================================
  console.log('\n2. UNIT');
  // 2a. mapper: extra (formerly selected) columns are ignored → output identical
  const baseRow: any = {
    type: 'job', title: 'Senior React Engineer', company: 'Acme', company_logo: null, description: 'Build things.',
    source: 'remotive', source_id: 'r-1', source_url: 'https://e.com', official_url: 'https://e.com/j', canonical_url_hash: 'h1', content_hash: 'c1',
    employment_type: 'Full-time', remote_type: 'Worldwide', eligible_countries: [], excluded_countries: [], timezone_requirements: [],
    salary_min: 100, salary_max: 200, salary_currency: 'USD', salary_period: 'yearly', required_skills: ['React'], preferred_skills: [],
    experience_requirement: '4-6', quality_score: 85, source_quality: 0.8, description_completeness: 'high', salary_quality: 'high',
    remote_policy_confidence: 'high', explicit_remote_scope: 'explicit_worldwide', status: 'active', posted_at: '2026-10-01T00:00:00Z',
    is_permanently_removed: false, link_checked_at: null, superseded_by_opportunity_id: null,
  };
  const withOld = {
    ...baseRow, id: 'uuid-1', source_language: 'de', original_title: 'Titel', original_description: 'Beschreibung', translated_at: '2026-10-02T00:00:00Z',
    translation_model: 'gemini', translated_content_hash: 'x', translation_status: 'ok',
  };
  assert(JSON.stringify(rowToCanonicalOpportunity(baseRow)) === JSON.stringify(rowToCanonicalOpportunity(withOld)), 'mapper output is identical with or without the removed columns');
  assert(rowToCanonicalOpportunity(baseRow).id === 'opp-remotive-r-1', 'CanonicalOpportunity.id is still opp-<source>-<source_id> (not the table UUID)');

  // 2b. sitemap equivalence on a synthetic catalog that exercises every category matcher
  const rnd = mulberry32(20261012);
  const allTags = SEO_CATEGORIES.flatMap((c) => c.tags);
  const words = ['Senior', 'Staff', 'Engineer', 'Developer', 'Designer', 'Product Manager', 'Data Analyst', 'Marketing Lead', 'Support', 'Software Engineering', 'Design', 'Data', 'Marketing', 'Entry Level'];
  const entries: SitemapJobEntry[] = Array.from({ length: 3000 }, (_, i) => ({
    sourceId: `syn-${i}`,
    title: `${words[Math.floor(rnd() * words.length)]} ${words[Math.floor(rnd() * words.length)]} ${i}`,
    postedAt: new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 280) * 86400000 + Math.floor(rnd() * 86400000)).toISOString(),
    requiredSkills: Array.from({ length: Math.floor(rnd() * 4) }, () => allTags[Math.floor(rnd() * allTags.length)]),
  }));
  const norm = (x: unknown) => JSON.stringify(x);
  assert(norm(buildSitemap(SITE_URL, entries)) === norm(oldSitemap(SITE_URL, entries)), 'buildSitemap() === the old sitemap logic on 3,000 synthetic listings (urls, dates, priorities, order)');
  assert(norm(buildSitemap(SITE_URL, [])) === norm(oldSitemap(SITE_URL, [])), 'identical on an empty catalog (static + category + guide routes only)');
  const one = [{ sourceId: 'x', title: 'Solo', postedAt: '2026-10-05T10:00:00Z', requiredSkills: [] }];
  assert(norm(buildSitemap(SITE_URL, one)) === norm(oldSitemap(SITE_URL, one)), 'identical on a one-listing catalog');
  const built = buildSitemap(SITE_URL, entries);
  assert(built.filter((e) => e.url.includes('/remote-jobs/view/')).length === 3000, 'one /view/ URL per active listing');
  assert(built.every((e) => e.lastModified instanceof Date && !isNaN((e.lastModified as Date).getTime())), 'every lastModified is a valid Date');

  // 2c. TTL cache semantics (injected clock)
  {
    let t = 0;
    let loads = 0;
    let fail = false;
    const stale: unknown[] = [];
    const cache = createAsyncTtlCache(async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      if (fail) throw new Error('db down');
      return `v${loads}`;
    }, { ttlMs: 1000, maxStaleMs: 5000, now: () => t, onStaleServed: (e) => stale.push(e) });

    const burst = await Promise.all(Array.from({ length: 10 }, () => cache.get()));
    assert(loads === 1 && burst.every((v) => v === 'v1'), 'ten concurrent first calls share ONE load (single-flight)');
    t = 999; await cache.get();
    assert(loads === 1, 'within the TTL: served from cache, no load');
    t = 1000; assert((await cache.get()) === 'v2' && loads === 2, 'at the TTL boundary: refreshes');
    t = 2500; fail = true;
    assert((await cache.get()) === 'v2' && loads === 3 && stale.length === 1, 'refresh fails inside maxStale: last good value is served, failure is reported');
    t = 2501; await cache.get();
    assert(loads === 4, 'a failed refresh is not cached as fresh — the next call retries');
    t = 7600; // the last good value was loaded at t=1000 -> 6,600 ms old, beyond maxStale (5,000)
    let threw = false; try { await cache.get(); } catch { threw = true; }
    assert(threw, 'beyond maxStale a failing load propagates instead of serving ancient data');
    fail = false; t = 7700;
    const recovered = await cache.get();
    assert(recovered === `v${loads}`, 'recovers on the first successful load');
    cache.invalidate(); const before = loads; await cache.get();
    assert(loads === before + 1, 'invalidate() forces a reload');

    let first = true;
    const cold = createAsyncTtlCache(async () => { if (first) { first = false; throw new Error('boom'); } return 'ok'; }, { ttlMs: 1000, maxStaleMs: 5000, now: () => 0 });
    let coldThrew = false; try { await cold.get(); } catch { coldThrew = true; }
    assert(coldThrew && (await cold.get()) === 'ok', 'a cold-start failure propagates and is not cached; the next call succeeds');
  }

  // ===========================================================================
  console.log('\n3. REAL INFRA — live Supabase, isolated synthetic rows');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) {
    console.log('  (skipped: Supabase env incomplete)');
    return finish();
  }

  const realFetch = globalThis.fetch;
  let restOpportunityCalls = 0;
  globalThis.fetch = ((input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input?.url ?? String(input);
    if (u.includes('/rest/v1/opportunities')) restOpportunityCalls++;
    return realFetch(input, init);
  }) as typeof fetch;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const suffix = Date.now().toString(36);
  const PREFIX = `egress-trim-${suffix}-`;
  const N_ACTIVE = 1100; // > 1,000 so the slim read MUST page across the PostgREST cap
  const desc = (i: number) => `Synthetic listing ${i}. ` + 'We are hiring a remote engineer to build and operate distributed systems. '.repeat(16);
  const mk = (id: string, over: Record<string, unknown> = {}, i = 0) => ({
    source: 'remotive', source_id: id, type: 'job', title: `Egress Test ${id}`, company: 'Egress Test Co', company_logo: null,
    description: desc(i), source_url: 'https://example.com', official_url: 'https://example.com/apply',
    canonical_url_hash: `h-${id}`, content_hash: `c-${id}`, employment_type: 'Full-time', remote_type: 'Worldwide',
    eligible_countries: [], excluded_countries: [], timezone_requirements: [], required_skills: ['TypeScript', 'React'],
    explicit_remote_scope: 'explicit_worldwide', status: 'active', posted_at: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
    first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0,
    ...over,
  });

  const activeIds = Array.from({ length: N_ACTIVE }, (_, i) => `${PREFIX}a-${String(i).padStart(4, '0')}`);
  const rows = [
    ...activeIds.map((id, i) => mk(id, {}, i)),
    mk(`${PREFIX}x-expired`, { status: 'expired' }, 1),
    mk(`${PREFIX}x-de-error`, { source_language: 'de', translation_status: 'error' }, 2),
    mk(`${PREFIX}t-de-ok`, { source_language: 'de', translation_status: 'ok', original_title: 'Titel', original_description: desc(3) }, 3),
    mk(`${PREFIX}t-en`, { source_language: 'en', translation_status: 'n/a' }, 4),
  ];
  const expectedVisible = new Set([...activeIds, `${PREFIX}t-de-ok`, `${PREFIX}t-en`]);

  try {
    for (let i = 0; i < rows.length; i += 200) {
      const { error } = await admin.from('opportunities').insert(rows.slice(i, i + 200));
      if (error) { assert(false, `seed batch ${i / 200 + 1}`, error.message); return finish(); }
    }
    assert(true, `seeded ${rows.length} isolated synthetic rows (${N_ACTIVE} active + expired + untranslated-German + translated-German + English)`);

    // 3a. slim read: complete, no dupes, gated, correct fields
    const slim = await getSitemapJobEntries(anon);
    const mine = slim.filter((e) => e.sourceId.startsWith(PREFIX));
    const mineIds = mine.map((e) => e.sourceId);
    assert(mine.length === expectedVisible.size, `slim read returns every visible seeded row across the 1,000-row page boundary (${mine.length}/${expectedVisible.size})`);
    assert(new Set(mineIds).size === mineIds.length, 'no duplicate rows across pages');
    assert(Array.from(expectedVisible).every((id) => mineIds.includes(id)), 'no row is skipped at the page boundary');
    assert(!mineIds.includes(`${PREFIX}x-expired`), 'an expired listing is excluded (RLS active-only)');
    assert(!mineIds.includes(`${PREFIX}x-de-error`), 'an untranslated non-English listing is excluded (translationSafe gate)');
    assert(mineIds.includes(`${PREFIX}t-de-ok`) && mineIds.includes(`${PREFIX}t-en`), 'a translated German and an English listing are included');
    const sample = mine.find((e) => e.sourceId === activeIds[7])!;
    assert(sample.title === `Egress Test ${activeIds[7]}` && Array.isArray(sample.requiredSkills) && sample.requiredSkills.join() === 'TypeScript,React' && !isNaN(Date.parse(sample.postedAt)), 'entry fields map correctly (title, skills, postedAt)');
    // (Row ORDER is deliberately not asserted: Postgres collation vs JS sort differ on '-'. The
    //  guarantees that matter — complete, no duplicates, none skipped at the boundary — are above.)

    // 3b. equivalence with the full read (now on the trimmed column list)
    const full = (await getActiveOpportunities(anon, { translationSafe: true })).filter((o) => o.sourceId.startsWith(PREFIX));
    assert(full.length === expectedVisible.size, `the full read, on the trimmed column list, still returns the same listings (${full.length})`);
    const bySource = new Map(full.map((o) => [o.sourceId, o]));
    const same = mine.every((e) => {
      const o = bySource.get(e.sourceId);
      return !!o && o.title === e.title && o.postedAt === e.postedAt && o.requiredSkills.join() === e.requiredSkills.join();
    });
    assert(same, 'slim entries agree with the full CanonicalOpportunity rows on title / postedAt / requiredSkills');
    const f0 = bySource.get(activeIds[0])!;
    assert(f0.id === `opp-remotive-${activeIds[0]}` && f0.description.length > 1000 && f0.company === 'Egress Test Co' && f0.status === 'active' && f0.officialUrl === 'https://example.com/apply', 'full-read rows still carry id/description/company/status/officialUrl intact');
    const tr = bySource.get(`${PREFIX}t-de-ok`)!;
    assert(tr.title === `Egress Test ${PREFIX}t-de-ok` && tr.description.length > 1000, 'a translated row still returns its (translated) title and description');

    // 3c. sitemap(): hits the DB once per TTL
    const { default: sitemap } = await import('../src/app/sitemap');
    restOpportunityCalls = 0;
    const s1 = await sitemap();
    const firstCalls = restOpportunityCalls;
    restOpportunityCalls = 0;
    const s2 = await sitemap();
    const s3 = await sitemap();
    assert(firstCalls >= 2, `first sitemap() read the catalog in pages (${firstCalls} REST calls for >1,000 rows)`);
    assert(restOpportunityCalls === 0, `the next two sitemap() calls made ${restOpportunityCalls} REST calls to opportunities (cache hit)`);
    assert(JSON.stringify(s1) === JSON.stringify(s2) && JSON.stringify(s2) === JSON.stringify(s3), 'cached calls return the identical sitemap');
    const jobUrls = s1.filter((e) => e.url.includes('/remote-jobs/view/')).map((e) => e.url);
    assert(expectedVisible.size <= jobUrls.length && Array.from(expectedVisible).every((id) => jobUrls.includes(`${SITE_URL}/remote-jobs/view/${id}`)), 'sitemap() includes a /view/ URL for every visible seeded listing');
    assert(!jobUrls.some((u) => u.includes(`${PREFIX}x-`)), 'sitemap() excludes the expired and untranslated-German listings');

    // 3d. bytes on the wire (uncompressed + a gzip estimate), same 1,000 rows, three column lists
    const measure = async (select: string) => {
      const res = await realFetch(`${url}/rest/v1/opportunities?select=${encodeURIComponent(select)}&source_id=like.${encodeURIComponent(PREFIX + 'a-*')}&order=source_id.asc&limit=1000`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Accept-Encoding': 'identity' },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { raw: buf.length, gz: zlib.gzipSync(buf).length, ok: res.ok };
    };
    const OLD_COLUMNS = 'id, ' + OPPORTUNITY_COLUMNS + ', source_language, original_title, original_description, translated_at, translation_model, translated_content_hash, translation_status';
    const mOld = await measure(OLD_COLUMNS);
    const mNew = await measure(OPPORTUNITY_COLUMNS);
    const mSite = await measure(SITEMAP_COLUMNS);
    assert(mOld.ok && mNew.ok && mSite.ok, 'all three measurement reads succeeded');
    const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
    console.log(`  · 1,000 synthetic rows (description ≈ ${desc(1).length} chars):`);
    console.log(`      old full column list : ${kb(mOld.raw)} raw, ~${kb(mOld.gz)} gzip`);
    console.log(`      trimmed column list  : ${kb(mNew.raw)} raw, ~${kb(mNew.gz)} gzip  (${(100 - (mNew.raw / mOld.raw) * 100).toFixed(1)}% smaller raw)`);
    console.log(`      sitemap column list  : ${kb(mSite.raw)} raw, ~${kb(mSite.gz)} gzip  (${(100 - (mSite.raw / mOld.raw) * 100).toFixed(1)}% smaller raw)`);
    assert(mNew.raw < mOld.raw, 'trimmed list is smaller than the old list');
    assert(mSite.raw < mNew.raw * 0.25, `sitemap list is under a quarter of the trimmed list (${kb(mSite.raw)} vs ${kb(mNew.raw)})`);
  } finally {
    const { error } = await admin.from('opportunities').delete().like('source_id', `${PREFIX}%`);
    const { count } = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
    assert(!error && (count ?? 0) === 0, `cleanup: all synthetic rows removed (${count ?? 0} remain)`, error?.message);
    globalThis.fetch = realFetch;
  }

  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

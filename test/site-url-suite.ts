/**
 * RemoteMatch — canonical host (SITE_URL) suite
 * ==============================================================================
 * Every public, search-facing URL (canonical tags, og:url, JSON-LD, sitemap, robots.txt, IndexNow) must name the host that actually
 * serves the app. Before this change they were hard-coded to https://remotematch.com — a different host — in ~50 places. They now all
 * derive from one constant, src/lib/site.ts.
 *
 * What this proves (pure: no env, no network, no database):
 *   1. SITE_URL is https://remotematch.online: https, no trailing slash, no path, SITE_HOST matches, no environment override;
 *   2. SOURCE SCAN of src/: the only remaining `remotematch.com` literals are the crawler User-Agent contact URLs (deliberately
 *      untouched — they are request fingerprints for third-party APIs, not SEO surfaces), and nothing else;
 *   3. each public SEO file imports SITE_URL and uses it exactly as many times as it used to carry the literal (pinned counts), with
 *      the specific canonical / og:url / metadataBase / JSON-LD / sitemap / robots forms asserted;
 *   4. behaviour: robots.txt, the IndexNow guard and the IndexNow payload (host, keyLocation, submitted URLs) use SITE_URL; the old host
 *      is rejected; private prefixes are still rejected on the new host; localhost still passes; buildSitemap keeps a base URL
 *      given to it (it is a pure function of its argument);
 *   5. the two existing suites that used to assert the old host no longer contain it.
 *
 * Run: npx tsx test/site-url-suite.ts
 */
import fs from 'fs';
import path from 'path';
import { SITE_URL, SITE_HOST } from '../src/lib/site';
import robots from '../src/app/robots';
import { isPublicIndexableUrl, INDEXNOW_HOST, INDEXNOW_KEY_LOCATION, notifyJobPublished, notifyJobUpdated, notifyJobExpired, submitToIndexNow } from '../src/lib/seo/indexnow';
import { buildSitemap } from '../src/lib/seo/sitemap-build';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s: string, needle: string) => s.split(needle).length - 1;
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));

(async () => {
console.log('\n1. The constant');
{
  assert(SITE_URL === 'https://remotematch.online', 'SITE_URL is https://remotematch.online');
  assert(SITE_URL.startsWith('https://') && !SITE_URL.endsWith('/') && new URL(SITE_URL).origin === SITE_URL, 'https, no trailing slash, no path (it is a bare origin)');
  assert(SITE_HOST === 'remotematch.online' && SITE_HOST === new URL(SITE_URL).host, 'SITE_HOST is the host of SITE_URL');
  const site = strip(read('src/lib/site.ts'));
  assert(!/process\.env/.test(site) && !/NEXT_PUBLIC/.test(site), 'no environment override (a NEXT_PUBLIC value would be inlined at build time)');
}

console.log('\n2. Source scan of src/');
{
  const files = walk(path.join(ROOT, 'src'));
  const hits: { file: string; line: string }[] = [];
  for (const f of files) for (const l of strip(fs.readFileSync(f, 'utf8')).split('\n')) if (l.includes('remotematch.com')) hits.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), line: l.trim() });
  const nonUa = hits.filter((h) => !/\+https:\/\/remotematch\.com/.test(h.line) || !/(User-Agent|botUserAgent|RemoteMatchBot)/.test(h.line.concat(' ', h.file.includes('robots-check') ? 'botUserAgent' : '')));
  assert(nonUa.length === 0, 'every remaining remotematch.com literal is a crawler User-Agent contact URL', JSON.stringify(nonUa.slice(0, 3)));
  assert(hits.length > 0 && hits.every((h) => h.line.includes('+https://remotematch.com')), `the ${hits.length} remaining literals are all "+https://remotematch.com" contact URLs (deliberately unchanged)`);
  const seoFiles = ['src/app/layout.tsx', 'src/app/guide/page.tsx', 'src/app/guide/[slug]/page.tsx', 'src/app/remote-jobs/page.tsx', 'src/app/remote-jobs/[slug]/page.tsx', 'src/app/remote-jobs/view/[id]/page.tsx', 'src/lib/seo/data.ts', 'src/lib/seo/sitemap-data.ts', 'src/lib/seo/sitemap-chunks.ts', 'src/app/robots.ts', 'src/lib/seo/indexnow.ts'];
  assert(seoFiles.every((f) => /from '@\/lib\/site'/.test(read(f))), 'all 10 SEO files import from @/lib/site');
  assert(seoFiles.every((f) => !/https:\/\/remotematch\.(com|online)/.test(strip(read(f)))), 'none of them contains a hard-coded origin literal (com or online)');
  const online = hits.length; void online;
  const onlineLits = files.filter((f) => /https:\/\/remotematch\.online/.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
  assert(JSON.stringify(onlineLits) === JSON.stringify(['src/app/admin/login/page.tsx', 'src/app/auth/confirm/route.ts', 'src/lib/site.ts', 'src/lib/translation/deepl-client.ts']), 'the only literal origin strings left are SITE_URL itself and three operational ones (admin login link, auth last-resort redirect, DeepL User-Agent)', onlineLits.join(', '));
}

console.log('\n3. Pinned usage counts and exact forms');
{
  const expected: Record<string, number> = {
    'src/app/layout.tsx': 9, 'src/app/guide/page.tsx': 6, 'src/app/guide/[slug]/page.tsx': 7, 'src/app/remote-jobs/page.tsx': 4,
    'src/app/remote-jobs/[slug]/page.tsx': 5, 'src/app/remote-jobs/view/[id]/page.tsx': 6, 'src/lib/seo/data.ts': 1, 'src/lib/seo/sitemap-data.ts': 1, 'src/lib/seo/sitemap-chunks.ts': 1, 'src/app/robots.ts': 1,
  };
  for (const [f, n] of Object.entries(expected)) {
    const uses = count(strip(read(f)), 'SITE_URL') - 1; // minus the import
    assert(uses === n, `${f}: ${n} SITE_URL uses (one per replaced literal)`, `found ${uses}`);
  }
  const layout = strip(read('src/app/layout.tsx'));
  assert(layout.includes('metadataBase: new URL(SITE_URL)') && /canonical: SITE_URL,/.test(layout) && layout.includes('logo: `${SITE_URL}/logo.png`') && layout.includes('urlTemplate: `${SITE_URL}/remote-jobs?q={search_term_string}`'), 'layout: metadataBase, canonical, Organization logo and the WebSite SearchAction template use SITE_URL');
  const view = strip(read('src/app/remote-jobs/view/[id]/page.tsx'));
  assert(view.includes('canonical: `${SITE_URL}/remote-jobs/view/${job.sourceId}`') && view.includes('url: `${SITE_URL}/remote-jobs/view/${job.sourceId}`'), 'job page: canonical and og:url/JSON-LD url use SITE_URL (the id part is unchanged here)');
  assert(strip(read('src/lib/seo/data.ts')).includes('url: `${SITE_URL}/remote-jobs/view/${job.sourceId}`'), 'JobPosting JSON-LD url uses SITE_URL');
  assert(/buildSitemap\(SITE_URL, activeJobs\)/.test(strip(read('src/lib/seo/sitemap-data.ts'))) && /opts\.siteUrl \?\? SITE_URL/.test(strip(read('src/lib/seo/sitemap-chunks.ts'))), 'sitemap-data builds the URL list with SITE_URL and sitemap-chunks writes the index locs with it');
  assert(strip(read('src/app/robots.ts')).includes('sitemap: `${SITE_URL}/sitemap.xml`'), 'robots.ts: Sitemap line uses SITE_URL');
}

console.log('\n4. Behaviour');
{
  assert(robots().sitemap === `${SITE_URL}/sitemap.xml` && robots().sitemap === 'https://remotematch.online/sitemap.xml', 'robots.txt points to https://remotematch.online/sitemap.xml');
  assert(INDEXNOW_HOST === SITE_HOST && INDEXNOW_KEY_LOCATION === `${SITE_URL}/remotematch-indexnow-key.txt`, 'IndexNow host and key location derive from SITE_URL');
  assert(isPublicIndexableUrl(`${SITE_URL}/remote-jobs`) && isPublicIndexableUrl(`${SITE_URL}/remote-jobs/software-engineering`) && isPublicIndexableUrl(`${SITE_URL}/remote-jobs/view/curated-001`) && isPublicIndexableUrl(`${SITE_URL}/guide/x`) && isPublicIndexableUrl(`${SITE_URL}/`), 'IndexNow accepts public URLs on the new host');
  assert(!isPublicIndexableUrl('https://remotematch.com/remote-jobs') && !isPublicIndexableUrl('https://www.remotematch.online/remote-jobs') && !isPublicIndexableUrl('https://admin.remotematch.online/remote-jobs'), 'IndexNow rejects the old host, www. and the admin host');
  assert(['/feed', '/tracker', '/settings', '/onboarding', '/match/x', '/staging', '/api/seo/indexnow'].every((p) => !isPublicIndexableUrl(`${SITE_URL}${p}`)), 'private prefixes are still rejected on the new host');
  assert(isPublicIndexableUrl('http://localhost:3000/remote-jobs'), 'localhost is still accepted (local testing)');
  // payload: stub fetch (no network)
  const real = globalThis.fetch; const sent: any[] = [];
  (globalThis as any).fetch = async (_u: string, init: any) => { sent.push({ url: _u, body: JSON.parse(init.body) }); return { ok: true, status: 200 } as Response; };
  try {
    await notifyJobPublished('job-1'); await notifyJobUpdated('job-2'); await notifyJobExpired('job-3');
    const direct = await submitToIndexNow([`${SITE_URL}/remote-jobs`, 'https://remotematch.com/remote-jobs', `${SITE_URL}/feed`]);
    assert(sent.length === 4 && sent.every((s) => s.url === 'https://api.indexnow.org/indexnow'), 'four submissions went to the IndexNow endpoint (stubbed fetch)');
    assert(sent.every((s) => s.body.host === 'remotematch.online' && s.body.keyLocation === 'https://remotematch.online/remotematch-indexnow-key.txt'), 'every payload carries host remotematch.online and the .online key location');
    assert(sent.every((s) => s.body.urlList.every((u: string) => u.startsWith('https://remotematch.online/'))), 'every submitted URL is on the new host');
    assert(JSON.stringify(sent[0].body.urlList) === JSON.stringify([`${SITE_URL}/remote-jobs/view/job-1`, `${SITE_URL}/remote-jobs`]), 'notifyJobPublished submits the job URL and the directory');
    assert(direct.submittedUrls.length === 1 && direct.rejectedUrls.length === 2, 'the old-host URL and the private URL are rejected, the public one submitted');
  } finally { (globalThis as any).fetch = real; }
  const sm = buildSitemap(SITE_URL, [{ sourceId: 'a-1', title: 'Engineer', postedAt: '2026-10-01T00:00:00Z', requiredSkills: [] }]);
  assert(sm.length > 3 && sm.every((e) => e.url === SITE_URL || e.url.startsWith(`${SITE_URL}/`)) && sm.some((e) => e.url === `${SITE_URL}/remote-jobs/view/a-1`), 'buildSitemap with SITE_URL: every entry is on the new host, the job URL is present');
  assert(buildSitemap('https://example.test', []).every((e) => e.url.startsWith('https://example.test')), 'buildSitemap stays a pure function of its base-URL argument');
}

console.log('\n5. Existing suites no longer assert the old host');
{
  for (const f of ['test/seo-audit.ts', 'test/egress-trim-suite.ts']) {
    const src = read(f);
    assert(!src.includes('remotematch.com') && /from '\.\.\/src\/lib\/site'/.test(src), `${f}: no remotematch.com, imports SITE_URL`);
  }
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

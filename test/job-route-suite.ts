/**
 * RemoteMatch — public job route ids: encode once, decode once
 * ==============================================================================
 * For Himalayas (37,032 rows) and WeWorkRemotely (317) the source id IS the job's URL, so `/remote-jobs/view/<id>` contained
 * slashes: Next answered 308 (collapsing `//`) then 404 on the single-segment `[id]` route, and every sitemap / listing / canonical /
 * IndexNow URL for ~98% of the catalog was dead. Every URL we build now goes through jobHref()/jobUrl() (encodeURIComponent), and the
 * route, its metadata and the middleware decode the param exactly once (findJobByRouteParam) — the rule `/match` has used since
 * 2026-10-14 (match-href.ts). Ids themselves never change.
 *
 * What this proves (pure; the last section is read-only and self-skips without Supabase env):
 *   1. every id shape round-trips and the produced segment is a single, safe path segment; URL-safe ids come out byte-identical to
 *      today's URLs (no change for the 1.4k-class of bare ids);
 *   2. reading back, through a simulation of what Next 14.2.35 does to the segment (verified with a probe app: unreserved escapes
 *      decoded, hex upper-cased, `%25` untouched): the right id resolves, a literal `%` id is not decoded twice, malformed escapes
 *      never throw, ordinary ids cost one lookup;
 *   3. the middleware's id extraction; the sitemap, JobPosting JSON-LD and IndexNow URLs equal the page's canonical builder;
 *   4. STATIC: no raw-id job URL template remains anywhere in src/, and every producer/reader goes through the helper;
 *   5. (needs env) real active rows of every source resolve through the same reader against the live catalog — SELECT only.
 *
 * Run: npx tsx test/job-route-suite.ts          (add --env-file=<env> for section 5)
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import fs from 'fs';
import path from 'path';
import { SITE_URL } from '../src/lib/site';
import { jobHref, jobUrl, jobIdSegmentFromPath, jobIdCandidates, findJobByRouteParam, JOB_VIEW_PATH } from '../src/lib/seo/job-href';
import { buildSitemap } from '../src/lib/seo/sitemap-build';
import { notifyJobPublished, notifyJobUpdated, notifyJobExpired, isPublicIndexableUrl, INDEXNOW_HOST } from '../src/lib/seo/indexnow';
import { buildJobPostingSchema } from '../src/lib/seo/data';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';

let passed = 0, failed = 0, skipped = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (s: string, needle: string) => s.split(needle).length - 1;
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(d, e.name)] : []));

/** What Next 14.2.35 hands the route/middleware for a path segment (probe-verified): unreserved escapes decoded, hex upper-cased, the rest untouched. */
const nextParam = (segment: string) => segment.replace(/%([0-9a-fA-F]{2})/g, (m, h) => { const c = String.fromCharCode(parseInt(h, 16)); return /[A-Za-z0-9._~-]/.test(c) ? c : '%' + h.toUpperCase(); });
/** Same normalisation but keeping the case the client sent (what middleware's nextUrl.pathname showed: lower-case hex preserved). */
const lowerCase = (segment: string) => segment.replace(/%([0-9A-F]{2})/g, (_m, h) => '%' + h.toLowerCase());

const HIM = (co: string, job: string) => `https://himalayas.app/companies/${co}/jobs/${job}`;
const IDS: Record<string, string> = {
  himalayas: HIM('talent-shore', 'recruiter-uk-lifescience'),
  himalayasDots: HIM('a.b_c~d', 'job-1.2_3~4'),
  weworkremotely: 'https://weworkremotely.com/remote-jobs/6sense-it-support-specialist',
  jobicy: '156753', arbeitnow: 'data-scientist-kaggle-drivendata-remote-worldwide-amsterdam-169939', greenhouse: 'greenhouse-airbnb-8318103',
  lever: 'lever-spotify-2d67c471-9015-41c0-a041-b982ec4a14fd', ashby: 'ashby-clickup-1b2c3d', remotive: '1234567', curated: 'curated-001',
  space: 'a b', percent: 'a%b', percent25: 'a%25b', percent2F: 'a%2Fb', tilde: 'a~b', unicode: 'ünï-cödé-✓', plus: 'a+b', amp: 'a&b', q: 'a?b=c', hash: 'a#b', semi: 'a;b:c@d', parens: "a(b)c*d!e'f", slash: 'a/b/c', dotdot: '../x', long: 'x'.repeat(500),
};
const SAFE = /^[A-Za-z0-9._~-]+$/;

(async () => {
console.log('\n1. Encode: every id shape becomes ONE safe path segment and round-trips');
{
  let bad: string[] = [];
  for (const [k, id] of Object.entries(IDS)) {
    const href = jobHref(id); const seg = href.slice(JOB_VIEW_PATH.length);
    const oneSegment = href.startsWith(JOB_VIEW_PATH) && !/[\/?#\s]/.test(seg) && !/%(?![0-9A-F]{2})/.test(seg);
    const parsed = new URL(`https://x.test${href}`);
    const roundTrip = decodeURIComponent(seg) === id && parsed.pathname.split('/').length === 4 && decodeURIComponent(parsed.pathname.split('/')[3]) === id && parsed.search === '' && parsed.hash === '';
    if (!oneSegment || !roundTrip) bad.push(k);
  }
  assert(bad.length === 0, `${Object.keys(IDS).length} id shapes (URLs, slugs, uuids, numbers, spaces, %, %25, %2F, ~, unicode, + & ? # ; : @ ( ) * ! ' / .., 500 chars): one safe segment, decode(encode(id)) === id, no query/hash leak`, bad.join(','));
  const safeIds = Object.entries(IDS).filter(([, id]) => SAFE.test(id));
  assert(safeIds.length >= 8 && safeIds.every(([, id]) => jobHref(id) === `/remote-jobs/view/${id}`), `${safeIds.length} URL-safe ids (jobicy, arbeitnow, greenhouse, lever, ashby, remotive, curated, dotted slugs) produce byte-identical paths to today's`);
  assert(jobHref(IDS.himalayas) === '/remote-jobs/view/https%3A%2F%2Fhimalayas.app%2Fcompanies%2Ftalent-shore%2Fjobs%2Frecruiter-uk-lifescience', 'a Himalayas id becomes https%3A%2F%2F… (the form production already accepts through to the route)');
  assert(jobUrl(IDS.himalayas) === `${SITE_URL}${jobHref(IDS.himalayas)}` && jobUrl('x', 'https://b.test') === 'https://b.test/remote-jobs/view/x', 'jobUrl = base + jobHref; base defaults to SITE_URL and can be overridden');
  const distinct = new Set(Object.values(IDS).map((id) => jobHref(id)));
  assert(distinct.size === Object.keys(IDS).length, 'distinct ids give distinct paths (injective on the shapes above)');
  assert(!/["'<>\s]/.test(jobHref(IDS.amp)) && !/["'<>\s]/.test(jobHref(IDS.parens).replace(/'/g, '')), 'no raw `& < > "` or whitespace in an HTML/XML attribute value');
}

console.log('\n2. Decode once: what the route and middleware do with the param');
{
  const calls: string[] = [];
  const catalog = new Map(Object.values(IDS).map((id) => [id, { sourceId: id }]));
  const lookup = async (id: string) => { calls.push(id); return catalog.get(id) ?? null; };
  let wrong: string[] = [];
  for (const [k, id] of Object.entries(IDS)) {
    for (const [label, param] of [['as Next gives it', nextParam(jobHref(id).slice(JOB_VIEW_PATH.length))], ['lower-case hex (middleware pathname)', lowerCase(jobHref(id).slice(JOB_VIEW_PATH.length))]] as const) {
      const hit = await findJobByRouteParam(param, lookup);
      if (!hit || hit.sourceId !== id) wrong.push(`${k}/${label}`);
    }
  }
  assert(wrong.length === 0, `every id resolves from the param exactly as Next / the middleware see it (${Object.keys(IDS).length} shapes x 2 forms)`, wrong.slice(0, 4).join(','));
  calls.length = 0; await findJobByRouteParam('curated-001', lookup);
  assert(calls.length === 1 && calls[0] === 'curated-001', 'an ordinary (URL-safe) id costs ONE lookup (no extra query for existing bare ids)');
  calls.length = 0; await findJobByRouteParam(nextParam(jobHref(IDS.himalayas).slice(JOB_VIEW_PATH.length)), lookup);
  assert(calls.length === 1 && calls[0] === IDS.himalayas, 'an encoded Himalayas id resolves on the first lookup, with the DECODED id');
  calls.length = 0; const miss = await findJobByRouteParam('nope%2Fnope', lookup);
  assert(miss === undefined && calls.join('|') === 'nope/nope|nope%2Fnope', 'an unknown id returns undefined after at most two lookups (decoded once, then as given)');
  // literal-percent ids: decoding twice would corrupt them
  const only = new Map([['a%25b', { sourceId: 'a%25b' }]]);
  calls.length = 0; const seg = jobHref('a%25b').slice(JOB_VIEW_PATH.length);
  const got = await findJobByRouteParam(nextParam(seg), async (id) => { calls.push(id); return only.get(id) ?? null; });
  assert(seg === 'a%2525b' && got?.sourceId === 'a%25b' && calls.every((c) => c === 'a%25b' || c === 'a%2525b') && !(calls as string[]).includes('a%b'), 'an id that contains a literal "%25" is decoded ONCE: it resolves, and the doubly-decoded "a%b" is never looked up');
  const none = await findJobByRouteParam('a%2525b', async (id) => { calls.push(id); return id === 'a%b' ? { sourceId: id } : null; });
  assert(none === undefined, 'double decoding does not happen: a%2525b can never reach the id "a%b"');
  assert(jobIdCandidates('abc%E0%A4%A').join('|') === 'abc%E0%A4%A' && (await findJobByRouteParam('abc%E0%A4%A', lookup)) === undefined, 'a malformed escape yields one candidate (as given), never a throw');
  assert(jobIdCandidates(undefined).length === 0 && jobIdCandidates('').length === 0 && jobIdCandidates(42).length === 0 && jobIdCandidates(['a']).length === 0, 'missing / empty / non-string params give no candidates (no lookup, no throw)');
  calls.length = 0; assert((await findJobByRouteParam('', lookup)) === undefined && calls.length === 0, 'an empty param performs no lookup');
}

console.log('\n3. Middleware extraction and the other producers');
{
  const enc = jobHref(IDS.himalayas);
  assert(jobIdSegmentFromPath(enc) === enc.slice(JOB_VIEW_PATH.length) && jobIdSegmentFromPath(`${enc}/extra/more`) === enc.slice(JOB_VIEW_PATH.length), 'the id segment is the first path segment after /remote-jobs/view/ (an encoded id keeps its %2F, so it is one segment)');
  assert(jobIdSegmentFromPath('/remote-jobs/view/') === '' && jobIdSegmentFromPath('/remote-jobs/view/abc/x') === 'abc' && jobIdSegmentFromPath('/remote-jobs') === null && jobIdSegmentFromPath('/remote-jobs/software-engineering') === null && jobIdSegmentFromPath('/api/x') === null && jobIdSegmentFromPath(undefined as any) === null, 'non-job paths give null; the bare prefix gives an empty id');
  const legacy = jobIdSegmentFromPath('/remote-jobs/view/https:/himalayas.app/companies/talent-shore/jobs/recruiter-uk-lifescience');
  assert(legacy === 'https:' && (await findJobByRouteParam(legacy, async () => null)) === undefined, 'the legacy collapsed form still yields a harmless "https:" id (no lookup hit, never a throw)');
  const jobs = Object.values(IDS).map((id, i) => ({ sourceId: id, title: 'Engineer', postedAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(), requiredSkills: [] as string[] }));
  const sm = buildSitemap(SITE_URL, jobs);
  const jobEntries = sm.filter((e) => e.url.includes('/remote-jobs/view/'));
  assert(jobEntries.length === jobs.length && jobs.every((j, i) => jobEntries[i].url === jobUrl(j.sourceId)), 'sitemap job URLs are exactly jobUrl(sourceId), in order');
  assert(buildSitemap('https://other.test', jobs.slice(0, 1)).some((e) => e.url === jobUrl(jobs[0].sourceId, 'https://other.test')), 'buildSitemap keeps using the base URL it is given');
  const real = read('src/lib/seo/sitemap-build.ts');
  assert(/url: jobUrl\(job\.sourceId, baseUrl\)/.test(strip(real)), 'sitemap-build builds job URLs with jobUrl(sourceId, baseUrl)');
  // JobPosting JSON-LD
  const job = normalizeOpportunity({ sourceId: IDS.himalayas, source: 'himalayas', title: 'Recruiter', company: 'Talent Shore', description: 'd'.repeat(400), sourceUrl: IDS.himalayas, officialUrl: IDS.himalayas, jobType: 'Full-time', locationString: 'Worldwide', tags: [], publicationDate: new Date().toISOString() } as never);
  const schema = buildJobPostingSchema(job as never);
  assert(schema !== null && (schema as any).url === jobUrl(IDS.himalayas), 'JobPosting JSON-LD url equals the page canonical builder for a Himalayas job', JSON.stringify((schema as any)?.url));
  // IndexNow
  const real0 = globalThis.fetch; const sent: any[] = [];
  (globalThis as any).fetch = async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 } as Response; };
  try {
    await notifyJobPublished(IDS.himalayas); await notifyJobUpdated(IDS.weworkremotely); await notifyJobExpired('curated-001');
    const want0 = jobUrl(IDS.himalayas, `https://${INDEXNOW_HOST}`);
    assert(sent.length === 3 && sent[0].urlList[0] === want0 && sent[1].urlList[0] === jobUrl(IDS.weworkremotely, `https://${INDEXNOW_HOST}`) && sent[2].urlList[0] === `https://${INDEXNOW_HOST}/remote-jobs/view/curated-001`, 'IndexNow submits the encoded job URL (publish / update / expire); bare ids unchanged');
    assert(isPublicIndexableUrl(want0) && sent.every((b) => b.urlList.every((u: string) => isPublicIndexableUrl(u))), 'IndexNow still accepts the encoded URLs as public indexable URLs');
  } finally { (globalThis as any).fetch = real0; }
}

console.log('\n4. Static guards');
{
  const files = walk(path.join(ROOT, 'src'));
  const withLiteral = files.filter((f) => strip(fs.readFileSync(f, 'utf8')).includes('/remote-jobs/view/')).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
  assert(JSON.stringify(withLiteral) === JSON.stringify(['src/lib/seo/job-href.ts']), 'the job-page path literal exists in ONE module (every other file builds/reads it through the helper)', withLiteral.join(', '));
  const raw = files.filter((f) => /view\/\$\{[^}]*(sourceId|jobId|source_id|\.id)[^}]*\}/.test(strip(fs.readFileSync(f, 'utf8'))) && !f.includes('companies')).map((f) => path.relative(ROOT, f));
  assert(raw.length === 0, 'no `view/${…id}` template (a raw, unencoded id in a job URL) remains in src/', raw.join(', '));
  const list = strip(read('src/app/remote-jobs/page.tsx')), cat = strip(read('src/app/remote-jobs/[slug]/page.tsx')), view = strip(read('src/app/remote-jobs/view/[id]/page.tsx'));
  assert(count(list, 'jobHref(job.sourceId)') === 2 && count(cat, 'jobHref(job.sourceId)') === 2 && count(view, 'jobHref(related.sourceId)') === 1, 'directory (2), category hub (2) and related-job (1) links all use jobHref()');
  assert(count(view, 'jobUrl(job.sourceId)') === 3 && /canonical: jobUrl\(job\.sourceId\)/.test(view), 'the job page canonical, og:url and JSON-LD url are all jobUrl(job.sourceId)');
  assert(count(view, 'findJobByRouteParam(id, getJobById)') === 2 && !/getJobById\(id\)/.test(view), 'the job page and its generateMetadata both read the param through findJobByRouteParam (decode once)');
  const mw = strip(read('src/middleware.ts'));
  assert(/jobIdSegmentFromPath\(pathname\)/.test(mw) && /findJobByRouteParam\(jobIdSegment, getJobById\)/.test(mw) && !/\.split\('\/'\)\[0\]/.test(mw), 'the middleware 410 check extracts the segment with jobIdSegmentFromPath and decodes once (no raw split of the pathname)');
  const data = strip(read('src/lib/seo/data.ts')), idx = strip(read('src/lib/seo/indexnow.ts'));
  assert(count(data, 'jobUrl(job.sourceId)') === 1 && count(idx, 'jobUrl(jobId, `https://${INDEXNOW_HOST}`)') === 3, 'JobPosting JSON-LD (1) and IndexNow (3) build job URLs with jobUrl()');
  const helper = strip(read('src/lib/seo/job-href.ts'));
  assert(!/process\.env|fetch\(|supabase/i.test(helper) && /encodeURIComponent\(sourceId\)/.test(helper) && /candidateIdsFromParam/.test(helper), 'the helper is pure (edge-safe), encodes with encodeURIComponent and reuses the /match decode-once reader');
  const decodes = files.filter((f) => /decodeURIComponent\(/.test(strip(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert(!decodes.some((f) => f.includes('remote-jobs/view') || f === 'src/middleware.ts'), 'no ad-hoc decodeURIComponent in the route or middleware (a second decode would corrupt ids with a literal %)');
}

console.log('\n5. Real catalog (read-only; needs env)');
{
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { skipped++; console.log('  (skipped: Supabase env incomplete)'); }
  else {
    const { createClient } = await import('@supabase/supabase-js');
    const { getJobById } = await import('../src/lib/seo/data');
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const sources = ['himalayas', 'weworkremotely', 'jobicy', 'arbeitnow', 'greenhouse', 'lever', 'ashby', 'remotive'];
    let checked = 0; const failures: string[] = []; const perSource: Record<string, number> = {};
    for (const source of sources) {
      const { data } = await admin.from('opportunities').select('source_id').eq('status', 'active').eq('source', source).limit(3);
      for (const row of data ?? []) {
        const param = nextParam(jobHref(row.source_id).slice(JOB_VIEW_PATH.length));
        const hit = await findJobByRouteParam(param, getJobById);
        checked++; perSource[source] = (perSource[source] ?? 0) + 1;
        if (!hit || hit.sourceId !== row.source_id) failures.push(`${source}:${row.source_id.slice(0, 50)}`);
      }
    }
    assert(checked >= 10 && failures.length === 0, `${checked} real active rows (${JSON.stringify(perSource)}) resolve through the route reader to the same source_id`, failures.slice(0, 3).join(' | '));
    assert((perSource.himalayas ?? 0) > 0 && (perSource.weworkremotely ?? 0) > 0, 'both URL-id sources are covered by real rows');
  }
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} section skipped` : ''}`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

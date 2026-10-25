/**
 * RemoteMatch — sitemap index + bounded chunks suite
 * ==============================================================================
 * `/sitemap.xml` used to be one `<urlset>` with every eligible URL (26k today, growing ~4.5k/day; the protocol allows 50,000 URLs and
 * 50 MB per file). It is now a route handler that serves the same single urlset while everything fits in ONE file below
 * MAX_URLS_PER_FILE (44,999) URLs and MAX_BYTES_PER_FILE bytes, and a `<sitemapindex>` of `/sitemaps/{n}.xml` chunks beyond that.
 *
 * What this proves (pure — no env, no network, no database):
 *   1. SERIALISER PARITY: serializeUrlset() is byte-identical to Next's own `resolveSitemap` for ordinary input (incl. the real
 *      buildSitemap() output); it differs only where Next would emit invalid XML or throw (escaping, invalid dates);
 *   2. an independent strict XML reader parses every output (declaration, namespace, nesting, entity-only `&`), incl. hostile text;
 *   3. chunk planning at the boundaries (0, 1, 44,998, 44,999, 45,000, 89,997 … 120,001): every file < 45,000 URLs, ranges contiguous,
 *      nothing lost or repeated, a byte budget is honoured, and a lone oversize entry still gets its own file;
 *   4. the ROOT document: plain urlset below the cap (parity with the old output), index above it; index correctness (same-host absolute
 *      locs, count, newest lastmod, no lastmod when none); empty dataset; > 50,000 eligible URLs through the real response helpers;
 *   5. the CHUNK documents: 404 for malformed / out-of-range / urlset-mode requests; determinism; the documented positional drift;
 *   6. the real route handlers, offline (no Supabase client => static + hub + guide URLs only): headers, status, body;
 *   7. STATIC GUARDS: no `sitemap.(ts|js|tsx)` metadata file may exist under src/app (Next builds it silently and it shadows the
 *      route handlers — verified on 14.2.35), both handlers are force-dynamic GET handlers, robots still points at /sitemap.xml,
 *      the data module keeps the slim read + TTL cache + the cache key the sync route invalidates.
 *
 * Run: npx tsx test/sitemap-chunk-suite.ts
 */
import fs from 'fs';
import path from 'path';
import { SITE_URL } from '../src/lib/site';
import { buildSitemap } from '../src/lib/seo/sitemap-build';
import { escapeXml, serializeUrlset, serializeSitemapIndex, serializeUrlEntry, URLSET_OVERHEAD_BYTES, type SitemapUrlEntry } from '../src/lib/seo/sitemap-xml';
import {
  MAX_URLS_PER_FILE, MAX_BYTES_PER_FILE, dedupeByUrl, parseChunkParam, planChunks, newestLastModified,
  renderSitemapRoot, renderSitemapChunk, respondSitemapRoot, respondSitemapChunk, SITEMAP_RESPONSE_HEADERS,
} from '../src/lib/seo/sitemap-chunks';
// Next's own serialiser — the oracle for byte parity (re-verify on a Next upgrade).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveSitemap } = require('next/dist/build/webpack/loaders/metadata/resolve-route-data') as { resolveSitemap: (d: unknown[]) => string };

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---- an independent, strict reader for the documents we emit --------------------------------------------------------------------
interface Item { loc: string; lastmod?: string; changefreq?: string; priority?: string }
function unescapeText(t: string): string {
  if (/<|>/.test(t)) throw new Error('raw angle bracket in text: ' + t.slice(0, 40));
  const bad = t.replace(/&(amp|lt|gt|quot|apos);/g, '').match(/&/);
  if (bad) throw new Error('raw ampersand in text: ' + t.slice(0, 60));
  return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function parseSitemapXml(xml: string): { root: 'urlset' | 'sitemapindex'; items: Item[] } {
  const decl = '<?xml version="1.0" encoding="UTF-8"?>\n';
  if (!xml.startsWith(decl)) throw new Error('missing XML declaration');
  const body = xml.slice(decl.length);
  const m = /^<(urlset|sitemapindex) xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n([\s\S]*)<\/\1>\n$/.exec(body);
  if (!m) throw new Error('root element / namespace / closing tag mismatch');
  const root = m[1] as 'urlset' | 'sitemapindex'; const inner = m[2];
  const rowTag = root === 'urlset' ? 'url' : 'sitemap';
  const items: Item[] = []; let pos = 0;
  const open = `<${rowTag}>\n`, close = `</${rowTag}>\n`;
  while (pos < inner.length) {
    if (!inner.startsWith(open, pos)) throw new Error(`expected ${open.trim()} at ${pos}`);
    const end = inner.indexOf(close, pos);
    if (end < 0) throw new Error('unclosed ' + rowTag);
    const block = inner.slice(pos + open.length, end);
    const it: Item = { loc: '' }; let seenLoc = false;
    for (const line of block.split('\n').filter((l) => l.length)) {
      const mm = /^<(loc|lastmod|changefreq|priority)>(.*)<\/\1>$/.exec(line);
      if (!mm) throw new Error('unexpected line: ' + line.slice(0, 60));
      const v = unescapeText(mm[2]);
      if (mm[1] === 'loc') { it.loc = v; seenLoc = true; } else (it as any)[mm[1]] = v;
    }
    if (!seenLoc || !it.loc) throw new Error('entry without <loc>');
    items.push(it); pos = end + close.length;
  }
  return { root, items };
}
const synth = (n: number, urlLen = 0): SitemapUrlEntry[] => Array.from({ length: n }, (_, i) => ({ url: `https://h.test/j/${i}${urlLen ? 'x'.repeat(urlLen) : ''}`, lastModified: new Date(Date.UTC(2026, 0, 1) + i * 1000), changeFrequency: 'weekly', priority: 0.75 }));

(async () => {
console.log('\n1. Serialiser parity with Next, and where it deliberately differs');
{
  const base: SitemapUrlEntry[] = [
    { url: 'https://h.test/', lastModified: new Date('2026-10-25T10:43:19.000Z'), changeFrequency: 'daily', priority: 1 },
    { url: 'https://h.test/a', lastModified: '2026-03-08T00:00:00.000Z', changeFrequency: 'weekly', priority: 0.85 },
    { url: 'https://h.test/b' },
    { url: 'https://h.test/c', priority: 0 },
    { url: 'https://h.test/d', lastModified: new Date(0), changeFrequency: 'monthly' },
  ];
  assert(serializeUrlset(base) === resolveSitemap(base), 'five entries (Date / string lastmod, with and without changefreq / priority, priority 0 and 1): byte-identical to Next');
  assert(serializeUrlset([]) === resolveSitemap([]), 'empty list: byte-identical to Next');
  const jobs = Array.from({ length: 1200 }, (_, i) => ({ sourceId: i % 3 === 0 ? `https%3A%2F%2Fh.test%2Fjobs%2F${i}` : `slug-${i}`, title: i % 5 === 0 ? 'Senior React Engineer' : 'Account Manager', postedAt: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(), requiredSkills: i % 5 === 0 ? ['react'] : [] }));
  const real = buildSitemap(SITE_URL, jobs);
  assert(serializeUrlset(real) === resolveSitemap(real), `real buildSitemap() output (${real.length} URLs: static, hubs, jobs, guides): byte-identical to Next`);
  const nasty: SitemapUrlEntry[] = [{ url: `${SITE_URL}/remote-jobs/view/a&b<c>"d'e`, lastModified: new Date('2026-01-01T00:00:00Z'), changeFrequency: 'daily' }];
  assert(resolveSitemap(nasty).includes('a&b<c>') && !serializeUrlset(nasty).includes('a&b<c>'), 'Next writes the raw `a&b<c>` into <loc> (invalid XML); ours does not');
  assert(serializeUrlset(nasty).includes('<loc>' + SITE_URL + '/remote-jobs/view/a&amp;b&lt;c&gt;&quot;d&apos;e</loc>'), 'all five predefined entities are escaped');
  assert(escapeXml('&amp;') === '&amp;amp;' && escapeXml("<'\">&") === '&lt;&apos;&quot;&gt;&amp;', '`&` is escaped first (no double-escaping of the others)');
  const bad: SitemapUrlEntry[] = [{ url: 'https://h.test/x', lastModified: new Date('not a date') }, { url: 'https://h.test/y', lastModified: new Date('2026-02-02T00:00:00Z') }];
  let nextThrows = false; try { resolveSitemap(bad); } catch { nextThrows = true; }
  assert(nextThrows && !serializeUrlset(bad).split('</url>')[0].includes('<lastmod>') && serializeUrlset(bad).includes('<lastmod>2026-02-02T00:00:00.000Z</lastmod>'), 'an invalid Date makes Next throw (500 for the whole sitemap); ours omits that one lastmod and keeps the rest');
  assert(serializeUrlEntry({ url: 'https://h.test/p', priority: 0.1 + 0.2 }) === resolveSitemap([{ url: 'https://h.test/p', priority: 0.1 + 0.2 }]).replace(/^[\s\S]*?<url>\n/, '<url>\n').replace(/<\/urlset>\n$/, ''), 'numbers are written exactly as Next writes them');
}

console.log('\n2. The independent XML reader (also proves every emitted document is well-formed)');
{
  const hostile = [`${SITE_URL}/remote-jobs/view/a&b`, `${SITE_URL}/x?y=1&z=<2>`, `${SITE_URL}/q"uote'`, `${SITE_URL}/ünï/cödé/✓`, `${SITE_URL}/p%20ath/https%3A%2F%2Fa.test%2Fb`, `${SITE_URL}/]]>`, `${SITE_URL}/&amp;`].map((url) => ({ url, lastModified: new Date('2026-01-01T00:00:00Z'), changeFrequency: 'daily', priority: 0.5 }));
  const parsed = parseSitemapXml(serializeUrlset(hostile));
  assert(parsed.root === 'urlset' && parsed.items.length === hostile.length && parsed.items.every((it, i) => it.loc === hostile[i].url), 'hostile URLs (& < > quotes, non-ASCII, `]]>`, a literal `&amp;`, percent-encoding) round-trip exactly through serialise -> strict parse');
  assert(parsed.items[0].lastmod === '2026-01-01T00:00:00.000Z' && parsed.items[0].priority === '0.5' && parsed.items[0].changefreq === 'daily', 'lastmod / priority / changefreq are read back');
  let threw = false; try { parseSitemapXml(resolveSitemap([{ url: 'https://h.test/a&b' }])); } catch { threw = true; }
  assert(threw, 'the reader rejects Next\'s unescaped output (it is a real validator, not a pass-through)');
  const idx = parseSitemapXml(serializeSitemapIndex([{ url: `${SITE_URL}/sitemaps/0.xml`, lastModified: new Date('2026-05-05T05:05:05Z') }, { url: `${SITE_URL}/sitemaps/1.xml` }]));
  assert(idx.root === 'sitemapindex' && idx.items.length === 2 && idx.items[0].lastmod === '2026-05-05T05:05:05.000Z' && idx.items[1].lastmod === undefined, 'a sitemapindex parses; lastmod is optional per entry');
}

console.log('\n3. Chunk planning');
{
  const MAX = MAX_URLS_PER_FILE;
  assert(MAX === 44_999 && MAX < 45_000 && MAX < 50_000, 'MAX_URLS_PER_FILE is 44,999 (every file below 45,000, below the 50,000 protocol limit)');
  assert(MAX_BYTES_PER_FILE < 50 * 1024 * 1024, 'MAX_BYTES_PER_FILE is below the 50 MB protocol limit');
  const cases = [0, 1, 44_998, 44_999, 45_000, 89_997, 89_998, 89_999, 120_001, 134_998];
  for (const n of cases) {
    const entries = synth(n);
    const ranges = planChunks(entries);
    const expected = Math.max(1, Math.ceil(n / MAX));
    const sizes = ranges.map(([a, b]) => b - a);
    const contiguous = ranges.every(([a, b], i) => b >= a && (i === 0 ? a === 0 : a === ranges[i - 1][1])) && ranges[ranges.length - 1][1] === n;
    assert(ranges.length === expected && sizes.every((s) => s <= MAX && s < 45_000) && contiguous && sizes.reduce((x, y) => x + y, 0) === n, `${n} URLs -> ${expected} file(s), every one < 45,000 URLs, contiguous, nothing lost`, JSON.stringify({ got: ranges.length, sizes: sizes.slice(0, 4) }));
  }
  const e = synth(10, 50);
  const per = Buffer.byteLength(serializeUrlEntry(e[0]), 'utf8');
  const tiny = planChunks(e, 1000, 300 + per * 3);
  const lens = tiny.map(([a, b]) => Buffer.byteLength(serializeUrlset(e.slice(a, b)), 'utf8'));
  assert(tiny.length > 1 && lens.every((l) => l <= 300 + per * 3) && tiny.reduce((s, [a, b]) => s + b - a, 0) === 10, 'a byte budget splits before the URL cap and every serialised file honours it', JSON.stringify(lens));
  const fixed = Array.from({ length: 4 }, (_, i) => ({ url: `https://h.test/j/${String(i).padStart(4, '0')}` }));
  const fper = Buffer.byteLength(serializeUrlEntry(fixed[0]), 'utf8');
  const exact = planChunks(fixed, 1000, URLSET_OVERHEAD_BYTES + 3 * fper);
  assert(exact.length === 2 && exact[0][1] - exact[0][0] === 3 && Buffer.byteLength(serializeUrlset(fixed.slice(0, 3)), 'utf8') === URLSET_OVERHEAD_BYTES + 3 * fper, 'a file whose size is EXACTLY the byte budget is allowed (the boundary is "greater than", not "greater or equal")');
  const big = [{ url: 'https://h.test/' + 'y'.repeat(5000) }, { url: 'https://h.test/small' }];
  assert(planChunks(big, 10, 2000).length === 2 && planChunks(big, 10, 2000)[0][1] - planChunks(big, 10, 2000)[0][0] === 1, 'a lone entry larger than the byte budget still gets a file of its own');
  const long = synth(30_000, 3000); // ~3 kB URLs: 30,000 of them exceed the real 45 MB budget even though the URL count is far below the cap
  const lr = planChunks(long);
  assert(lr.length >= 2 && lr.every(([a, b]) => b - a <= MAX), `30,000 URLs of ~3 kB each: split by BYTES into ${lr.length} files although the count is below the cap`);
  const first = Buffer.byteLength(serializeUrlset(long.slice(lr[0][0], lr[0][1])), 'utf8'), last = Buffer.byteLength(serializeUrlset(long.slice(lr[lr.length - 1][0], lr[lr.length - 1][1])), 'utf8');
  assert(first <= MAX_BYTES_PER_FILE && last <= MAX_BYTES_PER_FILE && first < 50 * 1024 * 1024, `the first / last file serialise to ${(first / 1048576).toFixed(1)} / ${(last / 1048576).toFixed(1)} MB — within the 45 MB budget, below the 50 MB limit`);
  assert(JSON.stringify(planChunks(synth(100_000))) === JSON.stringify(planChunks(synth(100_000))), 'planning is deterministic');
}

console.log('\n4. The root document (/sitemap.xml)');
{
  const MAX = MAX_URLS_PER_FILE;
  const small = synth(500);
  const r1 = renderSitemapRoot(small);
  assert(r1.kind === 'urlset' && r1.fileCount === 1 && r1.xml === resolveSitemap(small), 'below the cap: a plain urlset, byte-identical to what the old sitemap route returned');
  const atCap = renderSitemapRoot(synth(MAX));
  assert(atCap.kind === 'urlset' && parseSitemapXml(atCap.xml).items.length === MAX, `exactly ${MAX} URLs still fit in one urlset`);
  const over = renderSitemapRoot(synth(MAX + 1));
  const oi = parseSitemapXml(over.xml);
  assert(over.kind === 'index' && over.fileCount === 2 && oi.root === 'sitemapindex' && oi.items.length === 2, `${MAX + 1} URLs -> a sitemapindex with 2 chunks`);
  assert(oi.items.every((it, i) => it.loc === `${SITE_URL}/sitemaps/${i}.xml` && new URL(it.loc).host === new URL(SITE_URL).host), 'index locs are absolute, on the SITE_URL host, numbered from 0');
  const ents = synth(MAX + 5); const idx2 = parseSitemapXml(renderSitemapRoot(ents).xml);
  // synth() dates rise by one second per entry, so the newest of each chunk is its LAST entry (computed here without the library)
  const want0 = new Date(Date.UTC(2026, 0, 1) + (MAX - 1) * 1000).toISOString(), want1 = new Date(Date.UTC(2026, 0, 1) + (MAX + 4) * 1000).toISOString();
  assert(idx2.items[0].lastmod === want0 && idx2.items[1].lastmod === want1, 'each index entry carries the NEWEST lastmod of its chunk (expected values computed independently)');
  const shuffled = synth(MAX + 5).reverse(); // newest first now: the answer must not depend on position
  const idx3 = parseSitemapXml(renderSitemapRoot(shuffled).xml);
  assert(idx3.items[0].lastmod === new Date(Date.UTC(2026, 0, 1) + (MAX + 4) * 1000).toISOString(), 'the newest lastmod is found wherever it sits in the chunk');
  assert(newestLastModified([{ url: 'a', lastModified: new Date('nope') }, { url: 'b', lastModified: new Date('2026-01-01T00:00:00Z') }])?.toISOString() === '2026-01-01T00:00:00.000Z' && newestLastModified([{ url: 'a', lastModified: new Date('nope') }, { url: 'b', lastModified: 'garbage' }]) === undefined && newestLastModified([{ url: 'a' }, { url: 'b', lastModified: '' }]) === undefined, 'invalid / empty dates are ignored by newestLastModified (never NaN, never a throw)');
  const withBad = synth(MAX + 2); withBad[3] = { ...withBad[3], lastModified: new Date('not a date') };
  assert(parseSitemapXml(renderSitemapRoot(withBad).xml).items[0].lastmod === want0 || parseSitemapXml(renderSitemapRoot(withBad).xml).items[0].lastmod === new Date(Date.UTC(2026, 0, 1) + (MAX - 1) * 1000).toISOString(), 'an invalid date inside a chunk does not break or blank the index entry');
  const escIdx = parseSitemapXml(renderSitemapRoot(synth(100), { siteUrl: 'https://a.test/?x=1&y=<2>', maxUrls: 40 }).xml);
  assert(escIdx.items.length === 3 && escIdx.items[0].loc === 'https://a.test/?x=1&y=<2>/sitemaps/0.xml', 'index locs are XML-escaped (a siteUrl with & < > round-trips through the strict parser)');
  const nodate = parseSitemapXml(renderSitemapRoot(Array.from({ length: MAX + 2 }, (_, i) => ({ url: `https://h.test/${i}` }))).xml);
  assert(nodate.items.every((it) => it.lastmod === undefined), 'chunks with no dates produce index entries without <lastmod>');
  const empty = renderSitemapRoot([]);
  assert(empty.kind === 'urlset' && parseSitemapXml(empty.xml).items.length === 0 && empty.xml === resolveSitemap([]), 'empty dataset: a valid, empty urlset (never an index)');
  assert(renderSitemapRoot(synth(100), { siteUrl: 'https://other.test', maxUrls: 40 }).xml.includes('<loc>https://other.test/sitemaps/0.xml</loc>'), 'the index host comes from the siteUrl option / SITE_URL');
  const dupes = dedupeByUrl([{ url: 'https://h.test/a', priority: 1 }, { url: 'https://h.test/b' }, { url: 'https://h.test/a', priority: 0.1 }, { url: 'https://h.test/b' }]);
  assert(dupes.length === 2 && dupes[0].url === 'https://h.test/a' && (dupes[0] as any).priority === 1 && dupes[1].url === 'https://h.test/b', 'duplicate URLs collapse to the first occurrence, order preserved');
  assert(dedupeByUrl(synth(1000)).length === 1000, 'the real catalog case (no duplicates) is untouched');

  // > 50,000 eligible URLs through the real response helpers
  const huge = synth(120_001);
  const rootRes = await respondSitemapRoot(async () => huge);
  const rootDoc = parseSitemapXml(await rootRes.text());
  assert(rootRes.status === 200 && rootRes.headers.get('content-type') === 'application/xml; charset=utf-8' && rootRes.headers.get('cache-control') === 'public, max-age=0, must-revalidate', 'GET /sitemap.xml with 120,001 URLs: 200, application/xml; charset=utf-8, revalidate cache header');
  assert(rootDoc.root === 'sitemapindex' && rootDoc.items.length === 3 && rootDoc.items.length < 50_000, '120,001 URLs -> an index of 3 chunks (far below the 50,000-sitemap index limit)');
  const seen = new Set<string>(); let total = 0, maxItems = 0, maxBytes = 0;
  for (let i = 0; i < 3; i++) {
    const res = await respondSitemapChunk(async () => huge, `${i}.xml`);
    const text = await res.text(); const doc = parseSitemapXml(text);
    total += doc.items.length; maxItems = Math.max(maxItems, doc.items.length); maxBytes = Math.max(maxBytes, Buffer.byteLength(text, 'utf8'));
    for (const it of doc.items) seen.add(it.loc);
    if (res.status !== 200 || doc.root !== 'urlset') { assert(false, `chunk ${i} status/root`, `${res.status} ${doc.root}`); }
  }
  assert(total === 120_001 && seen.size === 120_001 && maxItems < 45_000 && maxBytes < 50 * 1024 * 1024, `the 3 chunks hold all 120,001 URLs exactly once; largest chunk ${maxItems} URLs / ${(maxBytes / 1048576).toFixed(1)} MB`);
  const miss = await respondSitemapChunk(async () => huge, '3.xml');
  assert(miss.status === 404 && (await miss.text()) === 'Not Found', '/sitemaps/3.xml (out of range) -> 404');
}

console.log('\n5. The chunk documents (/sitemaps/{n}.xml)');
{
  for (const [p, n] of [['0.xml', 0], ['7.xml', 7], ['123456.xml', 123456]] as const) assert(parseChunkParam(p) === n, `parseChunkParam(${JSON.stringify(p)}) = ${n}`);
  const badNames = ['abc.xml', '01.xml', '00.xml', '0', '0.XML', '-1.xml', '1.5.xml', '.xml', '', '0.xml ', ' 0.xml', '0.xml.gz', '٣.xml', '0x1.xml', '9'.repeat(20) + '.xml'];
  assert(badNames.every((b) => parseChunkParam(b) === null) && parseChunkParam(undefined) === null && parseChunkParam(5) === null && parseChunkParam(null) === null, 'malformed names / non-strings are rejected (leading zeros, case, sign, decimals, suffixes, unsafe integers)');
  const entries = synth(MAX_URLS_PER_FILE + 100);
  assert(renderSitemapChunk(entries, '0.xml') !== null && renderSitemapChunk(entries, '1.xml') !== null && renderSitemapChunk(entries, '2.xml') === null && renderSitemapChunk(entries, 'x.xml') === null, 'index mode: chunks 0 and 1 exist, 2 and malformed names do not');
  assert(renderSitemapChunk(synth(10), '0.xml') === null, 'urlset mode (everything fits in one file): every chunk URL is 404');
  const c0 = renderSitemapChunk(entries, '0.xml')!, c1 = renderSitemapChunk(entries, '1.xml')!;
  assert(c0 === renderSitemapChunk(entries, '0.xml') && parseSitemapXml(c0).items.length === MAX_URLS_PER_FILE && parseSitemapXml(c1).items.length === 100, 'chunks are deterministic; sizes are 44,999 and the remainder');
  const l0 = parseSitemapXml(c0).items, l1 = parseSitemapXml(c1).items;
  assert(l0[0].loc === entries[0].url && l1[0].loc === entries[MAX_URLS_PER_FILE].url, 'chunks are consecutive slices of the ordered list (order preserved across the boundary)');
  // documented drift: inserting one URL ahead of the boundary moves exactly one URL across it
  const shifted = [{ url: 'https://h.test/j/-1' }, ...entries];
  const s1 = parseSitemapXml(renderSitemapChunk(shifted, '1.xml')!).items.map((i) => i.loc), o1 = l1.map((i) => i.loc);
  assert(s1.length === 101 && s1.slice(1).join('|') === o1.join('|') && s1[0] === entries[MAX_URLS_PER_FILE - 1].url, 'positional membership drift (documented): one inserted URL pushes exactly one URL from chunk 0 into chunk 1');
}

console.log('\n6. The real route handlers, offline (no Supabase client => static + hub + guide URLs only)');
{
  const savedEnv = { u: process.env.NEXT_PUBLIC_SUPABASE_URL, a: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  try {
    const rootMod = await import('../src/app/sitemap.xml/route');
    const chunkMod = await import('../src/app/sitemaps/[chunk]/route');
    const res = await rootMod.GET();
    const doc = parseSitemapXml(await res.text());
    assert(res.status === 200 && res.headers.get('content-type') === 'application/xml; charset=utf-8' && doc.root === 'urlset' && doc.items.length >= 5, `GET /sitemap.xml: 200, application/xml; charset=utf-8, a valid urlset (${doc.items.length} static/hub/guide URLs)`);
    assert(doc.items.every((it) => it.loc === SITE_URL || it.loc.startsWith(`${SITE_URL}/`)) && doc.items[0].loc === SITE_URL, 'every URL is on SITE_URL, the home page first (the old order)');
    const c = await chunkMod.GET(new Request('http://x/sitemaps/0.xml'), { params: Promise.resolve({ chunk: '0.xml' }) });
    assert(c.status === 404 && (await c.text()) === 'Not Found', 'GET /sitemaps/0.xml while everything fits in /sitemap.xml: 404');
    const c2 = await chunkMod.GET(new Request('http://x/sitemaps/abc.xml'), { params: Promise.resolve({ chunk: 'abc.xml' }) });
    assert(c2.status === 404, 'GET /sitemaps/abc.xml: 404');
    assert(rootMod.dynamic === 'force-dynamic' && chunkMod.dynamic === 'force-dynamic' && typeof rootMod.GET === 'function' && typeof chunkMod.GET === 'function', 'both route modules export `dynamic = "force-dynamic"` and a GET handler');
    assert(JSON.stringify(SITEMAP_RESPONSE_HEADERS) === JSON.stringify({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' }), 'response headers are the content type + the cache header Next\'s built-in sitemap route used');
  } finally { if (savedEnv.u !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.u; if (savedEnv.a !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = savedEnv.a; }
}

console.log('\n7. Static guards');
{
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const appFiles = walk(path.join(ROOT, 'src', 'app')).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  const metadataSitemaps = appFiles.filter((f) => /(^|\/)sitemap\.(ts|tsx|js|jsx)$/.test(f) || /(^|\/)sitemap\.xml$/.test(f));
  assert(metadataSitemaps.length === 0, 'no `sitemap.(ts|tsx|js|jsx)` or static `sitemap.xml` metadata file under src/app (Next 14.2.35 builds one next to the route handlers without error and it silently wins /sitemap.xml)', metadataSitemaps.join(', '));
  assert(appFiles.includes('src/app/sitemap.xml/route.ts') && appFiles.includes('src/app/sitemaps/[chunk]/route.ts'), 'the two route handlers exist');
  for (const f of ['src/app/sitemap.xml/route.ts', 'src/app/sitemaps/[chunk]/route.ts']) {
    const s = strip(read(f));
    assert(/export const dynamic = 'force-dynamic'/.test(s) && /export async function GET\(/.test(s) && /getSitemapEntries/.test(s), `${f}: force-dynamic GET handler fed by getSitemapEntries`);
  }
  assert(/sitemap: `\$\{SITE_URL\}\/sitemap\.xml`/.test(strip(read('src/app/robots.ts'))), 'robots.txt still advertises /sitemap.xml (now an index when needed)');
  const data = strip(read('src/lib/seo/sitemap-data.ts'));
  assert(/getSitemapJobEntries/.test(data) && /createAsyncTtlCache/.test(data) && /getOrCreateCatalogCache\('sitemap-entries'/.test(data) && /SITEMAP_TTL_MS = 6 \* 60 \* 60 \* 1000/.test(data) && /SITEMAP_MAX_STALE_MS = 24 \* 60 \* 60 \* 1000/.test(data) && !/getActiveJobs|getActiveOpportunities/.test(data), 'the data module keeps the slim read, the 6 h TTL / 24 h stale cache and the "sitemap-entries" cache key the sync route invalidates');
  assert(/dedupeByUrl\(buildSitemap\(SITE_URL, activeJobs\)\)/.test(data), 'the URL list is buildSitemap() (eligibility + order unchanged) passed through the duplicate filter only');
  const chunks = strip(read('src/lib/seo/sitemap-chunks.ts')), xml = strip(read('src/lib/seo/sitemap-xml.ts'));
  assert(!/process\.env|fetch\(|supabase/i.test(chunks + xml), 'the chunk and XML modules are pure (no env, no network, no database)');
  assert(/MAX_URLS_PER_FILE = 44_999/.test(chunks) && /MAX_BYTES_PER_FILE = 45 \* 1024 \* 1024/.test(chunks), 'the limits are the documented constants (44,999 URLs, 45 MiB)');
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

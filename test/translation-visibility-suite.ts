/**
 * Translation visibility — a listing whose translation FAILED is hidden everywhere.
 * ==============================================================================
 * The read-side multilingual gate was `source_language IS NULL OR = 'en' OR
 * translation_status = 'ok'`. A row whose translation errored WITHOUT a detected
 * language keeps source_language NULL, so it passed the gate and stayed visible —
 * untranslated, forever. The gate now also requires translation_status to not be
 * 'error' (TRANSLATION_NOT_ERROR_OR, applied by every user-facing / SEO read).
 *
 *  §1 static   every gated read uses the shared gate; no stray copies of the old one
 *  §2 real     live Supabase, isolated rows covering every language × status
 *              combination, checked through EVERY read path:
 *              feed catalog read, hub index, sitemap read, by-id rows (hub pages),
 *              related jobs, directory search, the feed cache, loadHubPage(), and
 *              the real sitemap() route function. Also proves the OLD gate leaked.
 *
 * Run: npx tsx --env-file=.env.migration.local test/translation-visibility-suite.ts
 */
import fs from 'fs';
import path from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import {
  TRANSLATION_SAFE_OR,
  TRANSLATION_NOT_ERROR_OR,
  applyTranslationSafe,
  getActiveOpportunities,
  getCatalogIndexEntries,
  getSitemapJobEntries,
  getOpportunitiesBySourceIds,
  getRelatedActiveOpportunities,
  searchActiveOpportunitiesPage,
} from '../src/lib/ingestion/catalog-read';
import { getFeedCatalog } from '../src/lib/feed/catalog-cache';
import { loadHubPage, resetDirectoryCachesForTests } from '../src/lib/seo/directory';
import { invalidateCatalogCaches } from '../src/lib/ingestion/catalog-caches';

let passed = 0, failed = 0, skipped = 0;
const assert = (ok: boolean, msg: string, detail?: string) => {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; } else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
};
const skip = (m: string) => { skipped++; console.log(`  – SKIP: ${m}`); };
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('\n1. STATIC');
  const rawCatalog = read('src/lib/ingestion/catalog-read.ts');
  const catalog = noComments(rawCatalog);
  assert(TRANSLATION_NOT_ERROR_OR === 'translation_status.is.null,translation_status.neq.error', "the new clause keeps NULL-status rows (SQL's NULL <> 'error' is NULL) and drops 'error'");
  assert(TRANSLATION_SAFE_OR === 'source_language.is.null,source_language.eq.en,translation_status.eq.ok', 'the original gate clause is unchanged');
  const literal = (catalog.match(/'source_language\.is\.null,source_language\.eq\.en,translation_status\.eq\.ok'/g) || []).length;
  assert(literal === 1, `the gate string exists exactly once (the constant's definition) — no stray copies that could drift (${literal})`);
  const direct = (catalog.match(/\.or\(TRANSLATION_SAFE_OR\)\s*\.or\(TRANSLATION_NOT_ERROR_OR\)/g) || []).length;
  const viaHelper = (catalog.match(/applyTranslationSafe\(query\)/g) || []).length;
  assert(direct + viaHelper >= 6, `every gated read applies BOTH clauses (${direct} direct + ${viaHelper} via applyTranslationSafe)`);
  const onlyOldGate = (catalog.match(/\.or\(TRANSLATION_SAFE_OR\)(?!\s*\.or\(TRANSLATION_NOT_ERROR_OR\))/g) || []).length;
  assert(onlyOldGate === 0, 'no read applies the old clause on its own');
  const others = ['src/lib/seo/directory.ts', 'src/lib/feed/catalog-cache.ts', 'src/app/sitemap.ts'].map((f) => noComments(read(f)));
  assert(others.every((s) => !/source_language\.is\.null/.test(s)), 'directory, feed cache and sitemap carry no private copy of the gate (they go through catalog-read)');
  assert(/translationSafe/.test(catalog) && /applyTranslationSafe\(query\)/.test(catalog), 'getActiveOpportunities({ translationSafe }) uses the shared helper');

  console.log('\n2. REAL INFRA — every language × status combination, through every read path');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey) { skip('Supabase env incomplete'); return finish(); }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const PREFIX = `tvis-${Date.now().toString(36)}-`;

  const { count: preExisting } = await admin.from('opportunities').select('source_id', { count: 'exact', head: true });
  const mk = (key: string, over: Record<string, unknown>) => ({
    source: 'remotive', source_id: `${PREFIX}${key}`, type: 'job', title: `Visibilityword ${key}`, company: 'Vis Co', company_logo: null,
    description: `Description for ${key}. `.repeat(12), source_url: 'https://example.com', official_url: 'https://example.com/apply',
    canonical_url_hash: `h-${PREFIX}${key}`, content_hash: `c-${PREFIX}${key}`, employment_type: 'Full-time', remote_type: 'Worldwide',
    eligible_countries: [], excluded_countries: [], timezone_requirements: [], required_skills: ['TypeScript'], explicit_remote_scope: 'explicit_worldwide',
    status: 'active', posted_at: new Date(Date.now() - 3600_000).toISOString(), first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(),
    consecutive_absences: 0, ...over,
  });
  const spec: Array<[string, Record<string, unknown>, boolean]> = [
    ['vis-en-na',     { source_language: 'en', translation_status: 'n/a' }, true],
    ['vis-null-null', { source_language: null, translation_status: null }, true],   // not processed yet: visible by design
    ['vis-de-ok',     { source_language: 'de', translation_status: 'ok' }, true],
    ['hid-null-err',  { source_language: null, translation_status: 'error' }, false], // THE GAP: failed, language unknown
    ['hid-de-err',    { source_language: 'de', translation_status: 'error' }, false],
    ['hid-en-err',    { source_language: 'en', translation_status: 'error' }, false],
    ['hid-de-null',   { source_language: 'de', translation_status: null }, false],    // foreign, never translated
    ['hid-expired',   { source_language: 'en', translation_status: 'n/a', status: 'expired' }, false],
  ];
  const visible = new Set(spec.filter((s) => s[2]).map((s) => `${PREFIX}${s[0]}`));
  const hidden = new Set(spec.filter((s) => !s[2]).map((s) => `${PREFIX}${s[0]}`));
  const all = [...Array.from(visible), ...Array.from(hidden)];
  const mine = <T extends { sourceId: string }>(a: T[]) => a.filter((x) => x.sourceId.startsWith(PREFIX));
  const ids = (a: Array<{ sourceId: string }>) => new Set(mine(a).map((x) => x.sourceId));
  const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && Array.from(a).every((x) => b.has(x));
  const check = (label: string, got: Set<string>) =>
    assert(sameSet(got, visible), `${label}: shows exactly the ${visible.size} visible rows and none of the ${hidden.size} hidden ones`, `got ${Array.from(got).map((x) => x.replace(PREFIX, '')).sort().join(',')}`);

  try {
    const { error } = await admin.from('opportunities').insert(spec.map(([k, o]) => mk(k, o)));
    if (error) { assert(false, 'seed', error.message); return finish(); }
    assert(true, `seeded ${spec.length} rows: every language × status combination (${preExisting ?? 0} other rows exist in the table)`);
    resetDirectoryCachesForTests();

    check('feed catalog read   getActiveOpportunities({ freshOnly, translationSafe })', ids(await getActiveOpportunities(anon, { freshOnly: true, translationSafe: true })));
    check('full read           getActiveOpportunities({ translationSafe })', ids(await getActiveOpportunities(anon, { translationSafe: true })));
    check('hub index           getCatalogIndexEntries', ids(await getCatalogIndexEntries(anon)));
    check('sitemap read        getSitemapJobEntries', ids(await getSitemapJobEntries(anon)));
    check('hub page rows       getOpportunitiesBySourceIds(all ids)', ids(await getOpportunitiesBySourceIds(anon, all)));
    const search = await searchActiveOpportunitiesPage(anon, ['visibilityword'], { from: 0, to: 49 });
    check('directory search    searchActiveOpportunitiesPage', ids(search.rows));
    assert(search.total === search.rows.length, `the search COUNT honours the gate too (total ${search.total} = rows ${search.rows.length}), so pagination never promises hidden rows`);

    if ((preExisting ?? 0) <= 30) {
      check('related jobs        getRelatedActiveOpportunities(limit 20)', ids(await getRelatedActiveOpportunities(anon, `${PREFIX}__none__`, 20)));
    } else skip('related-jobs check needs a near-empty table (its LIMIT could exclude the seeded rows)');

    // the shared in-memory layers on top
    invalidateCatalogCaches();
    check('feed cache          getFeedCatalog()', ids((await getFeedCatalog()) ?? []));
    const hub = await loadHubPage(null, '1');
    check('directory hub       loadHubPage(null, 1)', ids(hub?.jobs ?? []));
    const { default: sitemap } = await import('../src/app/sitemap');
    const sm = await sitemap();
    const smIds = new Set(sm.map((e) => e.url).filter((u) => u.includes(`/view/${PREFIX}`)).map((u) => u.split('/view/')[1]));
    check('sitemap route       sitemap()', smIds);

    // The point of the change: the OLD gate alone leaked the "failed, language unknown" row.
    const oldGate = await admin.from('opportunities').select('source_id').like('source_id', `${PREFIX}%`).or(TRANSLATION_SAFE_OR);
    const oldIds = new Set((oldGate.data ?? []).map((r: any) => r.source_id as string));
    assert(oldIds.has(`${PREFIX}hid-null-err`), 'REGRESSION EVIDENCE: the old gate alone DID let a failed-translation, unknown-language row through');
    const newGate = await applyTranslationSafe(admin.from('opportunities').select('source_id').like('source_id', `${PREFIX}%`));
    const newIds = new Set((newGate.data ?? []).map((r: any) => r.source_id as string));
    assert(!newIds.has(`${PREFIX}hid-null-err`) && !newIds.has(`${PREFIX}hid-en-err`) && newIds.has(`${PREFIX}vis-null-null`), 'the shared gate hides every error row and still shows not-yet-processed (NULL/NULL) rows');
    // Reads that do NOT ask for the gate are unchanged (admin tooling must still see error rows).
    const ungated = ids(await getActiveOpportunities(anon));
    assert(ungated.has(`${PREFIX}hid-null-err`) && ungated.has(`${PREFIX}hid-de-err`), 'a read WITHOUT translationSafe is unchanged: error rows are still returned (admin views, the translation pass)');
  } finally {
    const { error } = await admin.from('opportunities').delete().like('source_id', `${PREFIX}%`);
    const { count } = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
    assert(!error && (count ?? 0) === 0, `cleanup: all synthetic rows removed (${count ?? 0} remain)`, error?.message);
    invalidateCatalogCaches();
  }
  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

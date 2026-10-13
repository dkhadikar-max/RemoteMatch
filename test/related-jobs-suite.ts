/**
 * Related-jobs bounded read — egress fix.
 * ==============================================================================
 * The job page's "related jobs" cards used to call getActiveJobs() (the WHOLE
 * catalog, ~21 MB on the wire at ~23k rows) on every view just to keep 3 rows.
 * They now call getRelatedJobs(): a database-side LIMIT 3.
 *
 *  §1 static   the page no longer reads the full catalog; the new read is bounded
 *  §2 real     against the live catalog as the anon role (RLS = active only):
 *              returns <= 3, excludes the viewed job, active + translation-safe,
 *              mapped to CanonicalOpportunity, limit is clamped, tiny payload
 *
 * Run: npx tsx --env-file=.env.migration.local test/related-jobs-suite.ts   (seeds + removes 5 isolated rows when a service key is present)
 */
import fs from 'fs';
import path from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import { getRelatedActiveOpportunities } from '../src/lib/ingestion/catalog-read';
import { getRelatedJobs } from '../src/lib/seo/data';

let passed = 0;
let failed = 0;
function assert(ok: boolean, msg: string, detail?: string) {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; }
  else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
}
// CRLF-normalised: this repo's working tree is CRLF on Windows, and the function-body slicing below keys on "\n}\n".
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

async function main() {
  console.log('\n1. STATIC');
  const page = noComments(read('src/app/remote-jobs/view/[id]/page.tsx'));
  assert(/getRelatedJobs\(/.test(page) && /getRelatedJobs,/.test(page), 'the job page imports and calls getRelatedJobs');
  assert(!/getActiveJobs/.test(page), 'the job page no longer references getActiveJobs (the whole-catalog read)');
  assert(!/\.slice\(0,\s*3\)/.test(page), 'the in-memory ".slice(0, 3)" of a full catalog is gone');
  const catalog = noComments(read('src/lib/ingestion/catalog-read.ts'));
  const fn = catalog.slice(catalog.indexOf('export async function getRelatedActiveOpportunities'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert(/\.limit\(/.test(body), 'getRelatedActiveOpportunities applies a database-side .limit()');
  assert(/\.neq\('source_id'/.test(body), 'it excludes the viewed job in the database (.neq source_id)');
  assert(/\.or\(TRANSLATION_SAFE_OR\)/.test(body) && /\.or\(TRANSLATION_NOT_ERROR_OR\)/.test(body), 'it applies the same multilingual gate as the full read (both shared clauses)');
  assert(!/getActiveOpportunities\(/.test(body) && !/\.range\(/.test(body) && !/while \(true\)/.test(body), 'it never pages or calls the full-catalog read');
  assert(!/\.order\(/.test(body), 'it is unordered (an ORDER BY would sort the whole active set to pick 3 rows)');
  const seo = noComments(read('src/lib/seo/data.ts'));
  assert(/export async function getRelatedJobs/.test(seo) && /getActiveJobs\(supabase\)/.test(seo), 'getActiveJobs is still exported for its other callers (directory search, category hubs)');

  console.log('\n2. REAL INFRA — live catalog as the anon role');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log('  (skipped: Supabase env not set)');
  } else {
    const anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws as any } });
    // A fresh database has an empty catalog, which would make this section depend on whatever happens to be
    // live. When a service key is available, seed 5 isolated active English rows (removed again at the end) so
    // the section is self-contained; without one it falls back to whatever the anon role can already see.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const admin = serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws as any } }) : null;
    const PREFIX = `rjs-${Date.now().toString(36)}-`;
    let seeded = false;
    if (admin) {
      const rows = [1, 2, 3, 4, 5].map((n) => ({
        source: 'remotive', source_id: `${PREFIX}${n}`, type: 'job', title: `Relatedword ${n}`, company: 'Related Co', company_logo: null,
        description: `Description for related ${n}. `.repeat(12), source_url: 'https://example.com', official_url: 'https://example.com/apply',
        canonical_url_hash: `h-${PREFIX}${n}`, content_hash: `c-${PREFIX}${n}`, employment_type: 'Full-time', remote_type: 'Worldwide',
        eligible_countries: [], excluded_countries: [], timezone_requirements: [], required_skills: ['TypeScript'], explicit_remote_scope: 'explicit_worldwide',
        status: 'active', source_language: 'en', translation_status: 'n/a', posted_at: new Date(Date.now() - 3600_000).toISOString(),
        first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0,
      }));
      const ins = await admin.from('opportunities').insert(rows);
      assert(!ins.error, 'setup: 5 isolated synthetic active rows seeded', ins.error?.message);
      seeded = !ins.error;
    }
    const pick = seeded ? { data: [{ source_id: `${PREFIX}1` }], error: null } : await anon.from('opportunities').select('source_id').limit(1);
    const viewed = pick.data?.[0]?.source_id as string | undefined;
    assert(!!viewed, 'setup: an active job is visible to the anon role', pick.error?.message);

    if (viewed) {
      const rel = await getRelatedJobs(anon, viewed, 3);
      assert(rel.length === 3, `returns exactly 3 related jobs (got ${rel.length})`);
      assert(rel.every((j) => j.sourceId !== viewed), 'none of them is the job being viewed');
      assert(rel.every((j) => j.status === 'active'), 'all are active (RLS-enforced)');
      assert(rel.every((j) => !!j.title && !!j.company && !!j.sourceId), 'mapped to CanonicalOpportunity with title/company/sourceId (what the cards render)');
      assert(new Set(rel.map((j) => j.sourceId)).size === rel.length, 'no duplicates');
      const raw = await anon.from('opportunities').select('source_id, source_language, translation_status').in('source_id', rel.map((j) => j.sourceId));
      assert((raw.data ?? []).every((r: any) => r.source_language === null || r.source_language === 'en' || r.translation_status === 'ok'), 'all are translation-safe (no untranslated non-English listing)');
      const payload = JSON.stringify(rel).length;
      assert(payload < 100_000, `the whole result is tiny (${(payload / 1024).toFixed(1)} KB; the full read it replaces is ~70 MB uncompressed)`);

      const none = await getRelatedActiveOpportunities(anon, '__no-such-source-id__', 3);
      assert(none.length === 3, 'a non-existent exclude id still returns 3 (nothing special-cased)');
      assert((await getRelatedActiveOpportunities(anon, viewed, 0)).length === 1, 'limit 0 is clamped up to 1');
      assert((await getRelatedActiveOpportunities(anon, viewed, 999)).length <= 20, 'limit 999 is clamped to at most 20');
    }

    if (admin && seeded) {
      const del = await admin.from('opportunities').delete().like('source_id', `${PREFIX}%`);
      const left = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
      assert(!del.error && (left.count ?? 0) === 0, `cleanup: all synthetic rows removed (${left.count ?? 0} remain)`, del.error?.message);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

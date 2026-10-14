/**
 * RemoteMatch — match-detail links must work for EVERY job id
 * ==============================================================================
 * Production bug (found 2026-10-14 while verifying PR #9): `/match/${id}` was built unencoded, and the ids of Himalayas
 * and WeWorkRemotely jobs contain a URL ("opp-himalayas-https://himalayas.app/…"). Next 308-collapsed `//` to `/` and
 * 404'd: 1,400 of 1,488 live feed jobs (94 %) had a dead "View details" / "See why it matches" / "View Match" link.
 *
 * This suite proves, without touching any id: (1) matchHref/resolveJobId round-trip every id shape — including the real
 * ids of every source in the live catalog (read-only) and a randomised corpus of hostile characters; (2) the rendered
 * links are encoded; (3) no raw `/match/${…}` link remains anywhere in src/; (4) the match page resolves its param through
 * resolveJobId; (5) job ids, ingestion and snapshots are untouched. The framework behaviour itself (routing + param
 * delivery on the repo's Next version) is covered end-to-end by test/match-route-framework-suite.ts.
 *
 * Read-only (the live-catalog section reads the feed catalog, like profile-integrity-suite). No writes.
 * Run: npx tsx --env-file=<env file> test/match-link-suite.ts      (works without env; the catalog section is then skipped)
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ws from 'ws';
(globalThis as unknown as { React: unknown; WebSocket: unknown }).React = React;
(globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
import { matchHref, candidateIdsFromParam, resolveJobId } from '../src/lib/match/match-href';
import { JobCard } from '../src/components/feed/job-card';
import { CURATED_JOBS } from '../src/lib/providers/curated';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';

let passed = 0;
let failed = 0;
let skipped = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/** What Next delivers for `/match/<segment>`: the segment, STILL ENCODED (verified on 14.2.35 dev + production server). */
const nextParamFor = (href: string) => href.slice('/match/'.length);

const SHAPES: Array<[string, string]> = [
  ['himalayas (URL id)', 'opp-himalayas-https://himalayas.app/companies/easypost/jobs/technical-support-engineer-i'],
  ['weworkremotely (URL id)', 'opp-weworkremotely-https://weworkremotely.com/remote-jobs/baymard-institute-market-research-data-analyst'],
  ['jobicy (numeric)', 'opp-jobicy-153099'],
  ['greenhouse', 'opp-greenhouse-airbnb-7654321'],
  ['ashby (uuid)', 'opp-ashby-linear-3f2b9c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'],
  ['lever', 'opp-lever-spotify-8c1d2e3f-aaaa-bbbb-cccc-0123456789ab'],
  ['arbeitnow (slug)', 'opp-arbeitnow-senior-product-designer-m-f-d-berlin-123456'],
  ['remotive', 'opp-remotive-1234567'],
  ['already-percent-encoded in the id', 'opp-himalayas-https://x.com/a%20b/c%2Fd'],
  ['query, fragment, ampersand', 'opp-himalayas-https://x.com/jobs/1?utm=a&b=c#frag'],
  ['unicode', 'opp-himalayas-https://x.com/jobs/ünïcode-日本語/ü'],
  ['plus, space, trailing percent', 'opp-himalayas-https://x.com/a+b/c d/100%'],
  ['dot segments', 'opp-himalayas-https://x.com/../a/./b/..//c'],
  ['backslash and quotes', "opp-x-https://x.com/a\\b/'c\"d"],
];

async function main() {
  console.log('='.repeat(78));
  console.log('MATCH-DETAIL LINKS');
  console.log('='.repeat(78));

  console.log('\n1. matchHref / resolveJobId — the old bug, then the round trip');
  const hima = SHAPES[0][1];
  assert(`/match/${hima}`.replace(/\/{2,}/g, '/').split('/').length > 3, 'REPRODUCED: the old raw link for a Himalayas id is multi-segment after Next collapses "//" (so it cannot match /match/[jobId])');
  const hrefH = matchHref(hima);
  assert(hrefH.startsWith('/match/') && !hrefH.slice('/match/'.length).includes('/') && !/[?#]/.test(hrefH), 'the new link for a Himalayas id is exactly ONE path segment, with no ? or #', hrefH);
  for (const [label, id] of SHAPES) {
    const href = matchHref(id);
    const oneSegment = href.startsWith('/match/') && !href.slice('/match/'.length).includes('/') && !/[?#]/.test(href);
    const hit = resolveJobId(nextParamFor(href), [{ id: 'opp-decoy-1' }, { id }, { id: id + 'x' }]);
    assert(oneSegment && hit?.id === id, `${label}: encoded into one segment and resolves back to the exact id`, `${href.slice(0, 90)} → ${hit?.id}`);
  }
  assert(SHAPES.every(([, id]) => matchHref(id) === `/match/${encodeURIComponent(id)}`) && SHAPES.every(([, id]) => typeof id === 'string'), 'matchHref never alters the id — it only encodes it (ids still key swipes, applications and snapshots)');

  console.log('\n2. Old links keep working (bookmarks, emails)');
  const jobs = [{ id: 'opp-jobicy-153099' }, { id: 'opp-greenhouse-airbnb-7654321' }];
  assert(resolveJobId('opp-jobicy-153099', jobs)?.id === 'opp-jobicy-153099', 'a raw link to a slash-free id still resolves');
  assert(resolveJobId('opp-x-abc%20def', [{ id: 'opp-x-abc%20def' }])?.id === 'opp-x-abc%20def', 'a raw link to an id containing a literal %20 resolves to that id, not to a decoded lookalike');
  assert(resolveJobId('opp-x-abc%', [{ id: 'opp-x-abc%' }])?.id === 'opp-x-abc%', 'a malformed escape never throws and still resolves');
  assert(resolveJobId('nope', jobs) === null && resolveJobId('', jobs) === null && resolveJobId(undefined, jobs) === null && resolveJobId(['a'] as unknown, jobs) === null, 'an unknown, empty, missing or non-string param resolves to null (the page then shows its existing not-found path)');
  assert(JSON.stringify(candidateIdsFromParam('a%2Fb')) === '["a/b","a%2Fb"]' && JSON.stringify(candidateIdsFromParam('plain')) === '["plain"]', 'candidates: decoded-once first, then the raw param, de-duplicated');

  console.log('\n3. Randomised hostile ids round-trip');
  let rng = 20261014;
  const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const alphabet = ['a', 'Z', '0', '-', '_', '.', '/', '//', ':', '?', '#', '&', '=', '%', '%2F', '%20', '+', ' ', 'ü', '日', '\\', '"', "'", '<', '>', '..', '~', '@', '[', ']', '{', '}', '|', '^', '`', '😀'];
  let bad = '';
  for (let i = 0; i < 3000 && !bad; i++) {
    const id = 'opp-src-' + Array.from({ length: 1 + Math.floor(rnd() * 25) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
    const href = matchHref(id);
    const seg = href.slice('/match/'.length);
    const ok = !seg.includes('/') && !/[?#\\]/.test(seg) && resolveJobId(seg, [{ id: 'decoy' }, { id }])?.id === id;
    if (!ok) bad = JSON.stringify(id);
  }
  assert(bad === '', '3,000 random ids built from "/", "//", "?", "#", "%", "%2F", "+", spaces, unicode, emoji, dots… all become one segment and resolve back exactly', bad);

  console.log('\n4. REAL ids from every source in the live catalog (read-only)');
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    skipped++;
    console.log('  – skipped: no Supabase env (run with --env-file to include the real-id section)');
  } else {
    const { getFeedCatalog } = await import('../src/lib/feed/catalog-cache');
    const catalog = (await getFeedCatalog()) ?? [];
    assert(catalog.length > 0, `loaded the live feed catalog (${catalog.length} jobs)`);
    const bySource: Record<string, { n: number; withSlash: number; ok: number }> = {};
    let failures = '';
    for (const o of catalog) {
      const src = o.id.split('-')[1] ?? '?';
      const b = (bySource[src] ??= { n: 0, withSlash: 0, ok: 0 });
      b.n++;
      if (o.id.includes('/')) b.withSlash++;
      const href = matchHref(o.id);
      const seg = href.slice('/match/'.length);
      if (!seg.includes('/') && !/[?#]/.test(seg) && resolveJobId(seg, catalog)?.id === o.id) b.ok++; else if (!failures) failures = o.id;
    }
    for (const [src, b] of Object.entries(bySource)) assert(b.ok === b.n, `${src}: all ${b.n} real ids (${b.withSlash} contain "/") produce a one-segment link that resolves to the same job`, failures);
    const ids = new Set(catalog.map((o) => o.id));
    assert(ids.size === catalog.length, 'every real id is unique, so the lookup cannot confuse two jobs');
    assert(Object.values(bySource).some((b) => b.withSlash > 0), 'the live catalog really contains slash ids (this is the production bug; the check is not vacuous)');
  }

  console.log('\n5. Rendered links');
  const opp = { ...(normalizeOpportunity(CURATED_JOBS[0])), id: hima };
  const html = renderToStaticMarkup(React.createElement(JobCard, { opportunity: opp as never }));
  const hrefs = Array.from(html.matchAll(/href="([^"]*\/match\/[^"]*)"/g)).map((m) => m[1].replace(/&amp;/g, '&'));
  assert(hrefs.length === 1 && hrefs[0] === matchHref(hima), 'JobCard renders the encoded href for a URL-style id', hrefs.join(' | '));
  assert(!html.includes(`href="/match/${hima}"`), 'JobCard no longer renders the raw link');

  console.log('\n6. No raw link is left, and the page resolves through the helper');
  const walk = (dir: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(e.name)) walk(p, out); } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); } return out; };
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
  const raw = walk(path.join(root, 'src')).filter((f) => rel(f) !== 'src/lib/match/match-href.ts' && /\/match\/\$\{/.test(fs.readFileSync(f, 'utf8'))).map(rel);
  assert(raw.length === 0, 'no `/match/${…}` template literal remains in src/ outside the helper', raw.join(', '));
  const sites: Array<[string, string]> = [['feed card ("View details" / "See why it matches")', 'src/components/feed/job-card.tsx'], ['swipe toast ("View Match")', 'src/components/feed/swipe-deck.tsx'], ['Tracker', 'src/app/tracker/page.tsx'], ['landing page', 'src/app/page.tsx']];
  for (const [label, file] of sites) {
    const s = read(file);
    assert(s.includes("from '@/lib/match/match-href'") && /href=\{matchHref\(/.test(s), `${label}: builds its link with matchHref`);
  }
  assert((read('src/app/tracker/page.tsx').match(/href=\{matchHref\(opp\.id\)\}/g) ?? []).length === 2, 'Tracker: both "View match & apply" links use matchHref');
  const page = read('src/app/match/[jobId]/page.tsx');
  assert(page.includes("import { resolveJobId } from '@/lib/match/match-href'") && page.includes('opp = resolveJobId(jobId, data.opportunities as CanonicalOpportunity[]);'), 'the match page resolves its route param with resolveJobId (decode once, accept old raw links)');
  assert(!/\.find\(\(o\) => o\.id === jobId\)/.test(page), 'the match page no longer compares the raw route param to ids');
  const mw = read('src/middleware.ts');
  assert(mw.includes("'/match'") && /matchesAny/.test(mw), 'middleware still gates /match by path prefix — an encoded id stays inside that prefix (the path is /match/<one segment>)');
  assert(new URL(hrefH, 'https://remotematch.online').pathname.startsWith('/match/'), 'the URL parser keeps the encoded id inside the /match/ path');

  console.log('\n7. Scope — ids, ingestion, snapshots, matching, data untouched');
  const lines = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // Pinned to THIS change's own commit range (PR #13: c3499c7..30a75c9), not a moving branch diff, so the guard keeps
  // holding after the PR merges and when later branches add other files. Skipped, with a note, if those commits are not
  // in this clone (shallow clone, or the branch was deleted after merge).
  const PINNED_BASE = 'c3499c7';
  const PINNED_TIP = '30a75c9';
  const pinnedAvailable = (() => { try { execSync('git cat-file -e ' + PINNED_BASE, { cwd: root, stdio: 'ignore' }); execSync('git cat-file -e ' + PINNED_TIP, { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } })();
  const changed = pinnedAvailable ? lines(`git diff --name-only ${PINNED_BASE} ${PINNED_TIP}`) : [];
  if (!pinnedAvailable) console.log('  (scope guard skipped: pinned commits ' + PINNED_BASE + '..' + PINNED_TIP + ' are not in this clone)');
  const allowed = new Set(['src/lib/match/match-href.ts', 'src/components/feed/job-card.tsx', 'src/components/feed/swipe-deck.tsx', 'src/app/tracker/page.tsx', 'src/app/page.tsx', 'src/app/match/[jobId]/page.tsx', 'test/match-link-suite.ts', 'test/match-route-framework-suite.ts']);
  assert(changed.every((f) => allowed.has(f)), 'only the helper, the five link sites, the match page and the tests changed', changed.filter((f) => !allowed.has(f)).join(', '));
  assert(changed.every((f) => !['src/lib/ingestion/', 'src/lib/matching/', 'src/app/api/', 'supabase/', 'src/lib/providers/', 'src/lib/db/', 'scripts/'].some((x) => f.startsWith(x))), 'ingestion (where ids are made), matcher, API routes (swipe/snapshots), migrations, providers and stores are untouched');
  const catalogRead = read('src/lib/ingestion/catalog-read.ts');
  assert(catalogRead.includes('id: `opp-${row.source}-${row.source_id}`'), 'job ids are still derived exactly as `opp-${source}-${source_id}` (unchanged)');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });

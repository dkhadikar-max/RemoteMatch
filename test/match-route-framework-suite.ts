/**
 * RemoteMatch — END-TO-END: does the framework route and deliver an encoded job id correctly?
 * ==============================================================================
 * test/match-link-suite.ts proves the helper round-trips ids. THIS suite proves the part that depends on the framework:
 * it builds and serves (`next build` + `next start`, the repo's own Next version) a minimal app that has the same
 * single-segment `/match/[jobId]` route, requests it with the links the REAL `matchHref` produces — for representative ids
 * of every source, edge shapes, and (with env) real ids from the live catalog — and asserts for each id:
 *   - the response is 200 (route matched, not 404 / not redirected),
 *   - the SERVER-side `params.jobId` and the CLIENT-side `useParams().jobId` both decode exactly once to the original id.
 * It also records what the OLD raw link does for URL-style ids (308 → 404), documenting why the fix exists.
 *
 * Why a probe app and not the real app: `/match` sits behind the auth middleware, and a test must not mint sessions for real
 * users. The probe has the same route shape; middleware only checks the path PREFIX, and an encoded id stays inside it.
 * The probe is created in a temporary folder inside the repo and removed afterwards. Needs no env and touches no data.
 * Slow (~1–2 min: a Next build). Run: npx tsx test/match-route-framework-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { matchHref, resolveJobId } from '../src/lib/match/match-href';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const PROBE = path.join(root, '.tmp-match-probe');
const NEXT_BIN = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

const freePort = () => new Promise<number>((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); s.on('error', reject); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decodeHtml = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const grab = (html: string, id: string) => { const m = html.match(new RegExp(`<pre id="${id}">([\\s\\S]*?)</pre>`)); return m ? JSON.parse(decodeHtml(m[1])) : null; };
const once = (s: string | null) => { if (s === null) return null; try { return decodeURIComponent(s); } catch { return null; } };

function writeProbe() {
  fs.rmSync(PROBE, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROBE, 'app', 'match', '[jobId]'), { recursive: true });
  fs.writeFileSync(path.join(PROBE, 'app', 'layout.js'), 'export default function RootLayout({ children }) { return (<html><body>{children}</body></html>); }\n');
  fs.writeFileSync(path.join(PROBE, 'app', 'match', '[jobId]', 'client.js'),
    "'use client';\nimport { useParams } from 'next/navigation';\nexport default function Client() {\n  const p = useParams();\n  return <pre id=\"client\">{JSON.stringify({ useParamsJobId: p?.jobId })}</pre>;\n}\n");
  fs.writeFileSync(path.join(PROBE, 'app', 'match', '[jobId]', 'page.js'),
    "import Client from './client';\nexport default function Page({ params }) {\n  return (<div><pre id=\"server\">{JSON.stringify({ serverParamsJobId: params.jobId })}</pre><Client /></div>);\n}\n");
}

async function main() {
  console.log('='.repeat(78));
  console.log('MATCH ROUTE — END-TO-END ON THE REPO\'S NEXT');
  console.log('='.repeat(78));
  let server: ChildProcess | null = null;
  try {
    console.log('\n0. Build and serve the probe app');
    writeProbe();
    const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'next', 'package.json'), 'utf8')).version;
    console.log(`  Next ${version}`);
    execFileSync(process.execPath, [NEXT_BIN, 'build'], { cwd: PROBE, stdio: 'pipe', timeout: 240_000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    assert(true, 'probe app built (production build)');
    const port = await freePort();
    server = spawn(process.execPath, [NEXT_BIN, 'start', '-p', String(port)], { cwd: PROBE, stdio: 'ignore', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/match/warmup'); break; } catch { await sleep(500); } }
    assert((await fetch(base + '/match/warmup')).status === 200, 'probe server is up and serves /match/[jobId]');

    // ids: edge shapes + (with env) real ids of every source
    const ids: Array<[string, string]> = [
      ['himalayas (URL id)', 'opp-himalayas-https://himalayas.app/companies/easypost/jobs/technical-support-engineer-i'],
      ['weworkremotely (URL id)', 'opp-weworkremotely-https://weworkremotely.com/remote-jobs/baymard-institute-market-research-data-analyst'],
      ['jobicy', 'opp-jobicy-153099'], ['greenhouse', 'opp-greenhouse-airbnb-7654321'],
      ['ashby', 'opp-ashby-linear-3f2b9c1e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'], ['arbeitnow', 'opp-arbeitnow-senior-product-designer-m-f-d-berlin-123456'], ['remotive', 'opp-remotive-1234567'],
      ['literal %20 and %2F inside the id', 'opp-himalayas-https://x.com/a%20b/c%2Fd?q=1&r=2#frag'],
      ['unicode', 'opp-himalayas-https://x.com/jobs/ünïcode-日本語/ü'], ['plus, space, trailing %', 'opp-himalayas-https://x.com/a+b/c d/100%'],
      ['dot segments', 'opp-himalayas-https://x.com/../a/./b/..//c'], ['backslash and quotes', "opp-x-https://x.com/a\\b/'c\"d"],
    ];
    if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const ws = (await import('ws')).default;
      (globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
      const { getFeedCatalog } = await import('../src/lib/feed/catalog-cache');
      const catalog = (await getFeedCatalog()) ?? [];
      const seen: Record<string, number> = {};
      for (const o of catalog) { const s = o.id.split('-')[1] ?? '?'; if ((seen[s] = (seen[s] ?? 0) + 1) <= 6) ids.push([`REAL ${s}`, o.id]); }
      console.log(`  (including ${ids.length - 12} real ids from the live catalog, up to 6 per source)`);
    }

    console.log('\n1. Every id, through the REAL helper\'s link');
    let rawBroken = 0; let rawSlashIds = 0;
    for (const [label, id] of ids) {
      const href = matchHref(id);
      const r = await fetch(base + href, { redirect: 'manual' });
      let sOk = false, cOk = false;
      if (r.status === 200) {
        const html = await r.text();
        const sv = grab(html, 'server')?.serverParamsJobId ?? null, cv = grab(html, 'client')?.useParamsJobId ?? null;
        sOk = once(sv) === id && resolveJobId(sv, [{ id: 'decoy' }, { id }])?.id === id;
        cOk = once(cv) === id && resolveJobId(cv, [{ id: 'decoy' }, { id }])?.id === id;
      }
      assert(r.status === 200 && sOk && cOk, `${label}: 200, and server + client params resolve back to the exact id`, `status ${r.status} server ${sOk} client ${cOk} ${id.slice(0, 50)}`);
      if (id.includes('/')) {
        rawSlashIds++;
        const old = await fetch(base + '/match/' + id, { redirect: 'follow' });
        if (old.status === 404) rawBroken++;
      }
    }
    console.log(`  documented: the OLD raw link 404s for ${rawBroken}/${rawSlashIds} URL-style ids on this Next version`);
    assert(rawSlashIds === 0 || rawBroken > 0, 'the old raw link really is broken here (so the fix is exercised, not vacuous)');

    console.log('\n2. Old links (bookmarks) for slash-free ids still route');
    for (const [label, id] of ids.filter(([, i]) => !i.includes('/') && !/[%?#+ \\"']/.test(i))) {
      const r = await fetch(base + '/match/' + id, { redirect: 'manual' });
      const html = r.status === 200 ? await r.text() : '';
      assert(r.status === 200 && resolveJobId(grab(html, 'server')?.serverParamsJobId, [{ id }])?.id === id, `${label}: the raw link /match/${id.slice(0, 40)} still works`);
    }
  } finally {
    if (server) { try { server.kill(); } catch { /* ignore */ } }
    await sleep(500);
    try { fs.rmSync(PROBE, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  assert(!fs.existsSync(PROBE), 'the temporary probe app was removed');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); try { fs.rmSync(PROBE, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(2); });

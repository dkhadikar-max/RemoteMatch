/**
 * Feed + resume routes — shared cached reads (egress).
 * ==============================================================================
 * Both routes used to read the catalog from Supabase on every request, per user
 * (~21 MB over the wire each at ~23k rows). They now read it ONCE into
 * process-wide caches:
 *
 *   resume  4 narrow columns (title, remote_type, employment_type, required_skills
 *           — exactly what checkHardEligibility() + the skill counts read)
 *   feed    the 48h-window catalog (scoring needs `description`, so full rows), with
 *           the 48-hour window RE-APPLIED IN MEMORY on every request so the
 *           freshness promise stays exact despite the cache
 *
 * and the sync routes drop the caches when ingestion writes.
 *
 *  §1 static   what the matcher reads; route wiring; sync-route invalidation
 *  §2 unit     registry semantics; freshness-window boundaries; resume equivalence on
 *              random profiles × listings; the whole feed pipeline on DEEP-FROZEN input
 *  §3 real     live Supabase, isolated rows: request counts + bytes, freshness under a
 *              cache, invalidation, and HTTP equivalence with the old whole-catalog math
 *
 * Run: npx tsx --env-file=.env.migration.local test/resume-feed-egress-suite.ts
 */
import fs from 'fs';
import path from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { createClient } from '@supabase/supabase-js';
import { getOrCreateCatalogCache, invalidateCatalogCaches, listCatalogCaches } from '../src/lib/ingestion/catalog-caches';
import { applyFreshnessWindow, getFeedCatalog } from '../src/lib/feed/catalog-cache';
import { getResumeEligibilityRows, asEligibilityOpportunity, RESUME_ELIGIBILITY_COLUMNS } from '../src/lib/resume/eligibility-index';
import { passesFreshnessGate, getFreshnessWindowBounds, FRESHNESS_WINDOW_MS } from '../src/lib/ingestion/freshness-gate';
import { getActiveOpportunities } from '../src/lib/ingestion/catalog-read';
import { scoreOpportunitiesForFeed } from '../src/lib/matching/engine';
import { classifyCareerTransition } from '../src/lib/matching/career-transition';
import { applyBehavioralPersonalization, deriveEffectiveDecisions } from '../src/lib/feed/behavioral-personalization';
import { selectRelevantOpportunities, computeSkillOpportunities, normalizeSkillKey } from '../src/lib/resume/skill-opportunities';
import { loadServerProfile } from '../src/lib/profile/server-profile';
import { hasRequiredEnv, newVerifiedSession, adminClient } from './helpers/verified-session';
import type { CanonicalOpportunity, PersonProfile } from '../src/types/byn';

let passed = 0, failed = 0, skipped = 0;
const assert = (ok: boolean, msg: string, detail?: string) => {
  if (ok) { console.log(`  ✓ PASS: ${msg}`); passed++; } else { console.error(`  ✗ FAIL: ${msg}${detail ? ' — ' + detail : ''}`); failed++; }
};
const skip = (m: string) => { skipped++; console.log(`  – SKIP: ${m}`); };
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fieldReads = (src: string, ident: string) => new Set(Array.from(src.matchAll(new RegExp(`\\b${ident}\\.([A-Za-z_]+)`, 'g'))).map((m) => m[1]));
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const TITLE_WORDS = ['Senior', 'Staff', 'Frontend', 'Backend', 'Data', 'Mobile', 'AI', 'Product', 'Designer', 'Engineer', 'Developer', 'Manager', 'Scientist', 'Analyst', 'Support'];
const REMOTE: Array<string | null> = ['Worldwide', 'US', 'EU/EEA', 'India', 'Specific countries', 'Americas', null];
const EMPLOYMENT: Array<string | null> = ['Full-time', 'Contract', 'Freelance', 'Part-time', 'Full-time', null];
const SKILLS = ['React', 'react', 'React.js', 'TypeScript', 'Node.js', 'Python', 'SQL', 'Go', 'Kubernetes', 'Figma', 'dbt', 'AWS', 'GraphQL', 'Rust', 'Swift'];

async function main() {
  // ===========================================================================
  console.log('\n1. STATIC');
  const engine = read('src/lib/matching/engine.ts');
  const heStart = engine.indexOf('export function checkHardEligibility');
  const heBody = noComments(engine.slice(heStart, engine.indexOf('export function computeScreeningFit', heStart)));
  const heFields = fieldReads(heBody, 'opportunity');
  assert(heBody.length > 500, `parsed checkHardEligibility (${heBody.length} chars)`);
  assert(Array.from(heFields).sort().join() === 'employmentType,remoteType,requiredSkills,title', `checkHardEligibility() reads EXACTLY {remoteType, employmentType, title, requiredSkills} (found: ${Array.from(heFields).sort().join(',')})`);
  const skillSrc = read('src/lib/resume/skill-opportunities.ts');
  const csStart = skillSrc.indexOf('export function computeSkillOpportunities');
  const csFields = fieldReads(noComments(skillSrc.slice(csStart)), 'opp');
  assert(Array.from(csFields).join() === 'requiredSkills', `computeSkillOpportunities() reads only requiredSkills (found: ${Array.from(csFields).join(',')})`);
  assert(RESUME_ELIGIBILITY_COLUMNS.split(',').map((c) => c.trim()).sort().join() === 'employment_type,remote_type,required_skills,title', 'the resume read selects exactly those four columns');
  assert(!/description/.test(RESUME_ELIGIBILITY_COLUMNS), 'the resume read does not select description');

  const feedRoute = noComments(read('src/app/api/opportunities/feed/route.ts'));
  assert(/getFeedCatalog\(\)/.test(feedRoute) && !/getActiveOpportunities\(/.test(feedRoute) && !/createSupabaseServerClient/.test(feedRoute), 'the feed route reads through the shared cache (no per-request catalog read)');
  const resumeRoute = noComments(read('src/app/api/resume/opportunities/route.ts'));
  assert(/getResumeEligibilityRows\(\)/.test(resumeRoute) && !/getActiveOpportunities/.test(resumeRoute), 'the resume route reads the slim cached rows (no whole-catalog read)');
  for (const f of ['src/app/api/opportunities/sync/route.ts', 'src/app/api/opportunities/sync/career-pages/route.ts']) {
    const src = noComments(read(f));
    assert(/invalidateCatalogCaches\(\)/.test(src) && /try\s*\{\s*invalidateCatalogCaches\(\);\s*\}\s*catch/.test(src), `${f.split('/').slice(-3).join('/')}: invalidates the catalog caches after writing, in a try/catch (a cache can never fail a sync)`);
  }
  const syncSrc = noComments(read('src/app/api/opportunities/sync/route.ts'));
  assert(syncSrc.indexOf('reconcileCrossProviderDuplicates()') < syncSrc.lastIndexOf('invalidateCatalogCaches()'), 'the main sync invalidates AFTER reconciliation (the last write), so no stale copy can be re-cached in between');
  const feedCache = noComments(read('src/lib/feed/catalog-cache.ts'));
  assert(/passesFreshnessGate/.test(feedCache) && /applyFreshnessWindow\(await cache\.get\(\), now\)/.test(feedCache), 'the feed cache re-applies the 48h window per request');

  // ===========================================================================
  console.log('\n2. UNIT');
  // 2a. registry
  {
    let inv = 0; const name = `t-${Date.now()}`;
    const a = getOrCreateCatalogCache(name + 'a', () => ({ invalidate: () => { inv++; } }));
    const a2 = getOrCreateCatalogCache(name + 'a', () => ({ invalidate: () => { inv += 100; } }));
    assert(a === a2, 'getOrCreateCatalogCache returns the SAME instance for a name (one cache per process, however bundled)');
    getOrCreateCatalogCache(name + 'bad', () => ({ invalidate: () => { throw new Error('boom'); } }));
    getOrCreateCatalogCache(name + 'c', () => ({ invalidate: () => { inv += 10; } }));
    const names = invalidateCatalogCaches();
    assert(inv === 11 && names.includes(name + 'a') && names.includes(name + 'c') && !names.includes(name + 'bad'), 'invalidateCatalogCaches calls every cache; a throwing one neither stops the others nor throws');
    assert(listCatalogCaches().includes(name + 'a') && typeof (globalThis as any).__remotematch_catalog_caches__ === 'object', 'caches live on globalThis (shared across route bundles)');
  }
  // 2b. freshness window
  {
    const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
    const iso = (ms: number) => new Date(ms).toISOString();
    const mkOpp = (postedAt: string | null | undefined) => ({ sourceId: String(postedAt), postedAt } as unknown as CanonicalOpportunity);
    const keep = (postedAt: string | null | undefined) => applyFreshnessWindow([mkOpp(postedAt)], NOW).length === 1;
    assert(keep(iso(NOW - FRESHNESS_WINDOW_MS)), 'posted exactly 48h ago: kept (inclusive boundary)');
    assert(!keep(iso(NOW - FRESHNESS_WINDOW_MS - 1)), 'posted 48h + 1ms ago: dropped');
    assert(keep(iso(NOW)) && keep(iso(NOW - 1)), 'posted now / 1ms ago: kept');
    assert(!keep(iso(NOW + 1)) && !keep(iso(NOW + 86400000)), 'a future posted_at is dropped (never "maximally fresh")');
    assert(!keep(null) && !keep(undefined) && !keep('') && !keep('not-a-date'), 'missing / empty / unparseable posted_at is dropped');
    // property: identical to the database bounds on random timestamps
    const r = mulberry32(99); let agree = true;
    for (let i = 0; i < 5000; i++) {
      const posted = NOW - 60 * 3600_000 + Math.floor(r() * 80 * 3600_000); // -60h .. +20h
      const { from, to } = getFreshnessWindowBounds(NOW);
      const dbSays = posted >= Date.parse(from) && posted <= Date.parse(to);
      if (keep(iso(posted)) !== dbSays) { agree = false; break; }
    }
    assert(agree, 'the in-memory window agrees with the database bounds (posted_at >= now-48h AND <= now) on 5,000 random timestamps');
    // the cache scenario: loaded at T0, requested at T0+3h
    const loaded = [mkOpp(iso(NOW - 46 * 3600_000)), mkOpp(iso(NOW - 2 * 3600_000))];
    assert(applyFreshnessWindow(loaded, NOW).length === 2 && applyFreshnessWindow(loaded, NOW + 3 * 3600_000).length === 1, 'a listing 46h old at load time is dropped 3h later WITHOUT a re-read — the cache cannot extend the 48h promise');
    assert(applyFreshnessWindow(loaded, NOW) !== loaded, 'a new array is returned per call (the cached one is never handed out)');
  }
  // 2c. resume equivalence: random profiles × random listings, slim stand-ins vs full objects
  {
    const rnd = mulberry32(20261012); const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];
    const full: CanonicalOpportunity[] = Array.from({ length: 2000 }, (_, i) => ({
      id: `opp-x-${i}`, type: 'job', title: `${pick(TITLE_WORDS)} ${pick(TITLE_WORDS)} ${i}`, company: 'C', description: 'long description '.repeat(30), source: 'remotive', sourceId: `s-${i}`,
      officialUrl: 'https://e.com', canonicalUrlHash: 'h', contentHash: 'c', employmentType: pick(EMPLOYMENT), remoteType: pick(REMOTE),
      eligibleCountries: ['US'], excludedCountries: [], timezoneRequirements: [], salaryCurrency: 'USD', status: 'active', isActive: true, isPermanentlyRemoved: false,
      requiredSkills: Array.from({ length: Math.floor(rnd() * 5) }, () => pick(SKILLS)), preferredSkills: ['Docs'], qualityScore: 80, postedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(),
    } as unknown as CanonicalOpportunity));
    const slimRows = full.map((o) => ({ title: o.title, remoteType: o.remoteType as string | null, employmentType: o.employmentType as string | null, requiredSkills: o.requiredSkills }));
    const slim = slimRows.map(asEligibilityOpportunity);
    const countries = ['us', 'germany', 'india', 'brazil', 'france', 'worldwide'];
    const empTypes = [[], ['full_time'], ['contract'], ['freelance', 'contract'], ['part_time'], ['Full-time'], ['full_time', 'part_time']];
    const roles = [[], ['Frontend Engineer'], ['Data Scientist'], ['Software Engineer'], ['Mobile Developer'], ['AI Engineer', 'Product Manager']];
    const mkProfile = (): PersonProfile => ({
      id: 'p', email: 'p@x.com', fullName: 'P', planTier: 'free', dailyEvaluationsCount: 0, lastEvaluationResetAt: '', createdAt: '', updatedAt: '',
      skills: Array.from({ length: Math.floor(rnd() * 5) }, () => ({ skillName: pick(SKILLS), evidenceLevel: pick(['strong', 'claimed']) })) as any,
      experiences: [], intent: { employmentTypes: pick(empTypes), targetRoles: pick(roles) } as any, location: { currentCountry: pick(countries), workPreference: 'worldwide' } as any,
    });
    let allSame = true, nonTrivial = 0, withRoles = 0;
    for (let i = 0; i < 120; i++) {
      const prof = mkProfile();
      const a = selectRelevantOpportunities(prof, full);
      const b = selectRelevantOpportunities(prof, slim);
      const owned = new Set(prof.skills.map((s) => normalizeSkillKey(s.skillName)));
      const dismissed = new Set<string>(rnd() < 0.5 ? [normalizeSkillKey('TypeScript')] : []);
      const sa = computeSkillOpportunities({ relevantOpps: a, ownedSkillKeys: owned, dismissedKeys: dismissed, limit: 8 });
      const sb = computeSkillOpportunities({ relevantOpps: b, ownedSkillKeys: owned, dismissedKeys: dismissed, limit: 8 });
      if (a.length !== b.length || JSON.stringify(sa) !== JSON.stringify(sb)) { allSame = false; break; }
      if (a.length > 0 && a.length < full.length) nonTrivial++;
      if ((prof.intent as any).targetRoles.length) withRoles++;
    }
    assert(allSame, 'for 120 random profiles × 2,000 listings, the slim stand-ins give the identical relevant set and identical skill counts as full objects');
    assert(nonTrivial >= 40 && withRoles >= 40, `the comparison is not vacuous (${nonTrivial}/120 profiles filtered some-but-not-all listings; ${withRoles} used target roles)`);

    // 2d. the shared catalog is never mutated: run the whole feed pipeline on DEEP-FROZEN input
    const sharedArr = deepFreeze(full.map((o) => ({ ...o, postedAt: new Date().toISOString() })));
    const before = JSON.stringify(sharedArr);
    const profile = mkProfile(); (profile as any).careerDirection = 'change_fields'; (profile as any).planTier = 'pro';
    let threw: string | null = null;
    try {
      const discoverable = sharedArr.filter((o) => !o.supersededByOpportunityId);
      const scored = scoreOpportunitiesForFeed(profile, discoverable);
      const withTransition = scored.map((opp) => { const t = classifyCareerTransition(profile, opp, true); return t ? { ...opp, careerTransition: t } : opp; });
      const swipes = withTransition.slice(0, 8).map((o, i) => ({ id: `s${i}`, opportunity_id: o.id, action: 'interested', created_at: new Date(Date.now() - i * 1000).toISOString(), rewound_decision_id: null }));
      const decisions = deriveEffectiveDecisions(swipes as any);
      const personalized = applyBehavioralPersonalization(withTransition as any, decisions);
      if (!Array.isArray(personalized) || personalized.length === 0) throw new Error('empty pipeline result');
      if (decisions.size < 5) throw new Error('personalization path not exercised');
    } catch (e) { threw = (e as Error).message; }
    assert(threw === null, `the whole feed pipeline (score → transition → personalization, reorder path included) runs on deeply frozen shared objects without a single write (${threw ?? 'ok'})`);
    assert(JSON.stringify(sharedArr) === before, 'the shared catalog is byte-identical after the pipeline ran');
  }

  // ===========================================================================
  console.log('\n3. REAL INFRA — live Supabase, isolated synthetic rows');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceKey || !hasRequiredEnv()) { skip('Supabase env incomplete'); return finish(); }

  const realFetch = globalThis.fetch;
  const net = { calls: 0, bytes: 0 };
  globalThis.fetch = (async (input: any, init?: any) => {
    const u = typeof input === 'string' ? input : input?.url ?? String(input);
    const res = await realFetch(input, init);
    if (u.includes('/rest/v1/opportunities')) { net.calls++; net.bytes += (await res.clone().arrayBuffer()).byteLength; }
    return res;
  }) as typeof fetch;
  const measure = async <T,>(fn: () => Promise<T>) => { net.calls = 0; net.bytes = 0; const r = await fn(); return { r, calls: net.calls, bytes: net.bytes }; };

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const PREFIX = `rf-egress-${Date.now().toString(36)}-`;
  const NOW = Date.now(); const H = 3600_000;
  const rr = mulberry32(4242); const rp = <T,>(a: readonly T[]) => a[Math.floor(rr() * a.length)];
  const desc = (i: number) => `Listing ${i}. We are hiring remote talent to build and operate distributed systems for customers worldwide. `.repeat(11);
  type Spec = { key: string; hoursAgo: number; over: Record<string, unknown> };
  const specs: Spec[] = [];
  for (let i = 0; i < 1000; i++) specs.push({ key: `fresh-${i}`, hoursAgo: (i % 40) + 0.5, over: {} });             // fresh, visible
  for (let i = 0; i < 100; i++) specs.push({ key: `aging-${i}`, hoursAgo: 46, over: {} });                          // fresh now, stale in 3h
  for (let i = 0; i < 60; i++) specs.push({ key: `stale-${i}`, hoursAgo: 60, over: {} });                           // outside the window
  for (let i = 0; i < 20; i++) specs.push({ key: `err-${i}`, hoursAgo: 2, over: { translation_status: 'error' } }); // hidden by the gate
  for (let i = 0; i < 20; i++) specs.push({ key: `expired-${i}`, hoursAgo: 2, over: { status: 'expired' } });       // hidden by RLS
  const mk = (s: Spec, i: number) => ({
    source: 'remotive', source_id: `${PREFIX}${s.key}`, type: 'job', title: `${rp(TITLE_WORDS)} ${rp(TITLE_WORDS)} ${i}`, company: `Co ${i % 40}`, company_logo: null,
    description: desc(i), source_url: 'https://example.com', official_url: 'https://example.com/apply', canonical_url_hash: `h-${PREFIX}${s.key}`, content_hash: `c-${PREFIX}${s.key}`,
    employment_type: rp(EMPLOYMENT.filter(Boolean) as string[]), remote_type: rp(REMOTE.filter(Boolean) as string[]), eligible_countries: [], excluded_countries: [], timezone_requirements: [],
    required_skills: Array.from({ length: 1 + Math.floor(rr() * 4) }, () => rp(SKILLS)), experience_requirement: '4-6', explicit_remote_scope: 'explicit_worldwide', status: 'active',
    posted_at: new Date(NOW - s.hoursAgo * H).toISOString(), first_seen_at: new Date().toISOString(), last_seen_in_feed_at: new Date().toISOString(), consecutive_absences: 0, ...s.over,
  });
  const idOf = (s: Spec) => `${PREFIX}${s.key}`;
  const expectedFeedAt = (now: number) => new Set(specs.filter((s) => !s.over.translation_status && !s.over.status && passesFreshnessGate(new Date(NOW - s.hoursAgo * H).toISOString(), now)).map(idOf));
  const mine = (a: Array<{ sourceId: string }>) => new Set(a.filter((o) => o.sourceId.startsWith(PREFIX)).map((o) => o.sourceId));
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && Array.from(a).every((x) => b.has(x));
  let session: Awaited<ReturnType<typeof newVerifiedSession>> | null = null;

  try {
    for (let i = 0; i < specs.length; i += 200) {
      const { error } = await admin.from('opportunities').insert(specs.slice(i, i + 200).map((s, k) => mk(s, i + k)));
      if (error) { assert(false, 'seed', error.message); return finish(); }
    }
    assert(true, `seeded ${specs.length} isolated rows (1000 fresh, 100 aging at 46h, 60 stale, 20 translation-error, 20 expired)`);
    invalidateCatalogCaches();

    // --- feed cache ---
    const f1 = await measure(() => getFeedCatalog(NOW));
    const f1Ids = mine(f1.r ?? []);
    assert(same(f1Ids, expectedFeedAt(NOW)), `feed catalog = exactly the fresh, visible rows (${f1Ids.size}); stale, translation-error and expired rows are absent`);
    console.log(`  · feed refresh: ${f1.calls} REST calls, ${kb(f1.bytes)} for ${(f1.r ?? []).length} rows`);
    const f2 = await measure(() => getFeedCatalog(NOW)); const f3 = await measure(() => getFeedCatalog(NOW));
    assert(f2.calls === 0 && f3.calls === 0, `repeat feed requests make 0 REST calls (${f2.calls}/${f3.calls})`);
    const later = NOW + 3 * H;
    const f4 = await measure(() => getFeedCatalog(later));
    assert(f4.calls === 0 && same(mine(f4.r ?? []), expectedFeedAt(later)) && mine(f4.r ?? []).size === f1Ids.size - 100, `3h later, still cached (0 calls) but the 100 listings that crossed 48h are gone — freshness stays exact (${mine(f4.r ?? []).size} = ${f1Ids.size} − 100)`);
    invalidateCatalogCaches();
    const f5 = await measure(() => getFeedCatalog(NOW));
    assert(f5.calls === f1.calls && f5.calls > 0, `after invalidateCatalogCaches() (what a sync does) the next request re-reads (${f5.calls} calls)`);
    console.log(`  · 100 feed requests: OLD ${kb(100 * f1.bytes)} (a read each)  ->  NEW ${kb(f1.bytes)} (one read, shared)  = 99% less (1 read instead of 100)`);

    // --- resume cache ---
    invalidateCatalogCaches();
    const old = await measure(() => getActiveOpportunities(anon));
    const r1 = await measure(() => getResumeEligibilityRows());
    const r2 = await measure(() => getResumeEligibilityRows());
    assert(r2.calls === 0 && r1.calls >= 1, `resume rows: first call ${r1.calls} REST calls, repeat ${r2.calls}`);
    assert(r1.r.length === old.r.length, `the slim read covers the same rows as the old full read (${r1.r.length} = ${old.r.length}; RLS hides the expired ones)`);
    console.log(`  · resume read: OLD ${kb(old.bytes)} per request (${(old.bytes / old.r.length).toFixed(0)} B/row)  ->  NEW ${kb(r1.bytes)} once per refresh (${(r1.bytes / r1.r.length).toFixed(0)} B/row), then 0`);
    assert(r1.bytes < old.bytes * 0.1, `the slim read is under 10% of the full read (${kb(r1.bytes)} vs ${kb(old.bytes)})`);
    assert(listCatalogCaches().includes('feed-catalog') && listCatalogCaches().includes('resume-eligibility'), 'both caches are registered for invalidation');

    // --- HTTP: the routes on the running dev server vs the OLD whole-catalog computation ---
    console.log('\n4. HTTP — the local dev server vs the old whole-catalog math');
    const BASE = process.env.TEST_BASE_URL || 'http://localhost:3100';
    let up = true; try { await realFetch(`${BASE}/api/health`); } catch { up = false; }
    if (!up) { skip(`no server reachable at ${BASE}`); }
    else {
      session = await newVerifiedSession();
      const feed = await (await realFetch(`${BASE}/api/opportunities/feed`)).json();
      const httpFeedIds = new Set<string>((feed.opportunities ?? []).filter((o: any) => o.sourceId?.startsWith(PREFIX)).map((o: any) => o.sourceId));
      // The server's cache is its own process state (up to 6h) and a test cannot invalidate it. If it was warmed by an
      // EARLIER run it holds that run's (now deleted) rows and none of ours — indistinguishable from a bug by row
      // content alone, so say so and skip instead of failing spuriously or passing vacuously. (An EMPTY response is
      // still a failure: a cold cache would have loaded our rows.)
      const foreignRows = (feed.opportunities ?? []).length > 0 && httpFeedIds.size === 0;
      if (foreignRows) {
        skip("the dev server's feed/resume caches were warmed by an earlier run (they hold that run's rows for up to 6h); restart the server (cold caches) and re-run to exercise the HTTP equivalence checks");
      } else {
      assert(feed.success === true && same(httpFeedIds, expectedFeedAt(Date.now())), `GET /api/opportunities/feed returns exactly the fresh, visible rows (${httpFeedIds.size})`);
      const scoredRes = await (await realFetch(`${BASE}/api/opportunities/feed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile: { skills: [{ skillName: 'TypeScript', evidenceLevel: 'strong' }], experiences: [], intent: { employmentTypes: [], targetRoles: [] }, location: { currentCountry: 'US', workPreference: 'worldwide' } } }) })).json();
      assert(scoredRes.success === true && scoredRes.scored === true && (scoredRes.opportunities ?? []).length >= httpFeedIds.size, `POST /api/opportunities/feed (scored) works from the cache (${(scoredRes.opportunities ?? []).length} scored)`);
      assert((scoredRes.opportunities ?? []).every((o: any) => typeof o.fitScore === 'number'), 'every scored listing carries a fit score');

      // resume: the route's answer must equal the OLD computation (full read + same pure functions)
      const { data: { user } } = await session.client.auth.getUser();
      const profile = await loadServerProfile(session.client, user!);
      const { data: dismissals } = await session.client.from('profile_skill_dismissals').select('skill_key').eq('profile_id', user!.id);
      const fullCatalog = await getActiveOpportunities(session.client);
      const relevant = selectRelevantOpportunities(profile, fullCatalog);
      const expected = computeSkillOpportunities({ relevantOpps: relevant, ownedSkillKeys: new Set(profile.skills.map((s) => normalizeSkillKey(s.skillName))), dismissedKeys: new Set((dismissals ?? []).map((d: any) => d.skill_key as string)), limit: 8 });
      const resumeRes = await realFetch(`${BASE}/api/resume/opportunities`, { headers: { authorization: `Bearer ${session.token}` } });
      const resume = await resumeRes.json();
      assert(resumeRes.status === 200 && resume.success === true, `GET /api/resume/opportunities -> 200 (${resumeRes.status})`);
      assert(resume.relevantJobCount === relevant.length && relevant.length > 0, `relevantJobCount matches the old computation over the full catalog (${resume.relevantJobCount} = ${relevant.length})`);
      assert(JSON.stringify(resume.opportunities) === JSON.stringify(expected) && expected.length > 0, `the ranked skill suggestions are IDENTICAL to the old path's (${expected.length} suggestions, e.g. ${expected.slice(0, 3).map((e) => `${e.skill}×${e.jobCount}`).join(', ')})`);
      assert((await realFetch(`${BASE}/api/resume/opportunities`)).status === 401, 'the resume route still requires a session (401 without one)');
      }
    }
  } finally {
    const { error } = await admin.from('opportunities').delete().like('source_id', `${PREFIX}%`);
    const { count } = await admin.from('opportunities').select('source_id', { count: 'exact', head: true }).like('source_id', `${PREFIX}%`);
    if (session) await adminClient().auth.admin.deleteUser(session.userId).catch(() => {});
    assert(!error && (count ?? 0) === 0, `cleanup: all synthetic rows removed (${count ?? 0} remain)${session ? ' and the test account deleted' : ''}`, error?.message);
    globalThis.fetch = realFetch;
    invalidateCatalogCaches();
  }
  return finish();
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

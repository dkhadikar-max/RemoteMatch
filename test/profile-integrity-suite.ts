/**
 * RemoteMatch — Profile integrity & truthful feed UI (PR 1)
 * ==============================================================================
 * Proves, with the REAL feed route handler and the REAL catalog (read-only):
 *   AC2/AC3  an empty / unusable profile NEVER yields a scored, "personalized" feed; a usable one scores as before
 *   AC4      hydration never overwrites local content with empty server data
 *   AC5      no fabricated percentage anywhere (job card, tracker)
 *   AC7      the demo persona is not the browser default and is stripped from stale browser storage; the SERVER
 *            singleton still starts from the persona (PR 2 territory — deliberately unchanged here)
 * plus engine-safety (an empty profile cannot crash the matcher/explainer code that now sees it more often).
 *
 * Read-only against the live catalog; creates no users and writes nothing.
 * Run: npx tsx --env-file=<env file> test/profile-integrity-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { NextRequest } from 'next/server';
import React from 'react';
import ws from 'ws';
(globalThis as unknown as { WebSocket: unknown }).WebSocket = ws;
// tsx compiles JSX with the classic runtime; Next uses the automatic one. Provide React for component rendering.
(globalThis as unknown as { React: unknown }).React = React;

import { renderToStaticMarkup } from 'react-dom/server';
import { JobCard } from '../src/components/feed/job-card';
import { IncompleteProfileNotice } from '../src/components/feed/incomplete-profile-notice';
import type { PersonProfile } from '../src/types/byn';
import { isUsableProfile, INCOMPLETE_PROFILE_COPY } from '../src/lib/profile/usable';
import { hydrateLocalProfileFromServer, type ServerOnboarding } from '../src/lib/profile/hydrate';
import { localStore, DEFAULT_DEMO_PROFILE, createEmptyProfile, stripDemoPersonaContent } from '../src/lib/db/mock-seed';
import { scoreOpportunitiesForFeed, checkHardEligibility } from '../src/lib/matching/engine';
import { generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { deriveSkillMatchSummary, deriveActionableSkillGaps } from '../src/lib/match/actionable-skill-gaps';
import { CURATED_JOBS } from '../src/lib/providers/curated';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const now = new Date().toISOString();
function profile(over: Partial<PersonProfile> = {}): PersonProfile {
  return { ...createEmptyProfile(), id: 'p1', email: 'p1@example.com', fullName: 'P One', ...over };
}
const skill = (name: string) => ({ id: `s-${name}`, profileId: 'p1', skillName: name, yearsUsed: 3, isPrimary: true, evidenceLevel: 'strong' as const });
const intent = (roles: string[]) => ({
  id: 'i1', profileId: 'p1', employmentTypes: ['Full-time' as const], targetRoles: roles,
  yearsOfExperience: '4-6' as const, preferredCurrency: 'USD', availabilityStatus: 'immediately' as const, updatedAt: now,
});

async function postFeed(body: unknown) {
  const { POST } = await import('../src/app/api/opportunities/feed/route');
  const req = new NextRequest('http://localhost/api/opportunities/feed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { opportunities?: Array<Record<string, unknown>> } };
}

async function main() {
  console.log('='.repeat(78));
  console.log('PROFILE INTEGRITY & TRUTHFUL FEED UI (PR 1)');
  console.log('='.repeat(78) + '\n');

  // ── 1. isUsableProfile — pure table ───────────────────────────────────────
  console.log('1. isUsableProfile');
  assert(!isUsableProfile(null) && !isUsableProfile(undefined) && !isUsableProfile('x') && !isUsableProfile(5), 'non-objects are unusable');
  assert(!isUsableProfile({}), 'empty object is unusable');
  assert(!isUsableProfile(profile()), 'empty profile (skills: [], no intent) is unusable');
  assert(!isUsableProfile(profile({ skills: [], intent: intent([]) })), 'intent with no target roles + no skills is unusable');
  assert(!isUsableProfile(profile({ skills: [skill('  ')] })), 'a blank skill name does not count');
  assert(!isUsableProfile(profile({ intent: intent(['', '  ']) })), 'blank target roles do not count');
  assert(!isUsableProfile({ skills: 'React' }), 'skills that is not an array is unusable');
  assert(isUsableProfile(profile({ skills: [skill('React')] })), 'one real skill is usable');
  assert(isUsableProfile(profile({ intent: intent(['Backend Engineer']) })), 'one real target role (no skills) is usable');
  assert(isUsableProfile(profile({ skills: [skill('Go')], intent: intent(['SRE']) })), 'skills + roles is usable');

  // ── 2. Feed route (REAL handler, REAL catalog, read-only) ─────────────────
  console.log('\n2. Feed route POST');
  const none = await postFeed(undefined);
  assert(none.status === 200 && none.json.success === true, 'no body → 200 success', JSON.stringify(none.json).slice(0, 120));
  assert(none.json.scored === false && none.json.personalized === false && none.json.reason === 'no_profile', 'no body → scored:false personalized:false reason:no_profile');
  const catalogSize = (none.json.opportunities ?? []).length;
  assert(catalogSize > 0, `catalog is non-empty (${catalogSize} jobs) — the tests below are meaningful`);

  const empty = await postFeed({ profile: profile() });
  assert(empty.json.scored === false && empty.json.personalized === false && empty.json.reason === 'profile_incomplete', 'EMPTY profile → scored:false personalized:false reason:profile_incomplete');
  assert((empty.json.opportunities ?? []).length === catalogSize, 'empty profile still receives the full unscored catalog');
  assert((empty.json.opportunities ?? []).every((o) => o.fitScore === undefined && o.fitBadge === undefined), 'no job carries a fitScore / fitBadge for an empty profile');

  const blank = await postFeed({ profile: profile({ skills: [skill('')], intent: intent(['']) }) });
  assert(blank.json.personalized === false && blank.json.reason === 'profile_incomplete', 'blank-only entries → not personalized');

  const usable = await postFeed({ profile: profile({ skills: [skill('React'), skill('TypeScript')], intent: intent(['Frontend Engineer']), location: { id: 'l', profileId: 'p1', currentCountry: 'Worldwide', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: ['Worldwide'], willingTimezones: ['UTC'] } }) });
  assert(usable.json.scored === true && usable.json.personalized === true && usable.json.reason === undefined, 'USABLE profile → scored:true personalized:true (no reason)');
  const scores = (usable.json.opportunities ?? []).map((o) => o.fitScore).filter((x): x is number => typeof x === 'number');
  assert(scores.length > 0 && new Set(scores).size > 1, `usable profile gets real, varying scores (${new Set(scores).size} distinct)`);

  const rolesOnly = await postFeed({ profile: profile({ intent: intent(['Frontend Engineer']) }) });
  assert(rolesOnly.json.personalized === true, 'target role alone (no skills) is enough to personalize');

  // ── 3. Hydration never wipes ──────────────────────────────────────────────
  console.log('\n3. hydrateLocalProfileFromServer');
  const emptyServer: ServerOnboarding = {
    onboardingCompletedAt: '2026-09-08T00:00:00Z', fullName: '', headline: '', rawResumeText: '',
    employmentTypes: [], targetRoles: [], yearsOfExperience: null, minSalary: null, preferredCurrency: 'USD',
    workPreference: null, currentCountry: '', currentTimezone: '', allowedCountries: [], willingTimezones: [], skills: [],
  };
  const mkStore = (initial: PersonProfile) => {
    let cur = initial;
    return {
      getProfile: () => cur,
      updateProfile: (p: Partial<PersonProfile>) => { cur = { ...cur, ...p }; return cur; },
    };
  };
  const mkFetch = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  const localFull = profile({ fullName: 'Local Name', skills: [skill('Rust')], intent: intent(['Systems Engineer']),
    location: { id: 'l', profileId: 'p1', currentCountry: 'India', currentTimezone: 'IST', workPreference: 'my_country', allowedCountries: ['India'], willingTimezones: ['IST'] } });
  const s1 = mkStore(localFull);
  await hydrateLocalProfileFromServer(mkFetch(emptyServer), s1);
  assert(s1.getProfile().skills.length === 1 && s1.getProfile().skills[0].skillName === 'Rust', 'empty server skills do NOT wipe local skills');
  assert(s1.getProfile().intent?.targetRoles[0] === 'Systems Engineer', 'empty server intent does NOT wipe local target roles');
  assert(s1.getProfile().location?.currentCountry === 'India', 'empty server location does NOT wipe local location');
  assert(s1.getProfile().fullName === 'Local Name', 'empty server name does not blank the local name');

  const s2 = mkStore(profile());
  await hydrateLocalProfileFromServer(mkFetch(emptyServer), s2);
  assert(!isUsableProfile(s2.getProfile()), 'empty local + empty server stays unusable (no invented content)');

  const fullServer: ServerOnboarding = { ...emptyServer, fullName: 'Server Name', headline: 'Dev', targetRoles: ['Backend Engineer'], employmentTypes: ['Full-time'],
    yearsOfExperience: '4-6', currentCountry: 'Germany', currentTimezone: 'CET', workPreference: 'worldwide', allowedCountries: ['Worldwide'], willingTimezones: ['CET'],
    skills: [{ name: 'Go', isPrimary: true }, { name: 'Kubernetes', isPrimary: false }] };
  const s3 = mkStore(localFull);
  await hydrateLocalProfileFromServer(mkFetch(fullServer), s3);
  assert(s3.getProfile().skills.map((x) => x.skillName).join() === 'Go,Kubernetes', 'server skills overwrite local when present');
  assert(s3.getProfile().intent?.targetRoles[0] === 'Backend Engineer', 'server roles overwrite local when present');
  assert(s3.getProfile().location?.currentCountry === 'Germany' && s3.getProfile().fullName === 'Server Name', 'server location + name overwrite local when present');
  assert(isUsableProfile(s3.getProfile()), 'hydrated profile is usable');

  const s4 = mkStore(localFull);
  await hydrateLocalProfileFromServer(mkFetch({ ...emptyServer, skills: [{ name: 'Go', isPrimary: true }] }), s4);
  assert(s4.getProfile().skills[0].skillName === 'Go' && s4.getProfile().intent?.targetRoles[0] === 'Systems Engineer', 'partial server data: skills replaced, untouched sections kept');

  const s5 = mkStore(localFull);
  await hydrateLocalProfileFromServer(mkFetch({ ...emptyServer, onboardingCompletedAt: null }), s5);
  assert(s5.getProfile() === localFull, 'un-onboarded empty server → store not touched at all');
  const s6 = mkStore(localFull);
  await hydrateLocalProfileFromServer(mkFetch({}, false), s6);
  assert(s6.getProfile() === localFull, 'unauthenticated (non-ok) → store not touched');
  const s7 = mkStore(localFull);
  await hydrateLocalProfileFromServer((async () => { throw new Error('offline'); }) as unknown as typeof fetch, s7);
  assert(s7.getProfile() === localFull, 'network failure → store not touched, no throw');

  // ── 4. Demo persona: server unchanged, browser empty, stale storage stripped ─
  console.log('\n4. Demo persona handling');
  assert(localStore.getProfile().fullName === DEFAULT_DEMO_PROFILE.fullName, 'SERVER singleton still starts from the persona (PR 2 scope, intentionally unchanged)');

  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const store = new Map<string, string>();
  g.window = {};
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  const Repo = (localStore as unknown as { constructor: new () => typeof localStore }).constructor;

  const fresh = new Repo().getProfile();
  assert(fresh.skills.length === 0 && !fresh.intent && fresh.fullName === '' && fresh.email === '', 'BROWSER default profile is empty (no persona)');
  assert(!isUsableProfile(fresh), 'BROWSER default profile is not usable');

  // a browser that already stored the whole persona (old behaviour persisted everything)
  store.set('remotematch_profile', JSON.stringify(DEFAULT_DEMO_PROFILE));
  const stale = new Repo().getProfile();
  assert(stale.skills.length === 0 && !stale.intent && !stale.location && stale.experiences.length === 0, 'stored pure persona is stripped on load');
  assert(stale.fullName === '' && stale.email === '', 'persona name/email stripped');

  // a browser that onboarded: real skills/intent/location/name, but persona experiences linger
  const onboarded: PersonProfile = { ...DEFAULT_DEMO_PROFILE, fullName: 'Real Person', headline: 'Real headline',
    skills: [skill('Go')], intent: { ...intent(['SRE']), id: 'intent-user' }, location: { id: 'loc-user', profileId: 'p1', currentCountry: 'India', currentTimezone: 'IST', workPreference: 'my_country', allowedCountries: ['India'], willingTimezones: ['IST'] } };
  store.set('remotematch_profile', JSON.stringify(onboarded));
  const kept = new Repo().getProfile();
  assert(kept.fullName === 'Real Person' && kept.skills[0].skillName === 'Go' && kept.intent?.targetRoles[0] === 'SRE' && kept.location?.currentCountry === 'India', 'real onboarded content is preserved');
  assert(kept.experiences.length === 0, "persona's lingering experiences are removed from an onboarded profile");
  const again = stripDemoPersonaContent(kept);
  assert(JSON.stringify(again) === JSON.stringify(kept), 'stripDemoPersonaContent is idempotent');
  delete g.window; delete g.localStorage;

  // ── 5. Engine safety with an EMPTY profile ────────────────────────────────
  console.log('\n5. Engine safety with an empty profile');
  const opps = CURATED_JOBS.map(normalizeOpportunity);
  const ep = createEmptyProfile();
  let threw = '';
  try {
    const sc = scoreOpportunitiesForFeed(ep, opps);
    assert(sc.length === opps.length && sc.every((o) => Number.isFinite(o.fitScore as number)), 'scoreOpportunitiesForFeed: finite scores');
    for (const o of opps.slice(0, 25)) {
      checkHardEligibility(ep, o);
      const a = generateRuleBasedMatchAnalysis(ep, o);
      if (!Number.isFinite(a.fitScore)) throw new Error('non-finite fitScore');
      deriveSkillMatchSummary(ep, o);
      deriveActionableSkillGaps(ep, o);
    }
  } catch (e) { threw = (e as Error).message; }
  assert(threw === '', 'matcher / explainer / gap code does not throw on an empty profile', threw);

  // ── 6. Static: no fabricated numbers, copy present, wiring ────────────────
  console.log('\n6. Static assertions');
  const card = read('src/components/feed/job-card.tsx');
  const tracker = read('src/app/tracker/page.tsx');
  const feedPage = read('src/app/feed/page.tsx');
  const notice = read('src/components/feed/incomplete-profile-notice.tsx');
  const route = read('src/app/api/opportunities/feed/route.ts');
  assert(!/fitScore\s*\?\?\s*\d/.test(card) && !/\?\?\s*94\b/.test(card), 'job-card has no numeric fitScore fallback (?? 94 gone)');
  assert(!/\b9[24]\b/.test(tracker.replace(/\/\/.*$/gm, '')), 'tracker has no fabricated 92/94 score fallback in any spelling');
  assert(/fitScore !== null/.test(card) && /fitScore !== null/.test(tracker), 'score UI renders only for a real number');
  assert(!feedPage.includes("'Full Stack Engineer'") && !feedPage.includes("'Engineering'"), 'feed page has no invented role fallbacks');
  assert(feedPage.includes('{!personalized && <IncompleteProfileNotice />}'), 'feed page shows the notice when not personalized');
  assert(INCOMPLETE_PROFILE_COPY.title === 'Complete your profile to get relevant matches.'
    && INCOMPLETE_PROFILE_COPY.body === 'Add your skills or target roles so we can assess how well each job fits your experience.'
    && INCOMPLETE_PROFILE_COPY.cta === 'Complete your profile', "notice copy is Deep's exact wording");
  assert(notice.includes('INCOMPLETE_PROFILE_COPY.href') && INCOMPLETE_PROFILE_COPY.href === '/settings', 'notice links to /settings');
  assert(route.includes('isUsableProfile(profile)') && route.includes("'profile_incomplete'"), 'feed route gates scoring on isUsableProfile');
  assert(!/localStore/.test(route), 'feed route still never touches the client-local store');

  // rendered output (behavioral — catches any fallback spelling, not just "?? 94")
  const job = normalizeOpportunity(CURATED_JOBS[0]);
  const unscoredHtml = renderToStaticMarkup(React.createElement(JobCard, { opportunity: job }));
  assert(!/\d+\s*%/.test(unscoredHtml) && !/>\s*match\s*</.test(unscoredHtml), 'JobCard WITHOUT a score renders no percentage and no match box');
  assert(!unscoredHtml.includes('Why it matches') && !unscoredHtml.includes('What may be missing'), 'unscored JobCard makes no match claims');
  const scoredHtml = renderToStaticMarkup(React.createElement(JobCard, { opportunity: { ...job, fitScore: 77 } }));
  assert(scoredHtml.includes('77%') && scoredHtml.includes('Why it matches'), 'JobCard WITH a real score renders it (77%)');
  const noticeHtml = renderToStaticMarkup(React.createElement(IncompleteProfileNotice));
  assert(noticeHtml.includes(INCOMPLETE_PROFILE_COPY.title) && noticeHtml.includes(INCOMPLETE_PROFILE_COPY.body) && noticeHtml.includes('href="/settings"'), 'notice renders the exact copy + /settings link');

  // frozen areas untouched
  const { execSync } = await import('child_process');
  const root = path.join(__dirname, '..');
  const diffNames = execSync('git diff --name-only origin/main', { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const frozen = ['src/lib/matching/', 'src/app/api/opportunities/swipe/', 'src/lib/eligibility', 'src/lib/ingestion/'];
  assert(diffNames.every((f) => !frozen.some((x) => f.startsWith(x))), 'diff vs origin/main touches no matcher / swipe route / ingestion files', diffNames.join(', '));

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

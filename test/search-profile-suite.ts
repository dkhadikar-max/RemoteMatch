/**
 * J — Unified Search Profile.
 * ==============================================================================
 *   1. Static check — match/[jobId]/page.tsx now hydrates before reading the
 *      client profile fixture (J4).
 *   2. HTTP — update_search_preferences() partial-update semantics: one field
 *      changes, every other field byte-identical; several fields atomically;
 *      validation (400s); auth (401); RLS (user B never touches user A).
 *   3. Scope-boundary proofs — currentTimezone / allowedCountries /
 *      willingTimezones untouched (J5); profile_skills row count untouched (no
 *      second skills source, ticket I stays the only skills writer);
 *      onboarding_completed_at untouched (complete_onboarding never called).
 *   4. Live-feed check — an edited target role changes feed *inputs* only;
 *      order stays fitScore-desc (engine.ts untouched).
 *   5. Immutability — an existing swipe's decision_snapshot is byte-identical
 *      after a search-preference update.
 *
 * Run: set -a && source .env.local && set +a && TEST_BASE_URL=... npx tsx test/search-profile-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import { hasRequiredEnv, newVerifiedSession, adminClient } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

async function run() {
  console.log('='.repeat(78));
  console.log('J — UNIFIED SEARCH PROFILE');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. STATIC CHECK — J4 hydration correction');
  // ==========================================================================
  {
    const matchPage = readFileSync(join(__dirname, '../src/app/match/[jobId]/page.tsx'), 'utf8');
    assert(matchPage.includes('hydrateLocalProfileFromServer'), 'match/[jobId]/page.tsx now hydrates from the server before reading the client profile fixture');
    const settingsPage = readFileSync(join(__dirname, '../src/app/settings/page.tsx'), 'utf8');
    assert(settingsPage.includes('SearchProfile'), 'Settings renders the SearchProfile panel');
    assert(!settingsPage.includes('Editing preferences from here is coming soon'), 'the old read-only Preferences copy is gone');
    const route = readFileSync(join(__dirname, '../src/app/api/profile/search-preferences/route.ts'), 'utf8');
    assert(!route.includes("rpc('complete_onboarding'"), 'the search-preferences route never calls complete_onboarding()');
    assert(!route.includes(".from('profile_skills'"), 'the search-preferences route never writes profile_skills directly');
    assert(route.includes("rpc('update_search_preferences'"), 'the route calls update_search_preferences() — the one path in (migration 017)');
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping HTTP section — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // migration-017 presence probe (same technique as 015/016's suites)
  const admin = adminClient();
  const probe = await admin.rpc('update_search_preferences', {});
  const migrated = !(probe.error && /does not exist|not find/i.test(probe.error.message || ''));
  if (!migrated) {
    skip(`migration 017 not applied yet (${probe.error?.message}) — HTTP section deferred`);
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }
  assert(probe.error?.code === '28000', `migration 017 present — service-role call (no auth.uid()) hits the function's own auth gate (got ${probe.error?.code})`);

  // ==========================================================================
  console.log('\n2+3. HTTP — partial updates, validation, RLS, scope-boundary proofs');
  // ==========================================================================
  const session = await newVerifiedSession();
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` };
  const getOnboarding = () => fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } }).then((r) => r.json());
  const postPrefs = (body: object, token: string | null = session.token) =>
    fetch(`${BASE_URL}/api/profile/search-preferences`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  try {
    const ob0 = await fetch(`${BASE_URL}/api/onboarding`, {
      method: 'POST', headers: authHeaders,
      body: JSON.stringify({
        fullName: 'J Tester', employmentTypes: ['Full-time'], targetRoles: ['Data Engineer'],
        yearsOfExperience: '4-6', minSalary: 100000, skills: [{ name: 'SQL', isPrimary: true }],
        workPreference: 'worldwide', currentCountry: 'United States', currentTimezone: 'Americas (EST/PST)',
        allowedCountries: ['Worldwide'], willingTimezones: ['UTC'],
      }),
    });
    assert(ob0.status === 200, `seed onboarding -> 200 (got ${ob0.status})`);
    const before = await getOnboarding();
    const skillsBefore = before.skills.length;
    const onboardingCompletedAtBefore = before.onboardingCompletedAt;

    // --- single-field partial update -----------------------------------
    const r1 = await postPrefs({ yearsOfExperience: '7-10' });
    assert(r1.status === 200, `single-field update -> 200 (got ${r1.status})`);
    const after1 = await getOnboarding();
    assert(after1.yearsOfExperience === '7-10', `yearsOfExperience changed (got ${after1.yearsOfExperience})`);
    assert(
      JSON.stringify(after1.targetRoles) === JSON.stringify(before.targetRoles) &&
        JSON.stringify(after1.employmentTypes) === JSON.stringify(before.employmentTypes) &&
        after1.minSalary === before.minSalary &&
        after1.workPreference === before.workPreference &&
        after1.currentCountry === before.currentCountry,
      'every OTHER field is byte-identical after a single-field update (true partial update)',
    );

    // --- J5: fields NOT in the RPC's remit are never touched ------------
    assert(
      after1.currentTimezone === before.currentTimezone &&
        JSON.stringify(after1.allowedCountries) === JSON.stringify(before.allowedCountries) &&
        JSON.stringify(after1.willingTimezones) === JSON.stringify(before.willingTimezones),
      'currentTimezone / allowedCountries / willingTimezones are untouched (J5 — not in scope, not repurposed)',
    );

    // --- several fields at once, atomically ------------------------------
    const r2 = await postPrefs({
      targetRoles: ['Product Manager', 'Data Engineer'],
      minSalary: 130000,
      workPreference: 'my_country',
      currentCountry: 'Canada',
    });
    assert(r2.status === 200, `grouped update -> 200 (got ${r2.status})`);
    const after2 = await getOnboarding();
    assert(
      JSON.stringify([...after2.targetRoles].sort()) === JSON.stringify(['Data Engineer', 'Product Manager'].sort()) &&
        after2.minSalary === 130000 &&
        after2.workPreference === 'my_country' &&
        after2.currentCountry === 'Canada',
      'grouped update applied all four fields atomically',
    );
    assert(after2.yearsOfExperience === '7-10', 'yearsOfExperience from the earlier update survives (still partial, not a reset)');

    // --- no second skills source ------------------------------------------
    assert(after2.skills.length === skillsBefore, `profile_skills untouched by search-preferences updates (still ${skillsBefore} skills)`);

    // --- complete_onboarding never re-invoked ------------------------------
    assert(after2.onboardingCompletedAt === onboardingCompletedAtBefore, 'onboarding_completed_at unchanged — complete_onboarding() was never called');

    // --- validation ---------------------------------------------------------
    assert((await postPrefs({ targetRoles: [] })).status === 400, 'empty targetRoles array -> 400');
    assert((await postPrefs({ employmentTypes: [] })).status === 400, 'empty employmentTypes array -> 400');
    assert((await postPrefs({ yearsOfExperience: 'ancient' })).status === 400, 'invalid yearsOfExperience -> 400');
    assert((await postPrefs({ workPreference: 'mars' })).status === 400, 'invalid workPreference -> 400');
    assert((await postPrefs({ currentCountry: '   ' })).status === 400, 'blank currentCountry -> 400');
    assert((await postPrefs({ minSalary: -5 })).status === 400, 'negative minSalary -> 400');
    assert((await postPrefs({})).status === 400, 'empty body -> 400 (no fields supplied)');
    assert((await postPrefs({ yearsOfExperience: '4-6' }, null)).status === 401, 'unauthenticated -> 401');

    // --- RLS: user B's update never touches user A ---------------------------
    const other = await newVerifiedSession();
    try {
      const ocB = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${other.token}` } } });
      await ocB.rpc('update_search_preferences', { p_current_country: 'Freedonia' });
      const { data: aIntent } = await admin.from('profile_locations').select('current_country').eq('profile_id', session.userId).maybeSingle();
      assert(aIntent?.current_country !== 'Freedonia', "user B's update never touched user A's profile_locations");
      const { data: bIntent } = await admin.from('profile_locations').select('current_country').eq('profile_id', other.userId).maybeSingle();
      assert(bIntent?.current_country === 'Freedonia', "user B's own row was written");
    } finally {
      await admin.auth.admin.deleteUser(other.userId).catch(() => {});
    }

    // ==========================================================================
    console.log('\n4. LIVE FEED — edited target role changes inputs only, order stays fitScore-desc');
    // ==========================================================================
    await postPrefs({ targetRoles: ['Full Stack Engineer'], workPreference: 'worldwide', currentCountry: 'United States' });
    const editedProfile = {
      id: session.userId, email: 'j@ex.com', fullName: 'J', planTier: 'free',
      dailyEvaluationsCount: 0, lastEvaluationResetAt: new Date().toISOString(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      skills: [{ id: 's1', profileId: session.userId, skillName: 'SQL', isPrimary: true }],
      experiences: [],
      intent: { id: 'i', profileId: session.userId, employmentTypes: ['Full-time'], targetRoles: ['Full Stack Engineer'], yearsOfExperience: '7-10', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: new Date().toISOString() },
      location: { id: 'l', profileId: session.userId, currentCountry: 'United States', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    };
    const feed = await (await fetch(`${BASE_URL}/api/opportunities/feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: editedProfile }),
    })).json();
    const opps = (feed.opportunities as any[]) ?? [];
    const sortedOk = opps.every((o, i) => i === 0 || opps[i - 1].fitScore >= o.fitScore);
    assert(feed.success && sortedOk, `feed for the edited profile stays fitScore-desc (${opps.slice(0, 4).map((o) => o.fitScore).join(', ')})`);

    // ==========================================================================
    console.log('\n5. IMMUTABILITY — an existing decision_snapshot is unaffected');
    // ==========================================================================
    if (opps.length > 0) {
      const oppId = opps[0].id;
      const sw = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ opportunityId: oppId, action: 'interested' }),
      });
      if (sw.status === 200) {
        const { data: beforeSnap } = await admin.from('swipes').select('decision_snapshot, created_at').eq('profile_id', session.userId).eq('opportunity_id', oppId).maybeSingle();
        await postPrefs({ targetRoles: ['Totally Different Role'], minSalary: 999999 });
        const { data: afterSnap } = await admin.from('swipes').select('decision_snapshot, created_at').eq('profile_id', session.userId).eq('opportunity_id', oppId).maybeSingle();
        assert(JSON.stringify(beforeSnap) === JSON.stringify(afterSnap), 'the swipe row + decision_snapshot are byte-identical after a search-preference update');
      } else {
        skip(`swipe returned ${sw.status} — immutability check skipped`);
      }
    } else {
      skip('no feed opportunities to swipe — immutability check skipped');
    }
  } finally {
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running search-profile suite:', e); process.exit(1); });

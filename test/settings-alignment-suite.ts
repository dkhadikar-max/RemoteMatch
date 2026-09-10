/**
 * F — Settings data-source alignment.
 * ==============================================================================
 * /settings must render SERVER-authoritative state only — `/api/profile` +
 * `/api/onboarding` — with no `localStore`/fixture value and no fabricated
 * fallback. A clean browser / new device / cleared localStorage must show the
 * same thing, because the page never reads local state for display.
 *
 * This suite covers what's testable without a browser:
 *   1. computeProfileCompleteness — pure, deterministic (filled/5).
 *   2. Source guard — settings/page.tsx has none of the banned fixture literals.
 *   3. HTTP contract — with a real verified session, `/api/onboarding` +
 *      `/api/profile` return the authoritative fields the page renders from.
 *   4. Write path — a user-session UPDATE of full_name/headline on `profiles`
 *      (the exact call the page makes) succeeds and is immediately reflected by
 *      `/api/onboarding`, and by a SECOND, independent session (proves DB-backed,
 *      not client-cached).
 *   5. Empty state — a user with null headline / no skills / no intent yields
 *      null/empty from `/api/onboarding` and a correct low completeness score.
 *
 * The clean-browser render assertions (no "Alex Chen", server values visible,
 * completeness deterministic in the UI) are a browser check against production
 * after deploy — see the F production-verification notes.
 *
 * Run: set -a && source .env.local && set +a && TEST_BASE_URL=http://localhost:3000 npx tsx test/settings-alignment-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import { computeProfileCompleteness } from '../src/lib/profile/completeness';
import { hasRequiredEnv, newVerifiedSession, adminClient } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tokenClient(token: string) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function run() {
  console.log('='.repeat(78));
  console.log('F — SETTINGS DATA-SOURCE ALIGNMENT');
  console.log('='.repeat(78));

  // ------------------------------------------------------------------
  // 1. computeProfileCompleteness — deterministic filled/5
  // ------------------------------------------------------------------
  console.log('\n1. computeProfileCompleteness (deterministic, no fabricated fallback)');
  {
    const empty = computeProfileCompleteness({ skillCount: 0, targetRoleCount: 0, employmentTypeCount: 0 });
    assert(empty.completed === 0 && empty.percent === 0, `all empty -> 0 / 0% (got ${empty.completed} / ${empty.percent}%)`);

    const two = computeProfileCompleteness({
      fullName: 'Jane', headline: 'Engineer', skillCount: 0, targetRoleCount: 0, employmentTypeCount: 0,
    });
    assert(two.completed === 2 && two.percent === 40, `name + headline only -> 2 / 40% (got ${two.completed} / ${two.percent}%)`);

    const roleOnly = computeProfileCompleteness({ skillCount: 0, targetRoleCount: 1, employmentTypeCount: 0 });
    assert(roleOnly.criteria.preferences && roleOnly.completed === 1, 'a target role alone satisfies the preferences criterion');
    const empOnly = computeProfileCompleteness({ skillCount: 0, targetRoleCount: 0, employmentTypeCount: 1 });
    assert(empOnly.criteria.preferences, 'an employment type alone also satisfies the preferences criterion');

    const halfLoc = computeProfileCompleteness({ skillCount: 0, targetRoleCount: 0, employmentTypeCount: 0, currentCountry: 'US', currentTimezone: '' });
    assert(!halfLoc.criteria.location, 'country without timezone does NOT satisfy location');

    const full = computeProfileCompleteness({
      fullName: 'Jane', headline: 'Engineer', skillCount: 3, targetRoleCount: 2, employmentTypeCount: 1,
      currentCountry: 'US', currentTimezone: 'America/New_York',
    });
    assert(full.completed === 5 && full.percent === 100, `all five -> 5 / 100% (got ${full.completed} / ${full.percent}%)`);

    const whitespace = computeProfileCompleteness({ fullName: '   ', headline: '\t', skillCount: 0, targetRoleCount: 0, employmentTypeCount: 0 });
    assert(whitespace.completed === 0, 'whitespace-only name/headline count as empty');
  }

  // ------------------------------------------------------------------
  // 2. Source guard — no fixture literals in settings/page.tsx
  // ------------------------------------------------------------------
  console.log('\n2. settings/page.tsx source guard (no fixture / fabricated literals)');
  {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/app/settings/page.tsx'), 'utf8');
    assert(!src.includes('Remote · Full-time'), 'no hardcoded "Remote · Full-time" string');
    assert(!/Alex Chen|alex\.chen@example\.com/.test(src), 'no "Alex Chen" / demo email literal');
    assert(!/\|\|\s*85\b|\?\?\s*85\b/.test(src), 'no "|| 85" / "?? 85" fabricated completeness fallback');
    assert(!/\|\|\s*'4-6'|\?\?\s*'4-6'/.test(src), "no \"|| '4-6'\" fabricated experience fallback");
    assert(!/skills\.length\s*\|\|\s*5|skills\.length\s*\?\?\s*5/.test(src), 'no "skills.length || 5" fabricated count');
    assert(!/localStore\.getProfile\(\)/.test(src.replace(/\/\/.*$/gm, '')), 'no localStore.getProfile() read for display (comments excluded)');
    assert(/fetchServerEntitlement/.test(src) && /\/api\/onboarding/.test(src), 'reads /api/profile (via fetchServerEntitlement) AND /api/onboarding directly');
    assert(/from\('profiles'\)\s*\n?\s*\.update\(\{ full_name/.test(src) || /\.update\(\{ full_name: name, headline:/.test(src), 'saves full_name/headline via a profiles UPDATE (server-authoritative write)');
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping HTTP + write-path checks — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------------------
  // 3 + 4. HTTP contract + write path (real verified session)
  // ------------------------------------------------------------------
  console.log('\n3+4. HTTP contract + write path (real verified session)');
  const session = await newVerifiedSession();
  const admin = adminClient();
  try {
    // /api/profile
    const profRes = await fetch(`${BASE_URL}/api/profile`, { headers: { Authorization: `Bearer ${session.token}` } });
    const prof = await profRes.json().catch(() => null);
    assert(profRes.status === 200, `GET /api/profile -> 200 (got ${profRes.status})`);
    assert(prof?.email === session.email, `/api/profile returns the authenticated email (got ${prof?.email})`);
    assert(prof?.planTier === 'free' && typeof prof?.dailyRightSwipesCount === 'number', '/api/profile returns entitlement fields');

    // /api/onboarding — fresh account: everything empty, name from signup metadata
    const onbRes = await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } });
    const onb = await onbRes.json().catch(() => null);
    assert(onbRes.status === 200, `GET /api/onboarding -> 200 (got ${onbRes.status})`);
    assert(
      Array.isArray(onb?.skills) && onb.skills.length === 0 &&
        Array.isArray(onb?.targetRoles) && onb.targetRoles.length === 0 &&
        onb?.headline === '' && onb?.yearsOfExperience === null,
      'fresh account: skills/targetRoles empty, headline "", yearsOfExperience null (no fabrication)',
    );

    // 5. empty-state completeness from that snapshot
    const emptyComp = computeProfileCompleteness({
      fullName: onb?.fullName, headline: onb?.headline, skillCount: onb?.skills.length ?? 0,
      targetRoleCount: onb?.targetRoles.length ?? 0, employmentTypeCount: onb?.employmentTypes.length ?? 0,
      currentCountry: onb?.currentCountry, currentTimezone: onb?.currentTimezone,
    });
    console.log(`   fresh-account completeness: ${emptyComp.completed}/5 (${emptyComp.percent}%)`);
    assert(emptyComp.percent <= 20, `fresh account computes a LOW completeness (<=20%), got ${emptyComp.percent}%`);

    // write path — the exact call settings/page.tsx makes
    const uc = tokenClient(session.token);
    const newName = `F Test ${Date.now()}`;
    const newHeadline = 'Staff Platform Engineer';
    const { error: upErr } = await uc.from('profiles').update({ full_name: newName, headline: newHeadline }).eq('id', session.userId);
    assert(!upErr, `user-session UPDATE of profiles.full_name/headline succeeds (RLS safe-columns)${upErr ? ` — ${upErr.message}` : ''}`);

    // reflected immediately by /api/onboarding on the SAME session
    const onb2 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
    assert(onb2?.fullName === newName && onb2?.headline === newHeadline, 'GET /api/onboarding reflects the new name + headline immediately');

    // reflected by a SECOND, independent session (proves DB-backed, not client state)
    const { data: signIn } = await createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      .auth.signInWithPassword({ email: session.email, password: session.password });
    const token2 = signIn?.session?.access_token;
    assert(Boolean(token2), 'a second sign-in for the same user yields a fresh token');
    if (token2) {
      const onb3 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${token2}` } })).json();
      assert(onb3?.fullName === newName && onb3?.headline === newHeadline, 'a fresh session sees the same name + headline (server-authoritative, survives new device / cleared localStorage)');
    }

    // blanking headline -> null round-trips as "" (page shows "Not set")
    await uc.from('profiles').update({ headline: null }).eq('id', session.userId);
    const onb4 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: { Authorization: `Bearer ${session.token}` } })).json();
    assert(onb4?.headline === '', 'cleared headline round-trips as "" (rendered as "Not set")');
  } finally {
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal error running settings-alignment suite:', err);
  process.exit(1);
});

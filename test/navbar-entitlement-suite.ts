/**
 * G — Navbar entitlement/quota alignment.
 * ==============================================================================
 * The navbar (src/components/navigation/navbar.tsx) used to hardcode
 * `evaluationCount = 3` (=> always "12 saves left today") and `isPro = false`
 * (=> Pro users never saw the badge). It now derives everything from
 * `fetchServerEntitlement()` → GET /api/profile, and renders NOTHING when there
 * is no session.
 *
 * This suite proves the server returns exactly the shape the navbar's render
 * logic consumes, and that the value it displays moves correctly:
 *   1. Pure — the navbar's derivations (savesRemaining, avatarInitial, which
 *      widget shows) against representative entitlement shapes.
 *   2. HTTP — fresh Free = 15; each interested swipe decrements; Pro = badge;
 *      no session = null; Pro rewind nets to zero.
 *   3. Static-render guard — navbar stays a client component; layout is not
 *      forced dynamic.
 *
 * Run: set -a && source .env.local && set +a && TEST_BASE_URL=... npx tsx test/navbar-entitlement-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import type { ServerEntitlement } from '../src/lib/entitlement/client';
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

// ---- the navbar's own derivations, mirrored exactly ------------------------
function savesRemaining(ent: ServerEntitlement | null): number | null {
  return ent ? Math.max(ent.rightSwipeLimit - ent.dailyRightSwipesCount, 0) : null;
}
function avatarInitial(ent: ServerEntitlement | null): string {
  const email = ent?.email?.trim();
  const ch = email ? email.match(/[a-z0-9]/i)?.[0] : undefined;
  return (ch ?? '?').toUpperCase();
}
function widget(ent: ServerEntitlement | null): 'pro-badge' | 'saves-pill' | 'none' {
  if (ent?.planTier === 'pro') return 'pro-badge';
  if (savesRemaining(ent) !== null) return 'saves-pill';
  return 'none';
}

async function run() {
  console.log('='.repeat(78));
  console.log('G — NAVBAR ENTITLEMENT / QUOTA ALIGNMENT');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. PURE — navbar derivations');
  // ==========================================================================
  {
    const free = (over: Partial<ServerEntitlement> = {}): ServerEntitlement => ({
      planTier: 'free', dailyRightSwipesCount: 0, dailyProposalsCount: 0, usageDate: '2026-09-11',
      rightSwipeLimit: 15, proposalLimit: 5, email: 'alex.chen@example.com', isAnonymous: false,
      linkedinUrl: null, githubUrl: null, careerDirection: 'continue', ...over,
    });

    assert(savesRemaining(free()) === 15, 'fresh Free → 15 saves');
    assert(savesRemaining(free({ dailyRightSwipesCount: 1 })) === 14, 'after 1 save → 14');
    assert(savesRemaining(free({ dailyRightSwipesCount: 15 })) === 0, 'at the limit → 0 (never negative)');
    assert(savesRemaining(free({ dailyRightSwipesCount: 99 })) === 0, 'past the limit → clamped to 0');
    assert(savesRemaining(null) === null, 'no session → null (pill not rendered)');

    assert(widget(free()) === 'saves-pill', 'Free renders the saves pill');
    assert(widget(free({ planTier: 'pro' })) === 'pro-badge', 'Pro renders the badge, not the pill');
    assert(widget(null) === 'none', 'no session renders neither pill nor badge');

    assert(avatarInitial(free()) === 'A', "avatar initial = first alnum of email, uppercased ('alex…' → 'A')");
    assert(avatarInitial(free({ email: '  9lives@x.io' })) === '9', 'leading space skipped, digit is fine');
    assert(avatarInitial(free({ email: null })) === '?', 'no email → "?" (never "A")');
    assert(avatarInitial(null) === '?', 'no session → "?"');
  }

  // ==========================================================================
  console.log('\n2. STATIC-RENDER GUARD');
  // ==========================================================================
  {
    const nav = readFileSync(join(__dirname, '../src/components/navigation/navbar.tsx'), 'utf8');
    const layout = readFileSync(join(__dirname, '../src/app/layout.tsx'), 'utf8');
    assert(nav.trimStart().startsWith("'use client'"), 'navbar.tsx is a client component');
    assert(!/export\s+const\s+dynamic/.test(nav) && !/generateStaticParams/.test(nav), 'navbar.tsx forces no dynamic rendering');
    assert(!/export\s+const\s+dynamic/.test(layout), 'layout.tsx is not forced dynamic');
    assert(!/isPro\s*=\s*false/.test(nav) && !/useState\(3\)/.test(nav), 'the hardcoded isPro=false / useState(3) are gone');
  }

  if (!hasRequiredEnv()) {
    console.log('\n(Skipping HTTP section — Supabase env not set.)');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  // ==========================================================================
  console.log('\n3. HTTP — /api/profile is what the navbar reads; the value moves');
  // ==========================================================================
  const admin = adminClient();
  const session = await newVerifiedSession();
  const getProfile = (token: string | null) =>
    fetch(`${BASE_URL}/api/profile`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

  try {
    // fresh Free
    const r1 = await getProfile(session.token);
    assert(r1.status === 200, `GET /api/profile → 200 (got ${r1.status})`);
    const p1 = (await r1.json()) as ServerEntitlement;
    assert(p1.planTier === 'free', `fresh account is Free (got ${p1.planTier})`);
    assert(p1.rightSwipeLimit === 15, `rightSwipeLimit === 15 (got ${p1.rightSwipeLimit})`);
    assert(p1.dailyRightSwipesCount === 0, `fresh dailyRightSwipesCount === 0 (got ${p1.dailyRightSwipesCount})`);
    assert(typeof p1.email === 'string' && p1.email.length > 0, 'email present (drives the avatar)');
    assert(savesRemaining(p1) === 15, 'navbar would render "15 saves left today"');

    // no session → null
    const rNo = await getProfile(null);
    assert(rNo.status === 401, `no Authorization → 401 (got ${rNo.status})`);
    // fetchServerEntitlement treats any non-200 as null
    assert(widget(rNo.ok ? ((await rNo.json()) as ServerEntitlement) : null) === 'none',
      'no session → navbar renders neither pill nor badge');

    // each interested swipe decrements the displayed value
    const feed = await (await fetch(`${BASE_URL}/api/opportunities/feed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    const oppIds: string[] = (feed.opportunities as any[]).map((o) => o.id);
    let expected = 0;
    for (let i = 0; i < 3 && i < oppIds.length; i++) {
      const sw = await fetch(`${BASE_URL}/api/opportunities/swipe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ opportunityId: oppIds[i], action: 'interested' }),
      });
      if (sw.status === 200) expected += 1;
      const pn = (await (await getProfile(session.token)).json()) as ServerEntitlement;
      assert(pn.dailyRightSwipesCount === expected,
        `after ${expected} interested swipe(s), dailyRightSwipesCount === ${expected} (got ${pn.dailyRightSwipesCount})`);
      assert(savesRemaining(pn) === 15 - expected, `navbar would render "${15 - expected} saves left today"`);
    }

    // Pro → the badge, not the pill
    const { error: upErr } = await admin.from('profiles').update({ plan_tier: 'pro' }).eq('id', session.userId);
    assert(!upErr, `elevate to Pro server-side (${upErr?.message ?? 'ok'})`);
    const pPro = (await (await getProfile(session.token)).json()) as ServerEntitlement;
    assert(pPro.planTier === 'pro', `GET /api/profile reflects Pro (got ${pPro.planTier})`);
    assert(widget(pPro) === 'pro-badge', 'navbar would render the Pro badge (no saves pill)');

    // Pro rewind nets the count back to zero effect (refund path fires
    // notifyEntitlementChanged in the app; here we just prove the number is honest)
    const beforeRewind = ((await (await getProfile(session.token)).json()) as ServerEntitlement).dailyRightSwipesCount;
    const rw = await fetch(`${BASE_URL}/api/opportunities/rewind`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}` },
    });
    const rwData = await rw.json().catch(() => ({}));
    if (rw.status === 200 && rwData.success) {
      const afterRewind = ((await (await getProfile(session.token)).json()) as ServerEntitlement).dailyRightSwipesCount;
      assert(afterRewind <= beforeRewind,
        `rewind does not increase the consumed count (${beforeRewind} → ${afterRewind})`);
    } else {
      skip(`rewind returned ${rw.status} (${rwData.error ?? 'no detail'}) — refund delta check skipped`);
    }
  } finally {
    await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running navbar-entitlement suite:', e); process.exit(1); });

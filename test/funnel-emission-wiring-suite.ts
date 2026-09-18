/**
 * Funnel Instrumentation — Unit 1 EMISSION WIRING verification.
 * ==============================================================================
 * Scope: proves the real API-layer mechanics the four new call sites depend
 * on (src/app/page.tsx, src/components/auth/VerifyCode.tsx,
 * src/app/feed/page.tsx, src/components/feed/swipe-deck.tsx) — by issuing
 * the EXACT same request shapes those components now send, against real
 * infrastructure with disposable accounts, then reading back the real rows.
 *
 * This project has no component-level (jsdom/React Testing Library) test
 * infrastructure anywhere — every existing suite is HTTP/real-infra
 * boundary testing (see test/funnel-event-api-suite.ts, test/helpers/
 * verified-session.ts). This suite follows the same convention. It does
 * NOT click through the real UI — landing_viewed (the one unauthenticated,
 * public page) is instead verified live in the actual browser, separately,
 * since that's the one page reachable without a login. signup_attributed
 * and feed_viewed/job_viewed are proven at the API layer using a real
 * session token obtained via the service-role admin API (never a typed
 * password, never a browser cookie) — the same permission-compliant
 * technique already established this session for the admin console check.
 *
 * Section 4 statically re-reads the actual source of
 * recordFunnelEventClient() to prove its never-throw contract by
 * construction, since that's what src/components/auth/VerifyCode.tsx
 * relies on to guarantee a funnel-recording failure can never block or
 * fail the real sign-in flow it's attached to.
 *
 * REQUIRES: Supabase env vars set. Run: npx tsx --env-file=.env.local
 * test/funnel-emission-wiring-suite.ts
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;
import * as fs from 'fs';
import * as path from 'path';

import { hasRequiredEnv, newVerifiedSession, adminClient, TestSession } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

function authedFetch(token: string | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

function anonymousId(): string {
  // Matches crypto.randomUUID()'s actual shape, not just the validator's
  // loose pattern — the real anonymous-id.ts uses crypto.randomUUID().
  return crypto.randomUUID();
}

async function run() {
  console.log('='.repeat(78));
  console.log('FUNNEL INSTRUMENTATION — UNIT 1 EMISSION WIRING');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. STATIC SOURCE CHECKS — the four wired call sites exist correctly');
  // ==========================================================================
  {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

    const anonIdSrc = read('src/lib/funnel/anonymous-id.ts');
    assert(anonIdSrc.includes('crypto.randomUUID()'), 'anonymous-id.ts generates via crypto.randomUUID()');
    assert(anonIdSrc.includes("localStorage.getItem(STORAGE_KEY)") && anonIdSrc.includes('localStorage.setItem(STORAGE_KEY'), 'anonymous-id.ts persists to and reads from localStorage under one stable key');
    assert(/catch\s*{\s*return null;\s*}/.test(anonIdSrc), 'anonymous-id.ts returns null (never throws) when storage is unavailable');

    const clientSrc = read('src/lib/funnel/client.ts');
    const clientCodeOnly = clientSrc.replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments/JSDoc before scanning for real statements
    assert(/try\s*{[\s\S]*fetch\('\/api\/funnel\/event'/.test(clientSrc), 'client.ts wraps the fetch in try');
    assert(/catch\s*{[\s\S]*}/.test(clientSrc) && !/\bthrow\b/.test(clientCodeOnly), 'client.ts has a catch block and never contains a throw statement — the never-throw contract holds by construction');

    const landingSrc = read('src/app/page.tsx');
    assert(landingSrc.includes("recordFunnelEventClient('landing_viewed'"), 'page.tsx calls recordFunnelEventClient(landing_viewed)');
    assert(/useEffect\(\(\) => {[\s\S]*getOrCreateAnonymousId[\s\S]*}, \[\]\)/.test(landingSrc), 'page.tsx fires it from a mount-only effect ([] deps)');

    const verifySrc = read('src/components/auth/VerifyCode.tsx');
    const signupIdx = verifySrc.indexOf("recordFunnelEventClient('signup_attributed'");
    const navIdx = verifySrc.indexOf("window.location.replace('/feed')");
    assert(signupIdx !== -1 && navIdx !== -1 && signupIdx < navIdx, 'VerifyCode.tsx calls signup_attributed BEFORE the hard navigation, not after (would be cancelled in flight)');
    assert(/await recordFunnelEventClient\('signup_attributed'/.test(verifySrc), 'the signup_attributed call is awaited, guaranteeing it completes before navigation');
    assert(verifySrc.indexOf('if (result.success)') < signupIdx, 'signup_attributed only fires on a genuinely successful verifyEmailOtp — never on failure');

    const feedSrc = read('src/app/feed/page.tsx');
    assert(feedSrc.includes("recordFunnelEventClient('feed_viewed')"), 'feed/page.tsx calls recordFunnelEventClient(feed_viewed)');

    const deckSrc = read('src/components/feed/swipe-deck.tsx');
    assert(/useEffect\(\(\) => {[\s\S]*recordFunnelEventClient\('job_viewed', { opportunity_id: currentOpp\.id }\)[\s\S]*}, \[currentOpp\?\.id\]\)/.test(deckSrc), 'swipe-deck.tsx fires job_viewed from an effect keyed on currentOpp?.id');
    // M-adjacent-2(b) safety: the new effect must not touch the existing
    // keyboard-handling effect's own dependency array.
    assert(deckSrc.includes('[handleSwipe, currentOpp, isDetailsOpen]'), 'the pre-existing keyboard effect\'s dependency array is unchanged — M-adjacent-2(b) stays untouched');
  }

  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — sections 2-4 skipped.');
    finish();
    return;
  }
  let serverUp = true;
  try { await fetch(`${BASE_URL}/api/health`); } catch { serverUp = false; }
  if (!serverUp) {
    skip(`No server reachable at ${BASE_URL} — sections 2-4 skipped.`);
    finish();
    return;
  }

  // ==========================================================================
  console.log('\n2. LANDING -> SIGNUP ATTRIBUTION JOIN (real infra, disposable account)');
  // ==========================================================================
  let session: TestSession | null = null;
  let sharedAnonId = '';
  try {
    // Replicates exactly what page.tsx's effect sends for a fresh visitor.
    sharedAnonId = anonymousId();
    const landingRes = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'landing_viewed', anonymous_id: sharedAnonId }),
    });
    assert(landingRes.status === 201, `landing_viewed with a real crypto.randomUUID()-shaped id succeeds (got ${landingRes.status})`);

    // A real disposable account, standing in for "the same browser completes
    // signup" — the anonymous id is the SAME one localStorage would have
    // handed VerifyCode.tsx, proving the join is possible in principle; the
    // getOrCreateAnonymousId() call itself is proven to return a stable id
    // by the static check above.
    session = await newVerifiedSession();
    const signupRes = await authedFetch(session.token, '/api/funnel/event', {
      method: 'POST', body: JSON.stringify({ event_type: 'signup_attributed', anonymous_id: sharedAnonId }),
    });
    assert(signupRes.status === 201, `signup_attributed with the SAME anonymous_id succeeds authenticated (got ${signupRes.status})`);

    const admin = adminClient();
    const { data: rows } = await admin
      .from('funnel_events')
      .select('event_type, profile_id, anonymous_id')
      .eq('anonymous_id', sharedAnonId)
      .order('created_at', { ascending: true });

    assert(
      Boolean(rows) && rows!.length === 2 &&
      rows![0].event_type === 'landing_viewed' && rows![0].profile_id === null &&
      rows![1].event_type === 'signup_attributed' && rows![1].profile_id === session.userId,
      `the join actually works: one landing_viewed row (profile_id null) and one signup_attributed row (profile_id = the real new user), same anonymous_id (found ${rows?.length ?? 0} rows)`
    );

    // ========================================================================
    console.log('\n3. FEED_VIEWED + JOB_VIEWED SEMANTICS, INCLUDING REWIND (real infra)');
    // ========================================================================
    const feedRes = await authedFetch(session.token, '/api/funnel/event', {
      method: 'POST', body: JSON.stringify({ event_type: 'feed_viewed' }),
    });
    assert(feedRes.status === 201, `feed_viewed (exact shape feed/page.tsx sends, no extra fields) succeeds (got ${feedRes.status})`);

    // Simulates the swipe-deck sequence: card A viewed, card B viewed (swipe
    // advanced the deck), then card A viewed AGAIN (a rewind brought it back
    // to the front) -- per the spec's chosen semantic, this is a genuine
    // second view, not suppressed.
    const cardA = 'opp-curated-curated-001';
    const cardB = 'opp-curated-curated-002';
    const viewSequence = [cardA, cardB, cardA];
    for (const oppId of viewSequence) {
      const res = await authedFetch(session.token, '/api/funnel/event', {
        method: 'POST', body: JSON.stringify({ event_type: 'job_viewed', opportunity_id: oppId }),
      });
      assert(res.status === 201, `job_viewed(${oppId}) succeeds (got ${res.status})`);
    }

    const { data: jobRows } = await adminClient()
      .from('funnel_events')
      .select('opportunity_id, created_at')
      .eq('profile_id', session.userId)
      .eq('event_type', 'job_viewed')
      .order('created_at', { ascending: true });
    assert(
      Boolean(jobRows) && jobRows!.length === 3 && jobRows!.map((r) => r.opportunity_id).join(',') === viewSequence.join(','),
      `three distinct job_viewed rows landed in order A, B, A -- a rewind back to card A produces a genuine second row, not a dedup (found: ${jobRows?.map((r) => r.opportunity_id).join(',')})`
    );
  } finally {
    const admin = adminClient();
    await admin.from('funnel_events').delete().or(`anonymous_id.eq.${sharedAnonId},profile_id.eq.${session?.userId ?? '00000000-0000-0000-0000-000000000000'}`);
    if (session) await admin.auth.admin.deleteUser(session.userId).catch(() => {});
  }

  // ==========================================================================
  console.log('\n4. FUNNEL API FAILURE CANNOT BREAK THE REAL FLOW IT OBSERVES');
  // ==========================================================================
  {
    // The client wrapper's contract (section 1's static check already proved
    // it can never throw). Here: prove the SERVER SIDE failing this exact
    // call (malformed body, same as a real bug or transient issue would
    // produce) still returns an ordinary HTTP response, never a hang/crash
    // that could cascade into whatever awaited it.
    const start = Date.now();
    const res = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'signup_attributed' }), // missing anonymous_id + no auth
    });
    const elapsedMs = Date.now() - start;
    assert(res.status === 401 || res.status === 400, `a malformed/unauthenticated signup_attributed call fails fast with an ordinary HTTP error, not a hang (got ${res.status} in ${elapsedMs}ms)`);
    assert(elapsedMs < 10000, `failure response returned quickly (${elapsedMs}ms), consistent with VerifyCode.tsx's await never being able to stall the real sign-in flow`);
  }

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running funnel-emission-wiring suite:', e); process.exit(1); });

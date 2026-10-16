/**
 * RemoteMatch — Razorpay billing: HTTP-boundary real-infra suite (Gate 3)
 * ==============================================================================
 * Real HTTP against a running dev server, real Supabase Auth sessions, and the
 * real Razorpay TEST-mode API. Nothing is mocked. Plan:
 * docs/razorpay-integration-plan.md.
 *
 * REQUIRES:
 *   - dev server at TEST_BASE_URL (default http://127.0.0.1:3100, the
 *     findmegig-dev-newdb launch config) with the same env as this process
 *   - NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY /
 *     SUPABASE_SERVICE_ROLE_KEY for a project with migration 032 applied
 *   - RAZORPAY_KEY_ID (must be rzp_test_ — the suite refuses live keys),
 *     RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET, RAZORPAY_PRO_PLAN_ID
 *
 * What it cannot prove without a human-completed Checkout payment: a real
 * `active` subscription reaching Pro via /verify, the webhook's pro mapping,
 * the already-Pro 409, and cancel. Those run in PHASE 2 below, against a test
 * user who paid in the browser (RZP_E2E_USER_ID / RZP_E2E_TOKEN); without
 * them PHASE 2 is reported as skipped, never as passed.
 *
 * Every test user is deleted at the end (profiles cascade), pass or fail.
 *
 * Run: npx tsx --env-file=.env.migration.local test/razorpay-billing-suite.ts
 */

import { createHmac } from 'node:crypto';
import { adminClient, hasRequiredEnv, newVerifiedSession, type TestSession } from './helpers/verified-session';
import { checkoutOutcome, orphanDecision, planTierForSubscription } from '../src/lib/razorpay';
import {
  CLAIM_TTL_MS,
  claimMarker,
  claimSubscriptionSlot,
  commitSubscriptionSlot,
  isActiveClaim,
  releaseSubscriptionSlot,
  writeProfileIfUnchanged,
} from '../src/lib/razorpay-claim';
import { applySubscriptionToProfiles, MAX_ATTEMPTS, processWebhookEvent } from '../src/lib/razorpay-webhook-apply';
import { RazorpayApiError, type RazorpaySubscription } from '../src/lib/razorpay';

// 127.0.0.1, not localhost: .env.devserver.local maps localhost:3100 to the
// admin host, where middleware 404s every consumer route.
const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3100';
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const PLAN_ID = process.env.RAZORPAY_PRO_PLAN_ID ?? '';

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

function skip(message: string) {
  console.log(`  – SKIP: ${message}`);
  skipped++;
}

function api(token: string | null, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

const hmac = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('hex');

function postWebhook(event: unknown, opts: { signature?: string | null; eventId?: string } = {}) {
  const raw = JSON.stringify(event);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sig = opts.signature === undefined ? hmac(raw, WEBHOOK_SECRET) : opts.signature;
  if (sig !== null) headers['X-Razorpay-Signature'] = sig;
  if (opts.eventId) headers['X-Razorpay-Event-Id'] = opts.eventId;
  return fetch(`${BASE_URL}/api/razorpay/webhook`, { method: 'POST', headers, body: raw });
}

function subscriptionEvent(type: string, subscriptionId: string) {
  return { entity: 'event', event: type, payload: { subscription: { entity: { id: subscriptionId, status: 'active' } } } };
}

/** Test-key read from Razorpay. Backs off and retries on 429 (test mode rate-limits bursts of reads). */
async function rzpGet(path: string) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}` },
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
      continue;
    }
    return { status: res.status, body: await json(res) };
  }
}

/** Creates a subscription straight through Razorpay's API — bypassing our
 *  route — so the suite can stage an "orphan" no profile has stored. */
async function rzpCreateSubscription(notesUserId: string) {
  const res = await fetch('https://api.razorpay.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ plan_id: PLAN_ID, total_count: 60, quantity: 1, notes: { userId: notesUserId } }),
  });
  return { status: res.status, body: await json(res) };
}

async function profileOf(userId: string) {
  const { data } = await adminClient()
    .from('profiles')
    .select('plan_tier, razorpay_subscription_id, razorpay_subscription_status, razorpay_customer_id')
    .eq('id', userId)
    .single();
  return data as {
    plan_tier: string;
    razorpay_subscription_id: string | null;
    razorpay_subscription_status: string | null;
    razorpay_customer_id: string | null;
  } | null;
}

const createdUsers: string[] = [];
/** Every Razorpay subscription this run creates (all TEST mode). Reported, read back with the test key, at the end. */
const createdTestSubscriptions: string[] = [];
const trackSub = (id: unknown) => {
  if (typeof id === 'string' && id.startsWith('sub_') && !createdTestSubscriptions.includes(id)) createdTestSubscriptions.push(id);
};
const createdEventIds: string[] = [];

async function newUser(): Promise<TestSession> {
  const s = await newVerifiedSession();
  createdUsers.push(s.userId);
  return s;
}

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — RAZORPAY BILLING SUITE (real infra, test mode)');
  console.log('='.repeat(78));

  if (!hasRequiredEnv() || !KEY_ID || !KEY_SECRET || !WEBHOOK_SECRET || !PLAN_ID) {
    console.log('\nSupabase or Razorpay env is incomplete — reported honestly rather than faked.');
    process.exitCode = 1;
    return;
  }
  if (!KEY_ID.startsWith('rzp_test_')) {
    console.log('\nRefusing to run: RAZORPAY_KEY_ID is not a test-mode key.');
    process.exitCode = 1;
    return;
  }

  // --------------------------------------------------------------------------
  // UNIT — the shared rules both routes call. These pin the mapping; the live
  // behaviour of a real authenticated/active subscription is only established
  // by the paid phase (PHASE 2), never by these.
  console.log('\nUNIT: entitlement rule (planTierForSubscription)');
  const tierCases: Array<[string, number, 'pro' | 'free']> = [
    ['active', 0, 'pro'],
    ['active', 3, 'pro'],
    ['authenticated', 0, 'free'],
    ['authenticated', 1, 'pro'],
    ['pending', 0, 'free'],
    ['pending', 2, 'pro'],
    ['created', 0, 'free'],
    ['halted', 4, 'free'],
    ['cancelled', 4, 'free'],
    ['completed', 60, 'free'],
    ['expired', 0, 'free'],
    ['paused', 2, 'free'],
  ];
  for (const [status, paid, want] of tierCases) {
    const got = planTierForSubscription({ status, paid_count: paid });
    assert(got === want, `${status} with paid_count ${paid} → ${want}`, got);
  }

  console.log('\nUNIT: /verify outcome (checkoutOutcome)');
  assert(checkoutOutcome({ status: 'authenticated', paid_count: 0 }) === 'awaiting_first_charge', 'Authorised mandate, no charge yet → awaiting_first_charge (not a failure, not Pro)');
  assert(checkoutOutcome({ status: 'pending', paid_count: 0 }) === 'awaiting_first_charge', 'pending with no prior charge → awaiting_first_charge');
  assert(checkoutOutcome({ status: 'active', paid_count: 1 }) === 'granted', 'active → granted');
  assert(checkoutOutcome({ status: 'authenticated', paid_count: 1 }) === 'granted', 'authenticated after a charge → granted');
  assert(checkoutOutcome({ status: 'created', paid_count: 0 }) === 'not_paid', 'created → not_paid');
  assert(checkoutOutcome({ status: 'halted', paid_count: 3 }) === 'not_paid', 'halted → not_paid');

  console.log('\nUNIT: webhook orphan decision (orphanDecision)');
  const paidOrphan = { status: 'active', paid_count: 1 };
  assert(orphanDecision({ status: 'authenticated', paid_count: 0 }, null) === 'ignore', 'Unpaid (authenticated, 0 charges) orphan → ignore');
  assert(orphanDecision({ status: 'created', paid_count: 0 }, null) === 'ignore', 'created orphan → ignore');
  assert(orphanDecision(paidOrphan, null) === 'bind', 'Paid orphan, profile holds nothing → bind');
  for (const s of ['created', 'halted', 'cancelled', 'completed', 'expired', 'paused']) {
    assert(orphanDecision(paidOrphan, { status: s }) === 'bind', `Paid orphan, profile holds a '${s}' subscription (cannot charge) → bind`);
  }
  for (const s of ['authenticated', 'active', 'pending']) {
    assert(orphanDecision(paidOrphan, { status: s }) === 'reconcile', `Paid orphan, profile holds a live '${s}' mandate → reconcile, never replace`);
  }

  console.log('\nUNIT: claim marker');
  {
    const now = Date.now();
    assert(isActiveClaim(claimMarker(now), now), 'Fresh claim is active');
    assert(!isActiveClaim(claimMarker(now - CLAIM_TTL_MS - 1000), now), 'Claim older than the TTL is stale');
    assert(!isActiveClaim('created', now) && !isActiveClaim(null, now) && !isActiveClaim('cancel_scheduled', now), 'Non-claim statuses are never claims');
    assert(claimMarker(1) < claimMarker(now), 'Fixed-width markers order lexically by time');
  }

  // --------------------------------------------------------------------------
  // SAFETY GUARD — the SERVER's Razorpay credentials, not just this runner's,
  // must be TEST mode before any test that makes the server talk to Razorpay.
  // Proof without creating anything through the server: the runner creates a
  // subscription with its rzp_test_ key (it exists only in this account's test
  // mode), binds it to a guard profile with a sentinel status, and sends a
  // signed webhook. The server can only sync the real status if ITS key can
  // read that test-mode subscription — i.e. the server uses this account's
  // test-mode credentials (and the same webhook secret). Otherwise: abort.
  console.log('\nSAFETY GUARD: server uses Razorpay TEST-mode credentials');
  {
    const guardUser = await newUser();
    const guardSub = await rzpCreateSubscription(guardUser.userId);
    trackSub(guardSub.body?.id);
    let serverIsTestMode = false;
    let detail: unknown = { createStatus: guardSub.status };
    if (guardSub.status === 200) {
      await adminClient()
        .from('profiles')
        .update({ razorpay_subscription_id: guardSub.body.id, razorpay_subscription_status: 'guard-sentinel' })
        .eq('id', guardUser.userId);
      const eventId = `evt_test_${Date.now()}_guard`;
      createdEventIds.push(eventId);
      const res = await postWebhook(subscriptionEvent('subscription.updated', guardSub.body.id), { eventId });
      const p = await profileOf(guardUser.userId);
      serverIsTestMode = res.status === 200 && p?.razorpay_subscription_status === guardSub.body.status;
      detail = { webhookStatus: res.status, synced: p?.razorpay_subscription_status, expected: guardSub.body.status };
    }
    assert(serverIsTestMode, "Server read a TEST-mode-only subscription with its own key (server credentials are this account's test mode)", detail);
    if (!serverIsTestMode) {
      console.log('\nRefusing to continue: cannot prove the server is using Razorpay TEST-mode credentials.');
      process.exitCode = 1;
      return;
    }
  }

  // --------------------------------------------------------------------------
  console.log('\nAUTH');
  for (const path of ['/api/razorpay/subscription', '/api/razorpay/verify', '/api/razorpay/cancel']) {
    const res = await api(null, path, {});
    assert(res.status === 401, `Unauthenticated POST ${path} → 401`, res.status);
    const forged = await api('not-a-real-token', path, {});
    assert(forged.status === 401, `Garbage bearer token on ${path} → 401`, forged.status);
  }

  const userA = await newUser();
  const userB = await newUser();

  // --------------------------------------------------------------------------
  console.log('\nSUBSCRIPTION CREATE');
  const resA = await api(userA.token, '/api/razorpay/subscription');
  const dataA = await json(resA);
  assert(resA.status === 200 && dataA.success === true, 'Verified user can start checkout (200)', { status: resA.status, dataA });
  const subA: string = dataA.subscriptionId;
  trackSub(subA);
  assert(typeof subA === 'string' && subA.startsWith('sub_'), 'Response carries a real sub_ id', subA);
  assert(dataA.keyId === KEY_ID, 'Response carries the public key id (test key)');
  assert(!JSON.stringify(dataA).includes(KEY_SECRET), 'Response never contains the key secret');
  assert(dataA.isMock !== true, 'Configured server does not return the mock');

  const remoteA = await rzpGet(`/subscriptions/${subA}`);
  assert(remoteA.status === 200, 'Subscription exists in Razorpay (test mode)', remoteA.status);
  assert(remoteA.body.plan_id === PLAN_ID, 'Subscription is on the configured ₹499 plan', remoteA.body.plan_id);
  assert(remoteA.body.notes?.userId === userA.userId, 'Razorpay notes.userId binds it to the caller', remoteA.body.notes);
  assert(remoteA.body.status === 'created', "Fresh subscription status is 'created'", remoteA.body.status);

  const profA = await profileOf(userA.userId);
  assert(profA?.razorpay_subscription_id === subA, 'Subscription id stored on caller profile', profA);
  assert(profA?.plan_tier === 'free', 'Starting checkout grants nothing (still free)', profA?.plan_tier);

  {
    // F1(a): a second checkout start (second tab / retry) must reuse the still
    // unpaid subscription, never orphan it by minting a new one.
    const again = await api(userA.token, '/api/razorpay/subscription');
    const againBody = await json(again);
    assert(
      again.status === 200 && againBody.subscriptionId === subA,
      "F1: repeat checkout reuses the stored 'created' subscription (no orphan)",
      { status: again.status, got: againBody.subscriptionId, want: subA }
    );
    assert((await profileOf(userA.userId))?.razorpay_subscription_id === subA, 'F1: stored subscription id unchanged');
  }

  const resB = await api(userB.token, '/api/razorpay/subscription');
  const dataB = await json(resB);
  const subB: string = dataB.subscriptionId;
  trackSub(subB);
  assert(resB.status === 200 && subB !== subA, 'Second user gets a distinct subscription', { status: resB.status, subB });

  // --------------------------------------------------------------------------
  console.log('\nVERIFY');
  {
    const res = await api(userA.token, '/api/razorpay/verify', {});
    assert(res.status === 400, 'Missing payment details → 400', res.status);
  }
  {
    const res = await api(userA.token, '/api/razorpay/verify', {
      razorpay_payment_id: 'pay_FAKE123',
      razorpay_subscription_id: subA,
      razorpay_signature: 'deadbeef'.repeat(8),
    });
    assert(res.status === 400, 'Forged signature → 400', res.status);
    assert((await profileOf(userA.userId))?.plan_tier === 'free', 'Forged signature leaves user free');
  }
  {
    const res = await api(userA.token, '/api/razorpay/verify', { mock: true });
    assert(res.status === 400, 'Mock redemption refused when Razorpay is configured → 400', res.status);
  }
  {
    // A cryptographically VALID handler result for A's subscription, replayed
    // by B: passes check 1 (signature), must fail check 2 (ownership).
    const paymentId = 'pay_TestOwnership1';
    const sig = hmac(`${paymentId}|${subA}`, KEY_SECRET);
    const res = await api(userB.token, '/api/razorpay/verify', {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subA,
      razorpay_signature: sig,
    });
    assert(res.status === 403, "Valid signature for another user's subscription → 403", res.status);
    assert((await profileOf(userB.userId))?.plan_tier === 'free', 'Ownership rejection leaves B free');
  }
  {
    // Valid signature, own subscription, but Razorpay says 'created' (unpaid):
    // check 3 must refuse. Proves Pro never comes from the signature alone.
    const paymentId = 'pay_TestUnpaid1';
    const res = await api(userA.token, '/api/razorpay/verify', {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subA,
      razorpay_signature: hmac(`${paymentId}|${subA}`, KEY_SECRET),
    });
    assert(res.status === 400, "Valid signature but unpaid ('created') subscription → 400", res.status);
    assert((await profileOf(userA.userId))?.plan_tier === 'free', 'Unpaid subscription leaves A free');
  }

  // --------------------------------------------------------------------------
  console.log('\nWEBHOOK');
  {
    const res = await postWebhook(subscriptionEvent('subscription.activated', subA), { signature: null });
    assert(res.status === 400, 'Missing X-Razorpay-Signature → 400', res.status);
  }
  {
    const res = await postWebhook(subscriptionEvent('subscription.activated', subA), { signature: hmac('other body', WEBHOOK_SECRET) });
    assert(res.status === 400, 'Signature over a different body → 400', res.status);
  }
  {
    const res = await postWebhook(subscriptionEvent('subscription.activated', subA), { signature: hmac(JSON.stringify(subscriptionEvent('subscription.activated', subA)), 'wrong-secret') });
    assert(res.status === 400, 'Signature with the wrong secret → 400', res.status);
  }
  {
    // Validly signed 'activated' event whose body even claims status 'active',
    // for a subscription Razorpay knows is only 'created'. The route must take
    // the tier from Razorpay's API, not from the event — so A stays free.
    const eventId = `evt_test_${Date.now()}_a`;
    createdEventIds.push(eventId);
    const res = await postWebhook(subscriptionEvent('subscription.activated', subA), { eventId });
    const body = await json(res);
    assert(res.status === 200 && body.received === true, 'Validly signed webhook accepted (200)', { status: res.status, body });
    const p = await profileOf(userA.userId);
    assert(p?.plan_tier === 'free', "Event type/body can't grant Pro — tier comes from Razorpay's live status", p);
    assert(p?.razorpay_subscription_status === 'created', "Profile status synced from Razorpay ('created')", p?.razorpay_subscription_status);

    const replay = await postWebhook(subscriptionEvent('subscription.activated', subA), { eventId });
    const replayBody = await json(replay);
    assert(replay.status === 200 && replayBody.duplicate === true, 'Replayed event id is a no-op (duplicate)', replayBody);

    const { data: ledger } = await adminClient().from('razorpay_webhook_events').select('event_id, event_type').eq('event_id', eventId);
    assert(ledger?.length === 1 && ledger[0].event_type === 'subscription.activated', 'Event recorded exactly once in the ledger', ledger);
  }
  {
    // F1(b) negative: an orphan (no profile stores it) bound to B via notes,
    // but UNPAID. The notes.userId fallback must not bind or grant anything —
    // it only fires when Razorpay's live status grants Pro.
    const orphan = await rzpCreateSubscription(userB.userId);
    trackSub(orphan.body.id);
    assert(orphan.status === 200 && orphan.body.status === 'created', 'Staged an unpaid orphan subscription for B via the Razorpay API', orphan.status);
    const before = await profileOf(userB.userId);
    const eventId = `evt_test_${Date.now()}_orphan`;
    createdEventIds.push(eventId);
    const res = await postWebhook(subscriptionEvent('subscription.activated', orphan.body.id), { eventId });
    const after = await profileOf(userB.userId);
    assert(
      res.status === 200 &&
        after?.plan_tier === 'free' &&
        after?.razorpay_subscription_id === before?.razorpay_subscription_id,
      'F1: notes.userId fallback never binds or grants Pro for an unpaid orphan',
      { status: res.status, before, after }
    );
  }
  {
    const eventId = `evt_test_${Date.now()}_unknown`;
    createdEventIds.push(eventId);
    const res = await postWebhook({ entity: 'event', event: 'payment.captured', payload: {} }, { eventId });
    assert(res.status === 200, 'Unhandled event type acknowledged (200)', res.status);
  }
  {
    const res = await postWebhook(subscriptionEvent('subscription.charged', 'sub_DoesNotExist000'), { eventId: `evt_test_${Date.now()}_ghost` });
    assert(res.status === 502, 'Unknown subscription → 502 so Razorpay retries, not recorded', res.status);
    const { data: ledger } = await adminClient().from('razorpay_webhook_events').select('event_id').like('event_id', 'evt_test_%_ghost');
    assert((ledger?.length ?? 0) === 0, 'Failed apply is not written to the ledger');
  }

  // --------------------------------------------------------------------------
  console.log('\nSCHEMA (migration 032)');
  {
    const { error } = await adminClient()
      .from('profiles')
      .update({ razorpay_subscription_id: subA })
      .eq('id', userB.userId);
    assert(error?.code === '23505', 'Unique index: one subscription id cannot sit on two profiles', error?.code);
  }
  {
    // Owner cannot write their own billing columns (migration 003 column grants).
    const { error } = await userB.client
      .from('profiles')
      .update({ plan_tier: 'pro', razorpay_subscription_status: 'active' })
      .eq('id', userB.userId);
    const p = await profileOf(userB.userId);
    assert(Boolean(error) && p?.plan_tier === 'free', 'User session cannot self-write plan_tier / razorpay_* columns', { error: error?.code, tier: p?.plan_tier });
  }
  {
    const { data, error } = await userB.client.from('razorpay_webhook_events').select('event_id').limit(1);
    assert(Boolean(error) || (data?.length ?? 0) === 0, 'User session cannot read the webhook ledger', error?.code);
  }

  // --------------------------------------------------------------------------
  console.log('\nCONCURRENCY + CLAIM (real infra)');
  {
    // Simultaneous checkout starts for ONE user must create exactly one
    // Razorpay subscription, and every request must get that same one.
    const userD = await newUser();
    const startedAtSec = Math.floor(Date.now() / 1000) - 5;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => api(userD.token, '/api/razorpay/subscription').then(async (r) => ({ status: r.status, body: await json(r) })))
    );
    const ids = Array.from(new Set(results.map((r) => r.body.subscriptionId)));
    ids.forEach(trackSub);
    assert(
      results.every((r) => r.status === 200) && ids.length === 1 && ids[0]?.startsWith('sub_'),
      '5 parallel checkout starts all return 200 with the SAME subscription id',
      results.map((r) => ({ status: r.status, id: r.body.subscriptionId, error: r.body.error }))
    );
    const pD = await profileOf(userD.userId);
    assert(pD?.razorpay_subscription_id === ids[0] && pD?.razorpay_subscription_status === 'created', 'Profile stores that one subscription and the claim is closed', pD);

    const listed = await rzpGet(`/subscriptions?from=${startedAtSec}&count=100`);
    const forD = (listed.body.items ?? []).filter((s: any) => s.notes?.userId === userD.userId);
    assert(listed.status === 200 && forD.length === 1, 'Razorpay holds exactly ONE subscription for that user', { listStatus: listed.status, count: forD.length });
  }
  {
    // A stale claim (holder crashed) is taken over rather than blocking forever.
    const userE = await newUser();
    await adminClient().from('profiles').update({ razorpay_subscription_status: claimMarker(Date.now() - CLAIM_TTL_MS - 60_000) }).eq('id', userE.userId);
    const res = await api(userE.token, '/api/razorpay/subscription');
    const body = await json(res);
    trackSub(body.subscriptionId);
    const pE = await profileOf(userE.userId);
    assert(
      res.status === 200 && pE?.razorpay_subscription_id === body.subscriptionId && pE?.razorpay_subscription_status === 'created',
      'Stale claim is taken over: checkout proceeds and the claim is replaced',
      { status: res.status, pE }
    );
  }
  {
    // A live claim held by "another request" that never finishes: the second
    // request waits, then refuses — and creates nothing.
    const userF = await newUser();
    const marker = claimMarker(Date.now());
    await adminClient().from('profiles').update({ razorpay_subscription_status: marker }).eq('id', userF.userId);
    const startedAtSec = Math.floor(Date.now() / 1000) - 5;
    const res = await api(userF.token, '/api/razorpay/subscription');
    const body = await json(res);
    const pF = await profileOf(userF.userId);
    const listed = await rzpGet(`/subscriptions?from=${startedAtSec}&count=100`);
    const forF = (listed.body.items ?? []).filter((s: any) => s.notes?.userId === userF.userId);
    assert(res.status === 409 && /already starting/i.test(body.error ?? ''), 'Live claim held elsewhere → 409 "already starting" after waiting', { status: res.status, body });
    assert(pF?.razorpay_subscription_status === marker && pF?.razorpay_subscription_id === null, 'The held claim is left untouched');
    assert(listed.status === 200 && forF.length === 0, 'No Razorpay subscription was created while the claim was held', forF.length);
  }
  {
    // Claim primitives against the real database, with the provider call
    // replaced by a deliberate failure (the route cannot be made to fail
    // Razorpay's create on demand without a test hook in production code).
    const admin = adminClient();
    const userG = await newUser();
    const first = await claimSubscriptionSlot(admin, userG.userId, null);
    const second = await claimSubscriptionSlot(admin, userG.userId, null);
    assert(Boolean(first) && second === null, 'Claim is exclusive: a second claim while held fails');

    const failingProvider = async (): Promise<{ id: string; status: string }> => {
      throw new Error('simulated provider failure');
    };
    let providerFailed = false;
    try {
      await failingProvider();
    } catch {
      providerFailed = true;
      await releaseSubscriptionSlot(admin, userG.userId, first!, null);
    }
    const afterRelease = await profileOf(userG.userId);
    assert(providerFailed && afterRelease?.razorpay_subscription_status === null && afterRelease?.razorpay_subscription_id === null,
      'Failed provider call releases the claim and restores the prior state', afterRelease);
    const retry = await claimSubscriptionSlot(admin, userG.userId, null);
    assert(Boolean(retry), 'After release, the next attempt can claim again (recoverable)');

    // A claim taken over (stale) before commit must not be able to store.
    await admin.from('profiles').update({ razorpay_subscription_status: claimMarker(Date.now()) + 'x' }).eq('id', userG.userId);
    const committed = await commitSubscriptionSlot(admin, userG.userId, retry!, { id: 'sub_NeverStored0001', status: 'created' });
    const afterCommit = await profileOf(userG.userId);
    assert(!committed && afterCommit?.razorpay_subscription_id === null, 'Commit by a request that lost its claim stores nothing');

    // Claims are many-parallel-safe at the DB level: 8 concurrent claims, one winner.
    const userH = await newUser();
    const racers = await Promise.all(Array.from({ length: 8 }, () => claimSubscriptionSlot(admin, userH.userId, null)));
    assert(racers.filter(Boolean).length === 1, 'Of 8 simultaneous claims on one profile, exactly one wins', racers.filter(Boolean).length);
  }

  // --------------------------------------------------------------------------
  // WEBHOOK vs CHECKOUT CLAIM RACE (real database). The race window is between
  // the webhook's read of a profile and its write. It is reproduced exactly by
  // acquiring a claim in that window: directly against the shared
  // compare-and-swap helper, and through the real apply loop via its
  // beforeWrite seam (which runs after the read/decision, before the write).
  console.log('\nWEBHOOK vs CLAIM RACE (real infra)');
  {
    const admin = adminClient();
    const readBilling = async (id: string) =>
      (await admin.from('profiles').select('plan_tier, razorpay_subscription_id, razorpay_subscription_status').eq('id', id).single()).data as {
        plan_tier: string; razorpay_subscription_id: string | null; razorpay_subscription_status: string | null;
      };
    const setBilling = (id: string, v: Record<string, unknown>) => admin.from('profiles').update(v).eq('id', id);
    const fakeSub = (over: Partial<RazorpaySubscription>): RazorpaySubscription => ({
      id: 'sub_Fake', plan_id: PLAN_ID, status: 'active', paid_count: 1, customer_id: null, current_end: null, notes: [], ...over,
    });

    // 1. Helper, holder shape: stale observed status vs a claim acquired after the read.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceHolder0001', razorpay_subscription_status: 'cancelled' });
      const seen = await readBilling(u.userId);
      const marker = await claimSubscriptionSlot(admin, u.userId, 'sub_RaceHolder0001');
      const res = await writeProfileIfUnchanged(admin, u.userId,
        { subscriptionId: seen.razorpay_subscription_id, status: seen.razorpay_subscription_status },
        { plan_tier: 'free', razorpay_subscription_status: 'cancelled' });
      const after = await readBilling(u.userId);
      assert(Boolean(marker) && res === 'conflict' && after.razorpay_subscription_status === marker && after.razorpay_subscription_id === 'sub_RaceHolder0001',
        'Holder write with stale status misses a claim acquired after the read — marker and binding intact', { res, after });
    }
    // 2. Helper, orphan shape (null/null observed) vs a claim acquired after the read.
    {
      const u = await newUser();
      const seen = await readBilling(u.userId);
      const marker = await claimSubscriptionSlot(admin, u.userId, null);
      const res = await writeProfileIfUnchanged(admin, u.userId,
        { subscriptionId: seen.razorpay_subscription_id, status: seen.razorpay_subscription_status },
        { plan_tier: 'pro', razorpay_subscription_status: 'active', razorpay_subscription_id: 'sub_RaceOrphan0001' });
      const after = await readBilling(u.userId);
      assert(seen.razorpay_subscription_status === null && Boolean(marker) && res === 'conflict' &&
        after.razorpay_subscription_status === marker && after.razorpay_subscription_id === null && after.plan_tier === 'free',
        'Orphan attach with stale null status misses a claim acquired after the read — nothing bound, no Pro', { res, after });
    }
    // 3. Helper refuses outright to write over an observed active claim.
    {
      const u = await newUser();
      const marker = claimMarker(Date.now());
      await setBilling(u.userId, { razorpay_subscription_status: marker });
      const res = await writeProfileIfUnchanged(admin, u.userId, { subscriptionId: null, status: marker }, { razorpay_subscription_status: 'active' });
      assert(res === 'claimed' && (await readBilling(u.userId)).razorpay_subscription_status === marker, 'Helper never writes over an observed active claim');
    }
    // 4. Apply loop, holder path: claim lands between read and write.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceHolder0002', razorpay_subscription_status: 'halted' });
      let marker: string | null = null;
      let writes = 0;
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceHolder0002', status: 'cancelled', paid_count: 2, notes: { userId: u.userId } }), {
        beforeWrite: async (path, attempt) => { writes++; if (path === 'holder' && attempt === 0) marker = await claimSubscriptionSlot(admin, u.userId, 'sub_RaceHolder0002'); },
      });
      const after = await readBilling(u.userId);
      assert(outcome.kind === 'skipped_claim' && Boolean(marker) && writes === 1 &&
        after.razorpay_subscription_status === marker && after.razorpay_subscription_id === 'sub_RaceHolder0002',
        'Holder path: CAS misses, retry re-reads, sees the claim and leaves it untouched', { outcome, writes, after });
    }
    // 5. Apply loop, orphan path: claim lands between read and write.
    {
      const u = await newUser();
      let marker: string | null = null;
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceOrphan0002', notes: { userId: u.userId } }), {
        beforeWrite: async (path, attempt) => { if (path === 'orphan' && attempt === 0) marker = await claimSubscriptionSlot(admin, u.userId, null); },
      });
      const after = await readBilling(u.userId);
      const { count: rec } = await admin.from('razorpay_webhook_events').select('event_id', { count: 'exact', head: true }).like('event_id', 'reconcile:sub_RaceOrphan0002%');
      assert(outcome.kind === 'retry_later' && outcome.status === 503 && Boolean(marker) &&
        after.razorpay_subscription_status === marker && after.razorpay_subscription_id === null && after.plan_tier === 'free' && rec === 0,
        'Orphan path: CAS misses, retry sees the claim → 503 retry-later; nothing bound, no Pro, no reconcile row', { outcome, after, rec });
    }
    // 6. Retry re-evaluates fresh state (not the stale write): one conflict, then success.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceHolder0003', razorpay_subscription_status: 'halted' });
      const seenAtWrite: Array<string | null> = [];
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceHolder0003', status: 'cancelled', paid_count: 2, notes: { userId: u.userId } }), {
        beforeWrite: async (_p, attempt) => {
          seenAtWrite.push((await readBilling(u.userId)).razorpay_subscription_status);
          if (attempt === 0) await setBilling(u.userId, { razorpay_subscription_status: 'paused' });
        },
      });
      const after = await readBilling(u.userId);
      assert(outcome.kind === 'applied' && seenAtWrite.length === 2 && after.razorpay_subscription_status === 'cancelled' && after.plan_tier === 'free',
        'After one lost CAS the retry re-reads the new state and applies (a resent stale write would never succeed)', { outcome, seenAtWrite, after });
    }
    // 7. Unresolvable conflict: bounded retries, then 503 — nothing written over the moving state.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceHolder0004', razorpay_subscription_status: 'halted' });
      let writes = 0;
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceHolder0004', status: 'cancelled', paid_count: 2, notes: { userId: u.userId } }), {
        beforeWrite: async (_p, attempt) => { writes++; await setBilling(u.userId, { razorpay_subscription_status: `churn-${attempt}` }); },
      });
      const after = await readBilling(u.userId);
      assert(outcome.kind === 'retry_later' && outcome.status === 503 && writes === MAX_ATTEMPTS &&
        after.razorpay_subscription_status === `churn-${MAX_ATTEMPTS - 1}` && after.razorpay_subscription_id === 'sub_RaceHolder0004',
        `Persistent conflict: exactly ${MAX_ATTEMPTS} attempts, then 503 retry-later; the webhook's state never overwrote it`, { outcome, writes, after });
    }
    // 8. Orphan bind still works through the shared helper (stored id unknown to
    //    Razorpay). Deterministic: the provider fetch is a stub returning 404 —
    //    no network call; any other fetch fails the test.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_DoesNotExist000', razorpay_subscription_status: 'cancelled' });
      const fetched: string[] = [];
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceOrphan0003', notes: { userId: u.userId } }), {
        fetchSubscription: async (id) => {
          fetched.push(id);
          if (id === 'sub_DoesNotExist000') throw new RazorpayApiError(404, 'stub: subscription not found');
          throw new Error(`unexpected provider fetch in test 8: ${id}`);
        },
      });
      const after = await readBilling(u.userId);
      assert(outcome.kind === 'bound' && after.razorpay_subscription_id === 'sub_RaceOrphan0003' && after.plan_tier === 'pro' &&
        fetched.length === 1 && fetched[0] === 'sub_DoesNotExist000',
        'Paid orphan binds via the CAS helper when the stored subscription is unknown (stubbed 404, no network)', { outcome, fetched, after });
    }
    // 9. Reconcile behaviour preserved: live stored mandate is never replaced.
    {
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceLive0001', razorpay_subscription_status: 'active' });
      const recId = 'reconcile:sub_RaceOrphan0004:sub_RaceLive0001';
      createdEventIds.push(recId);
      const outcome = await applySubscriptionToProfiles(admin, fakeSub({ id: 'sub_RaceOrphan0004', notes: { userId: u.userId } }), {
        fetchSubscription: async (id) => fakeSub({ id, status: 'active', paid_count: 3, notes: { userId: u.userId } }),
      });
      const after = await readBilling(u.userId);
      const { data: row } = await admin.from('razorpay_webhook_events').select('event_type').eq('event_id', recId).maybeSingle();
      assert(outcome.kind === 'reconcile' && after.razorpay_subscription_id === 'sub_RaceLive0001' && after.razorpay_subscription_status === 'active' &&
        row?.event_type === 'reconcile.duplicate_live_mandate',
        'Reconcile preserved: existing live binding untouched, reconcile row recorded', { outcome, after, row });
    }
    // 10. Route level: a held claim survives real webhook processing.
    {
      const u = await newUser();
      // Option A: a real TEST-mode subscription, created through the server
      // (whose credentials the SAFETY GUARD proved are test mode).
      const started = await json(await api(u.token, '/api/razorpay/subscription'));
      const subId: string = started.subscriptionId;
      trackSub(subId);
      const readBack = await rzpGet(`/subscriptions/${subId}`);
      assert(started.keyId === KEY_ID && KEY_ID.startsWith('rzp_test_') && readBack.status === 200 && readBack.body.id === subId,
        "Test 10's subscription exists in Razorpay TEST mode (server returned the test key id; read back with the test key)",
        { keyIsTest: String(started.keyId ?? '').startsWith('rzp_test_'), readBack: readBack.status });
      const marker = claimMarker(Date.now());
      await setBilling(u.userId, { razorpay_subscription_status: marker });
      const eventId = `evt_test_${Date.now()}_claimheld`;
      createdEventIds.push(eventId);
      const res = await postWebhook(subscriptionEvent('subscription.cancelled', subId), { eventId });
      const after = await readBilling(u.userId);
      assert(typeof subId === 'string' && res.status === 200 && after.razorpay_subscription_status === marker && after.razorpay_subscription_id === subId,
        'Route: signed webhook for the held profile leaves the claim marker and binding intact', { status: res.status, after });
    }

    // 11-13. Ledger writes are checked, via processWebhookEvent — the exact code
    // the route runs after its signature/duplicate checks.
    const ledgerCount = async (eventId: string) =>
      (await admin.from('razorpay_webhook_events').select('event_id', { count: 'exact', head: true }).eq('event_id', eventId)).count ?? 0;
    const realWriter = async (row: { event_id: string; event_type: string }) => {
      const { error } = await admin.from('razorpay_webhook_events').upsert(row, { onConflict: 'event_id', ignoreDuplicates: true });
      return { error };
    };
    const liveStoredStub = (userId: string) => async (id: string) => fakeSub({ id, status: 'active', paid_count: 3, notes: { userId } });
    {
      // 11. Reconcile row cannot be written → retryable 5xx, original event NOT recorded, binding untouched.
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceLive0002', razorpay_subscription_status: 'active' });
      const eventId = `evt_test_${Date.now()}_recfail`;
      const recId = 'reconcile:sub_RaceOrphan0005:sub_RaceLive0002';
      createdEventIds.push(eventId, recId);
      const result = await processWebhookEvent(
        admin,
        { eventId, eventType: 'subscription.charged', subscription: fakeSub({ id: 'sub_RaceOrphan0005', notes: { userId: u.userId } }) },
        {
          fetchSubscription: liveStoredStub(u.userId),
          recordLedgerRow: async (row) => (row.event_id.startsWith('reconcile:') ? { error: new Error('forced ledger failure') } : realWriter(row)),
        }
      );
      const after = await readBilling(u.userId);
      assert(result.status >= 500 && result.status < 600, 'Reconcile row write fails → retryable 5xx outcome', result);
      assert((await ledgerCount(eventId)) === 0 && (await ledgerCount(recId)) === 0, 'Original event is NOT recorded as handled (Razorpay will redeliver); no reconcile row');
      assert(after.razorpay_subscription_id === 'sub_RaceLive0002' && after.razorpay_subscription_status === 'active' && after.plan_tier === 'free',
        "Profile's existing live binding is unchanged", after);

      // 12. Idempotent on redelivery: real writer → reconcile recorded once, event recorded; a further
      //     delivery with the reconcile row already present still succeeds without duplicating it.
      const again = await processWebhookEvent(admin,
        { eventId, eventType: 'subscription.charged', subscription: fakeSub({ id: 'sub_RaceOrphan0005', notes: { userId: u.userId } }) },
        { fetchSubscription: liveStoredStub(u.userId) });
      const eventId2 = `evt_test_${Date.now()}_recagain`;
      createdEventIds.push(eventId2);
      const third = await processWebhookEvent(admin,
        { eventId: eventId2, eventType: 'subscription.charged', subscription: fakeSub({ id: 'sub_RaceOrphan0005', notes: { userId: u.userId } }) },
        { fetchSubscription: liveStoredStub(u.userId) });
      assert(again.status === 200 && again.body.reconcile === true && (await ledgerCount(eventId)) === 1 && (await ledgerCount(recId)) === 1,
        'Redelivery after the failure: reconcile row and event recorded exactly once', again);
      assert(third.status === 200 && (await ledgerCount(recId)) === 1 && (await ledgerCount(eventId2)) === 1,
        'Existing reconcile row is not an error and is not duplicated (idempotent)', third);
      assert((await readBilling(u.userId)).razorpay_subscription_id === 'sub_RaceLive0002', 'Binding still unchanged after redeliveries');
    }
    {
      // 13. Original-event record fails after a successful apply → 503, not acknowledged.
      const u = await newUser();
      await setBilling(u.userId, { razorpay_subscription_id: 'sub_RaceHolder0005', razorpay_subscription_status: 'halted' });
      const eventId = `evt_test_${Date.now()}_evtfail`;
      createdEventIds.push(eventId);
      const result = await processWebhookEvent(
        admin,
        { eventId, eventType: 'subscription.cancelled', subscription: fakeSub({ id: 'sub_RaceHolder0005', status: 'cancelled', paid_count: 2, notes: { userId: u.userId } }) },
        { recordLedgerRow: async () => ({ error: new Error('forced ledger failure') }) }
      );
      assert(result.status === 503 && (await ledgerCount(eventId)) === 0, 'Event-record failure → 503 and the event stays unrecorded', result);
    }
  }

  // --------------------------------------------------------------------------
  console.log('\nCANCEL');
  {
    const userC = await newUser();
    const res = await api(userC.token, '/api/razorpay/cancel');
    const body = await json(res);
    assert(
      res.status === 404 && body.error === 'No active subscription to cancel.',
      'Cancel with no subscription → 404 from the route itself',
      { status: res.status, body }
    );

    // F1(a) fall-through: a stored id Razorpay doesn't know (400/404) is
    // replaced by a fresh subscription rather than blocking checkout.
    await adminClient().from('profiles').update({ razorpay_subscription_id: 'sub_DoesNotExist000' }).eq('id', userC.userId);
    const fresh = await api(userC.token, '/api/razorpay/subscription');
    const freshBody = await json(fresh);
    trackSub(freshBody.subscriptionId);
    assert(
      fresh.status === 200 && typeof freshBody.subscriptionId === 'string' && freshBody.subscriptionId !== 'sub_DoesNotExist000',
      'F1: unusable stored subscription id is replaced with a fresh one',
      { status: fresh.status, freshBody }
    );
  }

  // --------------------------------------------------------------------------
  // PHASE 2 — after a real Checkout payment in the browser (E2E step).
  // RZP_E2E_USER_ID / RZP_E2E_TOKEN identify the browser-paid test user.
  console.log('\nPAID SUBSCRIPTION (browser E2E user)');
  const e2eUser = process.env.RZP_E2E_USER_ID;
  const e2eToken = process.env.RZP_E2E_TOKEN;
  if (!e2eUser || !e2eToken) {
    skip('No browser-paid test user supplied (RZP_E2E_USER_ID/RZP_E2E_TOKEN) — paid-path checks run in the E2E step');
  } else {
    const p = await profileOf(e2eUser);
    assert(p?.plan_tier === 'pro', 'Browser-paid user is Pro', p);
    const sub = p?.razorpay_subscription_id ?? '';
    const remote = await rzpGet(`/subscriptions/${sub}`);
    assert(
      planTierForSubscription(remote.body) === 'pro',
      'Razorpay reports a subscription the shared rule treats as paid (active, or charged at least once)',
      { status: remote.body.status, paid_count: remote.body.paid_count }
    );

    const again = await api(e2eToken, '/api/razorpay/subscription');
    assert(again.status === 409, 'Already-Pro user cannot start a second subscription → 409', again.status);

    const eventId = `evt_test_${Date.now()}_charged`;
    createdEventIds.push(eventId);
    const wh = await postWebhook(subscriptionEvent('subscription.charged', sub), { eventId });
    assert(wh.status === 200 && (await profileOf(e2eUser))?.plan_tier === 'pro', 'Signed charged webhook keeps the paid user Pro');

    // F1(b) positive: detach the PAID subscription from the profile (as if a
    // later checkout had replaced it) and drop to free; a signed event must
    // re-bind it via notes.userId and restore Pro.
    await adminClient().from('profiles').update({ razorpay_subscription_id: null, plan_tier: 'free' }).eq('id', e2eUser);
    const rebindId = `evt_test_${Date.now()}_rebind`;
    createdEventIds.push(rebindId);
    const rebind = await postWebhook(subscriptionEvent('subscription.charged', sub), { eventId: rebindId });
    const rebound = await profileOf(e2eUser);
    assert(
      rebind.status === 200 && rebound?.razorpay_subscription_id === sub && rebound?.plan_tier === 'pro',
      'F1: orphaned PAID subscription is re-bound to its notes.userId profile and Pro restored',
      rebound
    );

    const cancel = await api(e2eToken, '/api/razorpay/cancel');
    const cancelBody = await json(cancel);
    assert(cancel.status === 200 && cancelBody.success === true, 'Cancel at cycle end succeeds', { status: cancel.status, cancelBody });
    const afterCancel = await profileOf(e2eUser);
    assert(afterCancel?.plan_tier === 'pro', 'User keeps Pro until the cycle ends', afterCancel?.plan_tier);
    assert(afterCancel?.razorpay_subscription_status === 'cancel_scheduled', 'Local cancel_scheduled marker set', afterCancel?.razorpay_subscription_status);
    const cancelAgain = await json(await api(e2eToken, '/api/razorpay/cancel'));
    assert(cancelAgain.alreadyScheduled === true, 'Second cancel click is a no-op', cancelAgain);
  }
}

/** Reads back every subscription this run created using the TEST key, and reports them as intentional test data. */
async function reportTestSubscriptions() {
  console.log('\nTEST-MODE SUBSCRIPTIONS LEFT BEHIND (intentional test data)');
  if (createdTestSubscriptions.length === 0) {
    console.log('  none created');
    return;
  }
  for (const id of createdTestSubscriptions) {
    const r = await rzpGet(`/subscriptions/${id}`);
    const ok = r.status === 200 && r.body.id === id;
    assert(ok, `${id}: readable with the rzp_test_ key (test mode), status '${r.body.status}', paid_count ${r.body.paid_count}`, { status: r.status });
  }
}

async function cleanup() {
  console.log('\nCLEANUP');
  const admin = adminClient();
  for (const id of createdEventIds) {
    await admin.from('razorpay_webhook_events').delete().eq('event_id', id);
  }
  let deleted = 0;
  for (const id of createdUsers) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (!error) deleted++;
    else console.error(`  could not delete test user ${id}: ${error.message}`);
  }
  const { data: leftover } = await admin.from('profiles').select('id').in('id', createdUsers.length ? createdUsers : ['00000000-0000-0000-0000-000000000000']);
  console.log(`  deleted ${deleted}/${createdUsers.length} test users; ${leftover?.length ?? 0} profiles left; ${createdEventIds.length} ledger rows removed`);
  console.log('  (Razorpay test-mode subscriptions in status "created" are left to expire — test data only.)');
}

run()
  .catch((err) => {
    console.error('Suite crashed:', err);
    failed++;
  })
  .finally(async () => {
    await reportTestSubscriptions().catch((err) => {
      console.error('Could not verify test subscriptions:', err);
      failed++;
    });
    await cleanup().catch((err) => console.error('Cleanup failed:', err));
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    process.exitCode = failed > 0 ? 1 : 0;
  });

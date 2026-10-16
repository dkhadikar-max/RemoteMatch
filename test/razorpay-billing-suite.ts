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

async function rzpGet(path: string) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}` },
  });
  return { status: res.status, body: await json(res) };
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
    assert(['authenticated', 'active'].includes(remote.body.status), 'Razorpay reports the subscription authenticated/active', remote.body.status);

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
    await cleanup().catch((err) => console.error('Cleanup failed:', err));
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    process.exitCode = failed > 0 ? 1 : 0;
  });

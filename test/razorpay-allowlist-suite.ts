/**
 * RemoteMatch — Razorpay purchase allowlist (RAZORPAY_ALLOWLIST_USER_IDS) suite
 * ==============================================================================
 * Proves the rollout gate in /api/razorpay/subscription:
 *   - UNIT: parsePurchaseAllowlist / isPurchaseAllowed for every input shape.
 *   - ROUTE: for the mode the SERVER was started in (it must load the same env
 *     files as this runner), who can start a purchase, that a blocked user
 *     creates nothing, and that the webhook, /verify and /cancel are NOT gated.
 *   - MOCK: when the server has NO Razorpay keys (local dev mock mode), a
 *     blocked user must not receive a mock "purchase started" either.
 *
 * Safety — every route test refuses (and the run FAILS, exit 1) unless:
 *   - TEST_BASE_URL is a local server (127.0.0.1 / localhost / ::1), and
 *   - ISOLATED_TEST_PROJECT_HOST equals the database host exactly (an explicit
 *     opt-in kept in the gitignored env file — never a denylist of refs), and
 *   - with keys: RAZORPAY_KEY_ID is a rzp_test_ key.
 *
 * Run once per mode against an ISOLATED test project (never production):
 *   open   — RAZORPAY_ALLOWLIST_USER_IDS not set
 *   closed — set but empty (e.g. "")
 *   list   — set to ALLOWED_ID below
 *   mock   — list, with the server AND this runner given no RAZORPAY_* keys
 *   npx tsx --env-file=<isolated env> [--env-file=<allowlist env>] test/razorpay-allowlist-suite.ts
 *
 * Cleanup (always, pass or fail; every item attempted; ANY failure exits 1):
 * cancels every Razorpay test subscription the run created, deletes its
 * webhook-ledger rows, and deletes every user it created.
 */
import { createHmac } from 'node:crypto';
import { adminClient, anonKeyClient, hasRequiredEnv, newVerifiedSession, uniqueEmail } from './helpers/verified-session';
import { isPurchaseAllowed, parsePurchaseAllowlist } from '../src/lib/razorpay';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3400';
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const PLAN_ID = process.env.RAZORPAY_PRO_PLAN_ID ?? '';
/** Fixed so the server's env file can name it before the user exists. */
const ALLOWED_ID = '0a11ed00-0000-4000-8000-000000000001';
/** Opt-in, not a denylist: route tests run only when this names the DB host exactly. */
const ISOLATED_HOST = process.env.ISOLATED_TEST_PROJECT_HOST ?? '';
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Mock mode = NO Razorpay config at all. Any partial config is keyed mode and must pass the keyed checks (or be refused). */
const MOCK = !KEY_ID && !KEY_SECRET && !PLAN_ID && !WEBHOOK_SECRET;
/** Test-only: proves a failed cleanup step turns the run red. Honoured only after the safety checks pass with rzp_test_ config. */
const INJECT_CLEANUP_FAILURE = process.env.ALLOWLIST_SUITE_INJECT_CLEANUP_FAILURE === '1';
/**
 * Test-only: proves a user deletion that THROWS is counted and does not skip
 * the deletions after it. Puts a synthetic id (never a real user) FIRST in
 * the deletion queue and throws for it, so every real user still follows it.
 * Same gate as above.
 */
const INJECT_DELETE_THROW = process.env.ALLOWLIST_SUITE_INJECT_DELETE_THROW === '1';
const DELETE_THROW_PROBE_ID = 'de1e7e00-0000-4000-8000-0000000000aa';
/** Set only once every SAFETY check has passed with complete rzp_test_ config. Gates all Razorpay calls in cleanup. */
let testModeVerified = false;

let passed = 0;
let failed = 0;
function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}
function refuse(reason: string) {
  console.log(`\nRefusing to run route tests: ${reason}`);
  failed++; // a refused run must never read as a pass
}

const createdUsers: string[] = [];
const createdEventIds: string[] = [];
const createdSubscriptions: string[] = [];
const trackSub = (id: unknown) => {
  if (typeof id === 'string' && id.startsWith('sub_') && !createdSubscriptions.includes(id)) createdSubscriptions.push(id);
};
const auth = () => `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

async function userWithId(id: string) {
  const email = uniqueEmail();
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const { error } = await adminClient().auth.admin.createUser({ id, email, password, email_confirm: true });
  if (error) throw new Error(`create user ${id}: ${error.message}`);
  createdUsers.push(id);
  const { data, error: e2 } = await anonKeyClient().auth.signInWithPassword({ email, password });
  if (e2 || !data.session) throw new Error(`sign in ${id}: ${e2?.message}`);
  return { userId: id, token: data.session.access_token };
}
async function randomUser() {
  const s = await newVerifiedSession();
  createdUsers.push(s.userId);
  return { userId: s.userId, token: s.token };
}
const post = async (token: string, path: string, body: unknown = {}) => {
  const r = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
};
const profile = async (id: string) =>
  (await adminClient().from('profiles').select('plan_tier, razorpay_subscription_id, razorpay_subscription_status').eq('id', id).single())
    .data as any;
async function rzpSubsFor(userId: string, sinceSec: number) {
  const r = await fetch(`https://api.razorpay.com/v1/subscriptions?from=${sinceSec}&count=100`, { headers: { Authorization: auth() } });
  const j: any = await r.json();
  return { status: r.status, ids: (j.items ?? []).filter((s: any) => s.notes?.userId === userId).map((s: any) => s.id as string) };
}

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — RAZORPAY PURCHASE ALLOWLIST SUITE');
  console.log('='.repeat(78));

  // ---------------------------------------------------------------- UNIT
  console.log('\nUNIT: parsePurchaseAllowlist / isPurchaseAllowed');
  const A = ALLOWED_ID;
  const B = '0b10c4ed-0000-4000-8000-000000000002';
  assert(parsePurchaseAllowlist(undefined).mode === 'open', 'Variable not set → open (unchanged behaviour)');
  for (const raw of ['', ' ', ',,', ' , , ', 'not-a-uuid', 'abc,123', `${A.slice(0, 30)}`]) {
    assert(parsePurchaseAllowlist(raw).mode === 'closed', `Set but no valid UUID (${JSON.stringify(raw)}) → closed, never open`);
  }
  const l = parsePurchaseAllowlist(` ${A.toUpperCase()} , garbage ,${B}`);
  assert(l.mode === 'list' && l.userIds.size === 2, 'Valid UUIDs kept (trimmed, case-insensitive); malformed entries ignored', l);
  assert(isPurchaseAllowed(parsePurchaseAllowlist(undefined), B), 'open: any user allowed');
  assert(!isPurchaseAllowed(parsePurchaseAllowlist(''), A), 'closed: even a would-be-listed user is blocked');
  assert(isPurchaseAllowed(parsePurchaseAllowlist(A), A.toUpperCase()), 'list: listed user allowed (case-insensitive)');
  assert(!isPurchaseAllowed(parsePurchaseAllowlist(A), B), 'list: unlisted user blocked');

  // ---------------------------------------------------------------- SAFETY
  let base: URL;
  try {
    base = new URL(BASE_URL);
  } catch {
    return refuse(`TEST_BASE_URL is not a valid URL.`);
  }
  if (base.protocol !== 'http:') return refuse(`TEST_BASE_URL must use http: (got "${base.protocol}").`);
  if (!LOCAL_HOSTNAMES.has(base.hostname)) return refuse(`TEST_BASE_URL must be a local server (got host "${base.hostname}").`);
  if (!hasRequiredEnv()) return refuse('Supabase env incomplete.');
  const host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host;
  if (!ISOLATED_HOST || host !== ISOLATED_HOST) return refuse('ISOLATED_TEST_PROJECT_HOST must equal the database host.');
  if (!MOCK && (!KEY_ID.startsWith('rzp_test_') || !KEY_SECRET || !WEBHOOK_SECRET || !PLAN_ID)) {
    return refuse('Razorpay env must be complete with a rzp_test_ key (or entirely absent for mock mode).');
  }
  if ((INJECT_CLEANUP_FAILURE || INJECT_DELETE_THROW) && MOCK) {
    return refuse('Cleanup-failure injection needs complete rzp_test_ config (not mock mode).');
  }
  testModeVerified = !MOCK; // every keyed check above passed: complete config, rzp_test_ key
  const mode = parsePurchaseAllowlist(process.env.RAZORPAY_ALLOWLIST_USER_IDS).mode;
  const unavailable = /isn't available|aren't available/i;

  // ---------------------------------------------------------------- MOCK MODE
  if (MOCK) {
    console.log(`\nMOCK (server has no Razorpay keys; allowlist mode '${mode}', DB ${host}, server ${BASE_URL})`);
    if (mode !== 'list') return refuse("mock mode must be run with a 'list' allowlist.");
    const allowed = await userWithId(ALLOWED_ID);
    const blocked = await randomUser();
    const ra = await post(allowed.token, '/api/razorpay/subscription');
    const rb = await post(blocked.token, '/api/razorpay/subscription');
    assert(ra.status === 200 && ra.body.isMock === true, 'mock: listed user still gets the local mock (dev convenience unchanged)', ra);
    assert(rb.status === 503 && unavailable.test(rb.body.error ?? '') && rb.body.isMock !== true,
      'mock: unlisted user gets 503 — no mock "purchase started"', rb);
    const pb = await profile(blocked.userId);
    assert(pb.plan_tier === 'free' && pb.razorpay_subscription_id === null, 'mock: blocked user\'s profile untouched', pb);
    return;
  }

  // ---------------------------------------------------------------- ROUTE
  console.log(`\nROUTE (server expected in mode '${mode}', DB ${host}, server ${BASE_URL})`);
  const since = Math.floor(Date.now() / 1000) - 5;
  const allowed = await userWithId(ALLOWED_ID);
  const blocked = await randomUser();

  const ra = await post(allowed.token, '/api/razorpay/subscription');
  trackSub(ra.body.subscriptionId);
  const rb = await post(blocked.token, '/api/razorpay/subscription');
  trackSub(rb.body.subscriptionId);
  const pa = await profile(allowed.userId);
  const pb = await profile(blocked.userId);
  const sa = await rzpSubsFor(allowed.userId, since);
  const sb = await rzpSubsFor(blocked.userId, since);
  sa.ids.forEach(trackSub);
  sb.ids.forEach(trackSub);

  if (mode === 'list') {
    assert(ra.status === 200 && typeof ra.body.subscriptionId === 'string', 'list: listed user can start a purchase (200)', ra);
    assert(sa.ids.length === 1 && pa.razorpay_subscription_id === ra.body.subscriptionId, 'list: exactly one test subscription created for the listed user');
  } else if (mode === 'closed') {
    assert(ra.status === 503 && unavailable.test(ra.body.error ?? ''), 'closed: even the would-be-listed user gets 503', ra);
    assert(sa.ids.length === 0 && pa.razorpay_subscription_id === null, 'closed: nothing created for that user (Razorpay + profile)', { sa, pa });
  } else {
    assert(ra.status === 200 && rb.status === 200, 'open: every user can start a purchase (unchanged behaviour)', { ra: ra.status, rb: rb.status });
  }
  if (mode !== 'open') {
    assert(rb.status === 503 && unavailable.test(rb.body.error ?? ''), `${mode}: unlisted user gets 503 with the generic "unavailable" message`, rb);
    assert(sb.status === 200 && sb.ids.length === 0, `${mode}: no Razorpay subscription created for the blocked user`, sb);
    assert(pb.razorpay_subscription_id === null && pb.razorpay_subscription_status === null && pb.plan_tier === 'free',
      `${mode}: blocked user's profile untouched (no binding, no claim marker, still free)`, pb);
  }

  // ---------------------------------------------------- INDEPENDENCE (all keyed modes)
  console.log('\nINDEPENDENCE: webhook, /verify and /cancel are not gated');
  {
    // A blocked user who already holds a subscription (e.g. bought before the
    // allowlist was set) must still be synced by the webhook.
    const holder = await randomUser();
    const c = await fetch('https://api.razorpay.com/v1/subscriptions', {
      method: 'POST',
      headers: { Authorization: auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan_id: PLAN_ID, total_count: 60, quantity: 1, notes: { userId: holder.userId } }),
    });
    const sub: any = await c.json();
    trackSub(sub.id); // tracked immediately, before anything else can fail
    await adminClient().from('profiles').update({ razorpay_subscription_id: sub.id, razorpay_subscription_status: 'stale-sentinel' }).eq('id', holder.userId);
    const body = JSON.stringify({ entity: 'event', event: 'subscription.updated', payload: { subscription: { entity: { id: sub.id } } } });
    const eventId = `evt_test_${Date.now()}_allowlist`;
    createdEventIds.push(eventId);
    const w = await fetch(`${BASE_URL}/api/razorpay/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex'), 'X-Razorpay-Event-Id': eventId },
      body,
    });
    const ph = await profile(holder.userId);
    assert(c.status === 200 && w.status === 200 && ph.razorpay_subscription_status === sub.status,
      `Webhook still syncs a ${mode === 'open' ? '' : 'non-allowlisted '}subscriber (status updated from Razorpay)`, { create: c.status, webhook: w.status, ph });

    const v = await post(holder.token, '/api/razorpay/verify', {});
    assert(v.status === 400 && /Missing payment details/.test(v.body.error ?? ''), '/verify is not gated (reaches its own validation, not 503)', v);
    const fresh = await randomUser();
    const x = await post(fresh.token, '/api/razorpay/cancel');
    assert(x.status === 404 && /No active subscription/.test(x.body.error ?? ''), '/cancel is not gated (reaches its own logic, not 503)', x);
  }
}

/** Every cleanup step that did not succeed. Any non-zero count fails the run (exit 1). */
let cleanupFailures = 0;

async function cleanup() {
  console.log('\nCLEANUP (best effort — every step attempted; any failure fails the run)');
  // Injected id does not exist, so its cancellation must fail. Only ever sent
  // to Razorpay with verified rzp_test_ config (testModeVerified); a run that
  // asked for injection without it was already refused (exit 1).
  if (INJECT_CLEANUP_FAILURE && testModeVerified) createdSubscriptions.push('sub_CleanupFailProbe01');
  if (INJECT_DELETE_THROW && testModeVerified) createdUsers.unshift(DELETE_THROW_PROBE_ID);
  // 1. Cancel every Razorpay test subscription this run created. Success means
  //    a 2xx whose body is this same subscription with status 'cancelled' —
  //    anything else (non-2xx, other id, other status, unparseable) is a failure.
  if (createdSubscriptions.length && !testModeVerified) {
    cleanupFailures += createdSubscriptions.length;
    console.log(`  ${createdSubscriptions.length} subscription(s) NOT cancelled — test-mode config not verified`);
  } else {
    for (const id of createdSubscriptions) {
      try {
        const r = await fetch(`https://api.razorpay.com/v1/subscriptions/${id}/cancel`, {
          method: 'POST',
          headers: { Authorization: auth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancel_at_cycle_end: false }),
        });
        const j: any = await r.json().catch(() => null);
        if (r.ok && j?.id === id && j?.status === 'cancelled') console.log(`  subscription ${id}: cancelled`);
        else {
          cleanupFailures++;
          const why = !r.ok ? `HTTP ${r.status} ${j?.error?.description ?? ''}`.trimEnd() : `HTTP ${r.status} but body id=${j?.id ?? '?'} status=${j?.status ?? '?'}`;
          console.log(`  subscription ${id}: NOT cancelled — ${why}`);
        }
      } catch (err) {
        cleanupFailures++;
        console.log(`  subscription ${id}: NOT cancelled — ${(err as Error).message}`);
      }
    }
  }
  // 2. Ledger rows, 3. users — each attempted regardless of earlier failures;
  //    a returned error and a thrown exception both count, per item.
  let admin: ReturnType<typeof adminClient> | null = null;
  try {
    admin = adminClient();
  } catch (err) {
    cleanupFailures += createdEventIds.length + createdUsers.length;
    console.log(`  admin client unavailable — ${createdEventIds.length} ledger row(s) and ${createdUsers.length} user(s) NOT deleted: ${(err as Error).message}`);
  }
  let ledgerDeleted = 0;
  let deleted = 0;
  if (admin) {
    for (const id of createdEventIds) {
      try {
        const { error } = await admin.from('razorpay_webhook_events').delete().eq('event_id', id);
        if (error) throw new Error(error.message);
        ledgerDeleted++;
      } catch (err) {
        cleanupFailures++;
        console.log(`  ledger row ${id}: NOT deleted — ${(err as Error).message}`);
      }
    }
    for (const id of createdUsers) {
      try {
        if (id === DELETE_THROW_PROBE_ID) throw new Error('injected exception (test-only probe, not a real user)');
        const { error } = await admin.auth.admin.deleteUser(id);
        if (error) throw new Error(error.message);
        deleted++;
      } catch (err) {
        cleanupFailures++;
        console.log(`  user ${id}: NOT deleted — ${(err as Error).message}`);
      }
    }
  }
  console.log(`  deleted ${deleted}/${createdUsers.length} test users; ${ledgerDeleted}/${createdEventIds.length} ledger rows; ${createdSubscriptions.length} test subscriptions attempted`);
}

run()
  .catch((err) => {
    console.error('Suite crashed:', err);
    failed++;
  })
  .finally(async () => {
    await cleanup().catch((err) => {
      cleanupFailures++;
      console.error('Cleanup crashed:', err);
    });
    if (cleanupFailures > 0) console.error(`\nCLEANUP INCOMPLETE: ${cleanupFailures} step(s) failed — test resources may remain.`);
    console.log(`\n${passed} passed, ${failed} failed, ${cleanupFailures} cleanup failure(s).`);
    process.exitCode = failed > 0 || cleanupFailures > 0 ? 1 : 0;
  });

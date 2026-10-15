/**
 * LinkedIn Job Finder — quota refund on failed/unconfigured searches.
 *
 * Regression for a defect found in a production smoke test (SERPAPI_KEY was
 * not set in Railway): the search route reserved a Free-tier unit BEFORE
 * calling the vendor and refunded it only when the code threw. An
 * unconfigured or failing vendor is reported via `status`, not thrown, so
 * every such click silently spent one of the user's 3 daily searches.
 *
 * Pure (no infra): uses an in-memory ledger that mirrors the real RPC
 * semantics from migration 027 — reserve_linkedin_search() (limit 3 for
 * Free, denied at the limit, no increment on denial) and
 * rollback_linkedin_search_reservation() (GREATEST(count - 1, 0)). The real
 * RPCs themselves were verified live in linkedin-jobs-quota-suite.ts.
 *
 * Run: npx tsx test/linkedin-jobs-quota-refund-suite.ts
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { shouldRefundSearch, refundSearchReservation, settleSearchReservation } from '../src/lib/linkedin-jobs/quota';
import type { LinkedInSearchStatus } from '../src/lib/linkedin-jobs/search';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

type RpcClient = Pick<SupabaseClient, 'rpc'>;

interface FakeLedger {
  client: RpcClient;
  count: () => number;
  calls: string[];
}

/** refundBehavior: how rollback_linkedin_search_reservation() behaves. */
function fakeLedger(refundBehavior: 'ok' | 'error' | 'throw' = 'ok', limit = 3): FakeLedger {
  let count = 0;
  const calls: string[] = [];
  const client = {
    rpc: async (fn: string) => {
      calls.push(fn);
      if (fn === 'reserve_linkedin_search') {
        if (count >= limit) {
          return { data: { allowed: false, limit, remaining: 0 }, error: null };
        }
        count += 1;
        return { data: { allowed: true, limit, remaining: Math.max(limit - count, 0) }, error: null };
      }
      if (fn === 'rollback_linkedin_search_reservation') {
        if (refundBehavior === 'throw') throw new Error('network down');
        if (refundBehavior === 'error') return { data: null, error: { message: 'rpc failed' } };
        count = Math.max(count - 1, 0);
        return { data: { success: true }, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
  } as unknown as RpcClient;
  return { client, count: () => count, calls };
}

/** Mirrors the route's order of operations: reserve -> (search happens) -> settle. */
async function runSearchLikeTheRoute(ledger: FakeLedger, status: LinkedInSearchStatus) {
  const { data } = await ledger.client.rpc('reserve_linkedin_search');
  const reservation = data as { allowed: boolean; remaining: number | null };
  if (!reservation.allowed) return { denied: true as const };
  const settlement = await settleSearchReservation(ledger.client, status, reservation.remaining);
  return { denied: false as const, settlement };
}

async function run() {
  console.log('==============================================================================');
  console.log('LINKEDIN JOB FINDER — quota refund on failed/unconfigured searches');
  console.log('==============================================================================\n');

  console.log('1. shouldRefundSearch(): only a delivered search keeps its charge');
  {
    assert(shouldRefundSearch('ok') === false, "'ok' (incl. a legitimately empty result) is NOT refunded");
    assert(shouldRefundSearch('vendor_not_configured') === true, "'vendor_not_configured' is refunded");
    assert(shouldRefundSearch('vendor_failed') === true, "'vendor_failed' is refunded");
  }

  console.log('\n2. settleSearchReservation(): ok -> no RPC call, remaining untouched');
  {
    const l = fakeLedger();
    const s = await settleSearchReservation(l.client, 'ok', 2);
    assert(l.calls.length === 0, 'no refund RPC is made for a delivered search');
    assert(s.quotaRefunded === false && s.remaining === 2, 'remaining is left exactly as reserved');
    assert(!('quotaRefundError' in s), 'no error field on success');
  }

  console.log('\n3. settleSearchReservation(): missing SERPAPI_KEY and vendor failure both refund');
  for (const status of ['vendor_not_configured', 'vendor_failed'] as const) {
    const l = fakeLedger();
    await l.client.rpc('reserve_linkedin_search'); // the unit the route reserved up front
    const s = await settleSearchReservation(l.client, status, 2);
    assert(l.calls[l.calls.length - 1] === 'rollback_linkedin_search_reservation', `${status}: the rollback RPC was called`);
    assert(s.quotaRefunded === true, `${status}: reported as refunded`);
    assert(s.remaining === 3, `${status}: remaining goes 2 -> 3 (the unit came back)`);
    assert(l.count() === 0, `${status}: ledger counter is back to 0`);
  }
  {
    const l = fakeLedger();
    const s = await settleSearchReservation(l.client, 'vendor_failed', null);
    assert(s.remaining === null, 'a Pro user (remaining = null, unlimited) stays null after a refund');
  }

  console.log('\n4. A failed refund is SURFACED, not swallowed');
  for (const behavior of ['error', 'throw'] as const) {
    const l = fakeLedger(behavior);
    await l.client.rpc('reserve_linkedin_search');
    let threw = false;
    let s;
    try { s = await settleSearchReservation(l.client, 'vendor_failed', 2); } catch { threw = true; }
    assert(!threw, `refund RPC ${behavior === 'throw' ? 'throwing' : 'returning an error'} does not crash the request`);
    assert(s?.quotaRefunded === false, `${behavior}: reported as NOT refunded`);
    assert(typeof s?.quotaRefundError === 'string' && s.quotaRefundError.length > 0, `${behavior}: the error message is present in the result (so the route returns it)`);
    assert(s?.remaining === 2, `${behavior}: remaining is NOT inflated when the refund did not happen`);
    assert(l.count() === 1, `${behavior}: ledger still shows the charge (the truth), not a hidden refund`);
  }

  console.log('\n5. THE BUG, end to end: an unconfigured vendor must not exhaust a Free user\'s 3 daily searches');
  {
    const l = fakeLedger();
    let anyDenied = false;
    for (let i = 0; i < 6; i++) {
      const r = await runSearchLikeTheRoute(l, 'vendor_not_configured');
      if (r.denied) anyDenied = true;
    }
    assert(!anyDenied, '6 consecutive clicks against an unconfigured vendor: none denied (before the fix the 4th was)');
    assert(l.count() === 0, 'and the counter is still 0 — no allowance was spent on searches that returned nothing');
  }

  console.log('\n6. Delivered searches still consume the allowance, including legitimately empty ones');
  {
    const l = fakeLedger();
    const a = await runSearchLikeTheRoute(l, 'ok');
    const b = await runSearchLikeTheRoute(l, 'ok'); // e.g. a real search that found 0 LinkedIn jobs
    assert(l.count() === 2, 'two delivered searches (one may be empty) cost 2');
    await runSearchLikeTheRoute(l, 'vendor_failed');
    assert(l.count() === 2, 'a failed search in between cost nothing');
    const c = await runSearchLikeTheRoute(l, 'ok');
    const d = await runSearchLikeTheRoute(l, 'ok');
    assert(!a.denied && !b.denied && !c.denied, 'searches 1-3 (delivered) are allowed');
    assert(d.denied === true, 'the 4th DELIVERED search is denied — the Free limit is intact');
    assert(l.count() === 3, 'counter stops at the limit');
  }

  // NOTE: the fake ledger is single-threaded, so this checks the accounting
  // and the zero floor — NOT true concurrency. Row-lock atomicity is
  // Postgres's job and was verified live in linkedin-jobs-quota-suite.ts.
  console.log('\n7. Parallel failures net to zero and the counter never goes below zero (accounting check, not a race test)');
  {
    const l = fakeLedger();
    await Promise.all([1, 2, 3].map(() => runSearchLikeTheRoute(l, 'vendor_failed')));
    assert(l.count() === 0, '3 parallel failed searches net to 0, never negative');
    await Promise.all([1, 2, 3, 4, 5].map(() => l.client.rpc('rollback_linkedin_search_reservation')));
    assert(l.count() === 0, 'extra refunds cannot push the counter below zero (GREATEST(count-1, 0))');
  }

  console.log('\n8. refundSearchReservation() itself never throws');
  {
    const r1 = await refundSearchReservation(fakeLedger('throw').client);
    const r2 = await refundSearchReservation(fakeLedger('error').client);
    const r3 = await refundSearchReservation(fakeLedger('ok').client);
    assert(r1.refunded === false && !!r1.error, 'thrown RPC -> { refunded: false, error }');
    assert(r2.refunded === false && !!r2.error, 'errored RPC -> { refunded: false, error }');
    assert(r3.refunded === true && r3.error === undefined, 'healthy RPC -> { refunded: true }');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running linkedin-jobs-quota-refund-suite:', e); process.exit(1); });

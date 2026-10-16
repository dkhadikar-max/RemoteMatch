import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Per-user "creating a subscription" claim, so concurrent checkout starts for
 * one user create exactly ONE Razorpay subscription.
 *
 * The claim lives in profiles.razorpay_subscription_status as
 * `creating:<13-digit epoch ms>`. Acquiring it is a single conditional UPDATE:
 * Postgres re-evaluates the WHERE clause after waiting on a concurrent writer
 * of the same row, so of N simultaneous requests exactly one matches; the rest
 * update zero rows. The claim time is carried in the marker itself rather than
 * profiles.updated_at, because the quota RPCs (migration 003) bump updated_at
 * on every swipe — that would keep a dead claim looking fresh.
 *
 * Fixed-width (13-digit) timestamps make lexical order equal numeric order, so
 * "claim older than the cutoff" is a plain `lt` on the column.
 */

const CLAIM_PREFIX = 'creating:';
export const CLAIM_TTL_MS = 60_000;

export function claimMarker(atMs: number): string {
  return `${CLAIM_PREFIX}${String(Math.floor(atMs)).padStart(13, '0')}`;
}

/** True while a claim marker is younger than the TTL (a stale one may be taken over). */
export function isActiveClaim(status: string | null | undefined, nowMs = Date.now()): boolean {
  if (!status || !status.startsWith(CLAIM_PREFIX)) return false;
  const at = Number(status.slice(CLAIM_PREFIX.length));
  return Number.isFinite(at) && at > nowMs - CLAIM_TTL_MS;
}

/**
 * Atomically take the claim. Succeeds only if the profile is still free, still
 * holds exactly `observedSubscriptionId` (the value the caller decided on), and
 * carries no unexpired claim. Returns the marker on success, null otherwise.
 */
export async function claimSubscriptionSlot(
  admin: SupabaseClient,
  userId: string,
  observedSubscriptionId: string | null,
  nowMs = Date.now()
): Promise<string | null> {
  const marker = claimMarker(nowMs);
  const cutoff = claimMarker(nowMs - CLAIM_TTL_MS);
  let query = admin
    .from('profiles')
    .update({ razorpay_subscription_status: marker })
    .eq('id', userId)
    .eq('plan_tier', 'free');
  query =
    observedSubscriptionId === null
      ? query.is('razorpay_subscription_id', null)
      : query.eq('razorpay_subscription_id', observedSubscriptionId);
  const { data, error } = await query
    .or(
      `razorpay_subscription_status.is.null,razorpay_subscription_status.not.like.${CLAIM_PREFIX}*,razorpay_subscription_status.lt.${cutoff}`
    )
    .select('id');
  return !error && data?.length === 1 ? marker : null;
}

/** Give the claim back (recoverable failure), restoring the status seen before claiming. Only if we still hold it. */
export async function releaseSubscriptionSlot(
  admin: SupabaseClient,
  userId: string,
  marker: string,
  restoreStatus: string | null
): Promise<void> {
  await admin
    .from('profiles')
    .update({ razorpay_subscription_status: restoreStatus })
    .eq('id', userId)
    .eq('razorpay_subscription_status', marker);
}

/** Store the newly created subscription and end the claim — only if we still hold it. */
export async function commitSubscriptionSlot(
  admin: SupabaseClient,
  userId: string,
  marker: string,
  subscription: { id: string; status: string }
): Promise<boolean> {
  const { data, error } = await admin
    .from('profiles')
    .update({
      razorpay_subscription_id: subscription.id,
      razorpay_subscription_status: subscription.status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .eq('razorpay_subscription_status', marker)
    .select('id');
  return !error && data?.length === 1;
}

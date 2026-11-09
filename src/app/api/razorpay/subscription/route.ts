import { NextRequest, NextResponse } from 'next/server';
import {
  cancelSubscriptionAtCycleEnd,
  createSubscription,
  decideSubscriptionReuse,
  fetchSubscription,
  isProPlanSubscription,
  isPurchaseAllowed,
  isRazorpayConfigured,
  purchaseAllowlist,
  razorpayKeyId,
  RazorpayApiError,
  subscriptionUserId,
} from '@/lib/razorpay';
import {
  claimSubscriptionSlot,
  commitSubscriptionSlot,
  isActiveClaim,
  releaseSubscriptionSlot,
} from '@/lib/razorpay-claim';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { hasActivePurchaseGrant } from '@/lib/billing/purchase-access';
import {
  currencyForCountry,
  currencyForPlanId,
  DEFAULT_CURRENCY,
  MissingDisplayPriceError,
  planDescription,
  resolvePlan,
} from '@/lib/billing/currency-config';

/** How long a request waits for a concurrent request's claim to finish before giving up. */
const CLAIM_WAIT_MS = 6_000;
const CLAIM_POLL_MS = 400;
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Step 1 of a Pro upgrade: create (or reuse) a Razorpay subscription bound to
 * the authenticated caller and hand the browser what Checkout needs. Creating
 * a subscription grants nothing — Pro is only ever set by /verify or the
 * webhook after Razorpay itself confirms a successful charge.
 *
 * At most ONE subscription is created per user, even under concurrent
 * requests (two tabs, double-click, retry): creation happens only while
 * holding the atomic per-user claim in src/lib/razorpay-claim.ts; a request
 * that loses the claim waits for the winner and reuses its subscription.
 */
export async function POST(req: NextRequest) {
  let auth;
  try {
    auth = await getAuthenticatedUser(req);
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { user } = auth;

  // Rollout gate (RAZORPAY_ALLOWLIST_USER_IDS): when set, only listed users may
  // START a purchase; set-but-empty closes purchases for everyone. Checked
  // first — before the unconfigured/mock branch, any database read or any
  // Razorpay call — so a blocked user can neither create anything nor receive
  // a mock "purchase started". Deliberately the same message as "unconfigured".
  if (!isPurchaseAllowed(purchaseAllowlist, user.id)) {
    return NextResponse.json(
      { error: "Pro upgrades aren't available right now. Please check back soon." },
      { status: 503 }
    );
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 });
  }

  // Admin-controlled access (migration 033), required IN ADDITION to the
  // deployment allowlist above: only a user an admin has granted may start a
  // purchase. Also checked before the mock branch and before any Razorpay
  // call. Fails closed — no grant, a missing table or a failed lookup all
  // block — and gives the same generic message, so it reveals nothing.
  if (!(await hasActivePurchaseGrant(admin, user.id))) {
    return NextResponse.json(
      { error: "Pro upgrades aren't available right now. Please check back soon." },
      { status: 503 }
    );
  }

  if (!isRazorpayConfigured) {
    // Same rule as the Stripe hardening: in production, "unconfigured" means
    // "upgrades unavailable" — never a free Pro. The mock exists purely as a
    // local/test convenience and is redeemed by /verify for the caller only.
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json(
        { error: "Pro upgrades aren't available right now. Please check back soon." },
        { status: 503 }
      );
    }
    return NextResponse.json({ success: true, isMock: true });
  }

  // Billing currency is derived exclusively from the account's saved country.
  // Never trust a browser selector, request body, locale, or ChatGPT location.
  // Unknown/missing country uses the documented INR fallback; a failed DB
  // lookup fails closed rather than risking a currency chosen from client input.
  const { data: location, error: locationError } = await admin
    .from('profile_locations')
    .select('current_country')
    .eq('profile_id', user.id)
    .maybeSingle();
  if (locationError) {
    console.error('[razorpay] could not resolve account country', locationError.message);
    return NextResponse.json({ error: 'Could not verify your billing country. Please try again.' }, { status: 503 });
  }
  const requestedCurrency = currencyForCountry(location?.current_country);
  const { planId: resolvedPlanId, currency: resolvedCurrency } = resolvePlan(requestedCurrency);
  // Never silently downgrade a non-Indian account to an INR plan. If the USD
  // plan is not configured, stop checkout rather than charging the wrong currency.
  if (requestedCurrency === 'USD' && resolvedCurrency !== 'USD') {
    console.error('[razorpay] USD plan is not configured for a non-Indian account');
    return NextResponse.json({ error: "USD checkout isn't available right now. Please try again later." }, { status: 503 });
  }

  // F1 (2026-11-05 audit): `currency` here MUST reflect the currency of
  // whatever subscription is actually being checked out — never just the
  // latest request's hint. A reused stored subscription (below) may be on a
  // different plan than what THIS request asked for (e.g. it was created
  // under a different currency selection on an earlier, abandoned attempt);
  // callers reusing one must pass ITS real currency, derived from its own
  // plan_id via currencyForPlanId, not `resolvedCurrency`.
  // Requirement #6 (2026-11-06 review): an active-but-incompletely-configured
  // currency (a Plan id is set, but its display price is not) must fail
  // explicitly rather than complete a checkout with no price shown — see
  // MissingDisplayPriceError. Same 503 shape as every other config gate above.
  const checkoutFor = (subscriptionId: string, currency: string) => {
    let description: string;
    try {
      description = planDescription(currency);
    } catch (err) {
      if (!(err instanceof MissingDisplayPriceError)) throw err;
      console.error('[razorpay] currency is active but has no display price configured', currency);
      return NextResponse.json(
        { error: "Pro upgrades aren't available right now. Please check back soon." },
        { status: 503 }
      );
    }
    return NextResponse.json({
      success: true,
      subscriptionId,
      keyId: razorpayKeyId,
      email: user.email ?? null,
      currency,
      description,
    });
  };
  const alreadyStarting = () =>
    NextResponse.json({ error: 'Checkout is already starting. Please try again in a moment.' }, { status: 409 });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('plan_tier, razorpay_subscription_id, razorpay_subscription_status')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Could not load your account' }, { status: 500 });
    }
    if (profile.plan_tier === 'pro') {
      return NextResponse.json({ error: 'You already have RemoteMatch Pro.' }, { status: 409 });
    }

    // Another request holds the claim: wait for it to finish, then re-evaluate
    // (normally finding and reusing the subscription it just created).
    if (isActiveClaim(profile.razorpay_subscription_status)) {
      const deadline = Date.now() + CLAIM_WAIT_MS;
      let stillClaimed = true;
      while (Date.now() < deadline) {
        await sleep(CLAIM_POLL_MS);
        const { data: p } = await admin
          .from('profiles')
          .select('razorpay_subscription_status')
          .eq('id', user.id)
          .single();
        if (!isActiveClaim(p?.razorpay_subscription_status)) {
          stillClaimed = false;
          break;
        }
      }
      if (stillClaimed) return alreadyStarting();
      continue;
    }

    // Reuse the stored subscription while it is still unpaid ('created');
    // replacing it would orphan it. Never open a second one beside a live
    // mandate — that would risk charging the customer twice.
    const stored: string | null = profile.razorpay_subscription_id;
    if (stored) {
      let existing;
      try {
        existing = await fetchSubscription(stored);
      } catch (err) {
        const status = err instanceof RazorpayApiError ? err.status : 0;
        // 400/404: the stored id is unusable — replace it below. Anything
        // else is transient; refuse rather than risk an orphan.
        if (status !== 400 && status !== 404) {
          console.error('[razorpay] fetch stored subscription failed', status, (err as Error).message);
          return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
        }
      }
      if (existing && isProPlanSubscription(existing) && subscriptionUserId(existing) === user.id) {
        const decision = decideSubscriptionReuse(existing, resolvedPlanId);
        // Exhaustive switch (2026-11-06 fresh-review fix): a future 4th
        // SubscriptionReuseAction value is now a compile error here instead
        // of silently falling through to 'replace' (create a new
        // subscription) with no warning.
        switch (decision) {
          case 'reuse_unpaid':
            // F1 fix: report THIS subscription's real currency, derived from
            // its own plan_id — never the current request's currency hint
            // (which is guaranteed to match here anyway, since decision ===
            // 'reuse_unpaid' only when existing.plan_id === resolvedPlanId).
            return checkoutFor(existing.id, currencyForPlanId(existing.plan_id) ?? DEFAULT_CURRENCY);
          case 'blocked_live_mandate':
            return NextResponse.json(
              { error: 'Your payment is being confirmed. Please refresh in a minute.' },
              { status: 409 }
            );
          case 'replace':
            // Either a halted/cancelled/completed/expired/paused
            // subscription, OR an unpaid ('created') one in a DIFFERENT
            // currency than this request asked for (requirement #1) — either
            // way, fall through and create a fresh one in the currency just
            // resolved. Best-effort, non-blocking cancel of the stale one
            // first (2026-11-06 fresh-review fix) — it would otherwise be
            // silently orphaned at Razorpay forever; a failure here (e.g. it
            // already has no cycle to cancel) never blocks checkout.
            try {
              await cancelSubscriptionAtCycleEnd(existing.id);
            } catch (err) {
              console.error('[razorpay] could not cancel stale replaced subscription (non-fatal)', existing.id, (err as Error).message);
            }
            break;
          default: {
            const _exhaustive: never = decision;
            throw new Error(`decideSubscriptionReuse: unhandled decision ${_exhaustive}`);
          }
        }
      }
    }

    // Atomic per-user claim; only the winner creates. Losing means the
    // profile changed under us (another request claimed or stored first):
    // loop and re-evaluate rather than create.
    const marker = await claimSubscriptionSlot(admin, user.id, stored);
    if (!marker) continue;

    let subscription;
    try {
      subscription = await createSubscription({ userId: user.id, planId: resolvedPlanId });
    } catch (err) {
      // Recoverable: hand the claim back so the next click can try again.
      await releaseSubscriptionSlot(admin, user.id, marker, profile.razorpay_subscription_status);
      const status = err instanceof RazorpayApiError ? err.status : 0;
      console.error('[razorpay] create subscription failed', status, (err as Error).message);
      return NextResponse.json({ error: 'Could not start checkout. Please try again.' }, { status: 502 });
    }

    // Store the binding before the browser ever sees the id: /verify and the
    // webhook both resolve the user from this column.
    if (await commitSubscriptionSlot(admin, user.id, marker, subscription)) {
      return checkoutFor(subscription.id, resolvedCurrency);
    }
    // Our claim expired and was taken over before we stored. The subscription
    // we created was never shown to the browser, so it cannot be paid; it
    // stays 'created' and expires unused.
    console.error('[razorpay] subscription claim lost before commit; unused subscription', subscription.id);
    return alreadyStarting();
  }

  return alreadyStarting();
}

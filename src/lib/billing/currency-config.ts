/**
 * RemoteMatch — country → currency → Razorpay Plan configuration (Option A,
 * docs/international-payments-audit-plan-2026-10-31.md §2).
 *
 * Deliberately conservative: a currency is "active" only when its Plan id env
 * var is actually set — never assumed available just because it's listed
 * below. Every currency not active, and every unlisted/undetectable country,
 * resolves to the existing INR plan — today's behavior is the default, not a
 * special case. This module is pure config/lookup; nothing here creates a
 * Razorpay Plan.
 *
 * `/api/razorpay/subscription` (src/app/api/razorpay/subscription/route.ts)
 * IS wired to call `resolvePlan()` — has been since this module's original
 * PR — reading an optional `currency` hint off the request body and
 * resolving it through this module before creating or reusing a
 * subscription. (2026-11-07 round-3 review fix, P3: this header previously
 * still said "not done — see the plan doc," left over from before that
 * wiring landed and never updated — stale documentation, corrected here.)
 * What is NOT wired in is a country/currency *picker* — no caller passes
 * anything other than `DEFAULT_CURRENCY` today; see `currencyForCountry`'s
 * own doc comment below for that distinction.
 */

import { formatCurrency } from './currency-format';

export const DEFAULT_CURRENCY = 'INR' as const;
const CHECKOUT_CURRENCIES = new Set(['INR', 'USD']);

/** One Razorpay Subscription Plan per currency — each must be created by hand
 *  in the Razorpay dashboard first; this only names where its id lives. */
const PLAN_ENV_VAR_BY_CURRENCY: Record<string, string> = {
  INR: 'RAZORPAY_PRO_PLAN_ID',
  USD: 'RAZORPAY_PRO_PLAN_ID_USD',
  GBP: 'RAZORPAY_PRO_PLAN_ID_GBP',
  AED: 'RAZORPAY_PRO_PLAN_ID_AED',
  EUR: 'RAZORPAY_PRO_PLAN_ID_EUR',
};

/** ISO 3166-1 alpha-2 country → ISO 4217 currency. Deliberately a short,
 *  explicit, hand-maintained list (task scenarios + obvious EU members) —
 *  not an attempt at exhaustive world coverage. Add entries one at a time,
 *  each backed by a real Razorpay Plan, never speculatively. */
const CURRENCY_BY_COUNTRY: Record<string, string> = {
  IN: 'INR',
  US: 'USD',
  GB: 'GBP',
  AE: 'AED',
  // Eurozone (subset — extend deliberately, not by assuming all 27 EU states use EUR):
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  IE: 'EUR',
};

export interface PlanResolution {
  /** The currency actually used — may differ from the detected/requested one
   *  if it has no active Plan; never silently differs without `fellBack`. */
  currency: string;
  planId: string;
  /** True when the requested/detected currency had no active Plan and this
   *  fell back to DEFAULT_CURRENCY. Surface this in logs/analytics, not as
   *  an error to the user — a fallback is expected, deliberate behavior. */
  fellBack: boolean;
}

/** A configured plan id must look like a real Razorpay Plan id — the same
 *  `plan_` prefix check `isRazorpayConfigured` (razorpay.ts) already applies
 *  to the base INR plan. 2026-11-06 review fix (requirement #8): applied
 *  consistently to EVERY currency now — previously only INR got this check,
 *  so a malformed non-INR value (placeholder text, a key id pasted into the
 *  wrong var) passed `isCurrencyActive` and only failed later at the live
 *  Razorpay API call instead of being treated as "not configured" up front. */
export function validPlanId(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  return trimmed && trimmed.startsWith('plan_') ? trimmed : null;
}

/** The one place that turns a currency into "its currently configured plan
 *  id, if validly formatted, else null" — `isCurrencyActive`,
 *  `observeCurrentConfig` and `resolvePlan` all share this instead of each
 *  re-deriving "look up the env var, then validate it" independently
 *  (2026-11-06 fresh-review fix: those three had already started to drift —
 *  this is the single source every one of them reads through now). */
function configuredPlanId(currency: string): string | null {
  const envVar = PLAN_ENV_VAR_BY_CURRENCY[currency.toUpperCase()];
  return envVar ? validPlanId(process.env[envVar]) : null;
}

/** True only when this currency has a real, validly-formatted Plan id
 *  configured RIGHT NOW — never when it merely appears in CURRENCY_BY_COUNTRY,
 *  and never influenced by history (see `activePlanIds`/`currencyForPlanId`
 *  below for the historical counterpart). This is the one check that decides
 *  whether a currency may be used for a NEW subscription, so it must always
 *  reflect the current environment, nothing cached. */
export function isCurrencyActive(currency: string): boolean {
  return configuredPlanId(currency) !== null;
}

export function activeCurrencies(): string[] {
  return Object.keys(PLAN_ENV_VAR_BY_CURRENCY).filter((currency) => CHECKOUT_CURRENCIES.has(currency) && isCurrencyActive(currency));
}

/**
 * Append-only record of every (planId → currency) pair this process has ever
 * observed as validly configured. Reset only by restarting the process —
 * never by an env var being changed or removed afterward. This is the single
 * source of truth for "is this plan id one of ours" (`activePlanIds`,
 * `isProPlanSubscription` in razorpay.ts) and "what currency was THIS plan id
 * actually denominated in" (`currencyForPlanId`).
 *
 * 2026-11-06 review fix (requirement #3): before this, both functions
 * re-derived their answer from a LIVE `process.env` read on every call, so
 * rotating/unsetting a currency's plan id env var after go-live could flip a
 * still-paying subscription's `isProPlanSubscription` result to false
 * mid-process — risking a duplicate live mandate (the reuse-check in
 * /api/razorpay/subscription silently bypassed) or a legitimately-paid
 * orphan subscription being silently dropped with no profile bound and no
 * log line. A plan id recognized once now stays recognized for the rest of
 * this process's life, exactly like the base INR plan id already behaves in
 * razorpay.ts (computed once at import time, never re-read).
 *
 * Deliberately NOT used by `isCurrencyActive`/`activeCurrencies`/`resolvePlan`
 * — whether a currency may be offered for a NEW subscription is a live
 * question; whether an EXISTING subscription's plan id is still recognized
 * as ours is a historical one. Conflating the two is what caused the bug.
 *
 * KNOWN, NOT-FULLY-CLOSED LIMITATION (named, not silently left open, per the
 * 2026-11-06 fresh review): this Map is per-process memory, so it is empty
 * again after every restart — on Railway, that's every deploy. A currency
 * rotated out shortly before a redeploy, while a subscription on it is still
 * live, would not be remembered by the next process, so `isProPlanSubscription`
 * (razorpay.ts) and `currencyForPlanId` could both briefly stop recognizing
 * it — the double-mandate / dropped-orphan / wrong-fallback-price risks this
 * fix otherwise closes. An earlier attempt patched `isProPlanSubscription`
 * with a `notes.userId`-presence fallback (reasoning: Razorpay persists
 * notes forever, set only by this server); that was UNSOUND and was
 * reverted — it also recognized a subscription on a completely UNRELATED
 * plan on this account as "ours" whenever it happened to carry a
 * user-id-shaped `notes.userId`, breaking the existing F3.2 regression test.
 * `activePlanIds()` therefore remains the SOLE check, and the restart gap
 * stays genuinely open. The real fix needs a durable (plan_id → currency,
 * is-ours) record OUTSIDE process memory — e.g. in the database, written at
 * subscription-creation time — a real schema change deliberately left for a
 * separate, future pass rather than rushed here with an unsound shortcut.
 */
const knownPlanIdToCurrency = new Map<string, string>();

function observeCurrentConfig(): void {
  for (const currency of Object.keys(PLAN_ENV_VAR_BY_CURRENCY)) {
    const planId = configuredPlanId(currency);
    if (planId && !knownPlanIdToCurrency.has(planId)) {
      knownPlanIdToCurrency.set(planId, currency);
    }
  }
}

/** Every real Plan id this process has EVER seen configured (any currency,
 *  past or present) — so "is this subscription on one of OUR Pro plans" can
 *  check membership against a historical record, not just today's env. */
export function activePlanIds(): ReadonlySet<string> {
  observeCurrentConfig();
  return new Set(knownPlanIdToCurrency.keys());
}

/**
 * Reverse of resolvePlan: given a Razorpay plan id a subscription is ACTUALLY
 * on, returns which currency that is — the only correct source for "what
 * currency is this subscription in", never a request's currency hint. Added
 * for F1 (2026-11-05 audit): reusing a stored subscription must report ITS
 * currency, not whatever the latest request asked for. Historical (see
 * `knownPlanIdToCurrency` above) so a subscription's currency keeps resolving
 * correctly even if that currency's env var is later rotated — otherwise F1's
 * own fallback (`?? DEFAULT_CURRENCY`) could show an INR price/description
 * for a real non-INR charge (2026-11-06 review finding). Returns null if the
 * plan id isn't one of ours (caller should treat that as "unknown" rather
 * than guessing — in practice this is only ever called on a plan id that
 * already passed isProPlanSubscription, so it should always resolve).
 */
export function currencyForPlanId(planId: string): string | null {
  observeCurrentConfig();
  return knownPlanIdToCurrency.get(planId) ?? null;
}

/** Country code (any case, ISO-2) → currency this config WOULD use for it,
 *  ignoring whether that currency is actually active. Never trust this alone
 *  for billing — always resolve through `resolvePlan`, which applies the
 *  fallback. Unknown/missing country → DEFAULT_CURRENCY.
 *
 *  Has NO caller in application code today (2026-11-06 review finding): the
 *  only wired currency-selection path is `/api/razorpay/subscription` reading
 *  a raw `currency` string off the request body straight into `resolvePlan`.
 *  Kept, not deleted — this is the function a real country/currency picker
 *  will call once one exists (see docs/international-payments-audit-plan-
 *  2026-10-31.md) — but it is deliberately NOT wired into any route yet;
 *  wiring it in is a product decision outside this fix's scope. */
export function currencyForCountry(countryCode: string | null | undefined): string {
  if (!countryCode) return DEFAULT_CURRENCY;
  // Product pricing policy: India pays INR; every other known country pays USD.
  // Missing country remains INR until the account completes location onboarding.
  return countryCode.trim().toUpperCase() === 'IN' ? 'INR' : 'USD';
}

/**
 * The one function billing code should call. Takes a currency (already
 * resolved from a country, or requested directly — this module never trusts
 * a client-supplied currency as the final word, only as an input to look up)
 * and returns which Plan to actually use, falling back to INR whenever the
 * requested currency isn't active. Throws only if even INR is unconfigured
 * (mirrors `isRazorpayConfigured`'s existing behavior for the base case).
 * Live, not historical — same reasoning as `isCurrencyActive` above.
 */
export function resolvePlan(requestedCurrency: string): PlanResolution {
  const candidate = requestedCurrency.toUpperCase();
  const wanted = CHECKOUT_CURRENCIES.has(candidate) ? candidate : DEFAULT_CURRENCY;
  const planId = configuredPlanId(wanted);
  if (planId) {
    observeCurrentConfig();
    return { currency: wanted, planId, fellBack: false };
  }
  const fallbackPlanId = configuredPlanId(DEFAULT_CURRENCY);
  if (!fallbackPlanId) {
    throw new Error(`resolvePlan: neither ${wanted} nor the default currency ${DEFAULT_CURRENCY} has a configured plan`);
  }
  observeCurrentConfig();
  return { currency: DEFAULT_CURRENCY, planId: fallbackPlanId, fellBack: wanted !== DEFAULT_CURRENCY };
}

/**
 * Display-only major-unit price per currency (F2, 2026-11-05 audit: fixes the
 * hardcoded "₹499/month" that `razorpay-checkout.ts` showed even for a USD
 * subscriber). NEVER used to compute a charge — Razorpay's own Plan object is
 * always the real price; this only feeds `planDescription`'s wording. Must
 * stay in sync with the actual Plan amounts by hand (same manual-sync
 * requirement as the plan ids themselves — see the Dashboard-activation note
 * in the plan doc). Decided prices: INR 499 flat, USD 9 flat (Deep, 2026-10-30).
 */
const DISPLAY_AMOUNT_BY_CURRENCY: Record<string, number> = {
  INR: 499,
  USD: 9,
};

/** Thrown by `planDescription` when a currency has no display amount on
 *  file. 2026-11-06 review fix (requirement #6): this used to fall back to a
 *  price-less generic string, which meant activating a new currency (just
 *  setting its Plan id env var — `isCurrencyActive`/`resolvePlan` pick that
 *  up immediately, no code change needed) could silently ship a Checkout
 *  modal with no price shown at all, with no signal anywhere. An
 *  incompletely-configured currency must fail explicitly instead — callers
 *  (route.ts) catch this and refuse the checkout with a clear 503, the same
 *  "unavailable" shape already used for every other config gate in that
 *  route, rather than completing a checkout with a blank price. */
export class MissingDisplayPriceError extends Error {}

/** The description string Checkout should show, for whatever currency a
 *  subscription actually resolved to or is already on — always computed
 *  server-side so it can never drift from the real currency being charged.
 *  Throws `MissingDisplayPriceError` rather than silently showing a
 *  price-less description — see that class's doc comment. */
export function planDescription(currency: string): string {
  const upper = currency.toUpperCase();
  const amount = DISPLAY_AMOUNT_BY_CURRENCY[upper];
  if (amount === undefined) {
    throw new MissingDisplayPriceError(`planDescription: no display price configured for ${upper}`);
  }
  return `RemoteMatch Pro — ${formatCurrency(amount, upper)}/month`;
}

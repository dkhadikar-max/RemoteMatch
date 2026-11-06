/**
 * RemoteMatch — country → currency → Razorpay Plan configuration (Option A,
 * docs/international-payments-audit-plan-2026-10-31.md §2).
 *
 * Deliberately conservative: a currency is "active" only when its Plan id env
 * var is actually set — never assumed available just because it's listed
 * below. Every currency not active, and every unlisted/undetectable country,
 * resolves to the existing INR plan — today's behavior is the default, not a
 * special case. This module is pure config/lookup; nothing here creates a
 * Razorpay Plan or changes what /api/razorpay/subscription does until that
 * route is wired to call `resolvePlan()` (not done — see the plan doc).
 */

import { formatCurrency } from './currency-format';

export const DEFAULT_CURRENCY = 'INR' as const;

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

/** True only when this currency has a real, non-empty Plan id configured —
 *  never when it merely appears in CURRENCY_BY_COUNTRY. */
export function isCurrencyActive(currency: string): boolean {
  const envVar = PLAN_ENV_VAR_BY_CURRENCY[currency.toUpperCase()];
  if (!envVar) return false;
  return Boolean(process.env[envVar] && process.env[envVar]!.trim().length > 0);
}

export function activeCurrencies(): string[] {
  return Object.keys(PLAN_ENV_VAR_BY_CURRENCY).filter(isCurrencyActive);
}

/** Every real Plan id currently configured (any active currency), as a set —
 *  so "is this subscription on one of OUR Pro plans" can check membership
 *  instead of equality against the single INR plan id. */
export function activePlanIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const currency of activeCurrencies()) {
    const envVar = PLAN_ENV_VAR_BY_CURRENCY[currency];
    const id = process.env[envVar]?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Reverse of resolvePlan: given a Razorpay plan id a subscription is ACTUALLY
 * on, returns which currency that is — the only correct source for "what
 * currency is this subscription in", never a request's currency hint. Added
 * for F1 (2026-11-05 audit): reusing a stored subscription must report ITS
 * currency, not whatever the latest request asked for. Returns null if the
 * plan id isn't one of ours (caller should treat that as "unknown" rather
 * than guessing — in practice this is only ever called on a plan id that
 * already passed isProPlanSubscription, so it should always resolve).
 */
export function currencyForPlanId(planId: string): string | null {
  for (const currency of activeCurrencies()) {
    const envVar = PLAN_ENV_VAR_BY_CURRENCY[currency];
    if (process.env[envVar]?.trim() === planId) return currency;
  }
  return null;
}

/** Country code (any case, ISO-2) → currency this config WOULD use for it,
 *  ignoring whether that currency is actually active. Never trust this alone
 *  for billing — always resolve through `resolvePlan`, which applies the
 *  fallback. Unknown/missing country → DEFAULT_CURRENCY. */
export function currencyForCountry(countryCode: string | null | undefined): string {
  if (!countryCode) return DEFAULT_CURRENCY;
  return CURRENCY_BY_COUNTRY[countryCode.trim().toUpperCase()] ?? DEFAULT_CURRENCY;
}

/**
 * The one function billing code should call. Takes a currency (already
 * resolved from a country, or requested directly — this module never trusts
 * a client-supplied currency as the final word, only as an input to look up)
 * and returns which Plan to actually use, falling back to INR whenever the
 * requested currency isn't active. Throws only if even INR is unconfigured
 * (mirrors `isRazorpayConfigured`'s existing behavior for the base case).
 */
export function resolvePlan(requestedCurrency: string): PlanResolution {
  const wanted = requestedCurrency.toUpperCase();
  if (isCurrencyActive(wanted)) {
    const envVar = PLAN_ENV_VAR_BY_CURRENCY[wanted];
    return { currency: wanted, planId: process.env[envVar]!.trim(), fellBack: false };
  }
  const fallbackEnvVar = PLAN_ENV_VAR_BY_CURRENCY[DEFAULT_CURRENCY];
  const fallbackPlanId = process.env[fallbackEnvVar]?.trim();
  if (!fallbackPlanId) {
    throw new Error(`resolvePlan: neither ${wanted} nor the default currency ${DEFAULT_CURRENCY} has a configured plan`);
  }
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

/** The description string Checkout should show, for whatever currency a
 *  subscription actually resolved to or is already on — always computed
 *  server-side so it can never drift from the real currency being charged.
 *  Falls back to a currency-agnostic string if a currency has no display
 *  amount on file (shouldn't happen for an active currency, but fails safe
 *  rather than showing a wrong number). */
export function planDescription(currency: string): string {
  const upper = currency.toUpperCase();
  const amount = DISPLAY_AMOUNT_BY_CURRENCY[upper];
  if (amount === undefined) return 'RemoteMatch Pro — monthly subscription';
  return `RemoteMatch Pro — ${formatCurrency(amount, upper)}/month`;
}

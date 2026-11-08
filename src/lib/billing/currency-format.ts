/**
 * RemoteMatch — currency display formatting + rounding for billing amounts.
 * Pure functions, no network, no env reads — safe to unit-test offline.
 * docs/international-payments-audit-plan-2026-10-31.md §3.
 */

const LOCALE_BY_CURRENCY: Record<string, string> = {
  INR: 'en-IN',
  USD: 'en-US',
  GBP: 'en-GB',
  AED: 'ar-AE',
  EUR: 'de-DE',
};

/** Zero-decimal currencies per ISO 4217 (Razorpay's minor-unit list is wider,
 *  but none of today's supported currencies are zero-decimal — kept explicit
 *  so adding one later doesn't silently misconvert). */
const ZERO_DECIMAL_CURRENCIES = new Set<string>();

/** Razorpay amounts are integer minor units (e.g. paise, cents). Converts a
 *  major-unit display amount (499 for ₹499) to what the API call sends.
 *  Rounds to the nearest minor unit rather than truncating, so a converted
 *  price like 5.995 never silently loses a cent. */
export function toMinorUnits(amountMajor: number, currency: string): number {
  if (!Number.isFinite(amountMajor) || amountMajor < 0) {
    throw new Error(`toMinorUnits: invalid amount ${amountMajor}`);
  }
  const factor = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
  return Math.round(amountMajor * factor);
}

export function fromMinorUnits(amountMinor: number, currency: string): number {
  const factor = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
  return amountMinor / factor;
}

/** Display-only formatting (e.g. "₹499", "$6.00"). Never used to compute what
 *  gets charged — that's toMinorUnits, fed from the server's own price table,
 *  never from this function's output parsed back. */
export function formatCurrency(amountMajor: number, currency: string): string {
  const upper = currency.toUpperCase();
  const locale = LOCALE_BY_CURRENCY[upper] ?? 'en-US';
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: upper,
      minimumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(upper) ? 0 : 2,
      maximumFractionDigits: ZERO_DECIMAL_CURRENCIES.has(upper) ? 0 : 2,
    }).format(amountMajor);
  } catch {
    // Unknown/unsupported ISO code to Intl — fail safe to a plain, unambiguous string
    // rather than let a bad currency code throw all the way up to the checkout UI.
    return `${amountMajor.toFixed(2)} ${upper}`;
  }
}

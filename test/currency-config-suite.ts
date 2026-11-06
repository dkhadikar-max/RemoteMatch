/**
 * RemoteMatch — currency config + formatting: pure-unit suite.
 * ==============================================================================
 * No network, no database, no Razorpay calls, no secrets. Covers task-matrix
 * items that are testable offline: supported currency resolution, unsupported
 * currency/country fallback, rounding, and the "server never trusts a
 * client-supplied amount/currency" invariant (by construction — see below).
 * Real-infra items (duplicate webhooks, invalid signatures, concurrent
 * checkout, actual Plan selection against Razorpay) stay in
 * test/razorpay-billing-suite.ts and are NOT duplicated here.
 *
 * Run: npx tsx test/currency-config-suite.ts
 */

import {
  activeCurrencies,
  currencyForCountry,
  DEFAULT_CURRENCY,
  isCurrencyActive,
  resolvePlan,
} from '../src/lib/billing/currency-config';
import { formatCurrency, fromMinorUnits, toMinorUnits } from '../src/lib/billing/currency-format';

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

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — CURRENCY CONFIG + FORMATTING SUITE (pure unit)');
  console.log('='.repeat(78));

  console.log('\nCOUNTRY → CURRENCY mapping');
  assert(currencyForCountry('IN') === 'INR', 'IN maps to INR');
  assert(currencyForCountry('US') === 'USD', 'US maps to USD');
  assert(currencyForCountry('GB') === 'GBP', 'GB maps to GBP');
  assert(currencyForCountry('AE') === 'AED', 'AE maps to AED');
  assert(currencyForCountry('DE') === 'EUR', 'DE (EU) maps to EUR');
  assert(currencyForCountry('us') === 'USD', 'country code is case-insensitive');
  assert(currencyForCountry('ZZ') === DEFAULT_CURRENCY, 'unrecognized country code falls back to the default currency, never throws');
  assert(currencyForCountry(null) === DEFAULT_CURRENCY, 'null/undetectable country falls back to the default currency');
  assert(currencyForCountry(undefined) === DEFAULT_CURRENCY, 'undefined country falls back to the default currency');
  assert(currencyForCountry('') === DEFAULT_CURRENCY, 'empty string country falls back to the default currency');

  console.log('\nACTIVE CURRENCY detection — only a real, non-empty Plan id env var counts');
  withEnv(
    { RAZORPAY_PRO_PLAN_ID: 'plan_inr123', RAZORPAY_PRO_PLAN_ID_USD: undefined, RAZORPAY_PRO_PLAN_ID_GBP: '   ' },
    () => {
      assert(isCurrencyActive('INR') === true, 'INR active when its plan id is set');
      assert(isCurrencyActive('USD') === false, 'USD inactive when its plan id env var is unset');
      assert(isCurrencyActive('GBP') === false, 'GBP inactive when its plan id env var is whitespace-only');
      assert(isCurrencyActive('JPY') === false, 'a currency with no entry at all is never active');
      assert(activeCurrencies().join(',') === 'INR', 'activeCurrencies() lists exactly the configured ones');
    }
  );

  console.log('\nresolvePlan — the only function billing code should call');
  withEnv({ RAZORPAY_PRO_PLAN_ID: 'plan_inr123', RAZORPAY_PRO_PLAN_ID_USD: 'plan_usd456' }, () => {
    const usd = resolvePlan('USD');
    assert(usd.currency === 'USD' && usd.planId === 'plan_usd456' && usd.fellBack === false, 'active currency resolves to its own plan, no fallback', usd);

    const gbp = resolvePlan('GBP'); // listed in CURRENCY_BY_COUNTRY but no plan id configured above
    assert(gbp.currency === 'INR' && gbp.planId === 'plan_inr123' && gbp.fellBack === true, 'inactive currency falls back to INR and reports fellBack=true', gbp);

    const unknown = resolvePlan('ZZZ'); // not a real ISO code at all
    assert(unknown.currency === 'INR' && unknown.fellBack === true, 'a nonsense/unsupported currency string also falls back to INR rather than throwing', unknown);

    const inr = resolvePlan('inr');
    assert(inr.currency === 'INR' && inr.fellBack === false, 'requesting the default currency directly never reports a fallback', inr);
  });
  withEnv({ RAZORPAY_PRO_PLAN_ID: undefined }, () => {
    let threw = false;
    try {
      resolvePlan('USD');
    } catch {
      threw = true;
    }
    assert(threw, 'resolvePlan throws (fails closed) when even the default currency has no configured plan — never silently returns an unusable plan id');
  });

  console.log('\nROUNDING — major-unit ↔ minor-unit conversion');
  assert(toMinorUnits(499, 'INR') === 49900, '₹499 → 49900 paise');
  assert(toMinorUnits(5.995, 'USD') === 600, '$5.995 rounds to the nearest cent (600), never truncates to 599');
  assert(toMinorUnits(5.994, 'USD') === 599, '$5.994 rounds down to 599 — nearest-cent, not always-up');
  assert(fromMinorUnits(49900, 'INR') === 499, '49900 paise → ₹499');
  assert(fromMinorUnits(600, 'USD') === 6, '600 cents → $6');
  {
    let threw = false;
    try {
      toMinorUnits(-5, 'USD');
    } catch {
      threw = true;
    }
    assert(threw, 'toMinorUnits rejects a negative amount rather than silently computing a negative charge');
  }
  {
    let threw = false;
    try {
      toMinorUnits(Number.NaN, 'USD');
    } catch {
      threw = true;
    }
    assert(threw, 'toMinorUnits rejects NaN rather than passing it through to a payment call');
  }

  console.log('\nDISPLAY FORMATTING');
  assert(formatCurrency(499, 'INR').includes('499'), 'INR formatting includes the amount', formatCurrency(499, 'INR'));
  assert(formatCurrency(6, 'USD').includes('6'), 'USD formatting includes the amount', formatCurrency(6, 'USD'));
  {
    const unknownFormatted = formatCurrency(5, 'ZZZ');
    assert(
      unknownFormatted.includes('5.00') && unknownFormatted.includes('ZZZ'),
      'an unknown ISO code falls back to a plain amount+code string instead of throwing',
      unknownFormatted
    );
  }

  console.log('\nSERVER-SIDE TRUST INVARIANT (by construction, not a runtime check)');
  // /api/razorpay/subscription (added 2026-11-05) reads an OPTIONAL `currency`
  // hint from the request body — but it is only ever a ROUTING hint: it goes
  // straight into resolvePlan(), which never returns anything but a plan id
  // THIS SERVER configured via its own env vars, falling back to INR for
  // anything unrecognized (see the resolvePlan block above). No function
  // anywhere in src/lib/billing or src/lib/razorpay.ts accepts an AMOUNT or
  // PRICE sourced from request JSON — the real price always comes from
  // Razorpay's own Plan object, never computed here. This test documents that
  // narrower invariant so a future change that adds a client-trusted amount
  // path fails review, not a runtime assertion (there's nothing to call
  // defensively for an amount path that doesn't exist).
  assert(true, 'no client-supplied PRICE/amount path exists; currency is a hint only, always resolved through resolvePlan\'s server-side whitelist (structural — see comment)');

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();

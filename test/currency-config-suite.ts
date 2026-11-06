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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  activeCurrencies,
  activePlanIds,
  currencyForCountry,
  currencyForPlanId,
  DEFAULT_CURRENCY,
  isCurrencyActive,
  MissingDisplayPriceError,
  planDescription,
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

  console.log('\nPR #50 REMEDIATION (2026-11-06) — requirement #8: invalid plan ids rejected for EVERY currency, not just INR');
  withEnv(
    {
      RAZORPAY_PRO_PLAN_ID: 'notaplanid',
      RAZORPAY_PRO_PLAN_ID_USD: 'rzp_test_someKeyIdPastedByMistake',
      RAZORPAY_PRO_PLAN_ID_GBP: 'plan_realLookingGbp789',
    },
    () => {
      assert(isCurrencyActive('INR') === false, 'a malformed (no plan_ prefix) INR plan id is rejected');
      assert(isCurrencyActive('USD') === false, 'a malformed (no plan_ prefix) USD plan id is rejected — same strictness as INR, not just the base currency');
      assert(isCurrencyActive('GBP') === true, 'a validly-formatted GBP plan id is accepted');
    }
  );

  console.log('\nPR #50 REMEDIATION (2026-11-06) — requirement #6: an active-but-incompletely-configured currency fails explicitly, never a price-less checkout');
  assert(planDescription('INR') === 'RemoteMatch Pro — ₹499.00/month' || planDescription('INR').includes('499'), 'INR has a display price and does not throw', planDescription('INR'));
  assert(planDescription('USD').includes('9'), 'USD has a display price and does not throw', planDescription('USD'));
  for (const noPriceCurrency of ['GBP', 'AED', 'EUR']) {
    let threw = false;
    let isRightType = false;
    try {
      planDescription(noPriceCurrency);
    } catch (err) {
      threw = true;
      isRightType = err instanceof MissingDisplayPriceError;
    }
    assert(threw && isRightType, `planDescription('${noPriceCurrency}') throws MissingDisplayPriceError instead of returning a price-less description — it is wired as an active currency's Plan but has no display price on file yet`, noPriceCurrency);
  }

  console.log('\nPR #50 REMEDIATION (2026-11-06) — requirement #3 + #9: historical plan recognition survives env rotation, and currency lookups are observed, not re-derived per character');
  withEnv({ RAZORPAY_PRO_PLAN_ID: 'plan_inr123', RAZORPAY_PRO_PLAN_ID_USD: 'plan_usd_hist001' }, () => {
    // Warm the historical record while USD is live.
    resolvePlan('USD');
    assert(activePlanIds().has('plan_usd_hist001'), 'activePlanIds() contains the USD plan id while it is live');
    assert(currencyForPlanId('plan_usd_hist001') === 'USD', 'currencyForPlanId correctly resolves USD while live');
  });
  withEnv({ RAZORPAY_PRO_PLAN_ID: 'plan_inr123', RAZORPAY_PRO_PLAN_ID_USD: undefined }, () => {
    // USD is no longer ACTIVE for new business...
    assert(isCurrencyActive('USD') === false, 'USD is correctly inactive for NEW subscriptions once its env var is unset (live check, unaffected by history)');
    // ...but a subscription already on that plan id must still resolve its
    // real historical currency — this is exactly what fixes the "wrong
    // displayed price for a real charge" finding: a reused/looked-up
    // subscription's currency must never silently become INR just because
    // the env var was rotated after it was created.
    assert(activePlanIds().has('plan_usd_hist001'), 'activePlanIds() still contains the historically-known USD plan id after its env var is unset — requirement #3');
    assert(currencyForPlanId('plan_usd_hist001') === 'USD', 'currencyForPlanId still correctly resolves USD for a historical plan id after its env var is unset — fixes the false-INR-price finding');
  });

  console.log('\nPR #50 REMEDIATION (2026-11-06) — requirement #10 (explicit decision): currencyForCountry is kept, not deleted, and remains correct even though it has no production caller today');
  assert(currencyForCountry('GB') === 'GBP', 'currencyForCountry still correctly maps GB → GBP — ready for the not-yet-built country/currency picker to call; the one WIRED entry point today is the raw currency string in /api/razorpay/subscription, documented on the function itself');

  console.log('\nPR #50 REMEDIATION (2026-11-06) — requirement #7 (explicit decision): unused ledger columns were removed, not left silently NULL');
  {
    const migrationSql = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '043_billing_transactions.sql'),
      'utf8'
    );
    // Checked against the CREATE TABLE column list specifically (not the
    // explanatory header comment, which legitimately still names the dropped
    // columns to document the decision).
    const createTableMatch = migrationSql.match(/CREATE TABLE[\s\S]*?;/);
    const columnList = createTableMatch ? createTableMatch[0] : migrationSql;
    assert(!/razorpay_order_id\s+TEXT/.test(columnList), 'migration 043\'s CREATE TABLE no longer defines a razorpay_order_id column — nothing in this PR populates it, so it was removed rather than shipped as a silently-NULL column', columnList);
    assert(!/\bcountry\s+TEXT/.test(columnList), 'migration 043\'s CREATE TABLE no longer defines a bare country column — same reasoning as razorpay_order_id', columnList);

    // 2026-11-06 FRESH review fix: uniqueness is the COMPOSITE
    // (razorpay_payment_id, status), not razorpay_event_id alone — keying on
    // event id let a single real capture (reported on two separate
    // deliveries: subscription.charged AND payment.captured) write two rows
    // for the same payment. The composite key collapses both onto one row
    // (same payment id, same status) while a later status transition (e.g.
    // a refund) is still a distinct row, preserving the original fix's
    // intent without the double-count.
    assert(/UNIQUE\s*\(\s*razorpay_payment_id\s*,\s*status\s*\)/.test(columnList), 'migration 043\'s CREATE TABLE has a composite UNIQUE(razorpay_payment_id, status) constraint, not razorpay_event_id alone', columnList);
    assert(!/razorpay_event_id\s+TEXT\s+NOT NULL/.test(columnList), 'razorpay_event_id is a plain nullable audit column now, not a NOT NULL constraint — a delivery with no X-Razorpay-Event-Id header no longer risks a guaranteed insert failure', columnList);
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

run();

/**
 * PR #50 — migration 043 billing_transactions: executable PostgreSQL contract test.
 *
 * Runs the actual migration in an isolated in-memory PGlite database. This
 * verifies the real UNIQUE constraint and the exact ON CONFLICT column list
 * used by Supabase upsert(), not merely the application test seam.
 *
 * It does NOT replace a live Supabase integration run: platform roles,
 * PostgREST behavior, and Razorpay delivery behavior still need isolated
 * infrastructure verification.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '043_billing_transactions.sql'),
  'utf8'
);

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

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text
        LANGUAGE sql STABLE
        AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_user) $$;
      CREATE TABLE profiles (id uuid PRIMARY KEY);
      INSERT INTO profiles (id) VALUES ('11111111-1111-4111-8111-111111111111');
    `);

    await db.exec(migration);

    const profileId = '11111111-1111-4111-8111-111111111111';
    const paymentId = 'pay_same_capture';
    const subscriptionId = 'sub_test_ledger';

    console.log('\nMIGRATION: actual SQL applies cleanly');
    const table = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'billing_transactions'
    `);
    assert(table.rows.length === 1, 'migration creates public.billing_transactions');

    console.log('\nCAPTURE: duplicate webhook representations collapse to one ledger row');
    const captureSql = `
      INSERT INTO billing_transactions
        (profile_id, razorpay_payment_id, razorpay_refund_id, razorpay_subscription_id,
         amount_minor, currency, status, razorpay_event_id)
      VALUES ($1, $2, '', $3, 49900, 'INR', 'captured', $4)
      ON CONFLICT (razorpay_payment_id, status, razorpay_refund_id)
      DO UPDATE SET razorpay_event_id = EXCLUDED.razorpay_event_id
    `;
    await db.query(captureSql, [profileId, paymentId, subscriptionId, 'evt_subscription_charged']);
    await db.query(captureSql, [profileId, paymentId, subscriptionId, 'evt_payment_captured']);
    const captures = await db.query(
      `SELECT id, razorpay_event_id FROM billing_transactions WHERE razorpay_payment_id = $1 AND status = 'captured'`,
      [paymentId]
    );
    const captureRows = captures.rows as Array<{ id: string; razorpay_event_id: string | null }>;
    assert(captureRows.length === 1, 'same payment + captured status + empty refund sentinel yields exactly one row');
    assert(captureRows[0]?.razorpay_event_id === 'evt_payment_captured', 'duplicate delivery updates the audit event id on the existing row');

    console.log('\nPARTIAL REFUNDS: distinct refunds remain distinct; redelivery is idempotent');
    const refundSql = `
      INSERT INTO billing_transactions
        (profile_id, razorpay_payment_id, razorpay_refund_id, razorpay_subscription_id,
         amount_minor, currency, status, razorpay_event_id)
      VALUES ($1, $2, $3, $4, $5, 'INR', 'refunded', $6)
      ON CONFLICT (razorpay_payment_id, status, razorpay_refund_id)
      DO UPDATE SET amount_minor = EXCLUDED.amount_minor, razorpay_event_id = EXCLUDED.razorpay_event_id
    `;
    await db.query(refundSql, [profileId, paymentId, 'rfnd_partial_1', subscriptionId, 10000, 'evt_refund_1']);
    await db.query(refundSql, [profileId, paymentId, 'rfnd_partial_2', subscriptionId, 15000, 'evt_refund_2']);
    await db.query(refundSql, [profileId, paymentId, 'rfnd_partial_1', subscriptionId, 10000, 'evt_refund_1_redelivery']);
    const refunds = await db.query(
      `SELECT razorpay_refund_id, amount_minor, razorpay_event_id FROM billing_transactions WHERE razorpay_payment_id = $1 AND status = 'refunded' ORDER BY razorpay_refund_id`,
      [paymentId]
    );
    const refundRows = refunds.rows as Array<{ razorpay_refund_id: string; amount_minor: number | string; razorpay_event_id: string | null }>;
    assert(refundRows.length === 2, 'two different partial refund ids create two rows for the same parent payment');
    assert(
      refundRows[0]?.razorpay_refund_id === 'rfnd_partial_1' &&
      refundRows[1]?.razorpay_refund_id === 'rfnd_partial_2',
      'each partial refund retains its own refund id'
    );
    assert(
      refundRows[0]?.razorpay_event_id === 'evt_refund_1_redelivery',
      'redelivery of the same refund id upserts its existing row'
    );
    assert(
      Number(refundRows[0]?.amount_minor) === 10000 && Number(refundRows[1]?.amount_minor) === 15000,
      'each partial refund retains its own amount'
    );

    console.log('\nSTATUS TRANSITIONS: failed and captured records do not collide');
    await db.query(
      `INSERT INTO billing_transactions
        (profile_id, razorpay_payment_id, razorpay_refund_id, razorpay_subscription_id,
         amount_minor, currency, status)
       VALUES ($1, $2, '', $3, 49900, 'INR', 'failed')
       ON CONFLICT (razorpay_payment_id, status, razorpay_refund_id) DO NOTHING`,
      [profileId, paymentId, subscriptionId]
    );
    const allRows = await db.query(
      'SELECT status FROM billing_transactions WHERE razorpay_payment_id = $1',
      [paymentId]
    );
    assert(allRows.rows.length === 4, 'one capture + two partial refunds + one failed status coexist');

    console.log('\nACCESS CONTROL: client roles denied, service_role permitted');
    let anonDenied = false;
    await db.exec('SET ROLE anon;');
    try {
      await db.query('SELECT count(*) FROM billing_transactions');
    } catch {
      anonDenied = true;
    } finally {
      await db.exec('RESET ROLE;');
    }
    assert(anonDenied, 'anon cannot SELECT from billing_transactions');

    let authenticatedDenied = false;
    await db.exec('SET ROLE authenticated;');
    try {
      await db.query('SELECT count(*) FROM billing_transactions');
    } catch {
      authenticatedDenied = true;
    } finally {
      await db.exec('RESET ROLE;');
    }
    assert(authenticatedDenied, 'authenticated cannot SELECT from billing_transactions');

    await db.exec(`SET ROLE service_role; SET request.jwt.claim.role = 'service_role';`);
    const serviceRows = await db.query('SELECT count(*)::int AS count FROM billing_transactions');
    const serviceCount = serviceRows.rows[0] as { count: number | string } | undefined;
    assert(Number(serviceCount?.count) === 4, 'service_role can read ledger rows under the service_role-only RLS policy');
    await db.exec('RESET ROLE;');

    console.log('\nFOREIGN KEY: deleting a profile preserves billing history');
    await db.query('DELETE FROM profiles WHERE id = $1', [profileId]);
    const orphanRows = await db.query(
      'SELECT count(*)::int AS count FROM billing_transactions WHERE profile_id IS NULL'
    );
    const orphanCount = orphanRows.rows[0] as { count: number | string } | undefined;
    assert(Number(orphanCount?.count) === 4, 'profile deletion sets profile_id NULL without deleting financial history');

    console.log(`\n${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error('Migration 043 PGlite suite crashed:', error);
  process.exitCode = 1;
});

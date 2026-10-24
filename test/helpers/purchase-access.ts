/**
 * Test SETUP only: gives a test user an active billing_purchase_access row
 * (migration 033) so suites that exercise the purchase flow are not blocked
 * by the admin-controlled gate. Writes the row directly with the service-role
 * client instead of through admin_grant_purchase_access, so it needs no admin
 * and writes no audit row — the real grant path, its audit trail and its
 * authorization are proven in test/billing-access-suite.ts, not here.
 * The row is removed with the user (ON DELETE CASCADE).
 */
import { adminClient } from './verified-session';

const TEST_SETUP_GRANTER_ID = '00000000-0000-4000-8000-00000000057e';

export async function grantPurchaseAccessForTest(userId: string): Promise<void> {
  const { error } = await adminClient()
    .from('billing_purchase_access')
    .upsert(
      {
        user_id: userId,
        granted_by_admin_id: TEST_SETUP_GRANTER_ID,
        granted_by_email: 'test-setup',
        granted_at: new Date().toISOString(),
        revoked_at: null,
        revoked_by_admin_id: null,
        revoked_by_email: null,
        note: 'test setup',
      },
      { onConflict: 'user_id' }
    );
  if (error) throw new Error(`test setup: could not grant purchase access to ${userId}: ${error.message}`);
}

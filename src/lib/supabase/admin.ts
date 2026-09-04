import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// NOTE: intentionally does not depend on the `server-only` package (not an
// existing project dependency) to avoid a build-time addition outside this
// remediation's scope. Enforcement instead relies on: this module is only
// ever imported from route handlers (grep for importers before adding a new
// one), and SUPABASE_SERVICE_ROLE_KEY is never exposed via NEXT_PUBLIC_*.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const isSupabaseAdminConfigured = Boolean(
  supabaseUrl && serviceRoleKey && supabaseUrl.startsWith('https://') && serviceRoleKey.length > 20
);

let adminClient: SupabaseClient | null = null;

/**
 * Service-role Supabase client. Bypasses Row Level Security entirely —
 * NEVER import this from a Client Component, and never forward its key to
 * the browser. Restricted to code paths that are themselves already
 * trust-anchored by something other than the caller's own session:
 *   - the Stripe webhook (trust anchor: the verified Stripe signature)
 *   - the Stripe verify route's real-Stripe branch, to write plan_tier after
 *     Stripe itself has confirmed payment (trust anchor: Stripe's API
 *     response), which the authenticated user's own RLS-limited session
 *     cannot do by design (see supabase/migrations/003_security_remediation.sql).
 */
export function getSupabaseAdminClient(): SupabaseClient | null {
  if (!isSupabaseAdminConfigured) return null;
  if (!adminClient) {
    adminClient = createClient(supabaseUrl!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

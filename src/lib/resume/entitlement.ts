import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Resume Intelligence — Workstream 2: server-enforced Pro entitlement
 * (docs/resume-pr-b-workstream2-pro-entitlement-plan-2026-10-30.md).
 *
 * Mirrors the SAME established pattern already used by two other Pro-gated features in this
 * codebase (opportunities/feed's transitionLayerAllowed(), linkedin-jobs/connection-message's
 * inline check): a fresh, per-request `profiles.plan_tier` read, fail-closed. Deliberately NOT
 * `loadServerProfile()` — that function's `planTier` field is a hardcoded `'free'` stub (see
 * src/lib/profile/server-profile.ts:89), never read from the database; using it here would
 * silently deny every real Pro user.
 *
 * A Free user still gets the full deterministic rules-only analysis — this only decides
 * whether the AI layer is attempted.
 */

/** Fails closed: any error, a missing profile row, a null tier, or anything other than the
 *  literal string `'pro'` all return `false`. Never defaults to allowing AI access. A fresh
 *  read every call — no caching, so a subscription change takes effect on the very next
 *  request. */
export async function aiAnalysisAllowed(supabase: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data } = await supabase.from('profiles').select('plan_tier').eq('id', userId).single();
    return (data?.plan_tier as string | undefined) === 'pro';
  } catch {
    return false;
  }
}

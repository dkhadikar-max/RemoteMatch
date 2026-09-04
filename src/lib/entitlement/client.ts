import { ensureAuthenticatedSession } from '@/lib/supabase/browser';

export interface ServerEntitlement {
  planTier: 'free' | 'pro';
  dailyRightSwipesCount: number;
  dailyProposalsCount: number;
  usageDate: string;
  rightSwipeLimit: number;
  proposalLimit: number;
}

/**
 * The single client-side path to the server-authoritative entitlement
 * fields. Every page that needs to display or gate on planTier/quota must
 * go through this — never `localStore`/localStorage — so there is exactly
 * one place that can regress into trusting client state again.
 */
export async function fetchServerEntitlement(): Promise<ServerEntitlement | null> {
  await ensureAuthenticatedSession();
  try {
    const res = await fetch('/api/profile', { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as ServerEntitlement;
  } catch {
    return null;
  }
}

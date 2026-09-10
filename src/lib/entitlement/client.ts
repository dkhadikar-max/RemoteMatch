import type { CareerDirection } from '@/types/byn';

export interface ServerEntitlement {
  planTier: 'free' | 'pro';
  dailyRightSwipesCount: number;
  dailyProposalsCount: number;
  usageDate: string;
  rightSwipeLimit: number;
  proposalLimit: number;
  email: string | null;
  isAnonymous: boolean;
  linkedinUrl: string | null;
  githubUrl: string | null;
  /** Career Transition Matching. Defaults to 'continue' server-side. */
  careerDirection: CareerDirection;
}

/**
 * The single client-side path to the server-authoritative entitlement
 * fields. Every page that needs to display or gate on planTier/quota must
 * go through this — never `localStore`/localStorage — so there is exactly
 * one place that can regress into trusting client state again.
 *
 * No session-provisioning happens here anymore: by the time a page that
 * calls this renders, middleware has already required a verified session
 * to reach it (see src/middleware.ts). A null return here just means the
 * fetch itself failed — not a signal to go create any kind of session.
 */
export async function fetchServerEntitlement(): Promise<ServerEntitlement | null> {
  try {
    const res = await fetch('/api/profile', { method: 'GET' });
    if (!res.ok) return null;
    return (await res.json()) as ServerEntitlement;
  } catch {
    return null;
  }
}

/**
 * Name of the window event that signals server-side entitlement/quota may have
 * just changed (an interested swipe, a rewind, an upgrade). It is a REFRESH
 * SIGNAL ONLY — it carries no data. Every listener must refetch
 * `fetchServerEntitlement()` and treat that response as authoritative.
 */
export const ENTITLEMENT_CHANGED_EVENT = 'remotematch:entitlement-changed';

/** Fire the refresh signal. No-ops during SSR / when there is no `window`. */
export function notifyEntitlementChanged(): void {
  try {
    window.dispatchEvent(new Event(ENTITLEMENT_CHANGED_EVENT));
  } catch {
    /* no window — nothing to notify */
  }
}

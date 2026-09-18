/**
 * Funnel Instrumentation — emission wiring, anonymous-visitor identity.
 * ==============================================================================
 * A stable, opaque, client-generated id that persists across the landing
 * page and signup — the ONLY thing that lets `signup_attributed` (see
 * src/lib/funnel/events.ts) actually bridge a pre-signup `landing_viewed`
 * row to the resulting profile. Never a Supabase anonymous-auth session,
 * never derived from email/IP/fingerprint — matches the format
 * `funnel_events`' own validator already enforces
 * (ANONYMOUS_ID_PATTERN in events.ts).
 */

const STORAGE_KEY = 'rm_anon_id';

/**
 * Returns the persisted anonymous id, creating one on first call. Returns
 * null if localStorage is unavailable (private browsing, SSR, blocked
 * storage) — callers must treat that as "skip this funnel event", never
 * fabricate an id or throw.
 */
export function getOrCreateAnonymousId(): string | null {
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
  } catch {
    return null;
  }
}

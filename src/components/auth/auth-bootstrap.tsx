'use client';

import { useEffect } from 'react';
import { ensureAuthenticatedSession } from '@/lib/supabase/browser';

/**
 * Ensures every visitor has a real, server-verifiable Supabase Auth session
 * before any protected mutation (swipe/rewind/proposal/stripe) is attempted.
 *
 * RemoteMatch has no sign-up/login flow and this remediation is scoped to
 * NOT add one — so this uses Supabase's anonymous auth: a real `auth.users`
 * row and a signed session cookie are created silently on first visit, with
 * zero UI change. That session is what every API route trusts via
 * `supabase.auth.getUser()` — never anything the client sends directly.
 *
 * Requires "Allow anonymous sign-ins" enabled in the Supabase project's Auth
 * settings (see final report item 14 — this is a one-time dashboard change
 * the operator must make; it cannot be done from application code).
 */
export function AuthBootstrap() {
  useEffect(() => {
    ensureAuthenticatedSession();
  }, []);

  return null;
}

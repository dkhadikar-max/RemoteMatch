'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Replaces src/lib/auth/link-identity.ts entirely. There is no anonymous
 * session to link from anymore — every identity starts from a real sign-up.
 * Three flows, kept structurally separate:
 *
 *   1. SIGN-UP (signUpWithPassword) — creates a brand-new auth.users row
 *      via supabase.auth.signUp(). Email confirmation is required before
 *      the account is treated as active anywhere in the app (enforced
 *      server-side in getAuthenticatedUser() and in middleware, not just
 *      by this function's own behavior).
 *
 *   2. SIGN-IN (signInWithPassword / requestMagicLink) — for a returning,
 *      already-verified user. Never creates an account.
 *
 *   3. MAGIC LINK (requestMagicLink) — a single call that Supabase itself
 *      treats as sign-up-or-sign-in depending on whether the email already
 *      has an account (shouldCreateUser: true). The UI still labels the
 *      button contextually ("Sign up" vs "Sign in" tab), but the
 *      underlying call is intentionally the same either way — this is
 *      Supabase's own documented behavior for OTP, not a shortcut taken
 *      here.
 */

export interface AuthFlowResult {
  success: boolean;
  /** True when the account requires clicking the emailed confirmation/magic
   *  link before it's usable — no session exists yet at this point. */
  needsConfirmation?: boolean;
  /** User-safe message — never the raw Supabase error text. */
  error?: string;
}

function confirmRedirectUrl(): string {
  return `${window.location.origin}/auth/confirm`;
}

/** SIGN-UP — brand-new account. Requires email confirmation before use. */
export async function signUpWithPassword(email: string, password: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: confirmRedirectUrl() },
  });

  if (error) {
    return {
      success: false,
      error: "Couldn't create that account. The email may already be in use, or something went wrong.",
    };
  }

  // Supabase returns a user with no session when confirmation is required
  // (the normal case here — Confirm Email is on). If a session IS present,
  // confirmation is off project-wide; either way, the account is not
  // considered active until email_confirmed_at is set, which only
  // getAuthenticatedUser()/middleware ever decide, not this return value.
  return { success: true, needsConfirmation: !data.session };
}

/** SIGN-IN — returning, already-verified user. Never creates an account. */
export async function signInWithPassword(email: string, password: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { success: false, error: 'Incorrect email or password.' };
  }
  return { success: true };
}

/**
 * MAGIC LINK — works for both a brand-new email (creates + sends a
 * confirmation-style sign-up link) and an existing one (sends a sign-in
 * link). Supabase's own `shouldCreateUser` option is what implements this
 * dual behavior; this function does not branch on it itself.
 */
export async function requestMagicLink(email: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: confirmRedirectUrl(), shouldCreateUser: true },
  });

  if (error) {
    return { success: false, error: "Couldn't send the link. Please check the address and try again." };
  }
  return { success: true, needsConfirmation: true };
}

export async function signOutCurrentSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

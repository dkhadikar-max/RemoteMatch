'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Supabase-native passwordless EMAIL OTP. Supabase Auth remains the identity
 * and session system — this is the OTP grant, not the password grant (which
 * was removed in the Auth Flow Change — see docs/auth-flow-change-plan.md and
 * the OTP-code amendment).
 *
 * PRIMARY PATH = a one-time CODE the user reads from the email and types in:
 *
 *   1. startPasswordlessSignup(name, email)  — /signup — MAY create an account
 *        signInWithOtp({ email, options: { shouldCreateUser: true,
 *                                          data: { full_name } } })
 *      No emailRedirectTo. The 014 trigger copies full_name -> profiles.full_name.
 *
 *   2. requestSignInCode(email)  — /login — EXISTING account only
 *        signInWithOtp({ email, options: { shouldCreateUser: false } })
 *      A never-seen email on the login surface gets an error, not an account.
 *
 *   3. verifyEmailOtp(email, code)  — the VerifyCode screen
 *        verifyOtp({ email, token: code, type: 'email' })
 *      The email here is the one the user just entered on the previous screen —
 *      it is NOT an identity taken from a URL or a token payload.
 *
 * A successful verifyOtp establishes the session in the browser; the caller
 * then navigates to /feed and middleware routes by onboarding state.
 *
 * The Supabase email template must deliver `{{ .Token }}`. It MAY also carry a
 * link to /auth/confirm — that route is kept as a compatibility fallback
 * (token_hash / code) but the app's primary path is the entered code.
 */

export interface AuthFlowResult {
  success: boolean;
  /** A code was emailed; no session exists yet. */
  codeSent?: boolean;
  /** User-safe message — never the raw Supabase error text. */
  error?: string;
}

/** SIGN-UP — brand-new account. Name carried in user metadata for the trigger. */
export async function startPasswordlessSignup(name: string, email: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const fullName = name.trim();
  if (!fullName) return { success: false, error: 'Please enter your name.' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: { full_name: fullName },
    },
  });

  if (error) return { success: false, error: friendlySendError(error.message) };
  return { success: true, codeSent: true };
}

/** SIGN-IN — EXISTING account only. `shouldCreateUser: false` so the login
 *  surface never initiates account creation; a never-used email errors here
 *  and the person is pointed at /signup. */
export async function requestSignInCode(email: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });

  if (error) return { success: false, error: friendlySendError(error.message) };
  return { success: true, codeSent: true };
}

/**
 * Re-send a fresh code from the VerifyCode screen. Never creates — by the time
 * this runs the account already exists (the first request created it on
 * /signup, or it already existed on /login). Same call for both flows.
 */
export async function resendCode(email: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });

  if (error) return { success: false, error: friendlySendError(error.message) };
  return { success: true, codeSent: true };
}

/** Verify the emailed code. The email is supplied by the current sign-in
 *  flow (the address the user just typed), never from a URL/token. */
export async function verifyEmailOtp(email: string, code: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const token = code.replace(/\s+/g, '');
  if (!token) return { success: false, error: 'Enter the code from your email.' };

  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error || !data.session) {
    return { success: false, error: friendlyVerifyError(error?.message ?? '') };
  }
  return { success: true };
}

export async function signOutCurrentSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

function friendlySendError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('rate') || m.includes('too many') || m.includes('limit')) {
    return 'Too many attempts — wait a minute and try again.';
  }
  if (m.includes('invalid') && m.includes('email')) {
    return 'That email address doesn’t look valid.';
  }
  // shouldCreateUser:false on /login for an address with no account
  if (m.includes('signups not allowed') || m.includes('not found') || m.includes('otp_disabled')) {
    return 'No account for that email — create one to get started.';
  }
  return 'Couldn’t send the code — check the address and try again.';
}

function friendlyVerifyError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('expired')) return 'That code has expired — request a new one.';
  if (m.includes('rate') || m.includes('too many')) return 'Too many attempts — wait a minute and try again.';
  return 'That code isn’t right — check it and try again, or request a new one.';
}

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

/** The shape we read off a Supabase AuthError without importing the class.
 *  `code` is present on AuthApiError (the HTTP-boundary errors we care about). */
type SupabaseAuthErrorLike = { message?: string; code?: string; status?: number } | null | undefined;

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

  if (error) return { success: false, error: friendlySendError(error) };
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

  if (error) return { success: false, error: friendlySendError(error) };
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

  if (error) return { success: false, error: friendlySendError(error) };
  return { success: true, codeSent: true };
}

/** Verify the emailed code. The email is supplied by the current sign-in
 *  flow (the address the user just typed), never from a URL/token. */
export async function verifyEmailOtp(email: string, code: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const token = code.replace(/\s+/g, '');
  if (!token) return { success: false, error: 'Enter the code from your email.' };
  // A malformed entry (letters, symbols, a pasted URL, a truncated paste) is
  // unambiguously a wrong code — say so without a round-trip. Only a
  // well-formed digit string is worth sending to Supabase, whose rejection
  // then genuinely means wrong-or-expired (see friendlyVerifyError).
  if (!/^\d{4,12}$/.test(token)) {
    return { success: false, error: 'That code should be digits only — check what you pasted from the email.' };
  }

  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error || !data.session) {
    return { success: false, error: friendlyVerifyError(error) };
  }
  return { success: true };
}

export async function signOutCurrentSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

/**
 * Map a `signInWithOtp` failure to user-safe copy. Branch on `error.code`
 * first (stable across Supabase message wording), message text only as a
 * fallback. Verified error shapes (prod, 2026-09):
 *   - cooldown : status 429, code 'over_email_send_rate_limit',
 *                "For security purposes, you can only request this after N seconds."
 *   - unknown email on /login (shouldCreateUser:false):
 *                status 422, code 'otp_disabled', "Signups not allowed for otp"
 */
function friendlySendError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('you can only request this') ||
    m.includes('rate limit')
  ) {
    return 'You’re requesting codes too quickly — wait a minute, then request another.';
  }
  // shouldCreateUser:false on /login for an address with no account
  if (
    code === 'otp_disabled' ||
    m.includes('signups not allowed') ||
    m.includes('not found')
  ) {
    return 'No account found for that email — create one to get started.';
  }
  if (code === 'validation_failed' || (m.includes('invalid') && m.includes('email'))) {
    return 'That email address doesn’t look valid.';
  }
  return 'Couldn’t send the code — check the address and try again.';
}

/**
 * Map a `verifyOtp` failure to user-safe copy.
 *
 * NOTE: Supabase returns the SAME error for a wrong code and an expired one —
 * status 403, code 'otp_expired', "Token has expired or is invalid" — on
 * purpose, so a caller can't use the response as a code-guessing oracle.
 * There is no server signal that separates the two, so one honest message
 * covers both and always names the recovery action. A genuinely malformed
 * entry is caught client-side in verifyEmailOtp before we ever get here.
 */
function friendlyVerifyError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('you can only request this') ||
    m.includes('rate limit')
  ) {
    return 'Too many attempts — wait a minute, then request a new code.';
  }
  if (code === 'otp_expired' || m.includes('expired') || m.includes('invalid')) {
    return 'That code didn’t work — it may be wrong or expired. Request a new one and try again.';
  }
  return 'That code didn’t work — request a new one and try again.';
}

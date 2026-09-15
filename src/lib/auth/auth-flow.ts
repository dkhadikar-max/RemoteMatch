'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Email + password auth. Supabase Auth remains the identity and session
 * system — this reinstates the password grant (removed by the Auth Flow
 * Change, docs/auth-flow-change-plan.md) as the ONLY login method, per
 * explicit product direction (2026-09-16): "login should only be email and
 * password, no otp."
 *
 * Scope of the reversal:
 *   - /login is password-only now — signInWithPassword(), no OTP anywhere
 *     in that path.
 *   - /signup still verifies the email address with an emailed CODE before
 *     the account is usable (an unverified inbox must never grant access) —
 *     but now ALSO collects a password at signup time, so the login step
 *     above has something to check. This reuses the exact, already-proven
 *     verifyEmailOtp()/VerifyCode UI unchanged: supabase.auth.signUp() with
 *     "Confirm email" enabled sends the SAME "Confirm signup" template
 *     (already delivers `{{ .Token }}`, a numeric code — see the Auth Flow
 *     Change work) as signInWithOtp() used to, so no email-template change
 *     was needed.
 *   - Existing accounts created before this change have NO password set
 *     (the prior flow was passwordless by design). They reach one through
 *     requestPasswordReset()/setNewPassword() — the standard Supabase
 *     recovery-link flow — surfaced as "Forgot password?" on /login.
 *
 * FLOWS:
 *
 *   1. startSignupWithPassword(name, email, password)  — /signup
 *        supabase.auth.signUp({ email, password,
 *                                options: { data: { full_name } } })
 *      No session yet — Supabase emails a code. The 014 trigger (fires
 *      generically on auth.users INSERT, not tied to any specific grant)
 *      copies full_name -> profiles.full_name exactly as before.
 *
 *   2. signInWithPassword(email, password)  — /login
 *        supabase.auth.signInWithPassword({ email, password })
 *      Establishes a session directly — no code screen.
 *
 *   3. verifyEmailOtp(email, code)  — the VerifyCode screen, /signup only now
 *        verifyOtp({ email, token: code, type: 'email' })
 *      Unchanged from the AFC implementation.
 *
 *   4. requestPasswordReset(email)  — /forgot-password
 *        resetPasswordForEmail(email, { redirectTo: `${origin}/auth/confirm` })
 *      Emails a recovery link. /auth/confirm recognizes type=recovery and
 *      routes to /reset-password instead of /feed.
 *
 *   5. setNewPassword(password)  — /reset-password, after the recovery link
 *      has already established a session via /auth/confirm
 *        supabase.auth.updateUser({ password })
 */

export interface AuthFlowResult {
  success: boolean;
  /** A code was emailed; no session exists yet (signup only). */
  codeSent?: boolean;
  /** A password-reset link was emailed. */
  resetEmailSent?: boolean;
  /** User-safe message — never the raw Supabase error text. */
  error?: string;
}

/** The shape we read off a Supabase AuthError without importing the class.
 *  `code` is present on AuthApiError (the HTTP-boundary errors we care about). */
type SupabaseAuthErrorLike = { message?: string; code?: string; status?: number } | null | undefined;

/** SIGN-UP — brand-new account, password set at creation time. Name carried
 *  in user metadata for the 014 trigger, exactly as before. */
export async function startSignupWithPassword(name: string, email: string, password: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const fullName = name.trim();
  if (!fullName) return { success: false, error: 'Please enter your name.' };

  const passwordError = validatePasswordStrength(password);
  if (passwordError) return { success: false, error: passwordError };

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName },
    },
  });

  if (error) return { success: false, error: friendlySignUpError(error) };
  return { success: true, codeSent: true };
}

/**
 * Re-send a fresh signup verification code from the VerifyCode screen.
 * shouldCreateUser:false — by the time this runs the account already
 * exists (signUp() created it). Unchanged from the AFC implementation.
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

/** Verify the emailed signup code. The email is supplied by the current
 *  signup flow (the address the user just typed), never from a URL/token.
 *  Unchanged from the AFC implementation. */
export async function verifyEmailOtp(email: string, code: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const token = code.replace(/\s+/g, '');
  if (!token) return { success: false, error: 'Enter the code from your email.' };
  if (!/^\d{4,12}$/.test(token)) {
    return { success: false, error: 'That code should be digits only — check what you pasted from the email.' };
  }

  const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error || !data.session) {
    return { success: false, error: friendlyVerifyError(error) };
  }
  return { success: true };
}

/** SIGN-IN — email + password, the only login method. */
export async function signInWithPassword(email: string, password: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    return { success: false, error: friendlySignInError(error) };
  }
  return { success: true };
}

/** Emails a password-recovery link for an existing account — the path for
 *  every pre-existing passwordless account to establish a password, and
 *  for anyone who forgets theirs. Always reports success even for an
 *  unknown email (Supabase itself does this — avoids confirming which
 *  addresses have accounts). */
export async function requestPasswordReset(email: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: origin ? `${origin}/auth/confirm` : undefined,
  });

  if (error) return { success: false, error: friendlySendError(error) };
  return { success: true, resetEmailSent: true };
}

/** Sets a new password for the CURRENT session — only meaningful right
 *  after a recovery link has established one via /auth/confirm. */
export async function setNewPassword(password: string): Promise<AuthFlowResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const passwordError = validatePasswordStrength(password);
  if (passwordError) return { success: false, error: passwordError };

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { success: false, error: friendlyUpdatePasswordError(error) };
  return { success: true };
}

export async function signOutCurrentSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  return null;
}

/** Map a `signInWithOtp` (resend-code only, now) failure to user-safe copy. */
function friendlySendError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('you can only request this') ||
    m.includes('rate limit')
  ) {
    return 'You’re requesting this too quickly — wait a minute, then try again.';
  }
  if (code === 'otp_disabled' || m.includes('signups not allowed') || m.includes('not found')) {
    return 'No account found for that email.';
  }
  if (code === 'validation_failed' || (m.includes('invalid') && m.includes('email'))) {
    return 'That email address doesn’t look valid.';
  }
  return 'Couldn’t send the email — check the address and try again.';
}

/** Map a `signUp` failure to user-safe copy. */
function friendlySignUpError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (code === 'user_already_exists' || m.includes('already registered') || m.includes('already exists')) {
    return 'An account already exists for that email — sign in instead.';
  }
  if (code === 'weak_password' || m.includes('password') && m.includes('weak')) {
    return 'Choose a stronger password (at least 8 characters).';
  }
  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('you can only request this') ||
    m.includes('rate limit')
  ) {
    return 'You’re requesting this too quickly — wait a minute, then try again.';
  }
  if (code === 'validation_failed' || (m.includes('invalid') && m.includes('email'))) {
    return 'That email address doesn’t look valid.';
  }
  return 'Couldn’t create your account — check the details and try again.';
}

/** Map a `signInWithPassword` failure to user-safe copy. Supabase returns
 *  the SAME error for a wrong password and a nonexistent email (by
 *  design, so a login form can't be used to enumerate accounts) — one
 *  honest message covers both and always names the recovery action. */
function friendlySignInError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    m.includes('you can only request this') ||
    m.includes('rate limit')
  ) {
    return 'Too many attempts — wait a minute, then try again.';
  }
  if (code === 'email_not_confirmed' || m.includes('not confirmed')) {
    return 'Please verify your email first — check your inbox for the code from signup.';
  }
  if (code === 'invalid_credentials' || m.includes('invalid login credentials')) {
    return 'Incorrect email or password. If you signed up before we added passwords, use "Forgot password?" below to set one.';
  }
  return 'Couldn’t sign in — check your email and password and try again.';
}

function friendlyUpdatePasswordError(error: SupabaseAuthErrorLike): string {
  const code = error?.code ?? '';
  const m = (error?.message ?? '').toLowerCase();

  if (code === 'weak_password' || (m.includes('password') && m.includes('weak'))) {
    return 'Choose a stronger password (at least 8 characters).';
  }
  if (code === 'same_password' || m.includes('same password')) {
    return 'That’s your current password — choose a different one.';
  }
  return 'Couldn’t update your password — the reset link may have expired. Request a new one and try again.';
}

/** Map a `verifyOtp` (signup code) failure to user-safe copy. Unchanged
 *  from the AFC implementation. */
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

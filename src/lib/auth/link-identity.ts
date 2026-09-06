'use client';

import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Two structurally separate flows — never share a code path, so the
 * security boundary between them is visible in the diff, not just in
 * prose:
 *
 *   1. LINKING (linkEmailWithPassword / linkEmailMagicLink) — only ever
 *      valid when the CURRENT session is anonymous. Calls
 *      supabase.auth.updateUser(), which mutates that exact session's
 *      auth.users row in place: same id, same profile, same plan_tier,
 *      same quotas, same decisions/applications. Nothing here can target
 *      a different user.
 *
 *   2. SIGN-IN (signInWithPassword / requestSignInMagicLink) — for a
 *      returning user on a fresh/anonymous session (new device, cleared
 *      cookies). Authenticates as whatever existing user the credential
 *      belongs to and REPLACES the current session. This never reads,
 *      writes, or reconciles anything belonging to the anonymous session
 *      it replaces — that anonymous auth.users row is simply abandoned,
 *      by design. There is no merge path anywhere in this module.
 *
 * Email uniqueness (so a linking attempt against an already-registered
 * address fails rather than silently attaching to someone else's account)
 * is enforced by Supabase's own auth.users.email constraint, not by any
 * check in this file — "fail safely, never silently merge" is therefore a
 * property of the platform, not application discipline alone.
 */

export interface LinkResult {
  success: boolean;
  /** True when Confirm Email is on and the user must click the emailed link. */
  needsConfirmation?: boolean;
  /** User-safe message — never the raw Supabase error text (avoids leaking
   *  whether a given email exists, which is itself part of failing safely). */
  error?: string;
}

const GENERIC_LINK_FAILURE =
  "Couldn't link that email. It may already be in use on another account, or something went wrong. Try a different email, or sign in instead if this is your account.";

function confirmRedirectUrl(): string {
  return `${window.location.origin}/auth/confirm`;
}

async function requireAnonymousSession(): Promise<
  | { supabase: NonNullable<ReturnType<typeof getSupabaseBrowserClient>>; error: undefined }
  | { supabase: null; error: string }
> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { supabase: null, error: 'Service not configured.' };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.is_anonymous !== true) {
    // Defensive only — the UI never offers linking except to an anonymous
    // session, so this should be unreachable in practice.
    return { supabase: null, error: 'Linking is only available for the current anonymous session.' };
  }
  return { supabase, error: undefined };
}

/** LINKING — email + password, attached to the current anonymous session. */
export async function linkEmailWithPassword(email: string, password: string): Promise<LinkResult> {
  const { supabase, error: guardError } = await requireAnonymousSession();
  if (!supabase) return { success: false, error: guardError };

  const { error } = await supabase.auth.updateUser(
    { email, password },
    { emailRedirectTo: confirmRedirectUrl() }
  );

  if (error) return { success: false, error: GENERIC_LINK_FAILURE };
  // With Confirm Email on, the update is pending until the emailed link is
  // clicked — the account is not yet linked at this point.
  return { success: true, needsConfirmation: true };
}

/** LINKING — email only (magic-link / passwordless), same session. */
export async function linkEmailMagicLink(email: string): Promise<LinkResult> {
  const { supabase, error: guardError } = await requireAnonymousSession();
  if (!supabase) return { success: false, error: guardError };

  const { error } = await supabase.auth.updateUser(
    { email },
    { emailRedirectTo: confirmRedirectUrl() }
  );

  if (error) return { success: false, error: GENERIC_LINK_FAILURE };
  return { success: true, needsConfirmation: true };
}

/** SIGN-IN — returning user, password. Replaces the current session. */
export async function signInWithPasswordCredential(email: string, password: string): Promise<LinkResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { success: false, error: 'Incorrect email or password.' };
  }
  return { success: true };
}

/** SIGN-IN — returning user, magic link. Emailed link replaces the session
 *  once clicked; nothing changes until then. */
export async function requestSignInMagicLink(email: string): Promise<LinkResult> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { success: false, error: 'Service not configured.' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: confirmRedirectUrl(), shouldCreateUser: false },
  });

  if (error) {
    // Anti-enumeration: same generic message whether or not the address
    // has an account — Supabase's own OTP endpoint is already designed
    // not to reveal this, and this message preserves that.
    return { success: false, error: "Couldn't send a sign-in link. Please check the address and try again." };
  }
  return { success: true, needsConfirmation: true };
}

export async function signOutCurrentSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

/** Whether the current session is a not-yet-linked anonymous user. */
export async function isCurrentSessionAnonymous(): Promise<boolean> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return false;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return Boolean(user?.is_anonymous);
}

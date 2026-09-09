import { NextRequest, NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * COMPATIBILITY / FALLBACK route.
 *
 * The AFC primary path is an emailed OTP CODE the user types in (see
 * src/lib/auth/auth-flow.ts — verifyEmailOtp), which never touches this route.
 * This route stays for: (a) previously-issued email links still in inboxes,
 * (b) any Supabase email template that also carries a link.
 *
 * SECURITY BOUNDARY (unchanged): it accepts ONLY Supabase-issued verification
 * material and turns it into a session via the Supabase SDK. It never treats an
 * email address or user id as proof of identity, never mints a session from an
 * arbitrary redirect parameter, and the post-auth destination is decided here
 * (by onboarding state), not by anything in the link.
 *
 * Two link shapes are handled — whichever a Supabase email template produces:
 *
 *   1. PREFERRED — custom template `{{ .SiteURL }}/auth/confirm?token_hash=..&type=..`
 *        -> supabase.auth.verifyOtp({ token_hash, type })
 *   2. PKCE flow — default `{{ .ConfirmationURL }}` template: GoTrue verifies,
 *      then redirects here with `?code=..`
 *        -> supabase.auth.exchangeCodeForSession(code)
 *
 * A bare `?token=..` (the implicit-flow variant) is deliberately NOT handled:
 * verifying a raw `token` requires passing the email alongside it, and this
 * route will not accept an email as identity. The fix for a project on that
 * template is to switch it to the `token_hash` form (see the AFC review
 * package / deploy checklist).
 */
export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/login?verified=error`);
  }

  let userId: string | null = null;

  if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error || !data.user) {
      return NextResponse.redirect(`${origin}/login?verified=error`);
    }
    userId = data.user.id;
  } else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user) {
      return NextResponse.redirect(`${origin}/login?verified=error`);
    }
    userId = data.user.id;
  } else {
    return NextResponse.redirect(`${origin}/login?verified=error`);
  }

  // Onboarding-state routing. A read failure here must not strand a
  // just-verified user — fall through to /onboarding, the safe default
  // (middleware would send them there anyway).
  let onboarded = false;
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('onboarding_completed_at')
      .eq('id', userId)
      .single();
    onboarded = Boolean(profile?.onboarding_completed_at);
  } catch {
    onboarded = false;
  }

  return NextResponse.redirect(
    `${origin}${onboarded ? '/feed?verified=success' : '/onboarding?verified=success'}`,
  );
}

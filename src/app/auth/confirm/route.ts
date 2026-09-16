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
 *
 * Password reset (2026-09-16 addition, corrected TWICE same day after two
 * rounds of live production testing): requestPasswordReset() sends a
 * recovery link through this exact route (redirectTo points here, with a
 * `?next=recovery` marker — see below). Once a session is established,
 * that link must NOT drop the user straight into /feed or /onboarding —
 * the whole point was to let them SET a password, which they haven't done
 * yet.
 *
 * FIRST live test found: checking Supabase's own `type=recovery` query
 * param alone is NOT reliable — fixed by having requestPasswordReset()
 * embed `?next=recovery` directly in `redirectTo` (Supabase preserves an
 * existing query string on `redirectTo` and appends its own params on
 * top). This IS still correct and kept, but a SECOND live test then found
 * it wasn't the actual root cause of the original bug report: the real
 * recovery redirect Supabase generates for this project uses the IMPLICIT
 * grant — tokens in the URL FRAGMENT (`#access_token=...&type=recovery`),
 * not a query string at all. A fragment is never sent to a server in the
 * HTTP request line — this route (and the `?next=recovery` marker) can
 * never see it, no matter what. THE ACTUAL FIX lives client-side:
 * src/components/auth/RecoveryRedirect.tsx, mounted globally in the root
 * layout, manually parses the fragment and redirects to /reset-password —
 * see that file's header for the full explanation (including why the
 * SDK's own `detectSessionInUrl` doesn't handle this automatically: this
 * project's client is hardcoded to `flowType: 'pkce'`, which doesn't
 * auto-parse the older implicit-flow fragment shape). `type === 'recovery'` is
 * kept as a secondary check (defense in depth for the token_hash shape,
 * and for any previously-issued link still in an inbox from before this
 * fix), never relied on alone any more.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  // `req.nextUrl.origin` reflects the address Railway's proxy forwards the
  // request to internally (confirmed in production to resolve to
  // http://localhost:8080), not the public domain — so it can never be used
  // directly for a redirect the user's own browser will follow. Prefer the
  // standard reverse-proxy forwarded headers, fall back to nextUrl.origin
  // for local dev (where there is no proxy and it's already correct), and
  // fall back to the real production domain as a last resort so this can
  // never emit a broken localhost redirect.
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const forwardedHost = req.headers.get('x-forwarded-host');
  const origin =
    (forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : null) ??
    req.nextUrl.origin ??
    'https://remotematch.online';
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');
  // Our own marker, set by requestPasswordReset() on the redirectTo URL —
  // see the header comment above for why this, not `type`, is the
  // primary recovery signal.
  const isRecoveryFlow = searchParams.get('next') === 'recovery';

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

  // Password-reset link: send them to set a password, not into the app.
  // Primary signal is OUR OWN `next=recovery` marker (reliable regardless
  // of link shape); `type === 'recovery'` is kept as a secondary check.
  if (isRecoveryFlow || type === 'recovery') {
    return NextResponse.redirect(`${origin}/reset-password`);
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

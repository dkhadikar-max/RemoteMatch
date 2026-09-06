import { NextRequest, NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createSupabaseServerClient } from '@/lib/supabase/server';

/**
 * Target of every emailed confirmation/magic-link URL this app sends
 * (linkEmailWithPassword, linkEmailMagicLink, requestSignInMagicLink all
 * pass this route as emailRedirectTo). Supabase's own email templates
 * build the link as `{{ .SiteURL }}/auth/confirm?token_hash=...&type=...`
 * — `type` is supplied by Supabase itself (differs between the linking
 * and sign-in flows), not assumed here.
 *
 * This route only ever calls verifyOtp on whatever token/type it's given;
 * it never accepts an identity from the request otherwise, so it cannot
 * be used to attach a token to a different session than the one the
 * click naturally carries cookies for.
 */
export async function GET(req: NextRequest) {
  const { searchParams, origin } = req.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;

  if (!tokenHash || !type) {
    return NextResponse.redirect(`${origin}/settings?linked=error`);
  }

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.redirect(`${origin}/settings?linked=error`);
  }

  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

  return NextResponse.redirect(`${origin}/settings?linked=${error ? 'error' : 'success'}&tab=settings`);
}

'use client';

import { useEffect } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * Mounted once, globally, in the root layout — catches Supabase's password-
 * recovery session no matter WHICH page it lands on.
 *
 * ROOT CAUSE (confirmed live, 2026-09-16): a real password-recovery link
 * silently logged the user into the app with no chance to set a password.
 * Two compounding facts, both confirmed directly against this project's
 * real config, not assumed:
 *
 *   1. The redirect Supabase's hosted /verify endpoint actually produces
 *      for a recovery link is the IMPLICIT grant shape — tokens in the URL
 *      FRAGMENT (`#access_token=...&type=recovery&...`), not a query
 *      string. A fragment is a browser-only construct; it is NEVER sent to
 *      a server in the HTTP request line, so no server-side route —
 *      including /auth/confirm's token_hash/code/`?next=recovery`
 *      handling — can ever see it, regardless of what marker is added to
 *      the redirect URL.
 *
 *   2. This project's Supabase client (createBrowserClient from
 *      @supabase/ssr, confirmed in node_modules/@supabase/ssr's own
 *      source) is hardcoded to `flowType: 'pkce'`. A PKCE-configured
 *      client's `detectSessionInUrl` looks for a PKCE `?code=` query
 *      param on init — it does NOT auto-parse the older implicit-flow
 *      `#access_token=` fragment shape at all. Confirmed directly: loading
 *      a real Supabase-issued recovery fragment URL against this app
 *      leaves `document.cookie` completely empty — no session is
 *      established by the SDK's own automatic detection.
 *
 * So neither the server (fact 1) nor the client SDK's automatic detection
 * (fact 2) will ever turn a real recovery fragment into a session on their
 * own. This component closes both gaps itself:
 *
 *   - Manually parses `window.location.hash` for `access_token` +
 *     `refresh_token` + `type=recovery`, and calls `setSession()`
 *     directly — this is the explicit equivalent of what automatic
 *     detection would have done for an implicit-flow client, done by hand
 *     because a PKCE-flow client won't do it itself.
 *   - ALSO listens for `onAuthStateChange`'s `PASSWORD_RECOVERY` event —
 *     Supabase's own documented signal for exactly this scenario, which
 *     DOES fire automatically if a `?code=` (PKCE) recovery link is ever
 *     what gets emailed instead (e.g. if the "Reset Password" template is
 *     later changed). Both mechanisms are kept because which exact shape
 *     Supabase's "Reset Password" email template produces in production
 *     is dashboard-configured and not independently verifiable here.
 *
 * Mounted at the root layout (not just /reset-password) because the
 * fragment can land on ANY page — the Site URL Supabase falls back to is
 * the bare origin, not a specific route, whenever `redirectTo` isn't
 * exactly what's configured in the project's Redirect URLs allowlist.
 */
export function RecoveryRedirect() {
  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    const goToResetPassword = () => {
      if (window.location.pathname !== '/reset-password') {
        window.location.replace('/reset-password');
      }
    };

    // Manual fragment handling — the gap `detectSessionInUrl` leaves open
    // for a PKCE-configured client encountering implicit-flow tokens.
    if (window.location.hash.includes('type=recovery')) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (accessToken && refreshToken) {
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(({ error }) => {
          if (!error) goToResetPassword();
        });
      }
    }

    // Auth-state-change listener — Supabase's own documented signal,
    // covers the PKCE (?code=) shape, which the SDK DOES auto-detect.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        goToResetPassword();
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return null;
}

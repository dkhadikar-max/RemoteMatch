import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20
);

let browserClient: ReturnType<typeof createBrowserClient> | null = null;

/**
 * Browser-side Supabase client. Persists the session as cookies (not
 * localStorage) so the same session is readable server-side by API routes
 * and middleware via src/lib/supabase/server.ts.
 *
 * No auto-provisioning lives here anymore — under the mandatory-verified-
 * account invariant, a visitor either has a real signed-in, verified
 * session or they don't; if they don't, middleware sends them to /login.
 * There is deliberately no code path anywhere that silently creates an
 * identity for them (that was signInAnonymously(), now removed).
 */
export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured) return null;
  if (!browserClient) {
    browserClient = createBrowserClient(supabaseUrl!, supabaseAnonKey!);
  }
  return browserClient;
}

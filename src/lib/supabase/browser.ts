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
 */
export function getSupabaseBrowserClient() {
  if (!isSupabaseConfigured) return null;
  if (!browserClient) {
    browserClient = createBrowserClient(supabaseUrl!, supabaseAnonKey!);
  }
  return browserClient;
}

let pendingSignIn: Promise<void> | null = null;

/**
 * Awaited by pages before their first call to a protected API route, so a
 * fetch fired in the same tick as <AuthBootstrap>'s effect (first-ever
 * visit, session not created yet) doesn't race a 401. A no-op once a
 * session already exists; de-duplicated so concurrent callers on the same
 * page share one sign-in attempt instead of racing Supabase's anonymous
 * sign-in endpoint against itself.
 */
export async function ensureAuthenticatedSession(): Promise<void> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return;

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) return;

  if (!pendingSignIn) {
    pendingSignIn = supabase.auth.signInAnonymously().then(({ error }) => {
      if (error) console.warn('RemoteMatch: anonymous sign-in failed', error.message);
    }).finally(() => {
      pendingSignIn = null;
    });
  }
  await pendingSignIn;
}

import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && supabaseUrl.startsWith('https://') && supabaseAnonKey.length > 20
);

/**
 * Request-scoped Supabase client for Route Handlers / Server Components.
 * Reads the caller's session from cookies set by the browser client + the
 * auth-refresh middleware — never from a client-supplied header or body.
 *
 * Returns null when Supabase isn't configured. Callers MUST treat that as a
 * hard failure for protected routes (503), never as "fall back to mock
 * state" — see src/lib/db/mock-seed.ts for why that fallback is exactly the
 * P0 defect this migration removes.
 */
export function createSupabaseServerClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;

  const cookieStore = cookies();

  return createServerClient(supabaseUrl!, supabaseAnonKey!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component render — the auth middleware is
          // responsible for refreshing the session cookie in that case.
        }
      },
    },
  });
}

let publicClient: SupabaseClient | null = null;

/**
 * Anon-key Supabase client with no cookie/session dependency at all.
 *
 * For fully public, session-independent reads — the sitemap being the
 * motivating case: it is the same for every visitor (RLS's `status =
 * 'active'` filter is the only access control it needs) and, as a Next.js
 * metadata route file, is called by Next's own machinery with no arguments
 * and no request object to hang a cookie store off of. createSupabaseServerClient()
 * calls next/headers' cookies(), which throws when invoked outside an actual
 * request scope (e.g. a standalone script calling `sitemap()` directly, as
 * the SEO audit suite does) — a real coupling problem, not just a test
 * inconvenience, since it means sitemap's only route to correctness was an
 * implicit, undocumented "cookies() usage forces dynamic rendering" side
 * effect rather than an explicit one. Use this instead anywhere the read
 * genuinely doesn't depend on who's asking, and pair it with the route's own
 * `export const dynamic = 'force-dynamic'` rather than relying on that
 * inference.
 */
export function createSupabasePublicClient(): SupabaseClient | null {
  if (!isSupabaseConfigured) return null;
  if (!publicClient) {
    publicClient = createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return publicClient;
}

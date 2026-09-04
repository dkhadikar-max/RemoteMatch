import { cookies } from 'next/headers';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

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

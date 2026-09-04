import { NextRequest } from 'next/server';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { createSupabaseServerClient, isSupabaseConfigured } from '@/lib/supabase/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export class UnauthenticatedError extends Error {
  constructor() {
    super('unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

export class ServiceUnavailableError extends Error {
  constructor() {
    super('service_unavailable');
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Resolves the caller's identity SERVER-SIDE from a verified Supabase
 * credential — never from a client-supplied userId/header/body field.
 *
 * Two credential sources are accepted, both independently verified by
 * Supabase's auth server rather than trusted as-is:
 *   1. The session cookie set by the browser client (normal web UI flow).
 *   2. An `Authorization: Bearer <access_token>` header (used by the HTTP
 *      integration test suite in test/security-remediation-suite.ts, and
 *      generally the correct path for any future non-browser client).
 *
 * `supabase.auth.getUser()`/`getUser(token)` (never `getSession()`) is used
 * deliberately: it re-validates the JWT against Supabase's auth server on
 * every call instead of trusting a locally-cached session payload.
 *
 * Throws ServiceUnavailableError when Supabase isn't configured, so callers
 * fail closed (503) instead of silently falling back to any local/mock
 * state for a protected mutation.
 */
export async function getAuthenticatedUser(
  req?: NextRequest
): Promise<{ user: User; supabase: SupabaseClient }> {
  if (!isSupabaseConfigured) {
    throw new ServiceUnavailableError();
  }

  const bearer = req?.headers.get('authorization');
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;

  if (token) {
    // A client bound to this specific caller's token, so `auth.uid()` inside
    // RLS policies and SECURITY DEFINER RPC functions resolves to them —
    // not to the anon role.
    const tokenClient = createClient(supabaseUrl!, supabaseAnonKey!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const {
      data: { user },
      error,
    } = await tokenClient.auth.getUser(token);
    if (error || !user) {
      throw new UnauthenticatedError();
    }
    return { user, supabase: tokenClient };
  }

  const supabase = createSupabaseServerClient();
  if (!supabase) {
    throw new ServiceUnavailableError();
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw new UnauthenticatedError();
  }

  return { user, supabase };
}

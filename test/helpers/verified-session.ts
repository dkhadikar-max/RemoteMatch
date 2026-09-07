/**
 * Shared test-user provisioning for the HTTP-boundary suites, built around
 * the mandatory-verified-account invariant (src/lib/auth/get-authenticated-user.ts:
 * isAccountVerified — real session, is_anonymous === false, email_confirmed_at
 * set). Anonymous Sign-Ins is now permanently disabled in production, so
 * there is no live anonymous session obtainable at all any more — a helper
 * that created one (newAnonymousSessionForRejectionTest) was removed for
 * that reason; see test/auth-invariant-suite.ts section 2 for how the
 * anonymous-rejection invariant is proven now instead (a synthetic
 * unit-level check against isAccountVerified() + authErrorResponse()).
 *
 * Verified users are created via the admin API with `email_confirm: true`
 * — this bypasses only the email click-through (no live inbox in this
 * environment), not the invariant itself: the resulting user is a genuine
 * non-anonymous, confirmed account, indistinguishable from a real one to
 * every check in the app.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function hasRequiredEnv(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SERVICE_ROLE_KEY);
}

export function uniqueEmail(): string {
  return `remotematch-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

export function anonKeyClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

export interface TestSession {
  client: SupabaseClient;
  userId: string;
  email: string;
  password: string;
  token: string;
}

/** A real account: created + email-confirmed via the admin API, then signed
 *  into normally. is_anonymous === false, email_confirmed_at is set. */
export async function newVerifiedSession(): Promise<TestSession> {
  const email = uniqueEmail();
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const admin = adminClient();

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    throw new Error(`Could not create verified test user: ${createError?.message}`);
  }

  const client = anonKeyClient();
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError || !signedIn.session) {
    throw new Error(`Could not sign in newly-created verified test user: ${signInError?.message}`);
  }

  return { client, userId: created.user.id, email, password, token: signedIn.session.access_token };
}

/**
 * There is deliberately NO helper here that produces "a valid access token
 * for an unconfirmed user" — verified empirically (see the account-linking
 * conversation history) that no such token is obtainable in practice:
 *   - signInWithPassword for an unconfirmed user is refused by Supabase
 *     itself (400 email_not_confirmed) — no session is ever issued.
 *   - email_confirmed_at is a claim baked into the JWT at issue time; even
 *     admin-revoking confirmation on an already-signed-in user does NOT
 *     change what an already-issued token reports via getUser(token).
 * So "unverified → rejected" is tested two ways instead, both honest about
 * what they actually prove:
 *   1. HTTP: confirm Supabase itself refuses to issue a session for an
 *      unconfirmed user at all (the real, live enforcement point).
 *   2. Unit: call isAccountVerified() directly with a synthetic user shape
 *      (is_anonymous: false, email_confirmed_at: undefined) to prove the
 *      app's own defense-in-depth check is correct in isolation, since no
 *      live end-to-end token can exercise it the way anonymous rejection
 *      can be exercised end-to-end.
 * See test/auth-invariant-suite.ts.
 */
export async function attemptSignInUnconfirmed(email: string, password: string) {
  const client = anonKeyClient();
  return client.auth.signInWithPassword({ email, password });
}

/** Creates a real, UNCONFIRMED user (no session obtainable for it — see
 *  above) so attemptSignInUnconfirmed() has a real account to try against. */
export async function createUnconfirmedUser(): Promise<{ email: string; password: string; userId: string }> {
  const email = uniqueEmail();
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: false });
  if (error || !data.user) {
    throw new Error(`Could not create unconfirmed test user: ${error?.message}`);
  }
  return { email, password, userId: data.user.id };
}

import { isAdminHost } from '@/lib/auth/admin-host';

/**
 * Whether the navbar should call `/api/profile` for the consumer entitlement pill.
 * Never on the admin host (the navbar is hidden there and `/api/profile` does not exist — it 404s), and otherwise only
 * when a session is possible on this page and an auth cookie is present.
 */
export function shouldFetchEntitlement(input: { host: string | null | undefined; sessionPossible: boolean; hasAuthCookie: boolean }): boolean {
  if (isAdminHost(input.host)) return false;
  return input.sessionPossible && input.hasAuthCookie;
}

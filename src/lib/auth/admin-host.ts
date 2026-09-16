/**
 * Shared host-detection primitive for the admin console
 * (admin.remotematch.online) — used by BOTH src/middleware.ts (route gating)
 * and src/app/layout.tsx (chrome selection) so the two can never drift out
 * of sync with each other.
 *
 * Production: any host starting with "admin." (admin.remotematch.online).
 * Local dev: ADMIN_HOST_OVERRIDE lets a developer test the admin surface
 * without real DNS — e.g. set it to "localhost:3000" and every request is
 * treated as the admin host, or leave it unset and use a hosts-file entry
 * (e.g. "admin.localhost:3000", which already starts with "admin." and
 * needs no override at all).
 */
export function isAdminHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const override = process.env.ADMIN_HOST_OVERRIDE;
  if (override && host === override) return true;
  return host.toLowerCase().startsWith('admin.');
}

/**
 * RemoteMatch — the public site origin, in one place
 * ==============================================================================
 * Every public, search-facing URL the app emits (canonical tags, og:url, JSON-LD, the sitemap, robots.txt and IndexNow
 * submissions) is built from this constant, so it always names the host that actually serves the app.
 *
 * It is a plain constant on purpose, not an environment variable: a `NEXT_PUBLIC_*` value is inlined at build time, so
 * changing it would need a Railway variable AND a redeploy, and a missing variable would silently fall back to a default.
 * Changing the canonical host is a one-line edit here.
 *
 * Operational hosts are deliberately NOT derived from this: the admin console (`admin.` prefix, see lib/auth/admin-host.ts)
 * and the e-mail sender address have their own configuration.
 */
export const SITE_URL = 'https://remotematch.online';

/** The host part of SITE_URL (`remotematch.online`) — IndexNow validates submitted URLs against it. */
export const SITE_HOST = new URL(SITE_URL).host;

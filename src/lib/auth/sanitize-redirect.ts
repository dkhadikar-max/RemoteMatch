/**
 * Guards against `/login?redirect=...` becoming an open redirect.
 * Middleware only ever writes its OWN request pathname into this param
 * (see src/middleware.ts's `loginUrl.searchParams.set('redirect', pathname)`)
 * — that's inherently safe, it can't contain an external URL. The risk is
 * a crafted link handed to a victim directly
 * (`/login?redirect=https://evil.example`), so the value must be treated
 * as untrusted input here regardless of what legitimately produces it.
 *
 * Only a same-origin, single-leading-slash relative path is accepted.
 * Everything else — an absolute URL, a protocol-relative URL (`//host`,
 * which browsers resolve exactly like `https://host`), a backslash variant
 * (`/\host`, which some browsers also normalize to protocol-relative), or
 * any scheme (`javascript:...`) — falls back to a fixed safe default.
 */
const SAFE_DEFAULT = '/feed';

export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (!value) return SAFE_DEFAULT;
  // Must start with exactly one '/' and the next character must not be
  // '/' or '\' (both are browser-normalized to protocol-relative, i.e.
  // effectively "https://").
  if (!/^\/(?!\/|\\)/.test(value)) return SAFE_DEFAULT;
  // Defense in depth: reject an embedded scheme anywhere before the first
  // '/', '?', or '#' — a leading-slash string can't normally contain one,
  // but this guards against any URL-parsing quirk that would otherwise
  // let something like "/\t/javascript:alert(1)" or similar slip through.
  const beforeQueryOrHash = value.split(/[?#]/)[0];
  if (/^[^/?#]*:/.test(beforeQueryOrHash.replace(/^\//, ''))) return SAFE_DEFAULT;
  return value;
}

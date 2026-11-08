// RFC 2606 / commonly-reserved non-public TLDs.
const NON_PUBLIC_TLDS = new Set(['local', 'localhost', 'internal', 'test', 'example', 'invalid']);
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Normalize an employer-supplied website into a bare lowercase host.
 * Returns null for malformed URLs, single-label hosts, IP literals, and
 * reserved non-public TLDs. This does not verify domain ownership.
 */
export function normalizeDomain(rawWebsite: string): string | null {
  let candidate = rawWebsite.trim();
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  if (IPV4_RE.test(host) || host.includes(':')) return null;

  const labels = host.split('.');
  if (labels.length < 2) return null;

  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,}$/.test(tld) || NON_PUBLIC_TLDS.has(tld)) return null;

  return host;
}

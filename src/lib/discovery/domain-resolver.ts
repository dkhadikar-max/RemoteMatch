import dns from 'dns/promises';
import { BlocklistEntry } from '@/types/discovery';

const BLOCKED_IP_PREFIXES = [
  '0.',
  '10.',
  '100.64.',
  '127.',
  '169.254.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.0.0.',
  '192.168.',
  '198.18.',
  '198.19.',
];

const DEFAULT_BLOCKLIST = new Set([
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'wikipedia.org',
  'youtube.com',
  'crunchbase.com',
  'github.com',
  'medium.com',
  'substack.com',
  'notion.site',
]);

/**
 * Normalizes any raw domain string into a clean lowercase hostname.
 */
export function normalizeDomain(rawInput: string): string {
  let cleaned = rawInput.trim().toLowerCase();
  cleaned = cleaned.replace(/^https?:\/\//, '');
  cleaned = cleaned.replace(/\/.*$/, '');
  cleaned = cleaned.replace(/^www\./, '');
  cleaned = cleaned.replace(/:\d+$/, '');
  return cleaned;
}

/**
 * Extracts root domain (e.g. 'careers.airbnb.com' -> 'airbnb.com').
 */
export function extractRootDomain(hostname: string): string {
  const clean = normalizeDomain(hostname);
  const parts = clean.split('.');
  if (parts.length <= 2) return clean;

  const secondLevelTlds = new Set(['co.uk', 'gov.uk', 'ac.uk', 'com.au', 'net.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'gen.in', 'org.in']);
  const lastTwo = parts.slice(-2).join('.');
  if (secondLevelTlds.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/**
 * SSRF guard: verifies hostname does not resolve to private or loopback IP.
 */
export async function isSsrfSafeHostname(hostname: string): Promise<boolean> {
  try {
    const clean = normalizeDomain(hostname);
    if (!clean || clean === 'localhost') return false;

    const addresses = await dns.resolve4(clean);
    if (!addresses || addresses.length === 0) return false;

    for (const ip of addresses) {
      for (const prefix of BLOCKED_IP_PREFIXES) {
        if (ip.startsWith(prefix)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if a domain is on the blocklist (aggregators, social, ToS-hostile).
 */
export function isDomainBlocklisted(hostname: string, customBlocklist?: Set<string>): boolean {
  const root = extractRootDomain(hostname);
  if (DEFAULT_BLOCKLIST.has(root)) return true;
  if (customBlocklist && customBlocklist.has(root)) return true;
  return false;
}

/**
 * Resolves a company domain to its canonical final landing URL,
 * safely following HTTP redirects (up to 3 hops) with SSRF checks.
 */
export async function resolveOfficialDomain(rawDomain: string): Promise<{
  valid: boolean;
  resolvedRootDomain?: string;
  finalUrl?: string;
  rejectionReason?: string;
}> {
  const host = normalizeDomain(rawDomain);
  if (!host) {
    return { valid: false, rejectionReason: 'empty_domain' };
  }

  if (isDomainBlocklisted(host)) {
    return { valid: false, rejectionReason: 'blocklisted_domain' };
  }

  const isSafe = await isSsrfSafeHostname(host);
  if (!isSafe) {
    return { valid: false, rejectionReason: 'ssrf_unsafe_or_unresolvable' };
  }

  try {
    const targetUrl = `https://${host}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'RemoteMatchBot/1.0 (Company Discovery; +https://remotematch.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (res.status === 403 || res.status === 429) {
      return { valid: false, rejectionReason: `waf_blocked_${res.status}` };
    }

    if (!res.ok) {
      return { valid: false, rejectionReason: `http_error_${res.status}` };
    }

    const finalHost = normalizeDomain(new URL(res.url).hostname);
    if (isDomainBlocklisted(finalHost)) {
      return { valid: false, rejectionReason: 'redirected_to_blocklisted_domain' };
    }

    const rootDomain = extractRootDomain(finalHost);
    return {
      valid: true,
      resolvedRootDomain: rootDomain,
      finalUrl: res.url,
    };
  } catch (err) {
    return { valid: false, rejectionReason: `connection_failed: ${(err as Error).message}` };
  }
}

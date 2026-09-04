/**
 * RemoteMatch — IndexNow Notification Module
 * Reference: https://www.bing.com/indexnow
 *
 * IndexNow is a fast change-notification layer informing Bing, Yandex, and other
 * participating search engines when URLs are published, updated, or expired.
 * Note: IndexNow is a notification protocol, not a guarantee of indexing.
 */

import { timingSafeEqual } from 'crypto';

export const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'remotematch-key-849b8502';
export const INDEXNOW_KEY_LOCATION = 'https://remotematch.com/remotematch-indexnow-key.txt';
export const INDEXNOW_HOST = 'remotematch.com';

const PRIVATE_PATH_PREFIXES = [
  '/feed',
  '/tracker',
  '/settings',
  '/onboarding',
  '/match',
  '/staging',
  '/api',
];

/**
 * Validates whether a URL is safe and eligible for public search engine notification.
 * Strictly prevents submitting private application state or internal endpoints.
 */
export function isPublicIndexableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== INDEXNOW_HOST && parsed.hostname !== 'localhost') {
      return false;
    }
    const path = parsed.pathname.toLowerCase();
    for (const prefix of PRIVATE_PATH_PREFIXES) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        return false;
      }
    }
    // Must be a known public route pattern
    return (
      path === '/' ||
      path === '/remote-jobs' ||
      path.startsWith('/remote-jobs/') ||
      path === '/guide' ||
      path.startsWith('/guide/')
    );
  } catch {
    return false;
  }
}

/**
 * Submits URL list to IndexNow API.
 */
export async function submitToIndexNow(urls: string[]): Promise<{
  success: boolean;
  submittedUrls: string[];
  rejectedUrls: string[];
  message: string;
}> {
  const validUrls: string[] = [];
  const rejectedUrls: string[] = [];

  for (const u of urls) {
    if (isPublicIndexableUrl(u)) {
      validUrls.push(u);
    } else {
      rejectedUrls.push(u);
    }
  }

  if (validUrls.length === 0) {
    return {
      success: false,
      submittedUrls: [],
      rejectedUrls,
      message: 'No eligible public URLs to submit.',
    };
  }

  const payload = {
    host: INDEXNOW_HOST,
    key: INDEXNOW_KEY,
    keyLocation: INDEXNOW_KEY_LOCATION,
    urlList: validUrls,
  };

  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    return {
      success: res.ok || res.status === 200 || res.status === 202,
      submittedUrls: validUrls,
      rejectedUrls,
      message: `Submitted ${validUrls.length} URLs to IndexNow (Status: ${res.status}).`,
    };
  } catch (err: any) {
    return {
      success: false,
      submittedUrls: validUrls,
      rejectedUrls,
      message: `IndexNow submission dispatch recorded (network simulated or deferred): ${err.message}`,
    };
  }
}

/**
 * Internal notification helpers for job lifecycle changes.
 * These are called by the ingestion and publishing pipeline.
 */
export async function notifyJobPublished(jobId: string) {
  const urls = [
    `https://${INDEXNOW_HOST}/remote-jobs/view/${jobId}`,
    `https://${INDEXNOW_HOST}/remote-jobs`,
  ];
  return submitToIndexNow(urls);
}

export async function notifyJobUpdated(jobId: string) {
  const urls = [
    `https://${INDEXNOW_HOST}/remote-jobs/view/${jobId}`,
  ];
  return submitToIndexNow(urls);
}

export async function notifyJobExpired(jobId: string) {
  const urls = [
    `https://${INDEXNOW_HOST}/remote-jobs/view/${jobId}`,
    `https://${INDEXNOW_HOST}/remote-jobs`,
  ];
  return submitToIndexNow(urls);
}

/**
 * Authenticates internal callers for protected management endpoints.
 *
 * Fails closed: if INDEXNOW_SECRET is not set, every call is rejected
 * rather than falling back to a value committed to source (which was the
 * prior behavior — anyone with repo access could read it and call the
 * endpoint in any deployment that forgot to set the env var). This is
 * distinct from INDEXNOW_KEY above, which is meant to be public per the
 * IndexNow protocol (published at a well-known URL to prove domain
 * ownership) and is not a credential.
 */
export function verifyInternalSecret(authHeader: string | null): boolean {
  const secret = process.env.INDEXNOW_SECRET;
  if (!secret || !authHeader) return false;

  const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Constant-time comparison to avoid leaking the secret's length/prefix via
  // response-timing; falls back to a strict equality check only if the
  // lengths already differ (timingSafeEqual requires equal-length buffers).
  const secretBuf = Buffer.from(secret);
  const candidateBuf = Buffer.from(candidate);
  if (secretBuf.length !== candidateBuf.length) return false;

  return timingSafeEqual(secretBuf, candidateBuf);
}

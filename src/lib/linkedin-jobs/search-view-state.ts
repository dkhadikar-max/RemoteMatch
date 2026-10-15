/**
 * LinkedIn Job Finder — what the search tab should SHOW, decided from the
 * search API's response. Pure (no React, no network) so every state is
 * unit-testable; mirrors src/lib/feed/empty-state.ts's approach.
 *
 * Why this exists: after PR #16 the route reports an explicit `status`
 * ('ok' | 'vendor_not_configured' | 'vendor_failed'), but the page only
 * looked at `vendorConfigured`, so a failed vendor call (status
 * 'vendor_failed') rendered as an empty list with no explanation — which
 * reads as "no jobs match", the opposite of the truth.
 *
 * Rules:
 *  - A failure NEVER implies there are no matching jobs.
 *  - A temporary vendor failure ('vendor_failed') is distinguishable from
 *    "automated search isn't set up" ('vendor_not_configured'); only the
 *    former offers a retry (retrying the latter cannot help).
 *  - A successful search that found nothing ('empty') is a legitimate
 *    result, worded as one, with no retry.
 *  - We only tell the user a failed attempt didn't use a daily search when
 *    the API said it refunded it (`quotaRefunded === true`).
 */

export type SearchViewKind =
  | 'results'
  | 'empty'
  | 'not_configured'
  | 'vendor_failed'
  | 'request_failed'
  | 'limit_reached';

export interface SearchViewState {
  kind: SearchViewKind;
  /** Extra line about the daily allowance; null when we can't truthfully say anything. */
  quotaNote: string | null;
}

export interface SearchNoticeCopy {
  title: string;
  body: string;
  /** Whether the notice offers a "Try again" action. */
  canRetry: boolean;
  /** Failures are announced assertively; others politely. */
  isError: boolean;
}

/** Copy for every kind that renders a notice ('results' renders the list; 'limit_reached' opens the upgrade modal). */
export const SEARCH_NOTICE_COPY: Record<Exclude<SearchViewKind, 'results' | 'limit_reached'>, SearchNoticeCopy> = {
  empty: {
    title: 'No LinkedIn jobs matched this search',
    body: 'The search ran, but no postings with a LinkedIn listing matched. Try broader keywords or fewer filters.',
    canRetry: false,
    isError: false,
  },
  not_configured: {
    title: "Automated search isn't connected yet",
    body: 'Use "Paste a job" in the meantime.',
    canRetry: false,
    isError: false,
  },
  vendor_failed: {
    title: 'Search is temporarily unavailable',
    body: "We couldn't reach the job search service just now. This doesn't mean there are no matching jobs — please try again in a moment.",
    canRetry: true,
    isError: true,
  },
  request_failed: {
    title: 'Something went wrong',
    body: "Your search couldn't be completed. This doesn't mean there are no matching jobs — please try again.",
    canRetry: true,
    isError: true,
  },
};

export const QUOTA_REFUNDED_NOTE = "This attempt didn't use any of your daily searches.";

function quotaNoteFor(data: { quotaRefunded?: unknown } | null): string | null {
  return data && data.quotaRefunded === true ? QUOTA_REFUNDED_NOTE : null;
}

/** For a fetch that threw before any response arrived (offline, DNS, aborted). */
export function networkFailureState(): SearchViewState {
  return { kind: 'request_failed', quotaNote: null };
}

/**
 * @param ok         the HTTP response's `ok`
 * @param httpStatus the HTTP status code
 * @param data       the parsed JSON body (or null/undefined if it didn't parse)
 */
export function interpretSearchResponse(ok: boolean, httpStatus: number, data: unknown): SearchViewState {
  const d = (data && typeof data === 'object' ? data : null) as
    | { status?: unknown; results?: unknown; upgradeRequired?: unknown; quotaRefunded?: unknown }
    | null;

  // The Free daily limit: the page opens the upgrade modal instead of a notice.
  if (!ok && httpStatus === 403 && d?.upgradeRequired === true) {
    return { kind: 'limit_reached', quotaNote: null };
  }

  // Any other non-2xx (e.g. the route's 500): the request failed, say so.
  if (!ok || !d) {
    return { kind: 'request_failed', quotaNote: quotaNoteFor(d) };
  }

  if (d.status === 'vendor_not_configured') return { kind: 'not_configured', quotaNote: null };
  if (d.status === 'vendor_failed') return { kind: 'vendor_failed', quotaNote: quotaNoteFor(d) };

  if (d.status === 'ok' && Array.isArray(d.results)) {
    // A delivered search with nothing to show is a legitimate empty result.
    return { kind: d.results.length > 0 ? 'results' : 'empty', quotaNote: null };
  }

  // 200 but a shape we don't recognise: never present it as "no jobs".
  return { kind: 'request_failed', quotaNote: null };
}

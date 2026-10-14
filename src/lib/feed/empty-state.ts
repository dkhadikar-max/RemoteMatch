/**
 * What the feed should say when there is no card to show — pure, tested.
 * ==============================================================================
 * Until now every empty deck read "Queue Cleared — All opportunities matching your criteria have been evaluated",
 * even when (a) the jobs failed to LOAD (network/503 was swallowed), or (b) there was simply no fresh supply (the feed
 * only shows jobs posted within the last 48 h, so with ingestion paused it runs dry) — i.e. it told users they had
 * finished when they had not. Audit U-P0-1 / U-P1-1 (docs/audit-2026-10-13-ui-ux.md).
 *
 * Rule: "reviewed everything" may be said ONLY when the server really returned jobs and the user has already acted on
 * every one of them. Every other empty situation gets its own, truthful message.
 */
export type FeedEmptyKind = 'load_failed' | 'no_supply' | 'all_reviewed' | 'filters_exclude_all';

export interface FeedEmptyInput {
  /** The jobs request failed (network error, non-2xx, unparseable body). */
  loadFailed: boolean;
  /** How many jobs the server returned (before removing ones the user already swiped). */
  serverCount: number;
  /** …after removing ones the user already swiped. */
  unswipedCount: number;
  /** …after the user's active filters. */
  filteredCount: number;
  hasActiveFilters: boolean;
}

/** null = there is something to show (render the deck). */
export function feedEmptyKind(i: FeedEmptyInput): FeedEmptyKind | null {
  if (i.loadFailed) return 'load_failed';
  if (i.serverCount === 0) return 'no_supply';
  if (i.unswipedCount === 0) return 'all_reviewed';
  if (i.filteredCount === 0 && i.hasActiveFilters) return 'filters_exclude_all';
  return null;
}

export const FEED_EMPTY_COPY: Record<FeedEmptyKind, { title: string; body: string }> = {
  load_failed: {
    title: "We couldn't load jobs",
    body: "Check your connection and try again. Your saved jobs and applications aren't affected.",
  },
  no_supply: {
    title: 'No new jobs right now',
    body: "We don't have any new jobs to show at the moment. New remote jobs are added regularly — check back soon.",
  },
  all_reviewed: {
    title: "You've gone through every job we have right now",
    body: 'New jobs appear as employers post them. In the meantime you can look back at the jobs you saved.',
  },
  filters_exclude_all: {
    title: 'No jobs match these filters',
    body: 'Try removing a filter to see more jobs.',
  },
};

/**
 * Interprets the `POST /api/opportunities/feed` response. ANYTHING other than an HTTP-ok body with `success: true` and
 * an `opportunities` array is a failed load — never an empty-but-fine catalog.
 */
export function interpretFeedResponse(ok: boolean, data: unknown): { failed: boolean; returned: number } {
  const d = data as { success?: unknown; opportunities?: unknown } | null | undefined;
  if (ok && d && d.success === true && Array.isArray(d.opportunities)) return { failed: false, returned: d.opportunities.length };
  return { failed: true, returned: 0 };
}

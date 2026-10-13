/**
 * Shared, cached read of the feed's catalog.
 * ==============================================================================
 * GET/POST /api/opportunities/feed used to read every row in the 48-hour window
 * (all columns, descriptions included) from Supabase on EVERY request, per user.
 * The scoring engine reads `description`, so the columns cannot be trimmed here —
 * but the catalog itself is identical for every caller (RLS limits it to active
 * rows; scoring, swipe-exclusion and personalization happen afterwards, in memory,
 * per user), so it is read once and shared.
 *
 * FRESHNESS STAYS EXACT. The route promises that a listing stops appearing 48
 * hours after it was posted, with no background job. A cache could break that by
 * up to its TTL, so the 48-hour window is applied to the cached rows IN MEMORY on
 * every request (passesFreshnessGate — the same predicate as the database bounds:
 * posted_at ≤ now, and now − posted_at ≤ 48 h, NULL rejected). The database read
 * only has to contain "everything that can possibly still be fresh".
 *
 * NEW LISTINGS stay prompt: the sync routes call invalidateCatalogCaches() when a
 * sync has written rows, so the next feed request re-reads. The TTL below only
 * covers the gap BETWEEN syncs and a failed-sync fallback.
 *
 * The cached array and its objects are SHARED between users. Nothing downstream
 * mutates them (scoring spreads into new objects and sorts its own copy); that is
 * pinned by test/resume-feed-egress-suite.ts, which runs the whole feed pipeline on
 * deeply frozen input.
 */
import type { CanonicalOpportunity } from '@/types/byn';
import { getActiveOpportunities } from '@/lib/ingestion/catalog-read';
import { passesFreshnessGate } from '@/lib/ingestion/freshness-gate';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { createAsyncTtlCache, type TtlCache } from '@/lib/seo/ttl-cache';
import { getOrCreateCatalogCache, catalogTtlMs } from '@/lib/ingestion/catalog-caches';

export const FEED_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const FEED_CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1000;

const cache: TtlCache<CanonicalOpportunity[]> = getOrCreateCatalogCache('feed-catalog', () =>
  createAsyncTtlCache<CanonicalOpportunity[]>(
    async () => {
      const supabase = createSupabasePublicClient();
      if (!supabase) throw new Error('Supabase is not configured');
      // The same read the route has always done: 48h window (as of NOW) + the multilingual gate.
      return getActiveOpportunities(supabase, { freshOnly: true, translationSafe: true });
    },
    {
      ttlMs: catalogTtlMs(FEED_CATALOG_TTL_MS),
      maxStaleMs: FEED_CATALOG_MAX_STALE_MS,
      onStaleServed: (err) =>
        console.warn('[feed] catalog refresh failed; serving the last good copy:', err instanceof Error ? err.message : err),
    }
  )
);

/** Pure: keeps only listings that are fresh AT `now`. Exported for tests. */
export function applyFreshnessWindow(opportunities: CanonicalOpportunity[], now: number = Date.now()): CanonicalOpportunity[] {
  return opportunities.filter((o) => passesFreshnessGate(o.postedAt, now));
}

/**
 * The feed's catalog: fresh as of NOW, translation-safe, shared across callers.
 * Returns null when Supabase is not configured (the route answers 503, as before).
 * The returned array is a new array per call; its objects are shared — read-only.
 */
export async function getFeedCatalog(now: number = Date.now()): Promise<CanonicalOpportunity[] | null> {
  if (!createSupabasePublicClient()) return null;
  return applyFreshnessWindow(await cache.get(), now);
}

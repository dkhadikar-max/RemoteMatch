import type { MetadataRoute } from 'next';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { getSitemapJobEntries, type SitemapJobEntry } from '@/lib/ingestion/catalog-read';
import { buildSitemap } from '@/lib/seo/sitemap-build';
import { createAsyncTtlCache } from '@/lib/seo/ttl-cache';
import { getOrCreateCatalogCache, catalogTtlMs } from '@/lib/ingestion/catalog-caches';

// Sitemap content is identical for every visitor (RLS's active-only filter
// is the only access control it needs) and must reflect the live catalog,
// not a build-time snapshot — force-dynamic makes that explicit rather than
// leaning on cookies() usage to infer it (see createSupabasePublicClient()'s
// doc comment for why this route uses that client instead of the
// cookie-bound one).
export const dynamic = 'force-dynamic';

// Supabase egress: this route used to read the WHOLE catalog (every column,
// descriptions included — ~70 MB uncompressed at ~23k rows) on every request,
// and crawlers request it constantly. It now (a) reads only the four columns
// it uses (getSitemapJobEntries) and (b) reuses that result in-process for
// SITEMAP_TTL_MS. Catalog ingestion runs on a ~6h cadence, so a 6h-old URL
// list is not materially staler than the source; if a refresh fails the last
// good list keeps being served for up to SITEMAP_MAX_STALE_MS rather than
// handing crawlers a 500 or a truncated list.
const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;
const SITEMAP_MAX_STALE_MS = 24 * 60 * 60 * 1000;

// Process-wide (see catalog-caches.ts): one instance however Next bundles the routes, and
// dropped by the sync route when ingestion has written new rows.
const jobEntries = getOrCreateCatalogCache('sitemap-entries', () => createAsyncTtlCache<SitemapJobEntry[]>(
  async () => {
    const supabase = createSupabasePublicClient();
    // Throw (rather than return []) so a missing client is never cached as
    // "the sitemap has no jobs"; the caller below maps it to an empty list.
    if (!supabase) throw new Error('Supabase is not configured');
    return getSitemapJobEntries(supabase);
  },
  {
    ttlMs: catalogTtlMs(SITEMAP_TTL_MS),
    maxStaleMs: SITEMAP_MAX_STALE_MS,
    onStaleServed: (err) =>
      console.warn('[sitemap] refresh failed; serving the last good job list:', err instanceof Error ? err.message : err),
  }
));

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://remotematch.com';
  let activeJobs: SitemapJobEntry[] = [];
  if (createSupabasePublicClient()) {
    activeJobs = await jobEntries.get();
  }
  return buildSitemap(baseUrl, activeJobs);
}

/**
 * Paginated reads for the public directory (/remote-jobs) and the category
 * hubs (/remote-jobs/[slug]).
 * ==============================================================================
 * These pages used to read the WHOLE catalog (every column, descriptions
 * included — ~21 MB over the wire / ~70 MB uncompressed at ~23k rows) on every
 * request, then render every listing and a JSON-LD posting for each. At the
 * free-tier egress budget (5 GB/month ≈ 240 such reads) a handful of crawler
 * visits a day was enough to exhaust it.
 *
 * Now a page view costs one SMALL read:
 *
 *   index   a slim catalog index (7 narrow columns, no descriptions) shared by
 *           every page, kept behind a 6 h TTL cache with single-flight refresh
 *           and stale-if-error. Category MEMBERSHIP is decided in memory from it
 *           with the same predicate the old path used (matchesCategory()).
 *   slice   only the DIRECTORY_PAGE_SIZE rows on the requested page are fetched
 *           in full (by source_id), and recent slices are cached (LRU + TTL).
 *   search  a `?q=` query is answered by the DATABASE (ilike on title, company,
 *           description, remote type, plus skill tags) with LIMIT/OFFSET and an
 *           exact count — never by loading the catalog.
 *
 * Behavior differences from the old whole-catalog path (deliberate, tested):
 *   - listings are ordered newest first (the old order was unspecified);
 *   - results are paginated (24 per page);
 *   - search matches a skill tag only as a whole tag (case variants tried), not
 *     as an arbitrary substring of the joined tag list; title/company/description
 *     and remote type still match as substrings, and every term must match.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalOpportunity } from '@/types/byn';
import {
  getCatalogIndexEntries,
  getOpportunitiesBySourceIds,
  searchActiveOpportunitiesPage,
  SearchTimeoutError,
  type CatalogIndexEntry,
} from '../ingestion/catalog-read';
import { SEO_CATEGORIES, matchesCategory, type SeoCategory } from './data';
import { createSupabasePublicClient } from '@/lib/supabase/server';
import { createAsyncTtlCache, createLruTtlMap, type LruTtlMap, type TtlCache } from './ttl-cache';
import { getOrCreateCatalogCache, invalidateCatalogCaches, catalogTtlMs } from '../ingestion/catalog-caches';

export const DIRECTORY_PAGE_SIZE = 24;
/** Hard ceiling on the page number — the key space of a cache must not be
 *  user-controlled without bound. */
export const MAX_DIRECTORY_PAGE = 5000;

export const CATALOG_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
export const CATALOG_INDEX_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const PAGE_SLICE_TTL_MS = 30 * 60 * 1000;
export const PAGE_SLICE_MAX_ENTRIES = 300;

export interface DirectoryPage {
  jobs: CanonicalOpportunity[];
  /** Listings matching the category / search, across all pages. */
  total: number;
  /** The page actually served (1-based). */
  page: number;
  totalPages: number;
  pageSize: number;
  /** The requested page is beyond the last page of a non-empty result. */
  outOfRange: boolean;
  /** True only when the search could not complete (DB statement timeout) — jobs/total are
   *  empty/zero but this is NOT a genuine "no results" answer. Never set on the hub/browse path. */
  searchTimedOut?: boolean;
}

/** `?page=` → a safe positive integer (default 1). */
export function parsePageParam(raw: unknown): number {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof s === 'string' && /^\d{1,6}$/.test(s) ? parseInt(s, 10) : 1;
  return Math.min(Math.max(n, 1), MAX_DIRECTORY_PAGE);
}

// ---- search terms ---------------------------------------------------------------

// Lowered from 6: each term adds a fully-ANDed, unindexed ILIKE OR-clause (see
// searchActiveOpportunitiesPage's header) — fewer terms bounds the worst-case query cost.
// 5 (not 4) so a realistic technical-skills search ("c++ c# .net ci/cd node.js") still survives
// in full — dropping a term a visitor actually typed would be its own user-facing regression.
const MAX_TERMS = 5;
const MAX_TERM_LENGTH = 40;

/** Free text → safe, lowercase search terms. Anything outside [a-z0-9+#./-] is
 *  dropped: those are the characters real skills/titles use ("c++", "c#",
 *  ".net", "ci/cd"), and excluding the rest (`,()"*%_\` and whitespace) is what
 *  makes the terms safe to embed in a PostgREST filter and in an ILIKE pattern. */
export function buildSearchTerms(q: string | undefined | null): string[] {
  if (!q) return [];
  const terms: string[] = [];
  for (const raw of q.toLowerCase().trim().split(/\s+/)) {
    const t = raw.replace(/[^a-z0-9+#./-]/g, '').slice(0, MAX_TERM_LENGTH);
    if (t) terms.push(t);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

// ---- dependencies (injectable for tests) ------------------------------------------

export interface DirectoryDeps {
  getIndex(): Promise<CatalogIndexEntry[]>;
  getRows(ids: string[]): Promise<CanonicalOpportunity[]>;
  sliceCache: LruTtlMap<CanonicalOpportunity[]>;
}

const membershipCache = new WeakMap<CatalogIndexEntry[], Map<string, string[]>>();

/** Source ids of the listings on a hub, newest first. Memoized per index
 *  snapshot (a new snapshot = a new array identity), so filtering ~23k entries
 *  happens once per category per refresh, not once per request. */
function membersOf(index: CatalogIndexEntry[], cat: SeoCategory | null): string[] {
  const slug = cat?.slug ?? '*';
  let perIndex = membershipCache.get(index);
  if (!perIndex) {
    perIndex = new Map();
    membershipCache.set(index, perIndex);
  }
  let ids = perIndex.get(slug);
  if (!ids) {
    ids = (cat ? index.filter((e) => matchesCategory(cat, e)) : index).map((e) => e.sourceId);
    perIndex.set(slug, ids);
  }
  return ids;
}

/** One page of a category hub (`cat`) or of the whole directory (`cat` = null). */
export async function getHubPage(deps: DirectoryDeps, cat: SeoCategory | null, requestedPage: number): Promise<DirectoryPage> {
  const index = await deps.getIndex();
  const ids = membersOf(index, cat);
  const total = ids.length;
  const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
  const outOfRange = total > 0 && requestedPage > totalPages;
  const page = Math.min(Math.max(requestedPage, 1), totalPages);

  const key = `${cat?.slug ?? '*'}:${page}`;
  let jobs = deps.sliceCache.get(key);
  if (!jobs) {
    const slice = ids.slice((page - 1) * DIRECTORY_PAGE_SIZE, page * DIRECTORY_PAGE_SIZE);
    jobs = await deps.getRows(slice);
    // Only cache a slice that resolved in full; a partial result (rows expired
    // since the index was built) would otherwise stick for the whole TTL.
    if (jobs.length === slice.length) deps.sliceCache.set(key, jobs);
  }
  return { jobs, total, page, totalPages, pageSize: DIRECTORY_PAGE_SIZE, outOfRange };
}

/** One page of search results, answered by the database (never the catalog). */
export async function getSearchPage(supabase: SupabaseClient, q: string, requestedPage: number): Promise<DirectoryPage> {
  logSearchPageEntry(requestedPage, Boolean(q)); // TEMPORARY diagnostic — see logSearchPageEntry; remove after the Railway capture question is resolved
  const terms = buildSearchTerms(q);
  const from = (Math.max(requestedPage, 1) - 1) * DIRECTORY_PAGE_SIZE;
  try {
    const { rows, total } = await searchActiveOpportunitiesPage(supabase, terms, { from, to: from + DIRECTORY_PAGE_SIZE - 1 });
    const totalPages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));
    const outOfRange = total > 0 && requestedPage > totalPages;
    return { jobs: rows, total, page: Math.min(Math.max(requestedPage, 1), totalPages), totalPages, pageSize: DIRECTORY_PAGE_SIZE, outOfRange };
  } catch (err) {
    if (err instanceof SearchTimeoutError) {
      logSearchTimeout(terms.length, requestedPage);
      return { jobs: [], total: 0, page: 1, totalPages: 1, pageSize: DIRECTORY_PAGE_SIZE, outOfRange: false, searchTimedOut: true };
    }
    throw err; // a genuine, unexpected error still propagates — never silently hidden
  }
}

/** TEMPORARY diagnostic, unconditional on every call (not just timeouts) — isolates whether
 *  request-level console output from this exact code path reaches Railway's log stream at all,
 *  before trusting the absence of the `search_timeout` event below as meaningful. No search
 *  terms or request/user identifiers — only requestedPage and whether a query string was
 *  supplied. Remove once the Railway capture question is resolved; never allowed to affect the
 *  response, same discipline as logSearchTimeout. */
function logSearchPageEntry(requestedPage: number, hasQuery: boolean): void {
  try {
    console.log(JSON.stringify({ event: 'search_page_entry', at: new Date().toISOString(), requestedPage, hasQuery }));
  } catch {
    // logging is best-effort only
  }
}

/** Fires once per caught timeout, after the fix in fix/remote-jobs-search-timeout
 *  stopped it from throwing an uncaught error (and with it, the only log line that
 *  previously made a timeout visible in Railway's logs). Stable `event` name so a
 *  log search can count occurrences; no search terms or request/user identifiers —
 *  only a term count and the requested page. Never allowed to affect the response:
 *  a logging failure here must not turn a handled timeout back into a thrown error. */
function logSearchTimeout(termCount: number, page: number): void {
  try {
    console.error(JSON.stringify({ event: 'search_timeout', at: new Date().toISOString(), termCount, page }));
  } catch {
    // logging is best-effort only
  }
}

// ---- production wiring ------------------------------------------------------------

const indexCache: TtlCache<CatalogIndexEntry[]> = getOrCreateCatalogCache('directory-index', () => createAsyncTtlCache<CatalogIndexEntry[]>(
  async () => {
    const supabase = createSupabasePublicClient();
    if (!supabase) throw new Error('Supabase is not configured');
    return getCatalogIndexEntries(supabase);
  },
  {
    ttlMs: catalogTtlMs(CATALOG_INDEX_TTL_MS),
    maxStaleMs: CATALOG_INDEX_MAX_STALE_MS,
    onStaleServed: (err) =>
      console.warn('[directory] catalog index refresh failed; serving the last good index:', err instanceof Error ? err.message : err),
  }
));
const sliceCache: LruTtlMap<CanonicalOpportunity[]> = getOrCreateCatalogCache('directory-slices', () =>
  createLruTtlMap<CanonicalOpportunity[]>({ max: PAGE_SLICE_MAX_ENTRIES, ttlMs: catalogTtlMs(PAGE_SLICE_TTL_MS) })
);

const productionDeps: DirectoryDeps = {
  getIndex: () => indexCache.get(),
  getRows: async (ids) => {
    const supabase = createSupabasePublicClient();
    if (!supabase) throw new Error('Supabase is not configured');
    return getOpportunitiesBySourceIds(supabase, ids);
  },
  sliceCache,
};

/** The page of a category hub, or of the whole directory (`slug` = null).
 *  Returns null when Supabase is not configured (the pages render "no jobs"). */
export async function loadHubPage(slug: string | null, rawPage: unknown): Promise<DirectoryPage | null> {
  if (!createSupabasePublicClient()) return null;
  const cat = slug ? SEO_CATEGORIES.find((c) => c.slug === slug) ?? null : null;
  return getHubPage(productionDeps, cat, parsePageParam(rawPage));
}

/** One page of search results for the directory's `?q=`. Null when unconfigured. */
export async function loadSearchPage(q: string, rawPage: unknown): Promise<DirectoryPage | null> {
  const supabase = createSupabasePublicClient();
  if (!supabase) return null;
  return getSearchPage(supabase, q, parsePageParam(rawPage));
}

/** Test hook: drop the module-level caches. */
export function resetDirectoryCachesForTests(): void {
  invalidateCatalogCaches();
}

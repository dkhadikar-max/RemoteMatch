/**
 * Process-wide registry for the in-memory catalog caches.
 * ==============================================================================
 * The public hubs, sitemap, feed and resume route each keep a TTL cache of a
 * slim catalog read so a request costs ~nothing instead of a Supabase read (the
 * free tier allows ~240 whole-catalog reads a month). Two problems a bare
 * module-level `const cache = …` does not solve:
 *
 *  1. ONE INSTANCE PER PROCESS. Next.js may bundle a shared module into more
 *     than one route bundle; each bundle would then hold its own copy of the
 *     cache and re-read the catalog independently. Caches are therefore created
 *     through getOrCreateCatalogCache(), which keeps them on `globalThis`.
 *  2. FRESHNESS AFTER INGESTION. Product-facing caches are invalidated after
 *     writes so feeds and hubs see new rows immediately. The sitemap is the
 *     deliberate exception: its 80+ page cold read stays cached for the 6-hour
 *     TTL and uses stale-while-revalidate, so ingestion never makes crawlers pay
 *     the full rebuild cost.
 *
 * Scope: this is per-process state. It is correct for the single Railway service
 * this app runs as; with N replicas each keeps its own copy and an invalidation
 * only reaches the replica that handled the sync (the others fall back to their
 * TTL), which is still bounded.
 */

export interface Invalidatable {
  invalidate(): void;
}

const REGISTRY_KEY = '__remotematch_catalog_caches__';

function registry(): Map<string, Invalidatable> {
  const g = globalThis as unknown as Record<string, Map<string, Invalidatable> | undefined>;
  let r = g[REGISTRY_KEY];
  if (!r) {
    r = new Map();
    g[REGISTRY_KEY] = r;
  }
  return r;
}

/**
 * TTL for a catalog cache: `CATALOG_CACHE_TTL_MS` when set to a non-negative number,
 * else `defaultMs`. UNSET IN PRODUCTION. It exists for local servers and test rigs
 * that write rows straight into the database (bypassing the sync routes, which
 * invalidate the caches): `0` makes every cache re-read on every request, so
 * database-level suites keep testing database-level behavior. Never set it in
 * Railway — it would undo the egress saving.
 */
export function catalogTtlMs(defaultMs: number): number {
  const raw = process.env.CATALOG_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : defaultMs;
}

/** The named process-wide cache, created on first use. */
export function getOrCreateCatalogCache<T extends Invalidatable>(name: string, create: () => T): T {
  const r = registry();
  const existing = r.get(name) as T | undefined;
  if (existing) return existing;
  const created = create();
  r.set(name, created);
  return created;
}

/** Drops registered catalog caches except explicitly excluded names; returns invalidated names. Never throws. */
export function invalidateCatalogCaches(exceptNames: readonly string[] = []): string[] {
  const names: string[] = [];
  const excluded = new Set(exceptNames);
  for (const [name, cache] of Array.from(registry().entries())) {
    if (excluded.has(name)) continue;
    try {
      cache.invalidate();
      names.push(name);
    } catch {
      // One misbehaving cache must not stop the others (or the caller).
    }
  }
  return names;
}

/** Names of the registered caches (tests / diagnostics). */
export function listCatalogCaches(): string[] {
  return Array.from(registry().keys());
}

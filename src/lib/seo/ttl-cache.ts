/**
 * Tiny in-process async TTL cache with single-flight refresh and
 * stale-if-error — used so sitemap.xml stops re-reading the catalog from
 * Supabase on every crawler hit.
 *
 * Why not Next's `unstable_cache`: it throws outside the Next runtime (the
 * SEO audit suite calls `sitemap()` straight from tsx), and its on-disk
 * entries have a size ceiling the ~6 MB sitemap payload would sit uncomfortably
 * close to. A module-level cache is deterministic, runs anywhere, and is unit
 * testable with an injected clock. The cost is that each server process keeps
 * its own copy — correct for the single Railway service this app runs as; N
 * replicas would mean N refreshes per TTL, still bounded.
 *
 * Semantics:
 *  - value younger than `ttlMs`            -> returned with no load
 *  - older (or none)                       -> ONE load runs; concurrent callers
 *                                             await the same promise
 *  - load throws, value younger than
 *    `maxStaleMs`                          -> serve the stale value, keep
 *                                             retrying on the next call
 *  - load throws, no/too-old value         -> the error propagates (never
 *                                             cached; a half-failed read must
 *                                             not become "the sitemap")
 */
/**
 * Bounded key → value cache with a TTL per entry and least-recently-used
 * eviction (Map insertion order). Used for the few-dozen-KB "page slices" of
 * the directory/category hubs, where an unbounded map would be a memory leak
 * (the key space includes user-controlled page numbers).
 */
export interface LruTtlMap<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  readonly size: number;
  clear(): void;
  /** Same as clear(); the name the catalog-cache registry expects. */
  invalidate(): void;
}

export function createLruTtlMap<V>(options: { max: number; ttlMs: number; now?: () => number }): LruTtlMap<V> {
  const now = options.now ?? Date.now;
  const map = new Map<string, { v: V; at: number }>();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= options.ttlMs) {
        map.delete(key);
        return undefined;
      }
      // refresh recency
      map.delete(key);
      map.set(key, hit);
      return hit.v;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { v: value, at: now() });
      while (map.size > options.max) {
        const oldest = map.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    invalidate() {
      map.clear();
    },
  };
}

export interface TtlCache<T> {
  get(): Promise<T>;
  /** Drop the cached value (tests / manual refresh). */
  invalidate(): void;
}

export function createAsyncTtlCache<T>(
  load: () => Promise<T>,
  options: { ttlMs: number; maxStaleMs: number; now?: () => number; onStaleServed?: (err: unknown) => void }
): TtlCache<T> {
  const now = options.now ?? Date.now;
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  async function refresh(): Promise<T> {
    try {
      const v = await load();
      value = { v, at: now() };
      return v;
    } catch (err) {
      if (value && now() - value.at < options.maxStaleMs) {
        options.onStaleServed?.(err);
        return value.v;
      }
      throw err;
    }
  }

  return {
    async get() {
      if (value && now() - value.at < options.ttlMs) return value.v;
      if (!inflight) {
        inflight = refresh().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    invalidate() {
      value = null;
    },
  };
}

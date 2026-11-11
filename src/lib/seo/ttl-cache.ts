/**
 * Tiny in-process async TTL cache with single-flight refresh and
 * stale-if-error — used so sitemap.xml stops re-reading the catalog from
 * Supabase on every crawler hit.
 *
 * Why not Next's unstable_cache: it throws outside the Next runtime (the
 * SEO audit suite calls the route helpers straight from tsx), and its on-disk
 * entries have a size ceiling the sitemap payload would sit uncomfortably
 * close to. A module-level cache is deterministic, runs anywhere, and is unit
 * testable with an injected clock. The cost is that each server process keeps
 * its own copy — correct for the single Railway service this app runs as.
 *
 * Semantics:
 *  - value younger than ttlMs and not invalidated -> returned with no load
 *  - older, invalidated, or absent -> ONE load runs; concurrent callers await it
 *  - optional staleWhileRevalidate -> a retained value is returned immediately while ONE background refresh runs
 *  - load throws, retained value younger than maxStaleMs -> serve stale value
 *    and keep retrying on the next call
 *  - load throws, no/too-old value -> error propagates (never cache a partial read)
 *  - invalidate marks the value stale but RETAINS it as the last-known-good
 *    fallback; it must not erase the only snapshot that stale-if-error can serve
 */
/**
 * Bounded key → value cache with a TTL per entry and least-recently-used
 * eviction (Map insertion order). Used for the few-dozen-KB page slices of
 * the directory/category hubs, where an unbounded map would be a memory leak.
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
  /** Force a refresh while retaining the last successful value as stale fallback. */
  invalidate(): void;
}

export function createAsyncTtlCache<T>(
  load: () => Promise<T>,
  options: { ttlMs: number; maxStaleMs: number; now?: () => number; onStaleServed?: (err: unknown) => void; staleWhileRevalidate?: boolean }
): TtlCache<T> {
  const now = options.now ?? Date.now;
  let value: { v: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;
  let invalidated = false;
  let invalidationVersion = 0;

  async function refresh(): Promise<T> {
    const versionAtStart = invalidationVersion;
    try {
      const v = await load();
      if (versionAtStart === invalidationVersion) {
        value = { v, at: now() };
        invalidated = false;
      } else {
        // A write invalidated the cache while this read was in flight. Its
        // snapshot may predate that write, so don't mark it fresh. Retain an
        // existing last-good value; if none exists, keep this result only as
        // a bounded-age fallback while the next caller retries.
        if (!value) value = { v, at: now() };
        invalidated = true;
      }
      return v;
    } catch (err) {
      if (value && now() - value.at < options.maxStaleMs) {
        options.onStaleServed?.(err);
        return value.v;
      }
      throw err;
    }
  }

  function startRefresh(): Promise<T> {
    if (!inflight) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    async get() {
      if (value && !invalidated && now() - value.at < options.ttlMs) return value.v;
      // For large shared snapshots (the sitemap), do not make the request that
      // discovers expiry pay the full refresh cost. Serve the last good snapshot
      // immediately while one background refresh runs. A cold process still
      // waits for its first successful load; stale data is never fabricated.
      if (options.staleWhileRevalidate && value && now() - value.at < options.maxStaleMs) {
        void startRefresh().catch(() => undefined);
        return value.v;
      }
      return startRefresh();
    },
    invalidate() {
      // Do not discard the last-known-good value. Mark it stale so the next
      // caller refreshes, but preserve it for stale-if-error if that read fails.
      invalidated = true;
      invalidationVersion += 1;
    },
  };
}

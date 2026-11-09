import { createAsyncTtlCache } from '../src/lib/seo/ttl-cache';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${name}`);
  }
}

async function main() {
  let now = 1_000;
  let calls = 0;
  let shouldFail = false;
  let staleServed = 0;

  const cache = createAsyncTtlCache(
    async () => {
      calls++;
      if (shouldFail) throw new Error('simulated database statement timeout');
      return `snapshot-${calls}`;
    },
    {
      ttlMs: 100,
      maxStaleMs: 1_000,
      now: () => now,
      onStaleServed: () => { staleServed++; },
    }
  );

  assert(await cache.get() === 'snapshot-1', 'initial successful load is cached');
  now += 101;
  cache.invalidate();
  shouldFail = true;

  assert(await cache.get() === 'snapshot-1', 'failed refresh after invalidation serves the last-known-good snapshot');
  assert(staleServed === 1 && calls === 2, 'stale fallback is observable and the failed refresh is attempted');
  assert(await cache.get() === 'snapshot-1', 'a failed refresh remains invalidated and retries on the next request');
  assert(staleServed === 2 && calls === 3, 'repeated failures do not turn stale data into a fresh cache entry');

  shouldFail = false;
  assert(await cache.get() === 'snapshot-4', 'a later successful refresh replaces the stale snapshot');
  assert(await cache.get() === 'snapshot-4' && calls === 4, 'successful refresh clears invalidation until TTL expiry');

  now += 1_001;
  cache.invalidate();
  shouldFail = true;
  let expiredRejected = false;
  try {
    await cache.get();
  } catch {
    expiredRejected = true;
  }
  assert(expiredRejected, 'a snapshot older than maxStaleMs is not served');

  // An invalidation that races an in-flight refresh must not mark that
  // potentially pre-write result fresh or replace an existing good snapshot.
  let raceCalls = 0;
  let release: (value: string) => void = () => { throw new Error('refresh resolver was not registered'); };
  const raced = createAsyncTtlCache(
    async () => {
      raceCalls++;
      if (raceCalls === 1) return 'before-write';
      if (raceCalls === 2) return new Promise<string>((resolve) => { release = resolve; });
      return 'after-write';
    },
    { ttlMs: 10_000, maxStaleMs: 20_000, now: () => now }
  );
  assert(await raced.get() === 'before-write', 'race fixture caches its initial snapshot');
  raced.invalidate();
  const pending = raced.get();
  raced.invalidate();
  release('possibly-stale-in-flight-read');
  assert(await pending === 'possibly-stale-in-flight-read', 'the in-flight caller receives its completed read');
  assert(await raced.get() === 'after-write' && raceCalls === 3, 'invalidation during refresh forces another read instead of blessing a stale result');

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { bulkUpdateByIds, RunContext } from '../src/lib/ingestion/catalog-sync-apply';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS: ${message}`);
    passed++;
  } else {
    console.error(`FAIL: ${message}`);
    failed++;
  }
}

function fakeAdmin(
  respond: (ids: string[]) => { data: { id: string }[] | null; error: { message: string; code: string } | null },
  attempted: number[] = []
): any {
  return {
    from: () => ({
      update: () => ({
        in: (_column: string, ids: string[]) => ({
          select: () => ({
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
              attempted.push(ids.length);
              return Promise.resolve(respond(ids)).then(resolve, reject);
            },
          }),
        }),
      }),
    }),
  };
}

async function main(): Promise<void> {
  console.log('CATALOG TOUCH UPDATE TIMEOUT RETRY SUITE');

  // The production failure was one 25-ID PATCH canceled with SQLSTATE 57014.
  // Smaller idempotent batches succeed in this deterministic simulation.
  const attempted: number[] = [];
  const ctx = new RunContext();
  const ids = Array.from({ length: 25 }, (_, i) => `touch-${i}`);
  const admin = fakeAdmin(
    (batch) => batch.length > 6
      ? { data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }
      : { data: batch.map((id) => ({ id })), error: null },
    attempted
  );
  const written = await bulkUpdateByIds(admin, ctx, 'touch', ids, {
    last_seen_in_feed_at: new Date().toISOString(),
    consecutive_absences: 0,
  });

  assert(written === 25, `all 25 rows recover after timeout bisection (written=${written})`);
  assert(attempted.join(',') === '25,13,7,4,3,6,12,6,6', `retry sequence is deterministic and bounded (${attempted.join(',')})`);
  assert(ctx.requests === 9 && ctx.writeFailures === 0 && ctx.errors.length === 0, 'recovered timeout is not recorded as a write failure');

  // Persistent statement timeouts are reported at terminal batch granularity.
  const persistent = new RunContext();
  const persistentAttempts: number[] = [];
  const persistentAdmin = fakeAdmin(
    () => ({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }),
    persistentAttempts
  );
  const failedWrites = await bulkUpdateByIds(persistentAdmin, persistent, 'touch', ['a', 'b', 'c'], {
    last_seen_in_feed_at: new Date().toISOString(),
  });
  assert(failedWrites === 0, 'persistent failures do not claim successful writes');
  assert(persistentAttempts.length === 5, `persistent retry depth is bounded (${persistentAttempts.length} requests)`);
  assert(persistent.writeFailures === 3 && persistent.errors.some((e) => e.op === 'touch' && e.count === 3 && e.code === '57014'),
    'persistent timeout is accurately reported for all terminal rows');

  // Non-timeout failures are not retried.
  const other = new RunContext();
  const otherAttempts: number[] = [];
  const otherAdmin = fakeAdmin(
    () => ({ data: null, error: { message: 'permission denied', code: '42501' } }),
    otherAttempts
  );
  await bulkUpdateByIds(otherAdmin, other, 'touch', ['x', 'y', 'z'], { last_seen_in_feed_at: new Date().toISOString() });
  assert(otherAttempts.length === 1 && other.writeFailures === 3, 'non-timeout errors are not retried');

  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

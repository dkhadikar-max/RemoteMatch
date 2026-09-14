/**
 * Supply Discovery gate C5 — robots.txt permission check (docs/c5-implementation-plan.md §4a, §12).
 * Pure function under test, network mocked — no infra. Exercises real
 * robots.txt fixture text through the actual parser, not synthetic
 * pre-parsed structures.
 */
import { checkRobotsPermission } from '../src/lib/ingestion/robots-check';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL: ${message}`);
  }
}

const originalFetch = global.fetch;

function mockFetch(status: number, body: string) {
  (global as any).fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
}

function mockFetchThrows() {
  (global as any).fetch = async () => {
    throw new Error('simulated network failure');
  };
}

async function run() {
  console.log('==============================================================================');
  console.log('SUPPLY DISCOVERY C5 — ROBOTS.TXT PERMISSION CHECK');
  console.log('==============================================================================\n');

  console.log('1. Allow-all robots.txt');
  mockFetch(200, 'User-agent: *\nDisallow:\n');
  let result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === true, 'empty Disallow under User-agent: * -> allowed');

  console.log('\n2. Disallow-specific-path robots.txt');
  mockFetch(200, 'User-agent: *\nDisallow: /admin\nDisallow: /careers/internal/\n');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === true, 'path not matching any Disallow rule -> allowed (standard deny-list semantics)');
  result = await checkRobotsPermission('https://example.com/careers/internal/secret-role');
  assert(result.allowed === false, 'path matching a specific Disallow rule -> disallowed');
  result = await checkRobotsPermission('https://example.com/admin');
  assert(result.allowed === false, 'path matching a Disallow rule exactly -> disallowed');

  console.log('\n3. Disallow-all robots.txt');
  mockFetch(200, 'User-agent: *\nDisallow: /\n');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === false, "Disallow: / blocks every path -> disallowed");

  console.log('\n4. Longest-match-wins (Allow overrides a broader Disallow)');
  mockFetch(200, 'User-agent: *\nDisallow: /careers/\nAllow: /careers/public/\n');
  result = await checkRobotsPermission('https://example.com/careers/public/senior-eng');
  assert(result.allowed === true, 'more specific Allow rule beats a broader Disallow -> allowed');
  result = await checkRobotsPermission('https://example.com/careers/private/role');
  assert(result.allowed === false, 'path only matching the broader Disallow -> disallowed');

  console.log('\n5. Specific User-agent group takes priority over "*"');
  mockFetch(200, 'User-agent: *\nDisallow: /careers/\n\nUser-agent: RemoteMatchBot\nDisallow:\n');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng', 'RemoteMatchBot');
  assert(result.allowed === true, "a specific RemoteMatchBot group with no Disallow overrides the wildcard group's restriction");

  console.log('\n6. robots.txt exists but declares no applicable group at all');
  mockFetch(200, 'User-agent: SomeOtherBot\nDisallow: /\n');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng', 'RemoteMatchBot');
  assert(result.allowed === true, 'no group for our agent or "*" -> allowed (nothing restricts us)');

  console.log('\n7. Malformed / missing robots.txt — conservative fail-closed default');
  mockFetch(404, '');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === false, 'robots.txt returns 404 -> fails closed, disallowed (new-source decision, not a re-check)');

  mockFetch(500, 'Internal Server Error');
  result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === false, 'robots.txt returns 500 -> fails closed, disallowed');

  mockFetchThrows();
  result = await checkRobotsPermission('https://example.com/careers/senior-eng');
  assert(result.allowed === false, 'fetch throws (network/DNS failure) -> fails closed, disallowed');

  console.log('\n8. Malformed URL input');
  result = await checkRobotsPermission('not a url at all');
  assert(result.allowed === false, 'unparseable URL -> fails closed, disallowed');

  console.log('\n9. Comments and blank lines are ignored by the parser');
  mockFetch(200, '# comment line\n\nUser-agent: *\n# another comment\nDisallow: /private # inline comment stripped\n');
  result = await checkRobotsPermission('https://example.com/private/x');
  assert(result.allowed === false, 'Disallow rule still parsed correctly around comments/blank lines');
  result = await checkRobotsPermission('https://example.com/public/x');
  assert(result.allowed === true, 'unmatched path still resolves to allowed with comments present');

  global.fetch = originalFetch;

  console.log('\n==============================================================================');
  console.log(`${passed} passed, ${failed} failed, 0 skipped.`);
  console.log('==============================================================================');
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running robots-check suite:', e); process.exit(1); });

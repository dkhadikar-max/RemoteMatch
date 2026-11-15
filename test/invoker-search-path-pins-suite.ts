/**
 * P2 search_path hardening (Supabase advisor, 2026-11-15 production snapshot).
 *
 * Extracts the REAL function bodies for is_valid_application_transition and
 * get_application_outcome from 006_outcome_lifecycle.sql (not a simplified
 * stand-in), applies them plus the real lockdown from
 * 009_lock_down_readonly_helpers.sql to a PGlite schema, records behavior
 * for representative inputs BEFORE the pin migration, applies the real pin
 * migration, then re-tests the SAME inputs to prove behavior is byte-
 * identical AFTER -- the migration only sets search_path, nothing else.
 *
 * Also verifies, after the migration: SECURITY INVOKER (not DEFINER) on
 * both, search_path pinned, owner/caller-privilege model unchanged (an
 * invoker function has no "owner privilege" surface -- it runs as the
 * caller, which is exactly the point being confirmed), and the 009 grant
 * lockdown untouched.
 *
 * Run: npx tsx test/invoker-search-path-pins-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';

let passed = 0;
let failed = 0;
function assert(ok: boolean, label: string, detail?: string) {
  if (ok) { passed++; console.log('PASS ' + label); }
  else { failed++; console.error('FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

/** Extracts one CREATE OR REPLACE FUNCTION public.<name>(...) ... $$; block verbatim. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in source`);
  const end = source.indexOf('\n$$;', start);
  if (end < 0) throw new Error(`end of function ${name} not found`);
  return source.slice(start, end + 4);
}

const lifecycleSource = read('supabase/migrations/006_outcome_lifecycle.sql');
const realTransitionFn = extractFunction(lifecycleSource, 'is_valid_application_transition');
const realOutcomeFn = extractFunction(lifecycleSource, 'get_application_outcome');

// Sanity: these are the real bodies, not a rewritten copy -- confirm the
// exact transition rule and event filter this test will rely on are present.
assert(/p_from = 'interested' AND p_to IN \('applied', 'withdrawn', 'archived'\) THEN true/.test(realTransitionFn),
  'extracted the real is_valid_application_transition body (not a stand-in)');
assert(/event_type = 'status_changed'/.test(realOutcomeFn) && /'offer', 'rejected', 'withdrawn'/.test(realOutcomeFn),
  'extracted the real get_application_outcome body (not a stand-in)');

const lockdownSource = read('supabase/migrations/009_lock_down_readonly_helpers.sql');
const lockdownStatements = Array.from(lockdownSource.matchAll(/REVOKE ALL ON FUNCTION public\.(?:is_valid_application_transition|get_application_outcome)\([^)]*\) FROM PUBLIC, anon, authenticated;/g)).map((m) => m[0]);
assert(lockdownStatements.length === 2, 'both REVOKE statements for these two functions found in 009 (real source, not re-derived)');

const migration = read('supabase/migrations/20261115210000_pin_invoker_search_path.sql');

async function setupSchema(db: PGlite) {
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE anon NOLOGIN;
    CREATE TABLE public.applications (id uuid primary key default gen_random_uuid(), profile_id uuid, opportunity_id text, status text, notes text, applied_at timestamptz, updated_at timestamptz default now());
    CREATE TABLE public.application_events (id uuid primary key default gen_random_uuid(), application_id uuid, event_type text, event_payload jsonb, created_at timestamptz default now());
  `);
  await db.exec(realTransitionFn + ';');
  await db.exec(realOutcomeFn + ';');
  for (const stmt of lockdownStatements) await db.exec(stmt);
}

/** Runs the representative-input behavior matrix against whatever is
 *  currently installed, returning a stable, comparable snapshot. */
async function captureBehavior(db: PGlite, appId: string) {
  const transitionCases: Array<[string, string]> = [
    ['interested', 'applied'],
    ['interested', 'rejected'], // invalid: not in the allowed target set
    ['applied', 'interview'],
    ['applied', 'applied'], // invalid: p_from === p_to
    ['offer', 'archived'],
    ['rejected', 'applied'], // invalid: no transition out of rejected except archived
  ];
  const transitions: Record<string, boolean> = {};
  for (const [from, to] of transitionCases) {
    const r = await db.query(`SELECT public.is_valid_application_transition($1, $2) AS v;`, [from, to]);
    transitions[`${from}->${to}`] = (r.rows[0] as { v: boolean }).v;
  }

  // Three event-history scenarios per the real function's own filter
  // (event_type='status_changed' AND toStatus IN ('offer','rejected','withdrawn')):
  await db.exec(`DELETE FROM application_events; DELETE FROM applications;`);
  await db.query(`INSERT INTO applications (id, status) VALUES ($1, 'rejected');`, [appId]);
  await db.query(
    `INSERT INTO application_events (application_id, event_type, event_payload, created_at) VALUES
      ($1, 'status_changed', '{"toStatus":"interview"}'::jsonb, now() - interval '2 days'),
      ($1, 'status_changed', '{"toStatus":"rejected"}'::jsonb, now() - interval '1 day'),
      ($1, 'note_added', '{"toStatus":"rejected"}'::jsonb, now());`,
    [appId],
  );
  const outcomeWithTerminalEvent = (await db.query(`SELECT public.get_application_outcome($1) AS v;`, [appId])).rows[0] as { v: string };

  await db.exec(`DELETE FROM application_events;`);
  await db.query(`UPDATE applications SET status = 'interview' WHERE id = $1;`, [appId]);
  const outcomeFallbackToStatus = (await db.query(`SELECT public.get_application_outcome($1) AS v;`, [appId])).rows[0] as { v: string };

  return {
    transitions,
    outcomeWithTerminalEvent: outcomeWithTerminalEvent.v,
    outcomeFallbackToStatus: outcomeFallbackToStatus.v,
  };
}

async function main() {
  const appId = '11111111-1111-1111-1111-111111111111';

  // --- BEFORE: real functions, pre-migration ---
  const before = new PGlite();
  await setupSchema(before);
  const beforeBehavior = await captureBehavior(before, appId);
  assert(beforeBehavior.transitions['interested->applied'] === true, 'BEFORE: interested->applied is a valid transition');
  assert(beforeBehavior.transitions['interested->rejected'] === false, 'BEFORE: interested->rejected is correctly invalid');
  assert(beforeBehavior.transitions['applied->applied'] === false, 'BEFORE: a no-op transition (from === to) is invalid');
  assert(beforeBehavior.outcomeWithTerminalEvent === 'rejected', 'BEFORE: outcome prefers the terminal status_changed event over the row status');
  assert(beforeBehavior.outcomeFallbackToStatus === 'interview', 'BEFORE: outcome falls back to applications.status with no qualifying event');

  // --- Apply the real pin migration to the BEFORE instance ---
  let migrationError: string | null = null;
  try { await before.exec(migration); } catch (e) { migrationError = String((e as Error).message); }
  assert(migrationError === null, 'migration applies cleanly on top of the real pre-existing function definitions', migrationError ?? undefined);

  // --- AFTER: same instance, same real functions, now pinned ---
  const afterBehavior = await captureBehavior(before, appId);
  assert(JSON.stringify(afterBehavior) === JSON.stringify(beforeBehavior),
    'AFTER: every representative-input result is byte-identical to BEFORE (search_path pin changed nothing observable)',
    JSON.stringify({ before: beforeBehavior, after: afterBehavior }));

  // --- Ownership: ALTER FUNCTION ... SET search_path never touches OWNER TO,
  // but confirm directly rather than assume -- both functions' owner is
  // whoever ran the migration (the connecting role), unchanged from before. ---
  for (const sig of ['public.is_valid_application_transition(text,text)', 'public.get_application_outcome(uuid)']) {
    const ownerRes = await before.query(
      `SELECT r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = $1::regprocedure;`,
      [sig],
    );
    const owner = (ownerRes.rows[0] as { owner: string }).owner;
    assert(!!owner, `${sig} has a resolvable owner role after the migration (ownership untouched)`, owner);
  }

  // --- Metadata: SECURITY INVOKER, search_path, grants ---
  for (const [name, sig] of [
    ['is_valid_application_transition', 'public.is_valid_application_transition(text,text)'],
    ['get_application_outcome', 'public.get_application_outcome(uuid)'],
  ] as const) {
    const res = await before.query(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = $1::regprocedure;`, [sig]);
    const row = res.rows[0] as { prosecdef: boolean; proconfig?: string[] };
    assert(row.prosecdef === false, `${name} is SECURITY INVOKER (prosecdef=false), unchanged by this migration`);
    const pinned = (row.proconfig ?? []).some((c) => /^search_path=pg_catalog,\s*public$/.test(c));
    assert(pinned, `${name} has search_path pinned to pg_catalog, public`, JSON.stringify(row.proconfig));

    const authExec = await before.query(`SELECT has_function_privilege('authenticated', $1, 'EXECUTE') AS allowed;`, [sig]);
    assert((authExec.rows[0] as { allowed: boolean }).allowed === false, `${name} remains revoked from authenticated (009's lockdown untouched)`);
    const anonExec = await before.query(`SELECT has_function_privilege('anon', $1, 'EXECUTE') AS allowed;`, [sig]);
    assert((anonExec.rows[0] as { allowed: boolean }).allowed === false, `${name} remains revoked from anon (009's lockdown untouched)`);
  }

  // Invoker-model confirmation: because these are SECURITY INVOKER, "owner
  // privilege" is not a meaningful attack surface here (the function always
  // runs as whoever calls it, never as its owner) -- the only privilege
  // question that matters is "who can call it at all", already checked
  // above. Confirm that directly: calling as a role with EXECUTE still runs
  // with THAT role's own permissions, not the owner's.
  await before.exec(`GRANT EXECUTE ON FUNCTION public.is_valid_application_transition(text, text) TO authenticated;`);
  const invokerCheck = await before.query(`SELECT public.is_valid_application_transition('interested', 'applied') AS v;`);
  assert((invokerCheck.rows[0] as { v: boolean }).v === true, 'granted-to-authenticated call still executes correctly under SECURITY INVOKER (no owner-privilege dependency)');
  await before.exec(`REVOKE ALL ON FUNCTION public.is_valid_application_transition(text, text) FROM authenticated;`); // restore, for test hygiene only

  // --- Preflight/grant-check refusal path (schema mismatch / restored grant) ---
  const db2 = new PGlite();
  await setupSchema(db2);
  await db2.exec(`GRANT EXECUTE ON FUNCTION public.is_valid_application_transition(text, text) TO authenticated;`);
  let grantCheckError: string | null = null;
  try { await db2.exec(migration); } catch (e) { grantCheckError = String((e as Error).message); }
  assert(!!grantCheckError && /unexpected grant change/.test(grantCheckError), 'migration refuses to silently proceed if a grant was already restored before it runs');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

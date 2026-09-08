/**
 * RemoteMatch — Supply Discovery Registry suite (Additional Supply Discovery, gate C1)
 * ==============================================================================
 * Validates migration 012 in isolation against a throwaway PGlite instance
 * (real Postgres, WASM) with the full relevant schema chain applied:
 *   001 (base) -> 002 (RLS + roles) -> 010 (catalog lifecycle) -> 011
 *   (salary_period) -> 012 (this registry).
 *
 * Proves the C1 exit-bar items that do NOT require the migration to be live on
 * a Supabase project:
 *   - the 5 new tables exist, RLS enabled + forced, service-role only
 *   - anon / authenticated cannot read or write any of them
 *   - opportunities.source now has a real FK to supply_platforms(slug)
 *   - the FK rejects an unregistered platform and accepts a seeded one
 *   - the generated canonical_id column reproduces `opp-<source>-<source_id>`
 *     EXACTLY, including for a hyphenated source_id
 *   - the canonical_id unique index exists
 *   - supply_platforms.slug rejects a hyphen / uppercase slug
 *   - the 4 existing sources are seeded and grandfathered
 *
 * The production HTTP suites (outcome-lifecycle, security-remediation, seo-audit,
 * live-supply, gate2, monetization, verification) exercise the same schema
 * end-to-end and are run as part of post-approval deployment verification,
 * once 012 is live — they cannot pass against an unmigrated project because
 * getActiveOpportunityByCanonicalId now matches the canonical_id column.
 *
 * Run: npx tsx test/supply-registry-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function migration(n: string): string {
  return fs.readFileSync(path.resolve(__dirname, `../supabase/migrations/${n}`), 'utf8');
}

async function setRole(db: PGlite, role: 'authenticated' | 'anon' | 'service_role', uid?: string) {
  if (role === 'service_role') {
    await db.query('RESET ROLE;');
    await db.query(`SET request.jwt.claim.role = 'service_role';`);
    await db.query(`SET request.jwt.claim.sub = '';`);
  } else {
    await db.query(`SET ROLE ${role};`);
    await db.query(`SET request.jwt.claim.role = '${role}';`);
    await db.query(`SET request.jwt.claim.sub = '${uid ?? ''}';`);
  }
}

/** Returns 'denied' if the statement throws (grant/RLS), else the row count. */
async function trySelect(db: PGlite, sql: string): Promise<'denied' | number> {
  try {
    const r = await db.query(sql);
    return r.rows.length;
  } catch {
    return 'denied';
  }
}
async function tryWrite(db: PGlite, sql: string): Promise<'ok' | 'denied'> {
  try { await db.query(sql); return 'ok'; } catch { return 'denied'; }
}

async function run() {
  console.log('='.repeat(78));
  console.log('SUPPLY DISCOVERY REGISTRY SUITE (migration 012, PGlite)');
  console.log('='.repeat(78) + '\n');

  const db = new PGlite();

  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$ LANGUAGE sql STABLE;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon');
    $$ LANGUAGE sql STABLE;
  `);

  await db.exec(migration('001_initial_schema.sql'));
  await db.exec(migration('002_row_level_security.sql'));
  await db.exec(migration('010_live_supply_catalog.sql'));
  await db.exec(migration('011_add_salary_period.sql'));

  let migration012Applied = false;
  try {
    await db.exec(migration('012_supply_discovery_registry.sql'));
    migration012Applied = true;
  } catch (err) {
    console.error('migration 012 failed to apply:', (err as Error).message);
  }
  assert(migration012Applied, 'migration 012 applies cleanly on top of 001 + 002 + 010 + 011');
  if (!migration012Applied) { finish(); return; }

  const NEW_TABLES = [
    'supply_platforms', 'supply_sources', 'allowlist_employers',
    'source_discovery_events', 'demand_pattern_sources',
  ];

  // --- existence + RLS forced ---
  await setRole(db, 'service_role');
  for (const t of NEW_TABLES) {
    const r = await db.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [t]
    );
    const row = r.rows[0] as { relrowsecurity: boolean; relforcerowsecurity: boolean } | undefined;
    assert(!!row && row.relrowsecurity && row.relforcerowsecurity,
      `${t}: exists with RLS ENABLED and FORCED`);
  }

  // --- seeds ---
  const platforms = await db.query(`SELECT slug FROM supply_platforms ORDER BY slug`);
  assert(
    JSON.stringify(platforms.rows.map((r) => (r as { slug: string }).slug)) ===
      JSON.stringify(['arbeitnow', 'curated', 'jobicy', 'remotive']),
    'supply_platforms seeded with exactly the 4 grandfathered platforms');

  const grandfathered = await db.query(
    `SELECT count(*)::int AS n FROM supply_sources
       WHERE reviewed_by = 'grandfathered:migration-012' AND status = 'active'`);
  assert((grandfathered.rows[0] as { n: number }).n === 4,
    'supply_sources: 4 grandfathered rows, status=active, explicit provenance');

  // --- anon / authenticated are fully walled off ---
  for (const role of ['anon', 'authenticated'] as const) {
    for (const t of NEW_TABLES) {
      await setRole(db, role, '11111111-1111-4111-8111-111111111111');
      const sel = await trySelect(db, `SELECT * FROM ${t}`);
      assert(sel === 'denied' || sel === 0, `${role} cannot read ${t} (got ${sel})`);
      const ins = await tryWrite(db, `INSERT INTO ${t} DEFAULT VALUES`);
      assert(ins === 'denied', `${role} cannot INSERT into ${t}`);
    }
  }

  // --- service_role can use the registry ---
  await setRole(db, 'service_role');
  const svcRead = await trySelect(db, `SELECT * FROM supply_sources`);
  assert(svcRead === 4, `service_role reads supply_sources (got ${svcRead})`);
  const svcWrite = await tryWrite(db,
    `INSERT INTO supply_platforms (slug, display_name, source_type, kind)
       VALUES ('greenhouse', 'Greenhouse', 'ats', 'ats_board')`);
  assert(svcWrite === 'ok', 'service_role can register a new platform');

  // --- slug shape CHECK ---
  const badHyphen = await tryWrite(db,
    `INSERT INTO supply_platforms (slug, display_name, kind) VALUES ('gh-stripe', 'x', 'ats_board')`);
  assert(badHyphen === 'denied', 'supply_platforms.slug rejects a hyphenated slug');
  const badUpper = await tryWrite(db,
    `INSERT INTO supply_platforms (slug, display_name, kind) VALUES ('GH', 'x', 'ats_board')`);
  assert(badUpper === 'denied', 'supply_platforms.slug rejects an uppercase slug');

  // --- opportunities.source FK ---
  const fkReject = await tryWrite(db, `
    INSERT INTO opportunities (title, company, description, source, source_id,
      official_url, canonical_url_hash, content_hash, status)
    VALUES ('J', 'Co', 'd', 'bogusplatform', 'x1', 'https://e.co/1', 'h', 'h', 'active')`);
  assert(fkReject === 'denied', 'opportunities.source FK rejects an unregistered platform');

  const fkAccept = await tryWrite(db, `
    INSERT INTO opportunities (title, company, description, source, source_id,
      official_url, canonical_url_hash, content_hash, status)
    VALUES ('J', 'Co', 'd', 'remotive', 'reg-1', 'https://e.co/2', 'h2', 'h2', 'active')`);
  assert(fkAccept === 'ok', 'opportunities.source FK accepts a seeded platform');

  const fkAcceptGh = await tryWrite(db, `
    INSERT INTO opportunities (title, company, description, source, source_id,
      official_url, canonical_url_hash, content_hash, status)
    VALUES ('J', 'Co', 'd', 'greenhouse', 'acme-8172508', 'https://e.co/3', 'h3', 'h3', 'active')`);
  assert(fkAcceptGh === 'ok', 'opportunities.source FK accepts a platform added post-migration');

  // --- canonical_id generated column ---
  const c1 = await db.query(
    `SELECT canonical_id FROM opportunities WHERE source = 'remotive' AND source_id = 'reg-1'`);
  assert((c1.rows[0] as { canonical_id: string }).canonical_id === 'opp-remotive-reg-1',
    'canonical_id = opp-<source>-<source_id> for a simple id');

  const c2 = await db.query(
    `SELECT canonical_id FROM opportunities WHERE source = 'greenhouse' AND source_id = 'acme-8172508'`);
  assert((c2.rows[0] as { canonical_id: string }).canonical_id === 'opp-greenhouse-acme-8172508',
    'canonical_id concatenates a HYPHENATED source_id correctly (the old regex could not)');

  // exact reproduction of the historical curated id used across swipes/applications
  await db.query(`
    INSERT INTO opportunities (title, company, description, source, source_id,
      official_url, canonical_url_hash, content_hash, status)
    VALUES ('Curated', 'Automattic', 'd', 'curated', 'curated-001', 'https://a.com/j', 'hc', 'hc', 'active')`);
  const c3 = await db.query(
    `SELECT canonical_id FROM opportunities WHERE source = 'curated' AND source_id = 'curated-001'`);
  assert((c3.rows[0] as { canonical_id: string }).canonical_id === 'opp-curated-curated-001',
    'canonical_id reproduces the historical opp-curated-curated-001 EXACTLY');

  // --- canonical_id unique index ---
  const uidx = await db.query(
    `SELECT 1 FROM pg_indexes WHERE indexname = 'uq_opportunities_canonical_id'`);
  assert(uidx.rows.length === 1, 'unique index uq_opportunities_canonical_id exists');

  // --- (platform, board) uniqueness ---
  const dupBoard = await tryWrite(db,
    `INSERT INTO supply_sources (platform_slug, board, permission_basis)
       VALUES ('remotive', '', 'public_feed')`);
  assert(dupBoard === 'denied', 'supply_sources rejects a duplicate (platform_slug, board)');

  finish();
}

function finish() {
  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal error running supply-registry suite:', err);
  process.exit(1);
});

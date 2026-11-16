/**
 * P1 unindexed-foreign-key fix (Supabase advisor, 2026-11-15 production snapshot).
 * Applies the real migration against a minimal PGlite schema and confirms each
 * of the 5 target indexes exists afterward, with the FK column leading.
 *
 * Run: npx tsx test/fk-indexes-p1-suite.ts
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

const migration = readFileSync(
  join(__dirname, '..', 'supabase', 'migrations', '20261115200000_index_p1_unindexed_foreign_keys.sql'),
  'utf8',
);

async function main() {
  const db = new PGlite();
  // Minimal stand-ins for the five target tables/columns -- just enough for
  // the migration's preflight information_schema checks and CREATE INDEX
  // statements to run against something real, not the full production schema.
  await db.exec(`
    CREATE TABLE public.profile_skills (id serial primary key, profile_id uuid);
    CREATE TABLE public.profile_experiences (id serial primary key, profile_id uuid);
    CREATE TABLE public.matches (id serial primary key, opportunity_id uuid);
    CREATE TABLE public.application_feedback (id serial primary key, application_id uuid);
    CREATE TABLE public.generated_materials (id serial primary key, application_id uuid);
  `);

  let migrationError: string | null = null;
  try { await db.exec(migration); } catch (e) { migrationError = String((e as Error).message); }
  assert(migrationError === null, 'migration applies cleanly to a schema with the five expected tables/columns', migrationError ?? undefined);

  const expected: Array<[string, string, string]> = [
    ['idx_profile_skills_profile_id', 'profile_skills', 'profile_id'],
    ['idx_profile_experiences_profile_id', 'profile_experiences', 'profile_id'],
    ['idx_matches_opportunity_id', 'matches', 'opportunity_id'],
    ['idx_application_feedback_application_id', 'application_feedback', 'application_id'],
    ['idx_generated_materials_application_id', 'generated_materials', 'application_id'],
  ];
  for (const [indexName, table, column] of expected) {
    const res = await db.query(
      `SELECT a.attname AS leading_column
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class tc ON tc.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = i.indkey[0]
       WHERE ic.relname = $1 AND tc.relname = $2;`,
      [indexName, table],
    );
    const row = (res.rows[0] as { leading_column?: string } | undefined);
    assert(!!row, `${indexName} exists on ${table}`);
    assert(row?.leading_column === column, `${indexName} leads with ${column}`, row ? `got ${row.leading_column}` : undefined);
  }

  // Preflight must fail loudly, not silently no-op, when a target column is missing.
  const db2 = new PGlite();
  await db2.exec('CREATE TABLE public.profile_skills (id serial primary key);'); // no profile_id column
  let preflightError: string | null = null;
  try { await db2.exec(migration); } catch (e) { preflightError = String((e as Error).message); }
  assert(!!preflightError && /preflight failed/.test(preflightError), 'preflight raises a clear error instead of silently no-opping when a target column is missing');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });

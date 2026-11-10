import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261110103000_resume_eligibility_keyset_pagination.sql'), 'utf8');
let passed = 0;
let failed = 0;
function assert(ok: boolean, label: string) {
  if (ok) { passed++; console.log(`  ✓ PASS: ${label}`); }
  else { failed++; console.error(`  ✗ FAIL: ${label}`); }
}

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.opportunities (
        source text NOT NULL,
        source_id text NOT NULL,
        title text NOT NULL,
        remote_type text,
        employment_type text,
        required_skills text[],
        status text NOT NULL,
        PRIMARY KEY (source, source_id)
      );
      ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
      CREATE POLICY opportunities_select_active
        ON public.opportunities FOR SELECT TO anon, authenticated
        USING (status = 'active');
      GRANT SELECT ON public.opportunities TO anon, authenticated, service_role;
    `);
    await db.exec(migration);
    assert(true, 'keyset RPC migration applies to a minimal production-shaped schema');

    await db.query(`
      INSERT INTO public.opportunities
        (source, source_id, title, remote_type, employment_type, required_skills, status)
      SELECT
        CASE WHEN i % 3 = 0 THEN 'ashby' WHEN i % 3 = 1 THEN 'greenhouse' ELSE 'himalayas' END,
        lpad(i::text, 6, '0'),
        'Role ' || i::text,
        CASE WHEN i % 2 = 0 THEN 'Worldwide' ELSE 'US' END,
        'Full-time',
        CASE WHEN i % 7 = 0 THEN NULL ELSE ARRAY['SQL', 'Python']::text[] END,
        CASE WHEN i % 5 = 0 THEN 'expired' ELSE 'active' END
      FROM generate_series(1, 2505) AS i;
    `);

    await db.query('SET ROLE anon;');
    await db.query("SET request.jwt.claim.role = 'anon';");

    type Row = { source: string; source_id: string; title: string; remote_type: string | null; employment_type: string | null; required_skills: string[] };
    const page = async (afterSource: string | null, afterSourceId: string | null) => {
      const result = await db.query(
        'SELECT * FROM public.get_resume_eligibility_page($1, $2, 1000);',
        [afterSource, afterSourceId]
      );
      return result.rows as Row[];
    };

    const p1 = await page(null, null);
    const last1 = p1[p1.length - 1];
    const p2 = await page(last1.source, last1.source_id);
    const last2 = p2[p2.length - 1];
    const p3 = await page(last2.source, last2.source_id);
    const all = [...p1, ...p2, ...p3];
    const keys = all.map((r) => `${r.source}\u0000${r.source_id}`);
    const sortedUnique = keys.every((k, i) => i === 0 || keys[i - 1] < k) && new Set(keys).size === keys.length;

    assert(p1.length === 1000 && p2.length === 1000 && p3.length === 4, '1,000-row pages cover the 2,004 active rows without OFFSET');
    assert(sortedUnique, 'composite cursor returns strictly ordered, non-duplicated rows across provider boundaries');
    assert(all.every((r) => Array.isArray(r.required_skills)), 'NULL required_skills are normalized to empty arrays');
    const visible = await db.query('SELECT count(*)::int AS n FROM public.opportunities WHERE status = \'active\';');
    assert(all.length === Number((visible.rows[0] as any).n), 'anon/RLS result exactly matches the active-row count');
    const security = await db.query(`
      SELECT p.prosecdef AS security_definer,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_resume_eligibility_page';
    `);
    const s = security.rows[0] as any;
    assert(s.security_definer === false && s.anon_exec === true && s.auth_exec === true, 'RPC is SECURITY INVOKER and executable by anon/authenticated roles');
  } finally {
    await db.close();
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

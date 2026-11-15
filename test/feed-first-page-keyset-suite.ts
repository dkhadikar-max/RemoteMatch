/**
 * Feed first-page keyset query regression suite.
 *
 * Exercises the feed-specific SECURITY INVOKER RPC with a large stale prefix,
 * a small fresh window, translation gating, bounded pages, and anon RLS.
 *
 * Run: npx tsx test/feed-first-page-keyset-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'supabase/migrations/20261115190000_feed_first_page_query_plan.sql'), 'utf8');
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

async function main() {
  console.log('\nFEED FIRST-PAGE KEYSET (PGlite): query semantics, cursor, translation, RLS');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;

      CREATE TABLE public.opportunities (
        id bigserial PRIMARY KEY,
        type text, title text, company text, company_logo text, description text,
        source text NOT NULL, source_id text NOT NULL, source_url text,
        official_url text, canonical_url_hash text, content_hash text,
        employment_type text, remote_type text, eligible_countries text[],
        excluded_countries text[], timezone_requirements text[], salary_min numeric,
        salary_max numeric, salary_currency text, salary_period text,
        required_skills text[], preferred_skills text[], experience_requirement text,
        quality_score integer, source_quality integer, description_completeness text,
        salary_quality text, remote_policy_confidence text, explicit_remote_scope text,
        status text NOT NULL, posted_at timestamptz NOT NULL,
        is_permanently_removed boolean, link_checked_at timestamptz,
        superseded_by_opportunity_id uuid, source_language text, translation_status text,
        UNIQUE (source, source_id)
      );
      CREATE INDEX opportunities_posted_at_idx ON public.opportunities (posted_at DESC);
      ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
      CREATE POLICY opportunities_select_active ON public.opportunities
        FOR SELECT TO anon, authenticated USING (status = 'active');
      GRANT SELECT ON public.opportunities TO anon, authenticated, service_role;
    `);
    await db.exec(migration);
    assert(true, 'feed RPC migration applies to a minimal production-shaped schema');

    await db.query(`
      INSERT INTO public.opportunities (source, source_id, status, posted_at, source_language, translation_status)
      SELECT 'old-source', lpad(g::text, 5, '0'), 'active', now() - interval '10 days', 'en', NULL
      FROM generate_series(1, 2000) AS g;
    `);
    await db.query(`
      INSERT INTO public.opportunities (source, source_id, status, posted_at, source_language, translation_status)
      SELECT 'fresh-source', lpad(g::text, 3, '0'), 'active', now() - interval '1 hour', 'en', NULL
      FROM generate_series(1, 30) AS g;
    `);
    await db.query(`
      INSERT INTO public.opportunities (source, source_id, status, posted_at, source_language, translation_status)
      VALUES
        ('fresh-source', 'untranslated', 'active', now() - interval '1 hour', 'de', NULL),
        ('fresh-source', 'translation-error', 'active', now() - interval '1 hour', 'de', 'error'),
        ('fresh-source', 'translated', 'active', now() - interval '1 hour', 'de', 'ok'),
        ('fresh-source', 'future', 'active', now() + interval '1 hour', 'en', NULL),
        ('fresh-source', 'inactive', 'expired', now() - interval '1 hour', 'en', NULL);
    `);

    const first = await db.query(
      `SELECT source, source_id FROM public.get_fresh_active_opportunities_keyset_page(NULL,NULL,25,now()-interval '48 hours',now()) ORDER BY source,source_id;`
    );
    const firstRows = first.rows as Array<{ source: string; source_id: string }>;
    assert(firstRows.length === 25, 'first page is bounded to 25 fresh rows, excluding the 2,000-row stale prefix');

    const last = firstRows[firstRows.length - 1];
    const next = await db.query(
      `SELECT source, source_id FROM public.get_fresh_active_opportunities_keyset_page($1,$2,25,now()-interval '48 hours',now()) ORDER BY source,source_id;`,
      [last.source, last.source_id]
    );
    const nextRows = next.rows as Array<{ source: string; source_id: string }>;
    assert(nextRows.length === 6, 'continuation page returns remaining fresh rows only');
    const firstKeys = new Set(firstRows.map((row) => `${row.source}/${row.source_id}`));
    assert(nextRows.every((row) => !firstKeys.has(`${row.source}/${row.source_id}`)), 'cursor pages contain no duplicate rows');

    const all = [...firstRows, ...nextRows].map((row) => row.source_id);
    assert(all.includes('translated'), 'successfully translated non-English rows remain visible');
    assert(!all.includes('untranslated') && !all.includes('translation-error'), 'untranslated and failed translations remain hidden');
    assert(!all.includes('future') && !all.includes('inactive'), 'future and inactive rows remain hidden');

    await db.exec('BEGIN; SET LOCAL ROLE anon;');
    const anon = await db.query(
      `SELECT count(*)::int AS count FROM public.get_fresh_active_opportunities_keyset_page(NULL,NULL,100,now()-interval '48 hours',now());`
    );
    await db.exec('ROLLBACK;');
    assert(Number((anon.rows[0] as { count: number }).count) === 31, 'SECURITY INVOKER respects anon active-row RLS and translation visibility');

    let invalidBoundsRejected = false;
    try {
      await db.query(`SELECT * FROM public.get_fresh_active_opportunities_keyset_page(NULL,NULL,25,NULL,now());`);
    } catch {
      invalidBoundsRejected = true;
    }
    assert(invalidBoundsRejected, 'missing freshness bounds fail closed');

  } finally {
    await db.close();
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

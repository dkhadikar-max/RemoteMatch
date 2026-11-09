/**
 * Database-side remote-job hub pagination.
 *
 * Applies migration 048 to an embedded Postgres, verifies the SECURITY INVOKER
 * RPC under anon/RLS, checks category parity against matchesCategory(), and
 * proves the projection trigger follows inserts, updates, and deletes.
 *
 * Run: npx tsx test/catalog-hub-db-pagination-suite.ts
 */
import { PGlite } from '@electric-sql/pglite';
import { SEO_CATEGORIES, matchesCategory } from '../src/lib/seo/data';
import { CatalogHubTimeoutError, getCatalogHubPage } from '../src/lib/ingestion/catalog-read';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
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

async function setRole(db: PGlite, role: 'anon' | 'authenticated' | 'service_role') {
  await db.query('RESET ROLE;');
  await db.query(`SET ROLE ${role};`);
  await db.query(`SET request.jwt.claim.role = '${role}';`);
}

async function rpc<T>(db: PGlite, args: { p_category_slug: string | null; p_page: number; p_page_size: number }): Promise<T> {
  const result = await db.query(
    `SELECT public.get_remote_job_hub_page(
      p_category_slug := $1,
      p_page := $2,
      p_page_size := $3
    ) AS result;`,
    [args.p_category_slug, args.p_page, args.p_page_size]
  );
  const value = (result.rows[0] as any).result;
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

interface Fixture {
  source?: string;
  source_id: string;
  title: string;
  posted_at: string;
  required_skills: string[];
  remote_type: string | null;
  eligible_countries: string[];
  experience_requirement: string | null;
  status: string;
  source_language: string | null;
  translation_status: string | null;
}

function finish() {
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
}

async function main() {
  console.log('\nCATALOG HUB PAGINATION (PGlite): migration, RLS, trigger, category parity');
  const db = new PGlite();

  try {
    await db.exec(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;

      CREATE TABLE public.opportunities (
        id uuid PRIMARY KEY,
        source text NOT NULL,
        source_id text NOT NULL,
        type text NOT NULL DEFAULT 'job',
        title text NOT NULL,
        company text NOT NULL DEFAULT 'Fixture Co',
        company_logo text,
        description text NOT NULL DEFAULT 'Fixture description',
        source_url text,
        official_url text NOT NULL DEFAULT 'https://example.test/apply',
        canonical_url_hash text NOT NULL,
        content_hash text NOT NULL,
        employment_type text,
        remote_type text,
        eligible_countries text[],
        excluded_countries text[] DEFAULT ARRAY[]::text[],
        timezone_requirements text[] DEFAULT ARRAY[]::text[],
        salary_min numeric,
        salary_max numeric,
        salary_currency text,
        salary_period text,
        required_skills text[],
        preferred_skills text[] DEFAULT ARRAY[]::text[],
        experience_requirement text,
        quality_score integer,
        source_quality integer,
        description_completeness text,
        salary_quality text,
        remote_policy_confidence text,
        explicit_remote_scope text,
        status text NOT NULL,
        posted_at timestamptz,
        is_permanently_removed boolean DEFAULT false,
        link_checked_at timestamptz,
        superseded_by_opportunity_id uuid,
        source_language text,
        translation_status text,
        UNIQUE (source, source_id)
      );

      ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
      CREATE POLICY opportunities_select_active
        ON public.opportunities FOR SELECT TO anon, authenticated
        USING (status = 'active');
      GRANT SELECT ON public.opportunities TO anon, authenticated, service_role;
      GRANT INSERT, UPDATE, DELETE ON public.opportunities TO service_role;
    `);

    await db.exec(read('supabase/migrations/048_remote_job_hub_db_pagination.sql'));
    assert(true, 'migration 048 applies cleanly to a minimal Postgres schema');

    const fixtures: Fixture[] = [];
    const now = Date.UTC(2026, 10, 1);
    const base = (source_id: string, i: number, overrides: Partial<Fixture> = {}): Fixture => ({
      source_id,
      title: `General role ${i}`,
      posted_at: new Date(now + i * 60_000).toISOString(),
      required_skills: [],
      remote_type: 'APAC',
      eligible_countries: [],
      experience_requirement: null,
      status: 'active',
      source_language: 'en',
      translation_status: null,
      ...overrides,
    });

    for (let i = 0; i < 16; i++) fixtures.push(base(`generic-${String(i).padStart(2, '0')}`, i));
    fixtures.push(
      base('software', 16, { title: 'Frontend Engineer', required_skills: ['React'] }),
      base('product', 17, { title: 'Product Manager', required_skills: ['Roadmapping'] }),
      base('design', 18, { title: 'UX Designer', required_skills: ['Figma'] }),
      base('data', 19, { title: 'Data Analyst', required_skills: ['SQL'] }),
      base('marketing', 20, { title: 'Growth Marketing Specialist', required_skills: ['SEO'] }),
      base('senior', 21, { title: 'Principal Analyst', experience_requirement: '7-10' }),
      base('entry-level', 22, { title: 'Assistant Analyst', experience_requirement: '0-1' }),
      base('worldwide', 23, { title: 'Global Support', remote_type: 'Worldwide' }),
      base('united-states', 24, { title: 'US Support', remote_type: 'US' }),
      base('europe', 25, { title: 'EU Support', remote_type: 'EU/EEA' }),
      base('translated-de', 26, { title: 'Übersetzte Rolle', source_language: 'de', translation_status: 'ok' }),
      base('translation-error', 27, { title: 'Hidden foreign role', source_language: 'de', translation_status: 'error' }),
      base('expired', 28, { title: 'Expired role', status: 'expired' }),
      base('collision', 29, { title: 'Collision Engineer', required_skills: ['React'], source: 'zeta' }),
      base('collision', 29, { title: 'Collision Engineer', required_skills: ['React'], source: 'alpha' }),
    );

    await setRole(db, 'service_role');
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      await db.query(
        `INSERT INTO public.opportunities (
          id, source, source_id, title, posted_at, required_skills,
          remote_type, eligible_countries, experience_requirement,
          status, source_language, translation_status,
          canonical_url_hash, content_hash
        ) VALUES (
          $1::uuid, $2, $3, $4, $5::timestamptz, $6::text[],
          $7, $8::text[], $9, $10, $11, $12, $13, $14
        );`,
        [
          `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
          f.source ?? 'fixture',
          f.source_id,
          f.title,
          f.posted_at,
          f.required_skills,
          f.remote_type,
          f.eligible_countries,
          f.experience_requirement,
          f.status,
          f.source_language,
          f.translation_status,
          `hash-${f.source_id}-${f.source ?? 'fixture'}`,
          `content-${f.source_id}-${f.source ?? 'fixture'}`,
        ]
      );
    }

    const visible = fixtures.filter((f) =>
      f.status === 'active' &&
      (f.source_language === null || f.source_language === 'en' || f.translation_status === 'ok') &&
      (f.translation_status === null || f.translation_status !== 'error')
    );
    const expectedOrder = (rows: Fixture[]) => [...rows].sort((a, b) =>
      b.posted_at.localeCompare(a.posted_at) ||
      a.source_id.localeCompare(b.source_id) ||
      (a.source ?? 'fixture').localeCompare(b.source ?? 'fixture')
    );

    const indexCount = await db.query('SELECT count(*)::int AS n FROM public.opportunity_catalog_index;');
    assert(Number((indexCount.rows[0] as any).n) === visible.length, 'trigger/backfill projection contains only active, translation-safe rows');

    await setRole(db, 'anon');
    const rootPage1 = await rpc<{ total: number; jobs: Array<{ source_id: string; source: string }> }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 24,
    });
    const expectedRoot = expectedOrder(visible);
    assert(rootPage1.total === visible.length, 'root directory returns the exact active, translation-safe total');
    assert(
      rootPage1.jobs.map((j) => j.source_id).join('|') === expectedRoot.slice(0, 24).map((f) => f.source_id).join('|'),
      'root page 1 returns the newest 24 rows in deterministic order'
    );
    const collisionRows = rootPage1.jobs.filter((job) => job.source_id === 'collision');
    assert(
      collisionRows.length === 1 && collisionRows[0].source === 'alpha',
      'duplicate source_id entries are deduplicated within the page and resolve to the first source deterministically'
    );

    const rootPage2 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 2, p_page_size: 24,
    });
    assert(rootPage2.total === visible.length && rootPage2.jobs.length === visible.length - 24, 'root page 2 returns only the remaining rows with the same exact total');

    const outOfRange = await rpc<{ total: number; jobs: unknown[] }>(db, {
      p_category_slug: null, p_page: 5000, p_page_size: 24,
    });
    assert(outOfRange.total === visible.length && outOfRange.jobs.length === 0, 'out-of-range page preserves total and returns an empty jobs array');

    let categoryParity = true;
    const parityFailures: string[] = [];
    for (const category of SEO_CATEGORIES) {
      const expected = expectedOrder(visible.filter((f) => matchesCategory(category, {
        title: f.title,
        requiredSkills: f.required_skills,
        remoteType: f.remote_type ?? undefined,
        eligibleCountries: f.eligible_countries,
        experienceRequirement: f.experience_requirement ?? undefined,
      })));
      const actual = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
        p_category_slug: category.slug, p_page: 1, p_page_size: 24,
      });
      if (
        actual.total !== expected.length ||
        actual.jobs.map((j) => j.source_id).join('|') !== expected.slice(0, 24).map((f) => f.source_id).join('|')
      ) {
        categoryParity = false;
        parityFailures.push(category.slug);
      }
    }
    assert(categoryParity, `SQL category predicates match matchesCategory() for all ${SEO_CATEGORIES.length} hubs`, parityFailures.join(', '));

    await setRole(db, 'service_role');
    const policy = await db.query(`
      SELECT c.relrowsecurity AS enabled
      FROM pg_class c
      WHERE c.oid = 'public.opportunity_catalog_index'::regclass;
    `);
    const functionSecurity = await db.query(`
      SELECT p.prosecdef AS security_definer
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_remote_job_hub_page';
    `);
    assert((policy.rows[0] as any).enabled === true, 'projection table has RLS enabled');
    assert((functionSecurity.rows[0] as any).security_definer === false, 'page RPC is SECURITY INVOKER, not SECURITY DEFINER');

    // The trigger is transactional: lifecycle/translation changes remove and
    // restore a row in the projection without a separate refresh operation.
    await setRole(db, 'service_role');
    await db.query(`UPDATE public.opportunities SET status = 'expired' WHERE source_id = 'generic-00';`);
    let changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'status transition to expired removes the projection row');

    await db.query(`UPDATE public.opportunities SET status = 'active', source_language = 'de', translation_status = 'error' WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'translation error removes the projection row');

    await db.query(`UPDATE public.opportunities SET source_language = 'de', translation_status = 'ok' WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 1, 'successfully translated foreign row is restored to the projection');

    await db.query(`DELETE FROM public.opportunities WHERE source_id = 'generic-00';`);
    changed = await db.query(`SELECT count(*)::int AS n FROM public.opportunity_catalog_index WHERE source_id = 'generic-00';`);
    assert(Number((changed.rows[0] as any).n) === 0, 'deleting an opportunity deletes its projection row');

    await setRole(db, 'anon');
    const afterDelete = await rpc<{ total: number; jobs: unknown[] }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 24,
    });
    assert(afterDelete.total === visible.length - 1, 'directory total reflects committed trigger maintenance without a manual refresh');

    // Exercise the same catalog size that exposed the production failure. The
    // function must count the whole projection but return only a page, even if
    // a caller asks for an oversized page size.
    await setRole(db, 'service_role');
    await db.exec(`
      INSERT INTO public.opportunities (
        id, source, source_id, title, posted_at, required_skills,
        remote_type, eligible_countries, experience_requirement,
        status, source_language, translation_status,
        canonical_url_hash, content_hash
      )
      SELECT
        gen_random_uuid(),
        'scale',
        'scale-' || g::text,
        'Scale role ' || g::text,
        timestamptz '2026-11-02 00:00:00+00' + g * interval '1 second',
        ARRAY[]::text[],
        'APAC',
        ARRAY[]::text[],
        NULL,
        'active',
        'en',
        NULL,
        'scale-h-' || g::text,
        'scale-c-' || g::text
      FROM generate_series(1, 92357) AS series(g);
    `);

    await setRole(db, 'anon');
    const largePage1 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 1, p_page_size: 1000,
    });
    const largePage2 = await rpc<{ total: number; jobs: Array<{ source_id: string }> }>(db, {
      p_category_slug: null, p_page: 2, p_page_size: 24,
    });
    const largeIds1 = new Set(largePage1.jobs.map((j) => j.source_id));
    assert(
      largePage1.total === visible.length - 1 + 92357 && largePage1.jobs.length === 24,
      '92,357-row catalog returns an exact total but clamps every response to 24 full rows'
    );
    assert(
      largePage2.total === largePage1.total &&
      largePage2.jobs.length === 24 &&
      largePage2.jobs.every((j) => !largeIds1.has(j.source_id)),
      'large-catalog page 2 is bounded and does not repeat page 1 listings'
    );

    const timeoutClient = {
      rpc: async () => ({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }),
    } as any;
    let timeoutClassified = false;
    try {
      await getCatalogHubPage(timeoutClient, null, 1, 24);
    } catch (error) {
      timeoutClassified = error instanceof CatalogHubTimeoutError;
    }
    assert(timeoutClassified, 'catalog RPC SQLSTATE 57014 is classified as CatalogHubTimeoutError');

    const unexpectedClient = {
      rpc: async () => ({
        data: null,
        error: { code: '42601', message: 'syntax error' },
      }),
    } as any;
    let unexpectedPropagated = false;
    try {
      await getCatalogHubPage(unexpectedClient, null, 1, 24);
    } catch (error) {
      unexpectedPropagated = error instanceof Error && error.message.includes('syntax error');
    }
    assert(unexpectedPropagated, 'unexpected RPC errors still propagate rather than becoming empty results');

  } finally {
    await db.close();
  }

  finish();
}

main().catch((error) => {
  console.error('SUITE ERROR:', error);
  process.exitCode = 1;
});

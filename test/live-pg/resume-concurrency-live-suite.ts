/**
 * Resume Intelligence (PR B) — LIVE PostgreSQL concurrency gate.
 *
 * STATUS: PREPARED, NOT RUN. This file has never been executed against a real database. It
 * requires a disposable PostgreSQL instance this session does not have access to (no Docker for
 * `supabase start`, no password for the pre-existing local `postgresql-x64-18` Windows service —
 * see docs/resume-pr-b-live-concurrency-runbook.md for the full prerequisite explanation and why
 * neither was worked around). It is checked in only so the gate can run the moment a disposable
 * instance is available, without re-deriving this design from scratch.
 *
 * SAFETY REWRITE (docs/resume-pr-b-live-concurrency-safety-fixes-2026-10-22.md): a read-only
 * review of the first version of this harness found that its only safeguard against targeting the
 * wrong database was a connection-string hostname denylist — never a positive proof the target was
 * actually disposable/empty — and that it used a hardcoded test profile UUID the harness had no
 * way to prove it (rather than something pre-existing) had created. Both are fixed:
 *   - Three independent checks must ALL pass before any write happens (see live-pg-guards.ts):
 *     (1) the connection string is not an obviously-known shared host (cheap, secondary only);
 *     (2) LIVE_PG_TEST_CONFIRM_DISPOSABLE is set to an exact, deliberate confirmation string, not
 *         a boolean flag; (3) the target database has a `_resume_pr_b_live_audit_run` marker row
 *         whose run_tag matches LIVE_PG_TEST_RUN_TAG exactly — that marker is written ONLY by
 *         00-bootstrap.sql's own fail-closed preflight (which itself refuses to run if
 *         public.profiles/auth.uid()/any migration-036 table already exists). A database that was
 *         never deliberately bootstrapped for this exact run fails check 3 and the harness exits
 *         before issuing a single other query.
 *   - The test profile id is no longer a hardcoded constant. It is read from that same marker row
 *     — i.e. the id this run's own bootstrap generated server-side — so every write this harness
 *     makes, and everything its cleanup deletes, is provably scoped to rows this run created.
 *
 * THIRD FIX (2026-10-23, after the first live run): that run found upsert_resume_analysis() fails
 * every call with "column reference \"id\" is ambiguous" (42702) — see migration
 * 038_resume_upsert_analysis_ambiguity_fix.sql and docs/resume-pr-b-live-harness-run-2026-10-23.md.
 * Two additions here: (a) Section 2b, a regression test that exercises a VALID, same-owner call
 * (the success path), not just Section 2's ownership-denial path — the denial path alone never
 * would have caught this; (b) Section 3 now explicitly sets `process.env.RESUME_INTELLIGENCE_
 * ENABLED = 'true'` for this harness process only (that run also never reached the database in
 * Section 3 because the flag was unset, short-circuiting analyzeResume() before any SQL ran).
 *
 * SECOND FIX REVIEW (2026-10-22, same-day follow-up): connection establishment is now inside the
 * protected try/finally (if A connects but B's connect() throws, A is still explicitly closed —
 * see the `finally` block, never left dangling until process exit). Cleanup now attempts each
 * delete independently (one failure never blocks the rest) and reports any failure explicitly
 * instead of silently claiming "cleanup complete." Every client that was actually opened gets a
 * best-effort `.end()` on every exit path, including when cleanup itself fails.
 *
 * What this proves, once run, that test/resume-intelligence-persistence-suite.ts (mocked
 * SupabaseClient) cannot: that Postgres's actual `FOR UPDATE` row lock and the actual unique-
 * constraint-backed `INSERT ... ON CONFLICT` in upsert_resume_analysis() (supabase/migrations/
 * 036_resume_intelligence.sql) genuinely serialize two INDEPENDENT database connections racing
 * the identical analysis key — not just that the TypeScript calling code issues the right SQL in
 * the right order (which the mocked suite already proves).
 *
 * Design:
 *   - Two separate `pg.Client` connections (`pgA`, `pgB`) — two genuinely independent database
 *     sessions, each wrapped in `LivePgSupabaseShim`, a minimal adapter implementing only the
 *     subset of the Supabase JS client's surface that src/lib/ai/resume-intelligence-service.ts
 *     actually calls (`.from(...).select(...).eq(...).maybeSingle()` and `.rpc(...)`), translating
 *     each call into real SQL wrapped in its own `BEGIN; SET LOCAL request.jwt.claims = ...; SET
 *     LOCAL ROLE authenticated; ...; COMMIT;` — the exact mechanism PostgREST itself uses to scope
 *     a request to one authenticated user inside one transaction. This is not a mock of
 *     resume-intelligence's own logic: it is a faithful reproduction of Supabase's own auth
 *     plumbing, applied so the REAL analyzeResume() function (imported unmodified from
 *     ../../src/lib/ai/resume-intelligence-service.ts) can run against a REAL Postgres.
 *   - A `modelCallerOverride` is still used for the OpenAI call itself (no live OpenAI key is in
 *     scope for this gate, and was never authorized for live calls — decision 6, see memory
 *     remotematch-resume-intelligence.md). This is the ONE piece that remains a substitute, and it
 *     is the same seam test/resume-intelligence-persistence-suite.ts already uses — everything
 *     downstream of it (every database call) is real. The override includes a short randomized
 *     delay specifically to widen the race window between the two concurrent calls.
 *
 * Prerequisites and exact invocation: docs/resume-pr-b-live-concurrency-runbook.md.
 * Required env vars (ALL three; the harness exits before connecting if any is missing/wrong):
 *   LIVE_PG_TEST_DATABASE_URL        — the disposable database's connection string
 *   LIVE_PG_TEST_RUN_TAG             — must exactly match the run_tag passed to 00-bootstrap.sql
 *   LIVE_PG_TEST_CONFIRM_DISPOSABLE  — must be the exact string live-pg-guards.ts#REQUIRED_CONFIRMATION
 */
import { Client } from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import { analyzeResume, type AnalyzeRequest, type ModelCaller } from '../../src/lib/ai/resume-intelligence-service';
import { checkConnectionStringIsSafe, checkConfirmationFlag, runAllPreflightChecks, type MarkerRow } from './live-pg-guards';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** One independent database session, impersonating one authenticated user for every call it
 *  makes, implementing only the Supabase client surface analyzeResume() actually uses. */
class LivePgSupabaseShim {
  constructor(private pg: Client, private uid: string) {}

  private async withRequestTransaction<T>(body: () => Promise<T>): Promise<T> {
    await this.pg.query('BEGIN');
    try {
      await this.pg.query(`SET LOCAL request.jwt.claims = '${JSON.stringify({ sub: this.uid })}'`);
      await this.pg.query('SET LOCAL ROLE authenticated');
      const result = await body();
      await this.pg.query('COMMIT');
      return result;
    } catch (err) {
      await this.pg.query('ROLLBACK');
      throw err;
    }
  }

  async rpc(fn: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
    try {
      return await this.withRequestTransaction(async () => {
        const keys = Object.keys(args ?? {});
        const namedCall = keys.length > 0
          ? `SELECT * FROM ${fn}(${keys.map((k) => `${k} := $${keys.indexOf(k) + 1}`).join(', ')})`
          : `SELECT * FROM ${fn}()`;
        const values = keys.map((k) => (args as Record<string, unknown>)[k]);
        const res = await this.pg.query(namedCall, values);
        const data = fn === 'reserve_resume_analysis' || fn === 'refund_resume_analysis'
          ? res.rows[0] ?? null
          : res.rows;
        return { data: fn.startsWith('reserve_resume_analysis') ? (res.rows[0] as Record<string, unknown> | undefined)?.reserve_resume_analysis ?? res.rows[0] : data, error: null };
      });
    } catch (err) {
      const pgErr = err as { message: string; code?: string };
      return { data: null, error: { message: pgErr.message, code: pgErr.code } };
    }
  }

  from(table: string) {
    const pg = this.pg;
    const withTx = this.withRequestTransaction.bind(this);
    const conditions: Array<[string, unknown]> = [];
    const builder = {
      select(_cols: string) { return builder; },
      eq(col: string, val: unknown) { conditions.push([col, val]); return builder; },
      async maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }> {
        try {
          return await withTx(async () => {
            const where = conditions.map(([c], i) => `${c} = $${i + 1}`).join(' AND ');
            const values = conditions.map(([, v]) => v);
            const res = await pg.query(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, values);
            return { data: (res.rows[0] as Record<string, unknown>) ?? null, error: null };
          });
        } catch (err) {
          return { data: null, error: { message: (err as Error).message } };
        }
      },
    };
    return builder;
  }
}

function asSupabaseClient(shim: LivePgSupabaseShim): SupabaseClient {
  return shim as unknown as SupabaseClient;
}

/** A deterministic, non-OpenAI model stand-in with a randomized delay to widen the race window.
 *  The ONE substituted piece in this suite — see file header. Everything else is real Postgres. */
function makeDelayedModelCaller(delayMs: number): ModelCaller {
  return (async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return {
      model: 'live-concurrency-test-stub',
      raw: {
        resumeType: { roleFamily: 'unknown', confidence: 'low', alternatives: [], evidence: [] },
        overallSummary: { text: 'stub', evidence: [] },
        sectionReviews: [], strengths: [], improvements: [], bulletRewrites: [],
        skillsEvidence: { demonstrated: [], weaklySupported: [], notEvidenced: [] },
        formattingIssues: [], targetJobFit: null, keywordAlignment: null,
        actionPlan: [], questionsForCandidate: [], limitations: [],
      },
    } as never;
  }) as unknown as ModelCaller;
}

async function seedResumeVersion(shim: LivePgSupabaseShim, content: string): Promise<string> {
  const sha256 = require('crypto').createHash('sha256').update(content).digest('hex');
  const { data, error } = await shim.rpc('create_resume_version', {
    p_content: content, p_sha256: sha256, p_source: 'upload', p_parent_version_id: null,
  });
  if (error) throw new Error(`seedResumeVersion failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return (row as { create_resume_version?: string })?.create_resume_version ?? (row as string);
}

async function getProfileCount(pg: Client, profileId: string): Promise<number> {
  const res = await pg.query<{ daily_resume_analyses_count: number }>(
    'SELECT daily_resume_analyses_count FROM profiles WHERE id = $1', [profileId]
  );
  return res.rows[0]?.daily_resume_analyses_count ?? 0;
}

async function main() {
  const url = process.env.LIVE_PG_TEST_DATABASE_URL;
  const runTag = process.env.LIVE_PG_TEST_RUN_TAG ?? '';
  const confirmValue = process.env.LIVE_PG_TEST_CONFIRM_DISPOSABLE;

  if (!url) {
    console.error('LIVE_PG_TEST_DATABASE_URL is not set. See docs/resume-pr-b-live-concurrency-runbook.md.');
    process.exit(2);
  }

  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — LIVE POSTGRESQL CONCURRENCY GATE');
  console.log('='.repeat(78));

  // --- Preflight checks 1 and 2: evaluated BEFORE any connection is attempted ------------------
  const hostCheck = checkConnectionStringIsSafe(url);
  if (!hostCheck.ok) {
    console.error(`SAFETY ABORT: ${hostCheck.reason}`);
    process.exit(2);
  }
  const confirmCheck = checkConfirmationFlag(confirmValue);
  if (!confirmCheck.ok) {
    console.error(`SAFETY ABORT: ${confirmCheck.reason}`);
    process.exit(2);
  }
  if (!runTag) {
    console.error('SAFETY ABORT: LIVE_PG_TEST_RUN_TAG is not set. Refusing to connect. It must match the run_tag used with 00-bootstrap.sql.');
    process.exit(2);
  }

  const pgA = new Client({ connectionString: url });
  const pgB = new Client({ connectionString: url });
  let pgAConnected = false;
  let pgBConnected = false;

  let profileId = '';
  let otherProfileId = '';

  try {
    // Connection lifecycle: each connect() is tracked independently. If A succeeds and B then
    // throws, A is still explicitly closed in the finally block below (never left dangling until
    // process exit) — see CLEANUP/CONNECTION RESILIENCE comment on the finally block.
    await pgA.connect();
    pgAConnected = true;
    await pgB.connect();
    pgBConnected = true;

    const versionRes = await pgA.query('SELECT version()');
    console.log(`\nConnected. Server: ${versionRes.rows[0].version}`);

    // --- Preflight check 3: the positive, database-level identity check -----------------------
    const markerRes = await pgA.query(
      'SELECT run_tag, profile_id FROM public._resume_pr_b_live_audit_run WHERE run_tag = $1', [runTag]
    );
    const markerRow = (markerRes.rows[0] as unknown as MarkerRow | undefined) ?? null;
    const allChecks = runAllPreflightChecks({ url, confirmValue, markerRow, expectedRunTag: runTag });
    if (!allChecks.ok) {
      console.error(`SAFETY ABORT: ${allChecks.reason}`);
      console.error('No writes were attempted. Nothing beyond this SELECT against the marker table was executed.');
      process.exitCode = 2;
      return;
    }
    profileId = allChecks.profileId as string;
    console.log(`Preflight passed. Operating only on profile_id ${profileId} (from this run's own marker row).`);

    const shimA = new LivePgSupabaseShim(pgA, profileId);
    const shimB = new LivePgSupabaseShim(pgB, profileId);

    console.log('\n1. Schema / grants / auth introspection (direct SQL, no app code)');
    {
      const sig = await pgA.query(`
        SELECT p.proname, pg_get_function_arguments(p.oid) AS args, p.prosecdef AS security_definer
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'upsert_resume_analysis'
      `);
      assert(sig.rows.length === 1, 'exactly one upsert_resume_analysis overload exists (no leftover 13-param version from a prior apply)', JSON.stringify(sig.rows));
      assert(sig.rows[0]?.security_definer === true, 'upsert_resume_analysis is SECURITY DEFINER');
      assert(!String(sig.rows[0]?.args ?? '').includes('p_profile_id'), 'the live function signature has no p_profile_id parameter');

      const grants = await pgA.query<{ grantee: string; privilege_type: string }>(`
        SELECT grantee, privilege_type FROM information_schema.routine_privileges
        WHERE routine_name = 'upsert_resume_analysis' AND routine_schema = 'public'
      `);
      assert(grants.rows.some((r) => r.grantee === 'authenticated' && r.privilege_type === 'EXECUTE'),
        'EXECUTE is granted to authenticated', JSON.stringify(grants.rows));
      assert(!grants.rows.some((r) => r.grantee === 'service_role'),
        'no EXECUTE grant to service_role for upsert_resume_analysis', JSON.stringify(grants.rows));

      // ACL-HARDENING CHECK (added after a live-run finding, 2026-10-22 — see migration
      // 037_resume_intelligence_acl_hardening.sql): the presence of an `authenticated` grant and
      // the absence of a `service_role` grant (above) do NOT prove PUBLIC's default EXECUTE grant
      // was ever revoked — Postgres grants EXECUTE to PUBLIC by default on function creation, and a
      // later `GRANT ... TO authenticated` never removes that default. This is the check that
      // actually caught the gap live; keeping it here so re-running after migration 037 confirms
      // the fix, and so this specific gap can never again pass unnoticed through only the two
      // checks above it.
      for (const fn of ['create_resume_version', 'upsert_resume_analysis', 'record_resume_suggestion_decision', 'reserve_resume_analysis', 'refund_resume_analysis', 'finalize_resume_analysis']) {
        const fnGrants = await pgA.query<{ grantee: string; privilege_type: string }>(`
          SELECT grantee, privilege_type FROM information_schema.routine_privileges
          WHERE routine_name = $1 AND routine_schema = 'public'
        `, [fn]);
        assert(!fnGrants.rows.some((r) => r.grantee === 'PUBLIC' && r.privilege_type === 'EXECUTE'),
          `no implicit PUBLIC EXECUTE grant survives on ${fn} (migration 037 applied)`, JSON.stringify(fnGrants.rows));
        assert(!fnGrants.rows.some((r) => r.grantee === 'anon' && r.privilege_type === 'EXECUTE'),
          `no EXECUTE grant to anon on ${fn}`, JSON.stringify(fnGrants.rows));
        assert(fnGrants.rows.some((r) => r.grantee === 'authenticated' && r.privilege_type === 'EXECUTE'),
          `authenticated still retains EXECUTE on ${fn} after the ACL hardening`, JSON.stringify(fnGrants.rows));
      }
    }

    console.log('\n1b. Authenticated role but no JWT claims — auth.uid() IS NULL is rejected by the function itself (28000)');
    {
      // PREPARED 2026-10-30, NOT YET RUN — added while verifying migration 038's fix and checking
      // the harness's own authorization-case coverage per Deep's request. Every write RPC in
      // migration 036 (create_resume_version, upsert_resume_analysis, record_resume_suggestion_
      // decision, reserve_resume_analysis, refund_resume_analysis) starts with
      // `IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000'`
      // (v_uid := auth.uid()). Section 1 only proves the GRANT exists for `authenticated`; it does
      // not prove this in-function defense-in-depth check actually fires when a caller holds the
      // `authenticated` role (so the GRANT lets the call through) but auth.uid() still resolves to
      // NULL because no request.jwt.claims were ever set for that session — exactly what happens if
      // a caller reaches this RPC through some path other than PostgREST's normal per-request JWT
      // scoping. No existing suite (mocked or live) exercises this distinctly from the ownership
      // check in Section 2 below, which always has a real uid, just the WRONG one.
      await pgA.query('BEGIN');
      try {
        await pgA.query('SET LOCAL ROLE authenticated'); // role grant present, but no request.jwt.claims set
        const res = await pgA.query(
          // Migration 041 trimmed upsert_resume_analysis to claim-only (5 params, always
          // 'pending' internally) -- this check still exercises the exact same auth.uid()-first
          // guard, just via the current signature.
          `SELECT * FROM upsert_resume_analysis(
             p_resume_version_id := $1, p_mode := 'general', p_opportunity_id := NULL,
             p_job_content_hash := '', p_analysis_version := 'auth-null-test-v1')`,
          [require('crypto').randomUUID()] // any UUID — must be rejected on auth.uid() before the ownership lookup even runs
        );
        assert(false, 'auth.uid() IS NULL is rejected with ERRCODE 28000 before any row lookup', `query unexpectedly succeeded: ${JSON.stringify(res.rows)}`);
      } catch (err) {
        const pgErr = err as { code?: string; message?: string };
        assert(pgErr.code === '28000', 'auth.uid() IS NULL is rejected with ERRCODE 28000 before any row lookup', JSON.stringify(pgErr));
      } finally {
        await pgA.query('ROLLBACK');
      }
    }

    console.log('\n1c. finalize_resume_analysis() has its OWN auth.uid()-IS-NULL guard (migration 041, new function)');
    {
      await pgA.query('BEGIN');
      try {
        await pgA.query('SET LOCAL ROLE authenticated');
        const res = await pgA.query(
          `SELECT * FROM finalize_resume_analysis(
             p_analysis_id := $1, p_expected_attempt_number := 1, p_status := 'success',
             p_result := NULL, p_source_ai := false, p_model := NULL, p_prompt_tokens := NULL,
             p_completion_tokens := NULL, p_cost_usd := NULL)`,
          [require('crypto').randomUUID()]
        );
        assert(false, 'finalize_resume_analysis: auth.uid() IS NULL is rejected with ERRCODE 28000 before any row lookup', `query unexpectedly succeeded: ${JSON.stringify(res.rows)}`);
      } catch (err) {
        const pgErr = err as { code?: string; message?: string };
        assert(pgErr.code === '28000', 'finalize_resume_analysis: auth.uid() IS NULL is rejected with ERRCODE 28000 before any row lookup', JSON.stringify(pgErr));
      } finally {
        await pgA.query('ROLLBACK');
      }
    }

    console.log('\n2. Identity cannot be caller-supplied (live round trip)');
    {
      // A second profile, created fresh BY THIS RUN (never a hardcoded id) via the real
      // reserve/create path is unnecessary here — a bare INSERT scoped to a brand-new
      // crypto-random id is sufficient to prove cross-user ownership enforcement, and this id is
      // tracked in `otherProfileId` so cleanup can remove exactly (and only) this run's own row.
      otherProfileId = require('crypto').randomUUID();
      await pgA.query(`INSERT INTO profiles (id) VALUES ($1)`, [otherProfileId]);
      const shimOther = new LivePgSupabaseShim(pgB, otherProfileId);
      const versionIdOwnedByA = await seedResumeVersion(shimA, 'resume text for ownership test');
      const { error } = await shimOther.rpc('upsert_resume_analysis', {
        p_resume_version_id: versionIdOwnedByA, p_mode: 'general', p_opportunity_id: null,
        p_job_content_hash: '', p_analysis_version: 'v1',
      });
      assert(error?.code === '42501', 'a different authenticated session cannot claim an analysis against another user\'s resume_version_id (real auth.uid() enforcement, not app-level)', JSON.stringify(error));
    }

    console.log('\n2b. A VALID claim (same owner, own resume_version_id) actually succeeds — not just the denial path');
    {
      // REGRESSION TEST for the 2026-10-23 live-run finding (docs/resume-pr-b-live-harness-run-
      // 2026-10-23.md, fixed by migration 038_resume_upsert_analysis_ambiguity_fix.sql): Section 2
      // above only ever exercised the OWNERSHIP-DENIAL path of upsert_resume_analysis(), which is
      // exactly why the "column reference \"id\" is ambiguous" (42702) defect on the SUCCESS path
      // went undetected until the live concurrency race (Section 3) hit it independently. This
      // check calls upsert_resume_analysis() as the SAME profile that owns the resume_version_id —
      // the path that must actually write a row — and asserts it succeeds with no error, a real
      // row id, and wrote === true. Before migration 038, this fails with the same 42702 every
      // single valid call hits; after 038, it must pass.
      const versionIdOwnedByA = await seedResumeVersion(shimA, 'resume text for a valid upsert_resume_analysis call');
      const { data, error } = await shimA.rpc('upsert_resume_analysis', {
        p_resume_version_id: versionIdOwnedByA, p_mode: 'general', p_opportunity_id: null,
        p_job_content_hash: '', p_analysis_version: 'valid-call-regression-v1',
      });
      assert(!error, 'a valid, same-owner call to upsert_resume_analysis() completes with no error (regression for the 42702 ambiguous-column defect)', JSON.stringify(error));
      const row = Array.isArray(data) ? data[0] : data;
      assert(!!(row as { id?: string })?.id, 'the call returns a real row id, not an empty/null id', JSON.stringify(row));
      assert((row as { wrote?: boolean })?.wrote === true, 'wrote is true for a genuinely new row', JSON.stringify(row));
    }

    console.log('\n3. Genuine concurrent race — two independent connections, identical key');
    {
      // SCOPED TO THIS HARNESS PROCESS ONLY: setting process.env here mutates only this one
      // Node process's environment for the remainder of this script's run — it does not write to
      // any .env file, does not touch the Next.js application's own runtime, and has no effect
      // once this process exits. isResumeIntelligenceEnabled() (src/lib/ai/resume-intelligence-
      // service.ts) reads process.env.RESUME_INTELLIGENCE_ENABLED at call time, so this must be set
      // before analyzeResume() is invoked below, or every call short-circuits at the feature-flag
      // gate before reaching the database at all (exactly what happened in the 2026-10-23 run that
      // never set this — see docs/resume-pr-b-live-harness-run-2026-10-23.md).
      process.env.RESUME_INTELLIGENCE_ENABLED = 'true';
      const content = `race test resume ${Date.now()}`;
      const versionId = await seedResumeVersion(shimA, content);
      const req: AnalyzeRequest = {
        profileId, fullName: null, declaredSkills: [], resumeVersionId: versionId,
        resumeText: content, mode: 'general', aiAllowed: true,
      };
      const before = await getProfileCount(pgA, profileId);
      const caller = makeDelayedModelCaller(300 + Math.floor(Math.random() * 200));
      const [resA, resB] = await Promise.all([
        analyzeResume(asSupabaseClient(shimA), req, caller),
        analyzeResume(asSupabaseClient(shimB), req, caller),
      ]);
      const outcomes: Array<{ persisted: boolean }> = [resA, resB];
      const winners = outcomes.filter((r) => r.persisted === true);
      const losers = outcomes.filter((r) => r.persisted === false);
      assert(winners.length === 1, 'exactly one of the two concurrent requests persists a real analysis', JSON.stringify(outcomes));
      assert(losers.length === 1, 'exactly one of the two concurrent requests is turned away (already_in_progress)', JSON.stringify(outcomes));
      const rowCount = await pgA.query<{ n: number }>('SELECT count(*)::int AS n FROM resume_analyses WHERE resume_version_id = $1', [versionId]);
      assert(rowCount.rows[0].n === 1, 'exactly one resume_analyses row exists for this key — no duplicate row from the race', JSON.stringify(rowCount.rows));
      const after = await getProfileCount(pgA, profileId);
      assert(after === before + 1, 'quota was consumed exactly once, not twice, by the race (loser never reserved quota)', `before=${before} after=${after}`);
    }

    console.log('\n4. Abandoned-claim recovery (pending row older than the 3-minute window)');
    {
      const content = `abandoned claim test ${Date.now()}`;
      const versionId = await seedResumeVersion(shimA, content);
      const claim = await shimA.rpc('upsert_resume_analysis', {
        p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
        p_job_content_hash: '', p_analysis_version: 'resume-v1',
      });
      assert(!claim.error, 'initial pending claim succeeds', JSON.stringify(claim));
      // Backdate created_at past the 3-minute window — test-only direct SQL, scoped to exactly the
      // one row this run just created (by versionId), simulating a crashed process that never
      // finalized its claim. Not something production code ever does.
      await pgA.query(`UPDATE resume_analyses SET created_at = now() - interval '4 minutes' WHERE resume_version_id = $1`, [versionId]);
      const reclaim = await shimB.rpc('upsert_resume_analysis', {
        p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
        p_job_content_hash: '', p_analysis_version: 'resume-v1',
      });
      const reclaimRow = Array.isArray(reclaim.data) ? reclaim.data[0] : reclaim.data;
      assert((reclaimRow as { wrote?: boolean })?.wrote === true, 'a NEW request can reclaim an abandoned (>3min) pending row', JSON.stringify(reclaim));
    }

    console.log('\n5. Migration 039 review evidence — sequential (non-racing) edge cases against the new WHERE guard');
    {
      // PREPARED AND RUN 2026-10-30, as part of the focused review of migration 039 requested
      // after Section 3 was fixed. These are deliberately SEQUENTIAL (one call fully completes
      // before the next starts) — they isolate the pre-existing early-return IF branches
      // (unchanged by 039) from the new ON CONFLICT ... WHERE guard, and confirm 039 did not
      // alter behavior for any case that doesn't involve two truly concurrent first writes.

      console.log('  5a. An existing FAILED analysis (unavailable) is overwritten by a fresh retry');
      {
        // Migration 041 restructuring: the "existing failed row" precondition is now set up via
        // claim + finalize_resume_analysis (the only path that can ever write a terminal status),
        // not a direct upsert_resume_analysis call — the retry claim itself is still
        // upsert_resume_analysis, unchanged in spirit from before 041.
        const content = `failed-then-retry test ${Date.now()}`;
        const versionId = await seedResumeVersion(shimA, content);
        const claim = await shimA.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const claimRow = Array.isArray(claim.data) ? claim.data[0] : claim.data;
        assert(!claim.error && (claimRow as { wrote?: boolean })?.wrote === true, '5a: the initial pending claim succeeds', JSON.stringify(claim));
        const first = await shimA.rpc('finalize_resume_analysis', {
          p_analysis_id: (claimRow as { id: string }).id, p_expected_attempt_number: (claimRow as { attempt_number: number }).attempt_number,
          p_status: 'unavailable', p_result: null, p_source_ai: false, p_model: null, p_prompt_tokens: null, p_completion_tokens: null, p_cost_usd: null,
        });
        const firstRow = Array.isArray(first.data) ? first.data[0] : first.data;
        assert(!first.error && (firstRow as { finalized?: boolean })?.finalized === true, '5a: the "unavailable" finalize succeeds', JSON.stringify(first));
        const retry = await shimA.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const retryRow = Array.isArray(retry.data) ? retry.data[0] : retry.data;
        assert(!retry.error && (retryRow as { wrote?: boolean })?.wrote === true, '5a: a fresh retry claim overwrites the prior failed row (unchanged reclaim behavior — only success and live-pending are protected)', JSON.stringify(retry));
        assert((retryRow as { id?: string })?.id === (claimRow as { id?: string })?.id, '5a: the retry updates the SAME row (same unique key), not a duplicate', JSON.stringify({ claim: claimRow, retry: retryRow }));
      }

      console.log('  5b. An existing SUCCESS is never overwritten by a later claim OR a later finalize, even after 041');
      {
        const content = `success-protected test ${Date.now()}`;
        const versionId = await seedResumeVersion(shimA, content);
        const claim = await shimA.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const claimRow = Array.isArray(claim.data) ? claim.data[0] : claim.data;
        const claimedId = (claimRow as { id: string }).id;
        const claimedAttempt = (claimRow as { attempt_number: number }).attempt_number;
        const success = await shimA.rpc('finalize_resume_analysis', {
          p_analysis_id: claimedId, p_expected_attempt_number: claimedAttempt,
          p_status: 'success', p_result: { ok: true }, p_source_ai: true, p_model: 'test', p_prompt_tokens: 1, p_completion_tokens: 1, p_cost_usd: 0.001,
        });
        const successRow = Array.isArray(success.data) ? success.data[0] : success.data;
        assert(!success.error && (successRow as { finalized?: boolean })?.finalized === true, '5b: the success finalize succeeds', JSON.stringify(success));

        // (a) A later CLAIM attempt (a brand-new request for this same key) must be rejected by
        // upsert_resume_analysis's own prior-success-clobber guard — unchanged in spirit from
        // before 041, now simplified since the claim path only ever tries to write 'pending'.
        const lateClaim = await shimB.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const lateClaimRow = Array.isArray(lateClaim.data) ? lateClaim.data[0] : lateClaim.data;
        assert(!lateClaim.error && (lateClaimRow as { wrote?: boolean })?.wrote === false, '5b(a): a later claim attempt reports wrote=false — no misleading persistence metadata', JSON.stringify(lateClaim));
        assert((lateClaimRow as { id?: string })?.id === claimedId, '5b(a): it still returns the REAL (success) row id, not null/empty', JSON.stringify({ success: successRow, lateClaim: lateClaimRow }));

        // (b) A stale FINALIZE for the SAME attempt that already succeeded must be rejected by
        // finalize_resume_analysis's own ownership check (status is no longer 'pending') — the
        // NEW guard migration 041 adds, exercised here directly.
        const staleFinalize = await shimA.rpc('finalize_resume_analysis', {
          p_analysis_id: claimedId, p_expected_attempt_number: claimedAttempt,
          p_status: 'unavailable', p_result: null, p_source_ai: false, p_model: null, p_prompt_tokens: null, p_completion_tokens: null, p_cost_usd: null,
        });
        const staleFinalizeRow = Array.isArray(staleFinalize.data) ? staleFinalize.data[0] : staleFinalize.data;
        assert(!staleFinalize.error && (staleFinalizeRow as { result?: string })?.result === 'stale_attempt', '5b(b): a stale finalize for the already-successful attempt is rejected as stale_attempt (migration 041\'s own guard)', JSON.stringify(staleFinalize));

        const verify = await pgA.query('SELECT status, result FROM resume_analyses WHERE resume_version_id = $1', [versionId]);
        assert(verify.rows[0]?.status === 'success', '5b: the stored row is still status=success — genuinely untouched by either rejected write', JSON.stringify(verify.rows));
      }

      console.log('  5c. A caller arriving AFTER a live (not expired) pending claim already committed is turned away — unambiguous, no quota/metadata leak');
      {
        const content = `live-pending-sequential test ${Date.now()}`;
        const versionId = await seedResumeVersion(shimA, content);
        const firstClaim = await shimA.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const firstClaimRow = Array.isArray(firstClaim.data) ? firstClaim.data[0] : firstClaim.data;
        assert(!firstClaim.error && (firstClaimRow as { wrote?: boolean })?.wrote === true, '5c: the first pending claim succeeds', JSON.stringify(firstClaim));
        // Second caller arrives AFTER the first has already committed (sequential, not racing) —
        // this exercises the pre-existing early-return branch (unchanged by 039/041), confirming
        // neither later fix interferes with it.
        const second = await shimB.rpc('upsert_resume_analysis', {
          p_resume_version_id: versionId, p_mode: 'general', p_opportunity_id: null,
          p_job_content_hash: '', p_analysis_version: 'resume-v1',
        });
        const secondRow = Array.isArray(second.data) ? second.data[0] : second.data;
        assert(!second.error && (secondRow as { wrote?: boolean })?.wrote === false, '5c: the second, later caller is unambiguously turned away (wrote=false) by the still-live pending claim', JSON.stringify(second));
        assert((secondRow as { id?: string })?.id === (firstClaimRow as { id?: string })?.id, '5c: it returns the real, existing claim\'s id — never a fabricated or empty one', JSON.stringify({ first: firstClaimRow, second: secondRow }));
      }
    }

    console.log('\n' + '='.repeat(78));
    console.log(`RESULT: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(78));
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    // CLEANUP/CONNECTION RESILIENCE: every cleanup operation and every connection close is
    // attempted independently (each in its own try/catch) so that one failure never prevents the
    // rest from being attempted, and so every client that was actually opened is always given a
    // best-effort close — on the success path, on a thrown error from the test body above, AND on
    // a connection failure partway through startup (profileId/otherProfileId simply stay empty in
    // that case, so the scoped deletes below correctly do nothing). Every deletion remains scoped
    // ONLY to profileId (this run's own marker-derived id) or otherProfileId (generated fresh by
    // this run, above) — never a hardcoded constant, never a broader pattern. Failures are
    // reported explicitly, never silently swallowed as "cleanup complete."
    const cleanupFailures: string[] = [];

    const tryCleanupStep = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        cleanupFailures.push(`${label}: ${(err as Error).message}`);
      }
    };

    if (profileId) {
      await tryCleanupStep('delete resume_analyses', () =>
        pgA.query(`DELETE FROM resume_analyses WHERE resume_version_id IN (SELECT id FROM resume_versions WHERE profile_id = $1)`, [profileId]));
      await tryCleanupStep('delete resume_versions', () =>
        pgA.query(`DELETE FROM resume_versions WHERE profile_id = $1`, [profileId]));
      await tryCleanupStep('delete profiles row (primary test profile)', () =>
        pgA.query(`DELETE FROM profiles WHERE id = $1`, [profileId]));
      await tryCleanupStep('delete _resume_pr_b_live_audit_run marker row', () =>
        pgA.query(`DELETE FROM public._resume_pr_b_live_audit_run WHERE profile_id = $1`, [profileId]));
    }
    if (otherProfileId) {
      await tryCleanupStep('delete profiles row (secondary/ownership-test profile)', () =>
        pgA.query(`DELETE FROM profiles WHERE id = $1`, [otherProfileId]));
    }

    if (cleanupFailures.length > 0) {
      console.error('\nCLEANUP INCOMPLETE — the following step(s) failed and this run\'s rows may still be present (manual removal may be required, scoped to these exact ids):');
      for (const f of cleanupFailures) console.error(`  - ${f}`);
      if (profileId) console.error(`  profileId: ${profileId}`);
      if (otherProfileId) console.error(`  otherProfileId: ${otherProfileId}`);
      process.exitCode = process.exitCode && process.exitCode !== 0 ? process.exitCode : 3;
    } else if (profileId || otherProfileId) {
      console.log('\nCleanup completed: every row this run created has been removed.');
    }

    // Best-effort close of every client that was actually opened — independent of each other and
    // of any cleanup failure above, so a dangling connection never survives this function.
    if (pgAConnected) {
      try { await pgA.end(); } catch (err) { console.error(`Failed to close connection A cleanly: ${(err as Error).message}`); }
    }
    if (pgBConnected) {
      try { await pgB.end(); } catch (err) { console.error(`Failed to close connection B cleanly: ${(err as Error).message}`); }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 2; });

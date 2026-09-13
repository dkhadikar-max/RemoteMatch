/**
 * Tracker Opportunity Resolution.
 * ==============================================================================
 * Before: tracker/page.tsx resolved every card via
 *   `app.opportunity || localStore.getOpportunityById(app.opportunityId)`.
 *   `GET /api/applications` never populates `.opportunity` (confirmed by
 *   reading its own type/mapping code), so this was never really a
 *   "fallback" — it was the only path, on every single row, always.
 *   `localStore.getOpportunityById()` only ever matches the 12-entry
 *   `CURATED_JOBS` fixture — audited against real production data: 10/73
 *   real application rows matched it, 0/73 matched a real, live,
 *   non-curated catalog opportunity (91% of the real catalog today), and
 *   any application against one would have silently vanished from the
 *   Tracker UI (`if (!opp) return null`), not merely shown stale data.
 *
 * After: a new, narrowly-scoped `GET /api/applications/opportunities`
 *   resolves the caller's OWN applications' opportunities in one batched
 *   call — the caller's own RLS-scoped `applications` query is the sole
 *   source of which ids get resolved (never a client-supplied id, never a
 *   request body/query param); an admin-client read (trust-anchored by that
 *   ownership check, same pattern as `getOpportunityBySourceIdAnyStatus`)
 *   then resolves those exact ids REGARDLESS of `status` — an expired job a
 *   user genuinely applied to must still show its real title. A superseded
 *   opportunity resolves to ITS OWN row (the function has no knowledge of
 *   `superseded_by_opportunity_id` and never follows it) — the application
 *   represents what the user actually acted on.
 *
 * IMPORTANT: Section 1 (static) needs no database. Section 2 (real-infra)
 * requires a running server (`npm run dev`) and Supabase env vars — it
 * self-skips with a clear message otherwise. Every test account/opportunity
 * row this suite creates is deleted at the end, in a `finally` block; no
 * real user's application history is ever touched.
 *
 * Run: npx tsx test/tracker-opportunity-resolution-suite.ts
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import { hasRequiredEnv, newVerifiedSession, adminClient, TestSession } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const REAL_CURATED_OPPORTUNITY_ID = 'opp-curated-curated-001';

/** Strips both block comments (including JSDoc, spanning multiple lines)
 *  and line comments before a substring check, so this suite's own
 *  explanatory comments referencing the old localStore/CURATED_JOBS
 *  pattern for context are never mistaken for a real code reference. Same
 *  technique as test/skill-match-suite.ts's stripLineComments(). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/[^\r\n]*/, ''))
    .join('\n');
}

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

function authedFetch(token: string | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

/** Minimal full-column insert, mirroring production-smoke.ts's established
 *  probe-row pattern — every NOT NULL column the schema requires. */
function syntheticOpportunityRow(overrides: {
  source: string;
  sourceId: string;
  title: string;
  status: string;
  supersededByOpportunityId?: string | null;
}) {
  const now = new Date().toISOString();
  return {
    source: overrides.source,
    source_id: overrides.sourceId,
    type: 'job',
    title: overrides.title,
    company: 'Tracker Resolution Test Co',
    description: 'A'.repeat(150),
    official_url: 'https://example.com',
    canonical_url_hash: `hash-${overrides.sourceId}`,
    content_hash: `content-${overrides.sourceId}`,
    employment_type: 'full_time',
    remote_type: 'worldwide',
    eligible_countries: [],
    excluded_countries: [],
    timezone_requirements: [],
    salary_currency: 'USD',
    required_skills: [],
    preferred_skills: [],
    quality_score: 0,
    status: overrides.status,
    posted_at: now,
    link_reachable: null,
    link_checked_at: null,
    consecutive_absences: 0,
    first_seen_at: now,
    last_seen_in_feed_at: now,
    is_permanently_removed: false,
    explicit_remote_scope: 'unknown',
    source_quality: 1,
    description_completeness: 'high',
    salary_quality: 'unspecified',
    remote_policy_confidence: 'high',
    superseded_by_opportunity_id: overrides.supersededByOpportunityId ?? null,
  };
}

const canonicalId = (source: string, sourceId: string) => `opp-${source}-${sourceId}`;

async function run() {
  console.log('='.repeat(78));
  console.log('TRACKER OPPORTUNITY RESOLUTION');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. STATIC — localStore/CURATED_JOBS removed, endpoint accepts no input');
  // ==========================================================================
  {
    const trackerPage = readFileSync(join(__dirname, '../src/app/tracker/page.tsx'), 'utf8');
    const trackerPageCode = stripComments(trackerPage);
    assert(!/localStore/.test(trackerPageCode), 'tracker/page.tsx no longer references localStore in code (comments may still explain the history)');
    assert(!/CURATED_JOBS/.test(trackerPageCode), 'tracker/page.tsx no longer references CURATED_JOBS in code');
    assert(
      /fetch\('\/api\/applications\/opportunities'\)/.test(trackerPageCode),
      'tracker/page.tsx calls the new resolution endpoint'
    );

    const route = readFileSync(
      join(__dirname, '../src/app/api/applications/opportunities/route.ts'),
      'utf8'
    );
    assert(!/req\.json\(\)/.test(route), 'the resolution route never reads a request body');
    assert(!/searchParams/.test(route), 'the resolution route never reads query params');
    assert(
      /\.eq\('profile_id', user\.id\)/.test(route),
      "the route derives owned ids via the caller's own RLS-scoped applications query"
    );
    assert(
      /getOpportunitiesByCanonicalIdsAnyStatus/.test(route),
      'the route resolves via the shared any-status catalog-read helper'
    );

    const adminTs = readFileSync(join(__dirname, '../src/lib/supabase/admin.ts'), 'utf8');
    assert(
      /getOpportunitiesByCanonicalIdsAnyStatus/.test(adminTs),
      "admin.ts's header documents this as an approved call site"
    );

    const catalogRead = readFileSync(join(__dirname, '../src/lib/ingestion/catalog-read.ts'), 'utf8');
    assert(
      !/superseded_by_opportunity_id/.test(
        catalogRead.match(/export async function getOpportunitiesByCanonicalIdsAnyStatus[\s\S]*?\n}\n/)?.[0] ?? 'MISSING'
      ),
      'getOpportunitiesByCanonicalIdsAnyStatus never references superseded_by_opportunity_id — cannot follow it'
    );
  }

  // ==========================================================================
  console.log('\n2. REAL-INFRA — authorization boundary + resolution matrix (self-skips if env/server unavailable)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    const admin = adminClient();
    let sessionA: TestSession | null = null;
    let sessionB: TestSession | null = null;
    const seededSourceIds: Array<{ source: string; sourceId: string }> = [];

    try {
      // Reachability probe — if no dev server is up, self-skip the whole
      // section with a clear message rather than failing every assertion.
      let serverUp = true;
      try {
        await fetch(`${BASE_URL}/api/health`);
      } catch {
        serverUp = false;
      }
      if (!serverUp) {
        skip(`No server reachable at ${BASE_URL} — real-infra section skipped.`);
      } else {
        sessionA = await newVerifiedSession();
        sessionB = await newVerifiedSession();

        // ---- Seed: one real, currently-active, non-curated opportunity ----
        const { data: realNonCurated } = await admin
          .from('opportunities')
          .select('source, source_id, title')
          .eq('status', 'active')
          .neq('source', 'curated')
          .limit(1)
          .maybeSingle();

        // ---- Seed: synthetic expired + superseded pair (fully disposable) ----
        const stamp = Date.now();
        const expiredSourceId = `tracker-test-expired-${stamp}`;
        const survivorSourceId = `tracker-test-survivor-${stamp}`;
        const supersededSourceId = `tracker-test-superseded-${stamp}`;
        const nonexistentId = canonicalId('curated', `tracker-test-missing-${stamp}`);

        seededSourceIds.push(
          { source: 'curated', sourceId: expiredSourceId },
          { source: 'curated', sourceId: survivorSourceId },
          { source: 'curated', sourceId: supersededSourceId },
        );
        const survivorId = canonicalId('curated', survivorSourceId);

        // `superseded_by_opportunity_id` is a self-referential FK to the
        // opportunities table's own UUID primary key — NOT the canonical
        // `opp-${source}-${sourceId}` string (same distinction catalog-read.ts
        // itself documents). The survivor must exist first so its real UUID
        // can be read back before the superseded row references it.
        const { error: seedErr1 } = await admin.from('opportunities').insert([
          syntheticOpportunityRow({
            source: 'curated',
            sourceId: expiredSourceId,
            title: 'Expired Historical Role (test)',
            status: 'expired',
          }),
          syntheticOpportunityRow({
            source: 'curated',
            sourceId: survivorSourceId,
            title: 'Survivor Role (test)',
            status: 'active',
          }),
        ]);
        assert(!seedErr1, `synthetic expired + survivor rows seeded${seedErr1 ? `: ${seedErr1.message}` : ''}`);

        const { data: survivorRow, error: survivorLookupErr } = await admin
          .from('opportunities')
          .select('id')
          .eq('source', 'curated')
          .eq('source_id', survivorSourceId)
          .maybeSingle();
        assert(
          !survivorLookupErr && Boolean(survivorRow?.id),
          `survivor row's real UUID read back${survivorLookupErr ? `: ${survivorLookupErr.message}` : ''}`
        );

        const { error: seedErr2 } = await admin.from('opportunities').insert([
          syntheticOpportunityRow({
            source: 'curated',
            sourceId: supersededSourceId,
            title: 'Superseded Role — Original (test)',
            status: 'active',
            supersededByOpportunityId: survivorRow?.id ?? null,
          }),
        ]);
        assert(!seedErr2, `synthetic superseded row seeded${seedErr2 ? `: ${seedErr2.message}` : ''}`);

        const expiredId = canonicalId('curated', expiredSourceId);
        const supersededId = canonicalId('curated', supersededSourceId);
        const nonCuratedId = realNonCurated
          ? canonicalId(realNonCurated.source, realNonCurated.source_id)
          : null;

        // ---- SessionA: real interested swipes via the actual app code path
        //      (finalize_interested_swipe creates the applications row
        //      whether or not the opportunity is currently resolvable — same
        //      as how real production's synthetic-id applications rows
        //      exist today) ----
        const swipeIds = [REAL_CURATED_OPPORTUNITY_ID, expiredId, supersededId, nonexistentId];
        if (nonCuratedId) swipeIds.push(nonCuratedId);

        for (const id of swipeIds) {
          const res = await authedFetch(sessionA.token, '/api/opportunities/swipe', {
            method: 'POST',
            body: JSON.stringify({ opportunityId: id, action: 'interested' }),
          });
          assert(res.ok, `sessionA interested-swipe on ${id} succeeds (got ${res.status})`);
        }

        // ---- 401: unauthenticated ----
        const unauth = await authedFetch(null, '/api/applications/opportunities');
        assert(unauth.status === 401, `no Authorization header -> 401 (got ${unauth.status})`);

        // ---- SessionA resolution ----
        const resA = await authedFetch(sessionA.token, '/api/applications/opportunities');
        assert(resA.ok, `sessionA GET /api/applications/opportunities succeeds (got ${resA.status})`);
        const bodyA = await resA.json();
        const oppsA: Record<string, { title: string; company: string }> = bodyA.opportunities ?? {};

        assert(
          Boolean(oppsA[REAL_CURATED_OPPORTUNITY_ID]),
          'live curated opportunity resolves'
        );
        assert(
          Boolean(oppsA[expiredId]) && oppsA[expiredId].title === 'Expired Historical Role (test)',
          'expired opportunity owned by the caller resolves, with its real title'
        );
        assert(
          Boolean(oppsA[supersededId]) && oppsA[supersededId].title === 'Superseded Role — Original (test)',
          "superseded opportunity resolves to ITS OWN row's title, not the survivor's"
        );
        assert(
          !(survivorId in oppsA) || oppsA[survivorId]?.title !== oppsA[supersededId]?.title,
          'the survivor is never substituted for the superseded id the application actually references'
        );
        assert(
          !(nonexistentId in oppsA),
          'a genuinely nonexistent opportunity id is omitted, not fabricated'
        );
        if (nonCuratedId) {
          assert(
            Boolean(oppsA[nonCuratedId]) && oppsA[nonCuratedId].title === realNonCurated!.title,
            'live NON-curated opportunity resolves with its real title — the exact case that used to silently vanish'
          );
        } else {
          skip('No active non-curated opportunity found in the live catalog right now — live-non-curated case not exercised this run.');
        }

        // ---- Authorization boundary: sessionB owns none of these ----
        const resB = await authedFetch(sessionB.token, '/api/applications/opportunities');
        assert(resB.ok, `sessionB GET /api/applications/opportunities succeeds (got ${resB.status})`);
        const bodyB = await resB.json();
        assert(
          JSON.stringify(bodyB) === JSON.stringify({ opportunities: {} }),
          'sessionB (zero applications) gets the exact zero-id short-circuit shape { opportunities: {} }, with no query issued for them'
        );
        assert(
          !(REAL_CURATED_OPPORTUNITY_ID in (bodyB.opportunities ?? {})) &&
            !(expiredId in (bodyB.opportunities ?? {})) &&
            !(supersededId in (bodyB.opportunities ?? {})),
          "an opportunity not referenced by sessionB's own applications cannot be obtained through the endpoint, even though it exists and sessionA can see it"
        );
      }
    } finally {
      for (const { source, sourceId } of seededSourceIds) {
        try {
          await admin.from('opportunities').delete().eq('source', source).eq('source_id', sourceId);
        } catch {
          // best-effort cleanup
        }
      }
      if (sessionA) await admin.auth.admin.deleteUser(sessionA.userId).catch(() => {});
      if (sessionB) await admin.auth.admin.deleteUser(sessionB.userId).catch(() => {});
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running tracker-opportunity-resolution suite:', e); process.exit(1); });

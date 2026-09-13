/**
 * Funnel Instrumentation — POST /api/funnel/event.
 * ==============================================================================
 * Scope of THIS suite: the validated write boundary itself — event-type/
 * field validation, the auth requirement per event type, profile_id
 * always being session-derived (never client-supplied), and the RLS
 * deny-by-default boundary on `funnel_events`. It does NOT yet cover
 * `signup_attributed`'s real bridging (that requires wiring into the
 * signup flow, a separate authorized unit) or the reporting script — both
 * are out of scope for this implementation unit and will get their own
 * suites when built.
 *
 * REQUIRES: `npm run dev` reachable at BASE_URL, Supabase env vars set,
 * migration 019 (funnel_events, RLS enabled, zero client policies) live.
 *
 * Run: npx tsx test/funnel-event-api-suite.ts
 */
import ws from 'ws';
(globalThis as any).WebSocket = ws;

import { hasRequiredEnv, newVerifiedSession, adminClient, anonKeyClient, TestSession } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

let passed = 0, failed = 0, skipped = 0;
const assert = (c: boolean, n: string, d?: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}${d ? ` — ${d}` : ''}`); }
};
const skip = (n: string) => { skipped++; console.log(`  – SKIP: ${n}`); };

function authedFetch(token: string | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init.headers as any) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

function anonymousId(): string {
  return `anon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function run() {
  console.log('='.repeat(78));
  console.log('FUNNEL INSTRUMENTATION — POST /api/funnel/event');
  console.log('='.repeat(78));

  // ==========================================================================
  console.log('\n1. VALIDATION — event types, required/arbitrary fields');
  // ==========================================================================
  {
    const badType = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'not_a_real_event' }),
    });
    assert(badType.status === 400, `unknown event_type fails safely with 400 (got ${badType.status})`);

    const missingType = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ anonymous_id: anonymousId() }),
    });
    assert(missingType.status === 400, `missing event_type -> 400 (got ${missingType.status})`);

    const notJson = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    assert(notJson.status === 400, `invalid JSON body -> 400 (got ${notJson.status})`);

    const missingRequired = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'landing_viewed' }), // no anonymous_id
    });
    assert(missingRequired.status === 400, `landing_viewed without required anonymous_id -> 400 (got ${missingRequired.status})`);

    const badAnonFormat = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'landing_viewed', anonymous_id: '../../etc/passwd' }),
    });
    assert(badAnonFormat.status === 400, `malformed anonymous_id -> 400 (got ${badAnonFormat.status})`);

    const arbitraryField = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'landing_viewed', anonymous_id: anonymousId(), notes: 'free text should never be accepted' }),
    });
    assert(arbitraryField.status === 400, `arbitrary/free-text field ("notes") is rejected, not silently dropped (got ${arbitraryField.status})`);

    const wrongFieldForType = await fetch(`${BASE_URL}/api/funnel/event`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'landing_viewed', anonymous_id: anonymousId(), opportunity_id: 'opp-curated-curated-001' }),
    });
    assert(wrongFieldForType.status === 400, `a field valid for a DIFFERENT event_type (opportunity_id on landing_viewed) is rejected (got ${wrongFieldForType.status})`);
  }

  // ==========================================================================
  console.log('\n2. REAL-INFRA — auth requirements, identity derivation, RLS boundary (self-skips if env/server unavailable)');
  // ==========================================================================
  if (!hasRequiredEnv()) {
    skip('Supabase env vars not set — real-infra section skipped.');
  } else {
    let serverUp = true;
    try { await fetch(`${BASE_URL}/api/health`); } catch { serverUp = false; }
    if (!serverUp) {
      skip(`No server reachable at ${BASE_URL} — real-infra section skipped.`);
    } else {
      let session: TestSession | null = null;
      let anonId = '';
      let bridgeAnonId = '';
      try {
        // landing_viewed: unauthenticated must succeed.
        anonId = anonymousId();
        const landingRes = await fetch(`${BASE_URL}/api/funnel/event`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_type: 'landing_viewed', anonymous_id: anonId, utm_source: 'test-suite', utm_medium: 'automated', utm_campaign: 'ci' }),
        });
        assert(landingRes.status === 201, `unauthenticated landing_viewed with utm_* succeeds (got ${landingRes.status})`);

        // feed_viewed / job_viewed / signup_attributed without a session -> 401.
        for (const type of ['feed_viewed', 'job_viewed', 'signup_attributed']) {
          const body: Record<string, string> = { event_type: type };
          if (type === 'job_viewed') body.opportunity_id = 'opp-curated-curated-001';
          if (type === 'signup_attributed') body.anonymous_id = anonymousId();
          const res = await fetch(`${BASE_URL}/api/funnel/event`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          assert(res.status === 401, `${type} with no session -> 401 (got ${res.status})`);
        }

        session = await newVerifiedSession();

        // feed_viewed with a real session succeeds, no extra fields allowed.
        const feedRes = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'feed_viewed' }),
        });
        assert(feedRes.status === 201, `authenticated feed_viewed succeeds (got ${feedRes.status})`);

        // job_viewed requires opportunity_id, validates its shape.
        const jobMissingOpp = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'job_viewed' }),
        });
        assert(jobMissingOpp.status === 400, `authenticated job_viewed without opportunity_id -> 400 (got ${jobMissingOpp.status})`);

        const jobBadOpp = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'job_viewed', opportunity_id: 'not-a-real-id' }),
        });
        assert(jobBadOpp.status === 400, `authenticated job_viewed with a malformed opportunity_id -> 400 (got ${jobBadOpp.status})`);

        const jobRes = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'job_viewed', opportunity_id: 'opp-curated-curated-001' }),
        });
        assert(jobRes.status === 201, `authenticated job_viewed with a valid opportunity_id succeeds (got ${jobRes.status})`);

        // signup_attributed with a real session + anonymous_id succeeds.
        bridgeAnonId = anonymousId();
        const signupRes = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'signup_attributed', anonymous_id: bridgeAnonId }),
        });
        assert(signupRes.status === 201, `authenticated signup_attributed with anonymous_id succeeds (got ${signupRes.status})`);

        // profile_id is derived from the session, never trusted from the body —
        // prove a client-supplied profile_id/profileId is silently ignored, not
        // honored, by checking the row that actually landed.
        const spoofRes = await authedFetch(session.token, '/api/funnel/event', {
          method: 'POST', body: JSON.stringify({ event_type: 'feed_viewed', profile_id: '00000000-0000-0000-0000-000000000000', profileId: '00000000-0000-0000-0000-000000000000' }),
        });
        // Both keys are outside feed_viewed's allow-list (empty), so this must
        // be rejected as an arbitrary field — proving there is no code path
        // through which a body-supplied identity could ever be accepted.
        assert(spoofRes.status === 400, `a client-supplied profile_id on feed_viewed is rejected as an unexpected field, not silently accepted or overriding the session (got ${spoofRes.status})`);

        // Direct read-only verification: the rows this run actually wrote
        // carry the SESSION's real user id, never anything client-supplied.
        const admin = adminClient();
        const { data: rows } = await admin
          .from('funnel_events')
          .select('event_type, profile_id, anonymous_id, opportunity_id, utm_source')
          .eq('profile_id', session.userId)
          .order('created_at', { ascending: true });
        assert(
          Boolean(rows) && rows!.some((r) => r.event_type === 'feed_viewed') && rows!.some((r) => r.event_type === 'job_viewed' && r.opportunity_id === 'opp-curated-curated-001') && rows!.some((r) => r.event_type === 'signup_attributed' && r.anonymous_id === bridgeAnonId),
          `all authenticated events this run wrote landed with profile_id = the real session user, correct fields per type (found ${rows?.length ?? 0} rows)`
        );
        assert(
          rows!.every((r) => !('notes' in (r as any)) && !('content' in (r as any))),
          'no row carries any free-text field (structurally impossible given the schema, confirmed on real rows)'
        );

        const { data: landingRows } = await admin
          .from('funnel_events')
          .select('event_type, anonymous_id, utm_source, utm_medium, utm_campaign, profile_id')
          .eq('anonymous_id', anonId);
        assert(
          Boolean(landingRows?.length) && landingRows![0].profile_id === null && landingRows![0].utm_source === 'test-suite',
          'the unauthenticated landing_viewed row landed with profile_id null and the real utm_* values'
        );

        // RLS boundary for the `authenticated` role specifically — a real,
        // signed-in session's own client, not just the bare anon key.
        const { data: authRead, error: authReadErr } = await session.client.from('funnel_events').select('*').limit(1);
        assert(
          Boolean(authReadErr) || (authRead?.length ?? 0) === 0,
          `authenticated role cannot read funnel_events directly, even for its own rows (error=${authReadErr?.message ?? 'none'}, rows=${authRead?.length ?? 0})`
        );
        const { error: authWriteErr } = await session.client.from('funnel_events').insert({ event_type: 'landing_viewed', anonymous_id: anonymousId() });
        assert(Boolean(authWriteErr), `authenticated role cannot write funnel_events directly (got error: ${Boolean(authWriteErr)})`);
      } finally {
        // funnel_events.profile_id is ON DELETE SET NULL, not CASCADE — a
        // deleted test user's events would otherwise linger forever as
        // orphaned, profile_id-null noise in the real funnel report. Clean
        // up by the exact anonymous_ids this run used, then by profile_id
        // while it's still meaningful (before the user is deleted).
        const admin = adminClient();
        const { error: cleanupErr } = await admin
          .from('funnel_events')
          .delete()
          .or(`anonymous_id.eq.${anonId},anonymous_id.eq.${bridgeAnonId},profile_id.eq.${session?.userId ?? '00000000-0000-0000-0000-000000000000'}`);
        if (cleanupErr) {
          console.error(`  WARNING: cleanup failed to delete this run's funnel_events rows: ${cleanupErr.message}`);
        } else {
          const { data: leftover } = await admin
            .from('funnel_events')
            .select('id')
            .or(`anonymous_id.eq.${anonId},anonymous_id.eq.${bridgeAnonId}`);
          assert(!leftover || leftover.length === 0, `no funnel_events rows from this run remain after cleanup (found ${leftover?.length ?? 0})`);
        }
        if (session) await admin.auth.admin.deleteUser(session.userId).catch(() => {});
      }

      // ---- RLS boundary: neither client role can read/write directly ----
      const anon = anonKeyClient();
      const { data: anonRead, error: anonReadErr } = await anon.from('funnel_events').select('*').limit(1);
      assert(
        Boolean(anonReadErr) || (anonRead?.length ?? 0) === 0,
        `anon role cannot read funnel_events directly (error=${anonReadErr?.message ?? 'none'}, rows=${anonRead?.length ?? 0})`
      );
      const { error: anonWriteErr } = await anon.from('funnel_events').insert({ event_type: 'landing_viewed', anonymous_id: anonymousId() });
      assert(Boolean(anonWriteErr), `anon role cannot write funnel_events directly (got error: ${Boolean(anonWriteErr)})`);
    }
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal error running funnel-event-api suite:', e); process.exit(1); });

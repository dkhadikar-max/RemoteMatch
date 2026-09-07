/**
 * RemoteMatch — Outcome Data Foundation (P0): application lifecycle suite
 * ==============================================================================
 * Tests the server-authoritative application state machine introduced by
 * supabase/migrations/006_outcome_lifecycle.sql and the compare-and-swap
 * fix in 007_application_transition_cas.sql — the migrations that moved
 * `applied -> interview -> offer/rejected/withdrawn` off client-local
 * `localStorage` (see test/verification-suite.ts's TEST 9 note and
 * src/lib/db/mock-seed.ts's removed methods) and onto real, durable,
 * ownership-scoped, concurrency-safe Supabase state.
 *
 * Like security-remediation-suite.ts and auth-invariant-suite.ts, every test
 * here sends real HTTP requests to a running server and drives real
 * Supabase Auth sessions — this is deliberately not an in-process test of
 * the RPC logic, because the whole point is to prove what a real client can
 * and cannot do to a real application record.
 *
 * REQUIRES: `npm run dev` reachable at BASE_URL, Supabase env vars set,
 * supabase/migrations/001-007 applied.
 *
 * Run: npx tsx test/outcome-lifecycle-suite.ts
 */

import { hasRequiredEnv, newVerifiedSession, adminClient, TestSession } from './helpers/verified-session';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const REAL_OPPORTUNITY_ID = 'opp-curated-curated-001';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function authedFetch(token: string | null, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}

/** Every status transition requires the caller's observed `expectedStatus`
 *  (compare-and-swap — see 007_application_transition_cas.sql). Centralized
 *  here so every call site in this suite states it explicitly rather than
 *  risk a copy-pasted, silently-stale value. */
function patchStatus(
  token: string,
  opportunityId: string,
  expectedStatus: string,
  newStatus: string,
  notes?: string
) {
  return authedFetch(token, '/api/applications/status', {
    method: 'PATCH',
    body: JSON.stringify({ opportunityId, expectedStatus, status: newStatus, notes }),
  });
}

/** A fresh verified user with exactly one 'interested' application, created
 *  the same way the real app creates one — via a real right-swipe. */
async function newSessionWithApplication(): Promise<TestSession> {
  const session = await newVerifiedSession();
  const res = await authedFetch(session.token, '/api/opportunities/swipe', {
    method: 'POST',
    body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, action: 'interested' }),
  });
  if (!res.ok) {
    throw new Error(`Could not set up test application via swipe: ${res.status} ${await res.text()}`);
  }
  return session;
}

async function getApplicationRow(userId: string) {
  const admin = adminClient();
  const { data } = await admin
    .from('applications')
    .select('id, status, notes, applied_at')
    .eq('profile_id', userId)
    .eq('opportunity_id', REAL_OPPORTUNITY_ID)
    .single();
  return data as { id: string; status: string; notes: string; applied_at: string | null } | null;
}

async function getEventRows(applicationId: string) {
  const admin = adminClient();
  const { data } = await admin
    .from('application_events')
    .select('event_type, event_payload, created_at')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  return data ?? [];
}

async function run() {
  console.log('='.repeat(78));
  console.log('REMOTEMATCH — OUTCOME LIFECYCLE SUITE (P0)');
  console.log('='.repeat(78));

  if (!hasRequiredEnv() || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log('\nRequired Supabase env vars are not all set — cannot run this suite.');
    process.exitCode = 1;
    return;
  }

  // ----------------------------------------------------------------------
  // 1. AUTH BOUNDARY (reusing the same invariant every other route enforces)
  // ----------------------------------------------------------------------
  console.log('\n1. AUTH BOUNDARY');
  {
    const noAuthRes = await authedFetch(null, '/api/applications/status', {
      method: 'PATCH',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, expectedStatus: 'interested', status: 'applied' }),
    });
    assert(noAuthRes.status === 401, `PATCH /api/applications/status with no session -> 401 (got ${noAuthRes.status})`);

    const feedbackRes = await authedFetch(null, '/api/applications/feedback', {
      method: 'POST',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, didApply: 'applied' }),
    });
    assert(feedbackRes.status === 401, `POST /api/applications/feedback with no session -> 401 (got ${feedbackRes.status}) — this route had NO auth check before this migration`);

    const listRes = await authedFetch(null, '/api/applications');
    assert(listRes.status === 401, `GET /api/applications with no session -> 401 (got ${listRes.status})`);
  }

  // ----------------------------------------------------------------------
  // 2. HAPPY PATH: full lifecycle, durable events, correct entered_at timing
  // ----------------------------------------------------------------------
  console.log('\n2. HAPPY-PATH LIFECYCLE (interested -> applied -> interview -> offer)');
  {
    const session = await newSessionWithApplication();
    const before = await getApplicationRow(session.userId);
    assert(before?.status === 'interested', `New application starts at "interested" (got ${before?.status})`);

    const toApplied = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');
    assert(toApplied.status === 200, `interested -> applied succeeds with the correct expectedStatus (got ${toApplied.status})`);

    const afterApplied = await getApplicationRow(session.userId);
    assert(afterApplied?.status === 'applied' && Boolean(afterApplied.applied_at), 'applied_at is set exactly when status first becomes "applied"');

    const toInterview = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'interview', 'Technical round Tuesday');
    assert(toInterview.status === 200, `applied -> interview succeeds (got ${toInterview.status})`);

    const toOffer = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interview', 'offer', 'Offer: $150k');
    assert(toOffer.status === 200, `interview -> offer succeeds (got ${toOffer.status})`);

    const finalRow = await getApplicationRow(session.userId);
    assert(finalRow?.status === 'offer', `Final status is "offer" (got ${finalRow?.status})`);

    const events = await getEventRows(finalRow!.id);
    const statusChanges = events.filter((e) => e.event_type === 'status_changed');
    assert(statusChanges.length === 3, `Exactly 3 status_changed events recorded for 3 transitions (got ${statusChanges.length})`);
    assert(
      statusChanges.map((e) => e.event_payload.toStatus).join(',') === 'applied,interview,offer',
      `Event sequence is exactly applied -> interview -> offer (got ${statusChanges.map((e) => e.event_payload.toStatus).join(',')})`
    );
    assert(
      statusChanges.every((e) => !('enteredAt' in (e.event_payload as object))),
      'Event payload does not duplicate a mutable entered_at timestamp — created_at IS the authoritative moment'
    );
  }

  // ----------------------------------------------------------------------
  // 3. INVALID TRANSITIONS ARE REJECTED, PRODUCE NO EVENT
  // ----------------------------------------------------------------------
  console.log('\n3. INVALID TRANSITIONS REJECTED (correct expectedStatus, invalid target)');
  {
    const session = await newSessionWithApplication();
    const row = await getApplicationRow(session.userId);
    const eventsBefore = await getEventRows(row!.id);

    const skipToOffer = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'offer');
    assert(skipToOffer.status === 409, `interested -> offer (skipping applied/interview) is rejected (got ${skipToOffer.status})`);
    const skipBody = await skipToOffer.json().catch(() => ({}));
    assert(skipBody.error === 'invalid_transition', `Rejection reason is "invalid_transition", distinct from status_conflict (got "${skipBody.error}")`);

    const sameState = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'interested');
    assert(sameState.status === 409, `interested -> interested (no-op) is rejected as an invalid transition (got ${sameState.status})`);

    const eventsAfter = await getEventRows(row!.id);
    assert(eventsAfter.length === eventsBefore.length, 'No application_events row was written for either rejected attempt');

    const stillRow = await getApplicationRow(session.userId);
    assert(stillRow?.status === 'interested', 'applications.status is unchanged after the rejected attempts');
  }

  // ----------------------------------------------------------------------
  // 4. STALE expectedStatus IS REJECTED, EVEN WHEN THE TARGET WOULD OTHERWISE
  //    BE A VALID TRANSITION (this is the actual compare-and-swap guarantee)
  // ----------------------------------------------------------------------
  console.log('\n4. STALE expectedStatus -> status_conflict');
  {
    const session = await newSessionWithApplication();
    const row = await getApplicationRow(session.userId);
    const eventsBefore = await getEventRows(row!.id);

    // The application is actually "interested", but the caller claims it
    // observed "applied" — applied -> interview IS otherwise a valid
    // transition, so this proves the CAS check runs, and runs BEFORE
    // transition-validity, not instead of it.
    const staleRes = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'interview');
    assert(staleRes.status === 409, `Transition with a stale expectedStatus is rejected (got ${staleRes.status})`);
    const staleBody = await staleRes.json().catch(() => ({}));
    assert(staleBody.error === 'status_conflict', `Rejection reason is specifically "status_conflict" (got "${staleBody.error}")`);

    const eventsAfter = await getEventRows(row!.id);
    assert(eventsAfter.length === eventsBefore.length, 'No application_events row was written for the stale-expectedStatus attempt');

    const stillRow = await getApplicationRow(session.userId);
    assert(stillRow?.status === 'interested', 'applications.status is unchanged by the stale-expectedStatus attempt');

    // Sanity check: the SAME target transition succeeds once the caller
    // states the status the row is actually at — proves this is genuinely
    // a staleness check, not a broken transition table.
    const correctedRes = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');
    assert(correctedRes.status === 200, `The same application accepts a transition once expectedStatus matches reality (got ${correctedRes.status})`);
  }

  // ----------------------------------------------------------------------
  // 5. TERMINAL STATES DO NOT TRANSITION FURTHER, EXCEPT -> archived
  // ----------------------------------------------------------------------
  console.log('\n5. TERMINAL-STATE RULES (offer/rejected/withdrawn -> archived only)');
  {
    const session = await newSessionWithApplication();
    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');
    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'rejected');

    const backToApplied = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'rejected', 'applied');
    assert(backToApplied.status === 409, `rejected -> applied (reopening a terminal state) is rejected (got ${backToApplied.status})`);

    const toArchived = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'rejected', 'archived');
    assert(toArchived.status === 200, `rejected -> archived is allowed (got ${toArchived.status})`);

    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'archived', 'applications.status is now "archived" (the display state)');

    // The critical requirement: the TRUE outcome must still be recoverable
    // as "rejected" even though the current status is "archived" — this is
    // exactly what get_application_outcome() exists for.
    const admin = adminClient();
    const { data: outcome } = await admin.rpc('get_application_outcome', { p_application_id: row!.id });
    assert(outcome === 'rejected', `get_application_outcome() still resolves to "rejected" after archiving (got "${outcome}")`);

    const events = await getEventRows(row!.id);
    const sequence = events.filter((e) => e.event_type === 'status_changed').map((e) => e.event_payload.toStatus);
    assert(
      sequence.join(',') === 'applied,rejected,archived',
      `Event history preserves the full sequence "...->rejected->archived" (got ${sequence.join(',')})`
    );
  }

  // ----------------------------------------------------------------------
  // 6. withdrawn IS A DISTINCT, GENUINE OUTCOME
  // ----------------------------------------------------------------------
  console.log('\n6. withdrawn AS A DISTINCT OUTCOME');
  {
    const session = await newSessionWithApplication();
    const withdraw = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'withdrawn');
    assert(withdraw.status === 200, `interested -> withdrawn succeeds directly (got ${withdraw.status})`);

    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'withdrawn', 'Status is "withdrawn", distinct from "archived" or "rejected"');

    const toRejected = await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'withdrawn', 'rejected');
    assert(toRejected.status === 409, `withdrawn -> rejected is rejected — withdrawn is terminal except for archiving (got ${toRejected.status})`);
  }

  // ----------------------------------------------------------------------
  // 7. OWNERSHIP: user A cannot transition user B's application
  // ----------------------------------------------------------------------
  console.log('\n7. CROSS-USER OWNERSHIP ENFORCEMENT');
  {
    const userA = await newSessionWithApplication();
    const userB = await newVerifiedSession(); // no application of their own on this opportunity

    const res = await patchStatus(userB.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');
    assert(res.status === 404, `User B transitioning User A's opportunityId (B has no row there) -> 404, not information-leaking (got ${res.status})`);

    const rowA = await getApplicationRow(userA.userId);
    assert(rowA?.status === 'interested', "User A's application is unaffected by User B's attempt");
  }

  // ----------------------------------------------------------------------
  // 8. THE LIVE BYPASS IS CLOSED: direct REST UPDATE on `applications` fails
  // ----------------------------------------------------------------------
  console.log('\n8. DIRECT TABLE MUTATION IS DENIED (closes the pre-existing grant gap)');
  {
    const session = await newSessionWithApplication();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/applications?opportunity_id=eq.${REAL_OPPORTUNITY_ID}&profile_id=eq.${session.userId}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${session.token}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status: 'offer' }),
      }
    );
    const body = await res.text();
    assert(
      res.status === 401 || res.status === 403 || (res.ok && body === '[]'),
      `Direct PostgREST UPDATE on applications.status is refused or updates nothing now that the grant is revoked (got ${res.status}: ${body.slice(0, 200)})`
    );
    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'interested', 'applications.status is unchanged by the direct REST attempt — this is the regression test for the finding closed in 006_outcome_lifecycle.sql');
  }

  // ----------------------------------------------------------------------
  // 9. CONCURRENCY: two requests, both observing "applied", racing to
  //    different targets — exactly one wins, the other gets status_conflict
  //    (not a duplicate "still-valid-from-the-new-state" success). Asserts
  //    the exact DELTA in event count across the race, not an absolute
  //    count, so this test is sensitive to the race outcome specifically,
  //    not to setup history.
  // ----------------------------------------------------------------------
  console.log('\n9. CONCURRENT DIVERGENT TRANSITIONS: exactly one winner');
  {
    const session = await newSessionWithApplication();
    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');

    const row = await getApplicationRow(session.userId);
    const eventsBeforeRace = await getEventRows(row!.id);

    const [toInterview, toRejected] = await Promise.all([
      patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'interview', 'race: interview branch'),
      patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'rejected', 'race: rejected branch'),
    ]);

    const results = [
      { label: 'interview', res: toInterview },
      { label: 'rejected', res: toRejected },
    ];
    const winners = results.filter((r) => r.res.status === 200);
    const losers = results.filter((r) => r.res.status !== 200);

    assert(winners.length === 1, `Exactly one of two concurrent transitions from "applied" succeeds (got ${winners.length})`);
    assert(losers.length === 1 && losers[0].res.status === 409, `The other request is rejected with 409, not silently accepted (got ${losers[0]?.res.status})`);

    if (losers[0]) {
      const loserBody = await losers[0].res.json().catch(() => ({}));
      assert(
        loserBody.error === 'status_conflict',
        `The losing request is rejected specifically as "status_conflict" (it observed "applied", which was no longer current) — not "invalid_transition" (got "${loserBody.error}")`
      );
    }

    const finalRow = await getApplicationRow(session.userId);
    const winnerLabel = winners[0]?.label;
    assert(
      finalRow?.status === winnerLabel,
      `Final status matches whichever request actually won (expected "${winnerLabel}", got "${finalRow?.status}")`
    );

    // Notes correctness under the race: the winner's notes must be the ones
    // that were actually applied — not overwritten or lost, and not the
    // loser's notes leaking through.
    assert(
      finalRow?.notes === `race: ${winnerLabel} branch`,
      `The winning request's notes are the ones persisted (got "${finalRow?.notes}")`
    );

    const eventsAfterRace = await getEventRows(row!.id);
    const newEvents = eventsAfterRace.length - eventsBeforeRace.length;
    assert(
      newEvents === 1,
      `Exactly one new application_events row was written by the race, not two (delta since pre-race count: ${newEvents})`
    );
    const newestEvent = eventsAfterRace[eventsAfterRace.length - 1];
    assert(
      newestEvent.event_type === 'status_changed' && newestEvent.event_payload.toStatus === winnerLabel,
      `The one new event records the winning transition (got ${newestEvent.event_type} -> ${newestEvent.event_payload?.toStatus})`
    );
  }

  // ----------------------------------------------------------------------
  // 10. NORMAL SEQUENTIAL TRANSITIONS ARE UNAFFECTED BY CAS
  //     (each call observes the status the previous call just produced —
  //     the common case, and CAS must not get in its way)
  // ----------------------------------------------------------------------
  console.log('\n10. NORMAL SEQUENTIAL TRANSITIONS STILL WORK');
  {
    const session = await newSessionWithApplication();
    const steps: Array<[string, string]> = [
      ['interested', 'applied'],
      ['applied', 'interview'],
      ['interview', 'rejected'],
      ['rejected', 'archived'],
    ];
    let allSucceeded = true;
    for (const [expected, next] of steps) {
      const res = await patchStatus(session.token, REAL_OPPORTUNITY_ID, expected, next);
      if (res.status !== 200) allSucceeded = false;
    }
    assert(allSucceeded, 'A normal sequential run through 4 transitions, each stating the previous step\'s result as expectedStatus, succeeds end to end');

    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'archived', `Final status after the sequential run is "archived" (got ${row?.status})`);
  }

  // ----------------------------------------------------------------------
  // 11. FEEDBACK: auth + ownership + correct cascade to "applied"
  //     (unaffected by CAS — record_application_feedback() never accepted
  //     a client-claimed target status to compare against)
  // ----------------------------------------------------------------------
  console.log('\n11. APPLICATION FEEDBACK (replaces the previously unauthenticated, non-persisting route)');
  {
    const session = await newSessionWithApplication();
    const res = await authedFetch(session.token, '/api/applications/feedback', {
      method: 'POST',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, didApply: 'applied', notes: 'Applied via official site' }),
    });
    assert(res.status === 200, `Feedback "applied" succeeds (got ${res.status})`);

    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'applied' && Boolean(row.applied_at), 'Feedback "applied" cascades to status="applied" with applied_at set');

    const events = await getEventRows(row!.id);
    assert(events.some((e) => e.event_type === 'feedback_submitted'), 'A feedback_submitted event was recorded');
    assert(events.some((e) => e.event_type === 'status_changed' && e.event_payload.toStatus === 'applied'), 'A status_changed event to "applied" was also recorded in the same call');

    const otherUser = await newVerifiedSession();
    const crossUserRes = await authedFetch(otherUser.token, '/api/applications/feedback', {
      method: 'POST',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, didApply: 'applied' }),
    });
    assert(crossUserRes.status === 404, `Feedback on an application the caller does not own -> 404 (got ${crossUserRes.status})`);
  }

  // ----------------------------------------------------------------------
  // 12. NOTES-ONLY EDITS DO NOT POLLUTE THE TRANSITION HISTORY
  //     (unaffected by CAS — update_application_notes() is not a status
  //     transition and takes no expectedStatus)
  // ----------------------------------------------------------------------
  console.log('\n12. NOTES-ONLY EDIT IS SEPARATE FROM A STATUS TRANSITION');
  {
    const session = await newSessionWithApplication();
    const res = await authedFetch(session.token, '/api/applications/notes', {
      method: 'PATCH',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, notes: 'Just a reminder to follow up' }),
    });
    assert(res.status === 200, `Notes-only update succeeds (got ${res.status})`);

    const row = await getApplicationRow(session.userId);
    assert(row?.status === 'interested', 'Status is unaffected by a notes-only edit');
    assert(row?.notes === 'Just a reminder to follow up', 'Notes were persisted');

    const events = await getEventRows(row!.id);
    assert(events.length === 1 && events[0].event_type === 'note_added', `Exactly one note_added event was recorded, no status_changed event (got ${events.map((e) => e.event_type).join(',')})`);
  }

  // ----------------------------------------------------------------------
  // 13. MALFORMED INPUT -> 400, NO MUTATION
  //     One malformed request per route that actually accepts input, each
  //     matching that route's real validation contract rather than an
  //     artificially-invalid parameter. GET /api/applications takes no
  //     body/query input at all, so there is nothing malformed to send —
  //     no test is manufactured for it (its only failure mode, missing
  //     auth, is already covered in section 1).
  // ----------------------------------------------------------------------
  console.log('\n13. MALFORMED INPUT REJECTED (400), NO DATABASE MUTATION');
  {
    const session = await newSessionWithApplication();
    const row = await getApplicationRow(session.userId);

    // PATCH /api/applications/status — missing expectedStatus entirely
    // (isValidBody requires it to be present and a member of VALID_STATUSES).
    const missingExpected = await authedFetch(session.token, '/api/applications/status', {
      method: 'PATCH',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, status: 'applied' }),
    });
    assert(missingExpected.status === 400, `PATCH /api/applications/status with no expectedStatus field -> 400 (got ${missingExpected.status})`);

    // PATCH /api/applications/status — expectedStatus of the wrong type.
    const wrongTypeExpected = await authedFetch(session.token, '/api/applications/status', {
      method: 'PATCH',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, expectedStatus: 123, status: 'applied' }),
    });
    assert(wrongTypeExpected.status === 400, `PATCH /api/applications/status with a non-string expectedStatus -> 400 (got ${wrongTypeExpected.status})`);

    // PATCH /api/applications/notes — missing the required `notes` field
    // (isValidBody requires it to be a string).
    const missingNotes = await authedFetch(session.token, '/api/applications/notes', {
      method: 'PATCH',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID }),
    });
    assert(missingNotes.status === 400, `PATCH /api/applications/notes with no notes field -> 400 (got ${missingNotes.status})`);

    // POST /api/applications/feedback — missing didApply (isValidBody
    // requires it to be one of the enumerated outcomes).
    const missingDidApply = await authedFetch(session.token, '/api/applications/feedback', {
      method: 'POST',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID }),
    });
    assert(missingDidApply.status === 400, `POST /api/applications/feedback with no didApply field -> 400 (got ${missingDidApply.status})`);

    // POST /api/applications/feedback — didApply outside the enumerated set.
    const invalidDidApply = await authedFetch(session.token, '/api/applications/feedback', {
      method: 'POST',
      body: JSON.stringify({ opportunityId: REAL_OPPORTUNITY_ID, didApply: 'maybe_later' }),
    });
    assert(invalidDidApply.status === 400, `POST /api/applications/feedback with an out-of-enum didApply -> 400 (got ${invalidDidApply.status})`);

    // None of the above should have mutated anything: status unchanged,
    // notes unchanged, no new events written.
    const rowAfter = await getApplicationRow(session.userId);
    assert(rowAfter?.status === 'interested' && rowAfter?.notes === row?.notes, 'No malformed request above changed applications.status or notes');
    const eventsAfter = await getEventRows(row!.id);
    assert(eventsAfter.length === 0, `No malformed request above wrote any application_events row (got ${eventsAfter.length})`);
  }

  // ----------------------------------------------------------------------
  // 14. P0 SUCCESS CRITERION — OUTCOME-DATA INTEGRITY GATE
  //     Every question from the approved P0 scope must be mechanically
  //     answerable from stored data alone, with no client involved:
  //     how many applied, which job, score at decision time, when each
  //     state was entered, time-in-state, proportions reaching each outcome.
  // ----------------------------------------------------------------------
  console.log('\n14. P0 INTEGRITY GATE — full lifecycle answerable from stored data alone');
  {
    const session = await newSessionWithApplication();
    const row = await getApplicationRow(session.userId);

    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interested', 'applied');
    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'applied', 'interview');
    await patchStatus(session.token, REAL_OPPORTUNITY_ID, 'interview', 'offer');

    const admin = adminClient();

    // Q: which job, and what was the RemoteMatch score at decision time?
    const { data: swipe } = await admin
      .from('swipes')
      .select('decision_snapshot')
      .eq('profile_id', session.userId)
      .eq('opportunity_id', REAL_OPPORTUNITY_ID)
      .eq('action', 'interested')
      .single();
    const scoreAtDecision = (swipe?.decision_snapshot as Record<string, unknown> | null)?.fitScore;
    assert(typeof scoreAtDecision === 'number', `Score-at-decision-time is recoverable from swipes.decision_snapshot (got ${scoreAtDecision})`);

    // Q: when did the application enter each state, and how long did it stay?
    const events = await getEventRows(row!.id);
    const statusChanges = events.filter((e) => e.event_type === 'status_changed');
    assert(statusChanges.length === 3, 'Every state entry has its own durably-timestamped event');
    const timestamps = statusChanges.map((e) => new Date(e.created_at as unknown as string).getTime());
    const timeInAppliedMs = timestamps[1] - timestamps[0];
    assert(timeInAppliedMs >= 0, `Time-in-state ("applied" -> "interview") is computable from consecutive event timestamps (${timeInAppliedMs}ms)`);

    // Q: what proportion reached interview / offer / rejected / withdrawn?
    // (Proven mechanically answerable here via get_application_outcome();
    // the actual aggregate reporting query is P1 work, not this gate.)
    const { data: outcome } = await admin.rpc('get_application_outcome', { p_application_id: row!.id });
    assert(outcome === 'offer', `Final resolvable outcome is "offer" (got "${outcome}") — answerable with zero client/localStorage involvement`);

    // Confirm this is durable across "sessions/devices" — re-fetch via a
    // fresh GET, simulating a different device/browser reading the same
    // account back.
    const rereadRes = await authedFetch(session.token, '/api/applications');
    const rereadBody = await rereadRes.json();
    const rereadApp = rereadBody.applications.find((a: { opportunityId: string }) => a.opportunityId === REAL_OPPORTUNITY_ID);
    assert(rereadApp?.status === 'offer', 'The full lifecycle is durable and reappears identically from a fresh GET /api/applications call — not tied to any browser-local state');
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((err) => {
  console.error('Fatal error running outcome-lifecycle suite:', err);
  process.exit(1);
});

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/get-authenticated-user';
import { authErrorResponse } from '@/lib/auth/api-error';
import {
  isFunnelEventType,
  funnelEventRequiresAuth,
  validateFunnelEventBody,
  recordFunnelEvent,
} from '@/lib/funnel/events';

/**
 * Funnel Instrumentation — the single validated write path into
 * `funnel_events`. RLS on that table grants zero access to `anon`/
 * `authenticated` (migration 019) — this route, together with
 * recordFunnelEvent() (src/lib/funnel/events.ts), is the ONLY way a row
 * is ever written.
 *
 * event_type decides everything:
 *   - `landing_viewed` — unauthenticated allowed (the pre-signup,
 *     anonymous top of funnel). Requires `anonymous_id`; optional
 *     first-touch `utm_source`/`utm_medium`/`utm_campaign`.
 *   - `signup_attributed` / `feed_viewed` / `job_viewed` — require a real,
 *     verified session. `profile_id` is ALWAYS derived from that session
 *     here, never accepted from the request body — the same rule every
 *     other mutating route in this codebase follows (see
 *     GET /api/applications/opportunities for the identical pattern).
 *
 * Every field is checked against a fixed per-event-type allow-list
 * (validateFunnelEventBody) — an unrecognized key is a 400, not a
 * silently-ignored extra. There is no free-text field anywhere in this
 * path or in `funnel_events` itself, so resume/application content is
 * structurally unreachable through this route.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const bodyObj = body as Record<string, unknown>;

  const eventType = bodyObj.event_type;
  if (!isFunnelEventType(eventType)) {
    return NextResponse.json({ error: 'Invalid or missing event_type' }, { status: 400 });
  }

  // Identity is resolved once, here, from the verified session only —
  // never from anything in the body. A missing/invalid session is fine
  // for landing_viewed (profileId stays null); every other event type
  // requires one and fails closed if it's absent.
  let profileId: string | null = null;
  try {
    const { user } = await getAuthenticatedUser(req);
    profileId = user.id;
  } catch (err) {
    if (funnelEventRequiresAuth(eventType)) {
      return authErrorResponse(err) ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const validated = validateFunnelEventBody(eventType, bodyObj);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const result = await recordFunnelEvent(eventType, profileId, validated.fields);
  if (!result.ok) {
    return NextResponse.json({ error: 'Could not record event' }, { status: 500 });
  }

  return NextResponse.json({ success: true }, { status: 201 });
}

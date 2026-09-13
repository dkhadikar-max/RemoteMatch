/**
 * Funnel Instrumentation — validated write boundary for `funnel_events`.
 * ==============================================================================
 * RLS on `funnel_events` (migration 019) has zero client policies — `anon`
 * and `authenticated` can neither read nor write it directly. This module,
 * plus the one route that calls it (src/app/api/funnel/event/route.ts), is
 * the ONLY path any row is ever written through.
 *
 * Per the approved spec, only 5 of the 10 funnel steps get a new event at
 * all — the rest (signup started/completed, onboarding completed,
 * interested/passed, application submitted, outcome, and Step 8's Tailored
 * Application Assistance engagement) already have a real persisted source
 * (`profiles`, `auth.users`, `swipes`, `applications`, `generated_materials`)
 * and are read directly from those by the reporting script, never
 * duplicated here.
 *
 * Every field accepted by an event type is enumerated in
 * FUNNEL_EVENT_RULES below — there is no free-text field anywhere in this
 * module or the table itself, structurally preventing resume/application
 * content from ever reaching this table.
 */
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export type FunnelEventType =
  | 'landing_viewed'
  | 'signup_attributed'
  | 'feed_viewed'
  | 'job_viewed';

const FUNNEL_EVENT_TYPES: readonly FunnelEventType[] = [
  'landing_viewed',
  'signup_attributed',
  'feed_viewed',
  'job_viewed',
];

export function isFunnelEventType(value: unknown): value is FunnelEventType {
  return typeof value === 'string' && (FUNNEL_EVENT_TYPES as readonly string[]).includes(value);
}

interface FunnelEventRule {
  /** landing_viewed is the only pre-signup, anonymous step — everything
   *  else requires a real, verified session, and profile_id always comes
   *  from that session, never from the request body. */
  requiresAuth: boolean;
  /** The ONLY body fields (besides event_type) this event type may carry.
   *  Any other key in the request body is a 400, not a silently-ignored
   *  extra — this is what "reject arbitrary fields/free-text" means in
   *  practice. */
  allowedFields: readonly string[];
  /** Subset of allowedFields that must be present and non-empty. */
  requiredFields: readonly string[];
}

const FUNNEL_EVENT_RULES: Record<FunnelEventType, FunnelEventRule> = {
  landing_viewed: {
    requiresAuth: false,
    allowedFields: ['anonymous_id', 'utm_source', 'utm_medium', 'utm_campaign'],
    requiredFields: ['anonymous_id'],
  },
  signup_attributed: {
    requiresAuth: true,
    // Bridges the anonymous browsing session to the just-created account —
    // that link, not the timestamp, is the only reason this event exists
    // (profiles.created_at already has the timestamp).
    allowedFields: ['anonymous_id'],
    requiredFields: ['anonymous_id'],
  },
  feed_viewed: {
    requiresAuth: true,
    allowedFields: [],
    requiredFields: [],
  },
  job_viewed: {
    requiresAuth: true,
    allowedFields: ['opportunity_id'],
    requiredFields: ['opportunity_id'],
  },
};

export function funnelEventRequiresAuth(eventType: FunnelEventType): boolean {
  return FUNNEL_EVENT_RULES[eventType].requiresAuth;
}

/** Opaque client-generated id — never a Supabase anonymous-auth session,
 *  never an email/IP/fingerprint. Bounded length, no reason for it to ever
 *  be long. */
const ANONYMOUS_ID_PATTERN = /^[A-Za-z0-9-]{8,100}$/;

const MAX_FIELD_LENGTH = 200;

export type ValidatedFunnelFields = Partial<
  Record<'anonymous_id' | 'opportunity_id' | 'utm_source' | 'utm_medium' | 'utm_campaign', string>
>;

/**
 * The single place that decides which fields are allowed for which event
 * type, and what shape they must have. Never validates or derives
 * profile_id — that is always supplied separately by the route from the
 * authenticated session (or omitted pre-signup), never trusted from here.
 */
export function validateFunnelEventBody(
  eventType: FunnelEventType,
  body: Record<string, unknown>
): { ok: true; fields: ValidatedFunnelFields } | { ok: false; error: string } {
  const rule = FUNNEL_EVENT_RULES[eventType];

  const bodyKeys = Object.keys(body).filter((k) => k !== 'event_type');
  for (const key of bodyKeys) {
    if (!rule.allowedFields.includes(key)) {
      return { ok: false, error: `Unexpected field "${key}" for event_type "${eventType}"` };
    }
  }

  const fields: ValidatedFunnelFields = {};
  for (const key of rule.allowedFields) {
    const raw = body[key];
    if (raw === undefined || raw === null || raw === '') {
      if (rule.requiredFields.includes(key)) {
        return { ok: false, error: `Missing required field "${key}" for event_type "${eventType}"` };
      }
      continue;
    }
    if (typeof raw !== 'string' || raw.length > MAX_FIELD_LENGTH) {
      return { ok: false, error: `Invalid value for field "${key}"` };
    }
    (fields as Record<string, string>)[key] = raw;
  }

  if (fields.anonymous_id !== undefined && !ANONYMOUS_ID_PATTERN.test(fields.anonymous_id)) {
    return { ok: false, error: 'Invalid anonymous_id format' };
  }
  if (fields.opportunity_id !== undefined && !fields.opportunity_id.startsWith('opp-')) {
    return { ok: false, error: 'Invalid opportunity_id format' };
  }

  return { ok: true, fields };
}

/**
 * The only function anywhere in this codebase that writes to
 * `funnel_events` — uses the admin client because RLS on that table grants
 * no client role any access at all. `profileId`/`fields` must already be
 * fully validated/derived by the caller (the route below); this function
 * does no re-derivation and trusts nothing from a raw request itself.
 */
export async function recordFunnelEvent(
  eventType: FunnelEventType,
  profileId: string | null,
  fields: ValidatedFunnelFields
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = getSupabaseAdminClient();
  if (!admin) {
    return { ok: false, error: 'Service unavailable' };
  }
  const { error } = await admin.from('funnel_events').insert({
    event_type: eventType,
    profile_id: profileId,
    anonymous_id: fields.anonymous_id ?? null,
    opportunity_id: fields.opportunity_id ?? null,
    utm_source: fields.utm_source ?? null,
    utm_medium: fields.utm_medium ?? null,
    utm_campaign: fields.utm_campaign ?? null,
  });
  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

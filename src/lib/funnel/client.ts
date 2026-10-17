import type { ApplySurface, FunnelEventType } from './events';

/**
 * Funnel Instrumentation — emission wiring, client-side write helper.
 * ==============================================================================
 * The single client-side path any page/component uses to record a funnel
 * event. Mirrors src/lib/entitlement/client.ts's fetchServerEntitlement()
 * shape deliberately (same fire-and-forget, try/catch, never-throw
 * convention already established in this codebase).
 *
 * Fire-and-forget by design: a funnel-recording failure must NEVER affect
 * the real flow it's attached to (signup, feed load, swiping). Callers
 * should not await this unless they specifically need the write to
 * complete before an immediate navigation (see VerifyCode.tsx's use for
 * signup_attributed, ahead of its hard window.location.replace).
 */
export async function recordFunnelEventClient(
  eventType: FunnelEventType,
  fields?: Record<string, string>
): Promise<void> {
  try {
    await fetch('/api/funnel/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, ...fields }),
    });
  } catch {
    /* fire-and-forget — never let a funnel-event failure surface */
  }
}

/**
 * Records a click on an Apply link to the employer's site. Called from the
 * click handler, so it must never delay or block the navigation: no await,
 * `keepalive` so the request survives the tab switching away, and every
 * failure (including a signed-out 401 on the public job page) swallowed.
 */
export function trackApplyClick(opportunityId: string, surface: ApplySurface): void {
  try {
    fetch('/api/funnel/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: 'apply_clicked', opportunity_id: opportunityId, surface }),
      keepalive: true,
    }).catch(() => {
      /* fire-and-forget */
    });
  } catch {
    /* fire-and-forget */
  }
}

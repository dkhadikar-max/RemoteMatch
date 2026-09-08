import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { measureDemandGap } from '@/lib/demand/measure';

/**
 * C2 (Additional Supply Discovery) — demand-gap measurement trigger.
 *
 * Runs the read-only demand/supply measurement and persists ONE
 * demand_gap_snapshots row. Nothing consumes that row — this is instrumentation
 * plus the dataset-adequacy assessment. No discovery is triggered, no supply
 * claim is emitted, matching/scoring/swipe/monetization/SEO are untouched.
 *
 * Meant for a scheduler, not product traffic. Fail-closed constant-time secret
 * check on DEMAND_MEASURE_SECRET — same discipline as the ingestion sync route,
 * a SEPARATE secret so demand-measurement authority is not coupled to supply
 * synchronization. If the secret is unset, every request is rejected.
 */
function verifyDemandMeasureSecret(authHeader: string | null): boolean {
  const secret = process.env.DEMAND_MEASURE_SECRET;
  if (!secret || !authHeader) return false;
  const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const a = Buffer.from(secret);
  const b = Buffer.from(candidate);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || req.headers.get('X-Internal-Secret');
  if (!verifyDemandMeasureSecret(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized: internal secret required for demand measurement.' },
      { status: 401 },
    );
  }

  const admin = getSupabaseAdminClient();
  if (!isSupabaseAdminConfigured || !admin) {
    return NextResponse.json(
      { success: false, error: 'Supabase admin client is not configured.' },
      { status: 503 },
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const windowDays = Number(searchParams.get('windowDays')) || undefined;

    const result = await measureDemandGap(admin, windowDays ? { windowDays } : undefined);

    const { error } = await admin.from('demand_gap_snapshots').insert({
      computed_at: result.computed_at,
      window_start: result.window_start,
      window_end: result.window_end,
      signals_available: result.signals_available,
      constants_version: result.constants_version,
      lexicon_version: result.lexicon_version,
      verified_active_users: result.verified_active_users,
      distinct_demand_patterns: result.distinct_demand_patterns,
      total_demand_observations: result.total_demand_observations,
      revealed_demand_observations: result.revealed_demand_observations,
      application_progression_observations: result.application_progression_observations,
      progression_unattributable: result.progression_unattributable,
      dataset_adequate: result.dataset_adequate,
      adequacy_detail: result.adequacy_detail,
      ranked_gaps: result.ranked_gaps,
      notes: result.notes,
    });
    if (error) {
      return NextResponse.json({ success: false, error: `Could not persist snapshot: ${error.message}` }, { status: 500 });
    }

    // Deliberately return only the meta + verdict, never a user-facing gap
    // ranking or a shortage statement.
    return NextResponse.json({
      success: true,
      computed_at: result.computed_at,
      window: [result.window_start, result.window_end],
      signals_available: result.signals_available,
      verified_active_users: result.verified_active_users,
      distinct_demand_patterns: result.distinct_demand_patterns,
      total_demand_observations: result.total_demand_observations,
      structurally_measurable: result.structurally_measurable,
      d3_evidence_status: result.d3_evidence_status,
      gap_ranking_authorized: result.gap_ranking_authorized,
      adequacy_summary: result.adequacy_detail.summary,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

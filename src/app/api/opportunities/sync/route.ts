import { NextRequest, NextResponse } from 'next/server';
import { syncOpportunitiesToCatalog, revalidateStaleLinks, verifyIngestionSecret } from '@/lib/ingestion/catalog-sync';

/**
 * Previously: no authentication at all, and its body discarded
 * IngestionManager.runIngestion()'s result entirely — nothing persisted.
 * Now: requires INGESTION_SYNC_SECRET (fail-closed if unset, same
 * discipline as IndexNow's internal-secret check), and actually writes to
 * the `opportunities` catalog per the Live Supply Activation spec.
 *
 * Two independent actions, matching the spec's two independent cadences:
 *   POST /api/opportunities/sync              -> discovery + upsert + absence accounting
 *   POST /api/opportunities/sync?action=revalidate -> stale-link recheck only
 * Meant to be triggered by a scheduled job (Railway cron or an external
 * scheduler), not by product/user traffic.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('Authorization') || req.headers.get('X-Internal-Secret');
  if (!verifyIngestionSecret(authHeader)) {
    return NextResponse.json(
      { error: 'Unauthorized: internal secret required for catalog sync.' },
      { status: 401 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');

    if (action === 'revalidate') {
      const result = await revalidateStaleLinks();
      return NextResponse.json({ success: true, action: 'revalidate', ...result });
    }

    const result = await syncOpportunitiesToCatalog();
    return NextResponse.json({ success: true, action: 'sync', ...result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

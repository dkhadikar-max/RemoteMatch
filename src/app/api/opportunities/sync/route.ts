import { NextRequest, NextResponse } from 'next/server';
import {
  syncOpportunitiesToCatalog,
  revalidateStaleLinks,
  verifyIngestionSecret,
  reconcileCrossProviderDuplicates,
} from '@/lib/ingestion/catalog-sync';

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

    // M-adjacent-1 — a separate, independently-testable step, never inside
    // syncOpportunitiesToCatalog() itself (same pattern as revalidateStaleLinks).
    // Only runs when this cycle actually persisted something — an all-providers-
    // failed cycle changes nothing in the catalog, so there is nothing new to
    // reconcile against.
    const anyProviderSucceeded = result.providerOutcomes.some((o) => o.success);
    const reconciliation = anyProviderSucceeded ? await reconcileCrossProviderDuplicates() : null;

    return NextResponse.json({ success: true, action: 'sync', ...result, reconciliation });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

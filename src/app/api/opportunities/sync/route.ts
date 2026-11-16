import { NextRequest, NextResponse } from 'next/server';
import {
  syncOpportunitiesToCatalog,
  revalidateStaleLinks,
  verifyIngestionSecret,
  reconcileCrossProviderDuplicates,
} from '@/lib/ingestion/catalog-sync';
import { translatePendingOpportunities } from '@/lib/translation/translate-pending';
import { invalidateCatalogCaches } from '@/lib/ingestion/catalog-caches';
import { logCatalogSyncResult } from '@/lib/ingestion/lifecycle-log';

/**
 * Authenticated internal ingestion actions. The catalog write, translation,
 * duplicate reconciliation and link revalidation are separate requests so a
 * slow optional post-processing phase cannot turn a successful catalog sync
 * into an HTTP 5xx or hold the sync request open behind the Railway edge.
 *
 *   POST /api/opportunities/sync                 -> provider fetch + catalog writes
 *   POST /api/opportunities/sync?action=translate -> bounded translation pass
 *   POST /api/opportunities/sync?action=reconcile -> cross-provider dedupe
 *   POST /api/opportunities/sync?action=revalidate -> stale-link checks
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
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'revalidate', ...result });
    }

    if (action === 'translate') {
      const translation = await translatePendingOpportunities();
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'translate', translation });
    }

    if (action === 'reconcile') {
      const reconciliation = await reconcileCrossProviderDuplicates();
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'reconcile', reconciliation });
    }

    if (action !== null && action !== 'sync') {
      return NextResponse.json({ success: false, error: `Unsupported sync action: ${action}` }, { status: 400 });
    }

    // This is the only route that authorizes a real provider fetch. It is
    // protected by the internal secret check above.
    const result = await syncOpportunitiesToCatalog(undefined, { allowLiveProviderFetch: true });
    logCatalogSyncResult(result);

    // The catalog has changed; do not wait for translation or reconciliation
    // before acknowledging the successful write. Both have dedicated actions
    // and are invoked sequentially by the scheduled worker.
    try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }

    return NextResponse.json({ success: true, action: 'sync', ...result });
  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

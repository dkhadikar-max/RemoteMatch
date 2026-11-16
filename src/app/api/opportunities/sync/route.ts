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
import { newSyncRunId, describeSyncFailure } from '@/lib/ingestion/sync-failure-report';

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

  // Observability only (see sync-failure-report.ts): a short id to correlate a
  // run's log lines with the JSON error body, and the step currently running so
  // a failure says WHERE it happened. Neither changes what the sync does.
  const runId = newSyncRunId();
  let stage = 'request';

  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');
    console.log(`[sync ${runId}] start action=${action ?? 'sync'}`);

    if (action === 'revalidate') {
      stage = 'revalidate';
      const result = await revalidateStaleLinks();
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'revalidate', ...result });
    }

    if (action === 'translate') {
      stage = 'translation';
      const translation = await translatePendingOpportunities();
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'translate', translation });
    }

    if (action === 'reconcile') {
      stage = 'reconciliation';
      const reconciliation = await reconcileCrossProviderDuplicates();
      try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }
      return NextResponse.json({ success: true, action: 'reconcile', reconciliation });
    }

    if (action !== null && action !== 'sync') {
      return NextResponse.json({ success: false, error: `Unsupported sync action: ${action}` }, { status: 400 });
    }

    // This is the only route that authorizes a real provider fetch. It is
    // protected by the internal secret check above.
    stage = 'catalog_sync';
    const result = await syncOpportunitiesToCatalog(undefined, { allowLiveProviderFetch: true });
    logCatalogSyncResult(result);

    // The catalog has changed; do not wait for translation or reconciliation
    // before acknowledging the successful write. Both have dedicated actions
    // and are invoked sequentially by the scheduled worker.
    try { invalidateCatalogCaches(); } catch { /* cache invalidation is best effort */ }

    stage = 'finish';
    console.log(
      `[sync ${runId}] done providers=${result.providerOutcomes.filter((o) => o.success).length}/${result.providerOutcomes.length}`
    );
    return NextResponse.json({ success: true, action: 'sync', ...result });
  } catch (err) {
    // The cron discards the response body (curl -f) and this used to log nothing, so a failing
    // run left no trace of WHY. Log one redacted line (no secrets, no headers) and put the same
    // run id + stage in the body. The HTTP status is unchanged: still 500.
    const failure = describeSyncFailure(err, runId, stage);
    console.error(failure.logLine);
    return NextResponse.json(failure.body, { status: 500 });
  }
}

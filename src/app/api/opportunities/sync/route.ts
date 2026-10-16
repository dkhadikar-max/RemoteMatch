import { NextRequest, NextResponse } from 'next/server';
import {
  syncOpportunitiesToCatalog,
  revalidateStaleLinks,
  verifyIngestionSecret,
  reconcileCrossProviderDuplicates,
} from '@/lib/ingestion/catalog-sync';
import { translatePendingOpportunities } from '@/lib/translation/translate-pending';
import { invalidateCatalogCaches } from '@/lib/ingestion/catalog-caches';
import { newSyncRunId, describeSyncFailure } from '@/lib/ingestion/sync-failure-report';


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
      // Link checks can expire listings: drop the in-memory read caches (best effort, never fails the sync).
      try { invalidateCatalogCaches(); } catch { /* a cache must never fail a sync */ }
      return NextResponse.json({ success: true, action: 'revalidate', ...result });
    }

    // Explicit, visible authorization for the real live-provider fetch —
    // this route is the one legitimate caller, already gated above by
    // verifyIngestionSecret(). See syncOpportunitiesToCatalog()'s own
    // header for why this is a code-level parameter, not an env var.
    stage = 'catalog_sync';
    const result = await syncOpportunitiesToCatalog(undefined, { allowLiveProviderFetch: true });

    // Multilingual translation pass — runs after sync has written all newly-
    // discovered and refreshed rows, before cross-provider reconciliation.
    // Detects source language (DeepL auto-detect), translates non-English
    // title/description to English, validates output, and writes result.
    // Fail-closed: untranslated non-English rows remain invisible in the feed
    // until translation_status = 'ok'. Never throws — any row-level error is
    // caught and surfaced in the summary as `translationErrors`. A missing
    // DEEPL_API_KEY makes this a logged no-op (does not abort the sync).
    stage = 'translation';
    const translation = await translatePendingOpportunities();

    // M-adjacent-1 — a separate, independently-testable step, never inside
    // syncOpportunitiesToCatalog() itself (same pattern as revalidateStaleLinks).
    // Only runs when this cycle actually persisted something — an all-providers-
    // failed cycle changes nothing in the catalog, so there is nothing new to
    // reconcile against.
    const anyProviderSucceeded = result.providerOutcomes.some((o) => o.success);
    stage = 'reconciliation';
    const reconciliation = anyProviderSucceeded ? await reconcileCrossProviderDuplicates() : null;

    // The sync wrote to the catalog: drop the in-memory read caches (feed, hubs, sitemap, resume) so
    // the next request sees the new rows instead of waiting out a TTL. Best effort — a cache must
    // never fail a sync that has already written.
    try { invalidateCatalogCaches(); } catch { /* ignore */ }

    stage = 'finish';
    console.log(
      `[sync ${runId}] done providers=${result.providerOutcomes.filter((o) => o.success).length}/${result.providerOutcomes.length}`
    );
    return NextResponse.json({ success: true, action: 'sync', ...result, translation, reconciliation });

  } catch (err) {
    // The cron discards the response body (curl -f) and this used to log nothing, so a failing
    // run left no trace of WHY. Log one redacted line (no secrets, no headers) and put the same
    // run id + stage in the body. The HTTP status is unchanged: still 500.
    const failure = describeSyncFailure(err, runId, stage);
    console.error(failure.logLine);
    return NextResponse.json(failure.body, { status: 500 });
  }
}

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
import { refreshSitemapEntriesInBackground } from '@/lib/seo/sitemap-data';


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
      // Link checks can expire listings: refresh product caches immediately. If
      // any listing expired, refresh an already-warm sitemap in the background.
      try {
        invalidateCatalogCaches(['sitemap-entries']);
        if (result.expiredByLinkFailure > 0) refreshSitemapEntriesInBackground();
      } catch { /* a cache must never fail a sync */ }
      return NextResponse.json({ success: true, action: 'revalidate', ...result });
    }

    // Explicit, visible authorization for the real live-provider fetch —
    // this route is the one legitimate caller, already gated above by
    // verifyIngestionSecret(). See syncOpportunitiesToCatalog()'s own
    // header for why this is a code-level parameter, not an env var.
    const result = await syncOpportunitiesToCatalog(undefined, { allowLiveProviderFetch: true });

    // Print the sync summary + lifecycle report to the service log NOW, before the (slow) translation pass: Railway's edge cuts this
    // request at ~5 minutes, so the response body — which carries the shadow report — often never reaches the cron. Log-only; cannot
    // fail the sync (the helper swallows every error).
    logCatalogSyncResult(result);

    // Multilingual translation pass — runs after sync has written all newly-
    // discovered and refreshed rows, before cross-provider reconciliation.
    // Detects source language (DeepL auto-detect), translates non-English
    // title/description to English, validates output, and writes result.
    // Fail-closed: untranslated non-English rows remain invisible in the feed
    // until translation_status = 'ok'. Never throws — any row-level error is
    // caught and surfaced in the summary as `translationErrors`. A missing
    // DEEPL_API_KEY makes this a logged no-op (does not abort the sync).
    const translation = await translatePendingOpportunities();

    // M-adjacent-1 — a separate, independently-testable step, never inside
    // syncOpportunitiesToCatalog() itself (same pattern as revalidateStaleLinks).
    // Only runs when this cycle actually persisted something — an all-providers-
    // failed cycle changes nothing in the catalog, so there is nothing new to
    // reconcile against.
    const anyProviderSucceeded = result.providerOutcomes.some((o) => o.success);
    const reconciliation = anyProviderSucceeded ? await reconcileCrossProviderDuplicates() : null;

    // The sync wrote to the catalog: refresh product-facing caches immediately.
    // Refresh an already-warm sitemap off the crawler path; the stale-while-
    // revalidate cache serves the previous complete XML while its 80+ batches run.
    // If this process has never served the sitemap, do not create unused egress.
    // Best effort — a cache must never fail a sync that has already written.
    try {
      invalidateCatalogCaches(['sitemap-entries']);
      if (anyProviderSucceeded) refreshSitemapEntriesInBackground();
    } catch { /* ignore */ }

    return NextResponse.json({ success: true, action: 'sync', ...result, translation, reconciliation });

  } catch (err) {
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

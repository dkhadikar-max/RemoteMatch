/**
 * RemoteMatch — Multilingual Translation Pass
 * ==============================================================================
 * `translatePendingOpportunities()` is a post-sync pass, modelled after
 * `revalidateStaleLinks()` and `reconcileCrossProviderDuplicates()`. It runs
 * after `syncOpportunitiesToCatalog()` has written all newly-discovered and
 * refreshed rows, but before `reconcileCrossProviderDuplicates()`.
 *
 * FAIL-CLOSED CONTRACT (locked decision):
 *   A non-English row MUST NOT appear in the user-facing feed or in any
 *   SEO/sitemap path until translation_status = 'ok'. The feed and SEO
 *   queries in catalog-read.ts and seo/data.ts enforce this on the read side;
 *   this module enforces it on the write side by never setting
 *   translation_status = 'ok' unless validation passes.
 *
 * WHAT IS TRANSLATED:
 *   ONLY title and description — the two prose fields in CanonicalOpportunity.
 *   Every structured field (salary, country lists, skills, remote_type, etc.)
 *   is left completely unchanged. Company is a proper noun — never translated.
 *   required_skills / preferred_skills are technology names — never translated.
 *
 * WHAT IS NOT CHANGED:
 *   content_hash — identity fingerprint, computed from original-language text,
 *     must remain unchanged to preserve deduplication correctness.
 *   status — the lifecycle state machine (unknown/active/expired/draft) is
 *     owned entirely by catalog-sync.ts. This module never writes status.
 *   canonical_url_hash — URL identity, not affected by content.
 *
 * HASH-BASED RE-TRANSLATION (locked decision):
 *   Re-translation is triggered when content_hash != translated_content_hash,
 *   meaning the provider returned updated content after the last translation.
 *   On re-translation success, original_title/original_description are
 *   overwritten with the new pre-translation values, and translated_content_hash
 *   is updated. The previous English translation remains in title/description
 *   until the new translation succeeds — users always see some English text.
 *
 * FAILURE ISOLATION (the pass never throws):
 *   Model output is untrusted. Each Gemini element is shape-validated in
 *   gemini-translator.ts (parseTranslationResponse), the validators in
 *   validation.ts reject non-strings instead of throwing, and every row is
 *   processed inside its own try/catch: a malformed or failing row is recorded
 *   as translation_status = 'error' and the REST of its batch — and every later
 *   batch — is still processed. A failed database write is also treated as an
 *   error for that row (it is retried by the next pass) rather than counted as
 *   a success. Failures are classified: a PER-ROW definitive failure (malformed
 *   element, content validation, row missing from an otherwise-usable response)
 *   is recorded as 'error' and the row is hidden from every user-facing read; a
 *   BATCH-LEVEL failure (generator down, quota error, unusable response) leaves
 *   its rows PENDING — still visible as "not yet processed" and retried next
 *   pass — because 'error' is terminal and hides the row, and the free tier's
 *   request cap makes batch failures routine. The old behavior let one bad element throw out of the pass, so
 *   POST /api/opportunities/sync returned 500 after the catalog rows were
 *   already written and skipped cross-provider reconciliation.
 *
 * PROVIDER SUPPORT:
 *   1. Free Gemini Provider (Primary Free Default): uses GEMINI_API_KEY from Google
 *      AI Studio to batch translate jobs cleanly at zero cost.
 *   2. DeepL Provider: uses DEEPL_API_KEY if explicitly configured.
 */

import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { isDeepLConfigured, deeplTranslate } from './deepl-client';
import { translateJobBatchWithGemini, type BatchJobInput, type BatchTranslationOutput } from './gemini-translator';
import { validateTranslationPair } from './validation';
import { fetchAllRows } from '@/lib/supabase/query-helpers';

/** Parallel requests at once when using DeepL. */
const DEEPL_CONCURRENCY_LIMIT = 3;

/** Batch size when using Gemini (translates 10 jobs per single prompt). */
const GEMINI_BATCH_SIZE = 10;

/** One retry on transient failure. */
const MAX_ATTEMPTS = 2;

/** Backoff between retry attempts, ms. Keep provider 503/quota recovery from hot-looping. */
const RETRY_DELAY_MS = 4_000;

export interface TranslationPassSummary {
  /** Eligible candidates identified within this run's bounded selection; excludes the lookahead row and unscanned backlog. */
  examined: number;
  /** Identified candidates not sent to a provider. Does not include backlog or the lookahead row. */
  notAttempted: number;
  /** Why this pass stopped. Higher-priority provider stops override time and row budgets. */
  stoppedReason: 'complete' | 'row_budget' | 'time_budget' | 'provider_limit' | 'provider_failures';
  /** Rows successfully translated to English. */
  translated: number;
  /** English rows detected (no translation performed). */
  englishDetected: number;
  /** Rows where translation failed individually (translation_status = 'error') — hidden from every
   *  user-facing and SEO read. */
  errors: number;
  /** Rows left PENDING because their whole batch could not be processed (generator down, quota
   *  error, unusable response). Not marked 'error', so they stay visible as "not yet processed"
   *  and are picked up again by the next pass. */
  deferred: number;
  /** Rows where translation was re-triggered because content_hash changed. */
  retranslated: number;
  /** Provider used ('gemini' | 'deepl' | 'none'). */
  provider: 'gemini' | 'deepl' | 'none';
}

export interface PendingRow {
  uuid: string;          // the DB primary key UUID
  title: string;
  description: string;
  content_hash: string;
  translation_status: string | null;
  translated_content_hash: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type RowOutcome = 'translated' | 'english' | 'error' | 'retranslated' | 'deferred';

type AdminClient = ReturnType<typeof getSupabaseAdminClient>;

/** Applies one row update. Returns false (and logs) when the database refuses
 *  it or the call throws — never throws itself. */
async function writeRow(admin: AdminClient, uuid: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const { error } = await admin!.from('opportunities').update(patch).eq('id', uuid);
    if (error) {
      console.warn(`[translation] Row ${uuid}: database update failed — ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[translation] Row ${uuid}: database update threw — ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

async function markRowError(admin: AdminClient, uuid: string): Promise<void> {
  await writeRow(admin, uuid, { translation_status: 'error' });
}

/**
 * One row of a Gemini batch. Everything that can go wrong with a single result
 * — a missing or wrongly-typed field that slipped past the parse layer, a
 * validation failure, a failed write — ends in `'error'` for THIS row only.
 */
async function processGeminiRow(
  admin: AdminClient,
  row: PendingRow,
  out: BatchTranslationOutput | undefined
): Promise<RowOutcome> {
  try {
    const isRetranslation =
      row.translation_status === 'ok' &&
      row.translated_content_hash !== null &&
      row.content_hash !== row.translated_content_hash;

    if (!out) {
      console.warn(`[translation] Row ${row.uuid}: missing from (or rejected in) the batch translation output.`);
      await markRowError(admin, row.uuid);
      return 'error';
    }

    // Fail-closed: an unusable language code is an error, never a silent "en"
    // (which would publish untranslated foreign text as English).
    if (typeof out.detectedLanguage !== 'string' || out.detectedLanguage.trim() === '') {
      console.warn(`[translation] Row ${row.uuid}: no usable detected language — recorded as an error.`);
      await markRowError(admin, row.uuid);
      return 'error';
    }
    const lang = out.detectedLanguage.toLowerCase().split('-')[0];

    // English detected
    if (lang === 'en') {
      const ok = await writeRow(admin, row.uuid, {
        source_language: 'en',
        translation_status: 'n/a',
        translated_at: new Date().toISOString(),
        translated_content_hash: row.content_hash,
        translation_model: 'gemini-3.5-flash-lite',
      });
      return ok ? 'english' : 'error';
    }

    // Non-English: Validate (non-string fields come back as { valid: false }, never throw)
    const validation = validateTranslationPair(out.translatedTitle, out.translatedDescription, row.description);
    if (!validation.valid) {
      console.warn(`[translation] Row ${row.uuid} (${lang}): validation failed — ${validation.reason}`);
      await markRowError(admin, row.uuid);
      return 'error';
    }

    // Success — write translation
    const ok = await writeRow(admin, row.uuid, {
      title: out.translatedTitle.trim(),
      description: out.translatedDescription.trim(),
      original_title: row.title,
      original_description: row.description,
      source_language: lang,
      translation_status: 'ok',
      translated_at: new Date().toISOString(),
      translated_content_hash: row.content_hash,
      translation_model: 'gemini-3.5-flash-lite',
    });
    if (!ok) return 'error';
    return isRetranslation ? 'retranslated' : 'translated';
  } catch (err) {
    console.warn(`[translation] Row ${row.uuid}: unexpected ${(err as Error)?.name ?? 'error'} — recorded as an error, batch continues: ${(err as Error)?.message ?? String(err)}`);
    await markRowError(admin, row.uuid);
    return 'error';
  }
}

/**
 * Translates a batch using Gemini 3.5 Flash Lite (100% free with existing GEMINI_API_KEY).
 *
 * `translate` is injectable so tests can drive the whole pass with canned model
 * responses — no live Gemini call, no free-tier quota spent.
 */
function isProviderQuotaOrRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\b429\b|quota|rate.?limit|resource_exhausted/i.test(message);
}

class TranslationRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super("Gemini request exceeded " + timeoutMs + "ms.");
    this.name = "TranslationRequestTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranslationRequestTimeoutError(timeoutMs)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function errorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const rec = err as Record<string, unknown>;
  const value = rec.status ?? rec.statusCode ?? rec.code;
  const status = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(status) ? status : null;
}

function isProviderQuotaOrRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = errorStatus(err);
  return status === 429 || status === 456 || /\b429\b|\b456\b|quota|rate.?limit|resource_exhausted/i.test(message);
}

function isProviderServerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const status = errorStatus(err);
  return (status !== null && status >= 500 && status <= 599) || /\b5\d\d\b|HTTP\s+5\d\d/i.test(message);
}

export interface GeminiBatchOptions {
  onProviderLimit?: () => void;
  onBatchFailure?: () => void;
  onBatchSuccess?: () => void;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export async function processGeminiBatch(
  admin: AdminClient,
  batch: PendingRow[],
  translate: (jobs: BatchJobInput[]) => Promise<BatchTranslationOutput[]> = (jobs) => translateJobBatchWithGemini(jobs),
  options: GeminiBatchOptions = {}
): Promise<RowOutcome[]> {
  const inputs = batch.map((r) => ({ id: r.uuid, title: r.title, description: r.description }));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  let outputs: BatchTranslationOutput[] | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      outputs = await withTimeout(Promise.resolve().then(() => translate(inputs)), timeoutMs);
      break;
    } catch (err) {
      console.warn("[translation] Gemini batch attempt " + attempt + " failed:", (err as Error)?.message ?? String(err));
      if (isProviderQuotaOrRateLimitError(err)) {
        // Quota is a pass-wide stop. Never spend a retry or start another batch.
        options.onProviderLimit?.();
        return batch.map(() => "deferred" as const);
      }
      // A request timeout is not retried. Only an HTTP 5xx receives the one retry.
      if (err instanceof TranslationRequestTimeoutError || !isProviderServerError(err) || attempt === MAX_ATTEMPTS) {
        options.onBatchFailure?.();
        return batch.map(() => "deferred" as const);
      }
      if (retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }

  if (!Array.isArray(outputs) || outputs.length === 0) {
    console.warn("[translation] Gemini batch returned no usable elements; rows remain pending.");
    options.onBatchFailure?.();
    return batch.map(() => "deferred" as const);
  }

  // A partially usable response is a successful batch: each rejected/missing row
  // is isolated and handled by processGeminiRow, while valid neighbours survive.
  options.onBatchSuccess?.();
  const outputMap = new Map<string, BatchTranslationOutput>();
  for (const output of outputs) {
    if (output && typeof output.id === "string" && !outputMap.has(output.id)) outputMap.set(output.id, output);
  }

  const results: RowOutcome[] = [];
  for (const row of batch) {
    results.push(await processGeminiRow(admin, row, outputMap.get(row.uuid)));
  }
  return results;
}

/**
 * DeepL fallback row processor. Never throws: any failure is this row's error.
 */
async function processDeepLRow(admin: AdminClient, row: PendingRow, onProviderLimit?: () => void): Promise<RowOutcome> {
  try {
    const isRetranslation =
      row.translation_status === 'ok' &&
      row.translated_content_hash !== null &&
      row.content_hash !== row.translated_content_hash;

    let result: { detectedSourceLanguage: string; translations: string[] } | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        result = await deeplTranslate([row.title, row.description]);
        break;
      } catch (err) {
        if (isProviderQuotaOrRateLimitError(err)) {
          onProviderLimit?.();
          break;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }

    // The call never succeeded (quota / network): not the row's fault — leave it pending.
    if (!result) return 'deferred';
    if (typeof result.detectedSourceLanguage !== 'string' || !Array.isArray(result.translations)) {
      await markRowError(admin, row.uuid);
      return 'error';
    }

    const lang = result.detectedSourceLanguage.toUpperCase();
    if (lang === 'EN' || lang === 'EN-US' || lang === 'EN-GB') {
      const ok = await writeRow(admin, row.uuid, {
        source_language: 'en',
        translation_status: 'n/a',
        translated_at: new Date().toISOString(),
        translated_content_hash: row.content_hash,
        translation_model: 'deepl-free',
      });
      return ok ? 'english' : 'error';
    }

    const translatedTitle = result.translations[0];
    const translatedDescription = result.translations[1];

    const validation = validateTranslationPair(translatedTitle, translatedDescription, row.description);
    if (!validation.valid) {
      await markRowError(admin, row.uuid);
      return 'error';
    }

    const bcp47 = lang.toLowerCase().split('-')[0];
    const ok = await writeRow(admin, row.uuid, {
      title: translatedTitle.trim(),
      description: translatedDescription.trim(),
      original_title: row.title,
      original_description: row.description,
      source_language: bcp47,
      translation_status: 'ok',
      translated_at: new Date().toISOString(),
      translated_content_hash: row.content_hash,
      translation_model: 'deepl-free',
    });
    if (!ok) return 'error';
    return isRetranslation ? 'retranslated' : 'translated';
  } catch (err) {
    console.warn(`[translation] Row ${row.uuid}: unexpected ${(err as Error)?.name ?? 'error'} — recorded as an error: ${(err as Error)?.message ?? String(err)}`);
    await markRowError(admin, row.uuid);
    return 'error';
  }
}

function tally(summary: TranslationPassSummary, results: RowOutcome[]): void {
  for (const res of results) {
    if (res === 'translated') summary.translated++;
    else if (res === 'english') summary.englishDetected++;
    else if (res === 'error') summary.errors++;
    else if (res === 'deferred') summary.deferred++;
    else if (res === 'retranslated') { summary.retranslated++; summary.translated++; }
  }
}

/**
 * Post-sync translation pass.
 *
 * Automatically chooses the best configured translation engine:
 *   1. Free Gemini 3.5 Flash Lite (via existing GEMINI_API_KEY) — fast, high-quality, free.
 *   2. DeepL Free (via DEEPL_API_KEY) if explicitly provided.
 *
 * NEVER THROWS. A failure at any level is logged and reflected in
 * `summary.errors`; the caller (POST /api/opportunities/sync) can therefore rely
 * on reaching its cross-provider reconciliation step.
 */
export interface TranslationPassOptions {
  /** TEST SEAM ONLY — replaces the Gemini call; never supplied by production callers. */
  translate?: (jobs: BatchJobInput[]) => Promise<BatchTranslationOutput[]>;
  /** Test-only dependency injection. */
  admin?: NonNullable<AdminClient>;
  /** Injected monotonic clock for deterministic deadline tests. */
  clock?: () => number;
  /** Test overrides; production reads the two documented environment variables. */
  maxRows?: number;
  maxMs?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Post-sync translation pass. Pending rows are selected newest-first in one
 * bounded query; only stale-content detection uses id-keyset pagination.
 * The row cap counts attempted rows, not rows scanned during stale detection.
 */
export async function translatePendingOpportunities(
  options: TranslationPassOptions = {}
): Promise<TranslationPassSummary> {
  const summary: TranslationPassSummary = {
    examined: 0,
    notAttempted: 0,
    stoppedReason: "complete",
    translated: 0,
    englishDetected: 0,
    errors: 0,
    deferred: 0,
    retranslated: 0,
    provider: "none",
  };

  const hasGemini = Boolean(options.translate) || Boolean(process.env.GEMINI_API_KEY);
  const hasDeepL = isDeepLConfigured();
  if (hasGemini) summary.provider = "gemini";
  else if (hasDeepL) summary.provider = "deepl";
  else {
    console.warn("[translation] Neither GEMINI_API_KEY nor DEEPL_API_KEY is configured — translation pass is a no-op.");
    return summary;
  }

  if (!options.admin && !isSupabaseAdminConfigured) {
    console.warn("[translation] Supabase admin not configured — translation pass is a no-op.");
    return summary;
  }
  const admin = options.admin ?? getSupabaseAdminClient();
  if (!admin) {
    console.warn("[translation] Could not get Supabase admin client.");
    return summary;
  }

  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const maxRows = Math.max(1, options.maxRows ?? positiveInteger(process.env.TRANSLATION_MAX_ROWS_PER_RUN, 300));
  const maxMs = Math.max(1, options.maxMs ?? positiveInteger(process.env.TRANSLATION_MAX_MS, 120_000));
  const deadline = startedAt + maxMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const cutoff = new Date(clock() - 48 * 60 * 60 * 1_000).toISOString();

  let pendingLookahead = false;
  let staleLookahead = false;
  let selectionFailed = false;
  let providerLimitReached = false;
  let providerFailuresReached = false;
  let consecutiveBatchFailures = 0;
  let attemptedRows = 0;

  try {
    // Pending selection is deliberately NOT freshness-windowed. Read only
    // candidate identity/hash fields plus one lookahead row. Full descriptions
    // are fetched later, and only for rows within the remaining attempt budget.
    const pendingResult = await admin
      .from("opportunities")
      .select("id, posted_at, content_hash, translation_status, translated_content_hash")
      .eq("status", "active")
      .is("translation_status", null)
      .order("posted_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(maxRows + 1);

    if (pendingResult.error) {
      console.error("[translation] Failed to query pending candidates:", pendingResult.error.message);
      return summary;
    }

    const pendingFound = (pendingResult.data ?? []) as Array<{ id: string }>;
    pendingLookahead = pendingFound.length > maxRows;
    const pendingCandidates = pendingFound.slice(0, maxRows);
    const pendingIds = pendingCandidates.map((row) => row.id);

    // Stale scan is the ONLY id-keyset-paged selection. It intentionally scans
    // all lightweight ids/hashes in the 48h window, even when that exceeds the
    // attempted-row budget, then takes only the remaining budget plus lookahead.
    let staleCandidates: Array<{ id: string }> = [];
    const remainingBudget = maxRows - pendingIds.length;
    if (remainingBudget > 0) {
      try {
        const staleScan = await fetchAllRows<{
          id: string;
          content_hash: string | null;
          translated_content_hash: string | null;
        }>(
          (afterId, pageSize) => {
            let query = admin
              .from("opportunities")
              .select("id, content_hash, translated_content_hash")
              .eq("status", "active")
              .eq("translation_status", "ok")
              .gte("posted_at", cutoff)
              .order("id", { ascending: true })
              .limit(pageSize);
            if (afterId !== null) query = query.gt("id", afterId);
            return query;
          },
          { label: "translation stale-content scan", pageSize: 1_000, maxRows: 500_000 }
        );

        const changed = staleScan.filter(
          (row) => row.translated_content_hash != null && row.content_hash !== row.translated_content_hash
        );
        staleLookahead = changed.length > remainingBudget;
        staleCandidates = changed.slice(0, remainingBudget);
      } catch (err) {
        selectionFailed = true;
        console.error("[translation] Stale-content scan failed:", (err as Error)?.message ?? String(err));
      }
    }

    const candidateIds = [...pendingIds, ...staleCandidates.map((row) => row.id)];
    summary.examined = candidateIds.length;

    // This is the only description read. It cannot include the lookahead row
    // or any backlog beyond the per-run candidate budget.
    let typedRows: PendingRow[] = [];
    if (candidateIds.length > 0) {
      const details = await admin
        .from("opportunities")
        .select("id, title, description, content_hash, translation_status, translated_content_hash")
        .in("id", candidateIds);
      if (details.error) {
        selectionFailed = true;
        console.error("[translation] Failed to fetch in-budget translation content:", details.error.message);
      } else {
        const byId = new Map<string, PendingRow>();
        for (const row of (details.data ?? []) as Array<Record<string, unknown>>) {
          byId.set(row.id as string, {
            uuid: row.id as string,
            title: row.title as string,
            description: row.description as string,
            content_hash: row.content_hash as string,
            translation_status: (row.translation_status as string | null) ?? null,
            translated_content_hash: (row.translated_content_hash as string | null) ?? null,
          });
        }
        typedRows = candidateIds.map((id) => byId.get(id)).filter((row): row is PendingRow => Boolean(row));
      }
    }

    console.log("[translation] Identified " + summary.examined + " in-budget candidates; provider=" + summary.provider + ".");

    if (summary.provider === "gemini") {
      for (let i = 0; i < typedRows.length; i += GEMINI_BATCH_SIZE) {
        // The 120s budget prevents starting another batch. A batch already in
        // flight is allowed to finish, including its single 5xx retry.
        if (clock() >= deadline) break;
        const batch = typedRows.slice(i, i + GEMINI_BATCH_SIZE);
        attemptedRows += batch.length;
        const results = await processGeminiBatch(admin, batch, options.translate, {
          timeoutMs: requestTimeoutMs,
          retryDelayMs,
          onProviderLimit: () => { providerLimitReached = true; },
          onBatchFailure: () => {
            consecutiveBatchFailures += 1;
            if (consecutiveBatchFailures >= 2) providerFailuresReached = true;
          },
          onBatchSuccess: () => { consecutiveBatchFailures = 0; },
        });
        tally(summary, results);
        if (providerLimitReached || providerFailuresReached) break;
      }
    } else {
      for (let i = 0; i < typedRows.length; i += DEEPL_CONCURRENCY_LIMIT) {
        if (clock() >= deadline) break;
        const batch = typedRows.slice(i, i + DEEPL_CONCURRENCY_LIMIT);
        attemptedRows += batch.length;
        const results = await Promise.all(batch.map((row) =>
          processDeepLRow(admin, row, () => { providerLimitReached = true; })
        ));
        tally(summary, results);
        if (providerLimitReached) break;
        if (results.every((result) => result === "deferred")) {
          consecutiveBatchFailures += 1;
          if (consecutiveBatchFailures >= 2) providerFailuresReached = true;
        } else {
          consecutiveBatchFailures = 0;
        }
        if (providerFailuresReached) break;
      }
    }
  } catch (err) {
    // Preserve the pass's non-throwing contract. If candidates were already
    // identified, report them as not attempted and never claim full completion.
    selectionFailed = true;
    console.error("[translation] Pass aborted unexpectedly:", (err as Error)?.message ?? String(err));
  }

  summary.notAttempted = Math.max(0, summary.examined - attemptedRows);
  const hasLookahead = pendingLookahead || staleLookahead;
  const timeBudgetReached = clock() >= deadline && (summary.notAttempted > 0 || hasLookahead);

  // Stop-reason precedence is intentional and must not be reordered.
  summary.stoppedReason = providerLimitReached
    ? "provider_limit"
    : providerFailuresReached || selectionFailed
      ? "provider_failures"
      : timeBudgetReached
        ? "time_budget"
        : hasLookahead
          ? "row_budget"
          : "complete";

  console.log(
    "[translation] Done. translated=" + summary.translated +
    " (retranslated=" + summary.retranslated + ") english=" + summary.englishDetected +
    " errors=" + summary.errors + " deferred=" + summary.deferred +
    " examined=" + summary.examined + " notAttempted=" + summary.notAttempted +
    " stoppedReason=" + summary.stoppedReason
  );
  return summary;
}

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

/** Parallel requests at once when using DeepL. */
const DEEPL_CONCURRENCY_LIMIT = 3;

/** Batch size when using Gemini (translates 10 jobs per single prompt). */
const GEMINI_BATCH_SIZE = 10;

/** One retry on transient failure. */
const MAX_ATTEMPTS = 2;

/** Backoff between retry attempts, ms. */
const RETRY_DELAY_MS = 1_200;

export interface TranslationPassSummary {
  /** Total rows examined (active, in freshness window, not yet lang-detected or stale hash). */
  examined: number;
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
export async function processGeminiBatch(
  admin: AdminClient,
  batch: PendingRow[],
  translate: (jobs: BatchJobInput[]) => Promise<BatchTranslationOutput[]> = (jobs) => translateJobBatchWithGemini(jobs)
): Promise<RowOutcome[]> {
  const inputs = batch.map((r) => ({
    id: r.uuid,
    title: r.title,
    description: r.description,
  }));

  let outputs: BatchTranslationOutput[] = [];
  let answered = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      outputs = await translate(inputs);
      answered = true;
      break;
    } catch (err) {
      console.warn(`[translation] Gemini batch attempt ${attempt} failed:`, (err as Error).message);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  // BATCH-LEVEL FAILURE — the generator never answered (quota / network / unusable JSON) or
  // answered with nothing usable. That says nothing about the rows themselves, so they are NOT
  // marked 'error': 'error' rows are hidden from every read path, and on the free tier's tight
  // request cap this happens routinely — marking would hide most of a fresh sync. They stay
  // pending (status NULL, visible as "not yet processed") and the next pass retries them.
  if (!answered || !Array.isArray(outputs) || outputs.length === 0) {
    console.warn(`[translation] Batch of ${batch.length} produced no usable results — rows left pending for the next pass (not marked as errors).`);
    return batch.map(() => 'deferred' as const);
  }

  const outputMap = new Map<string, BatchTranslationOutput>();
  for (const o of Array.isArray(outputs) ? outputs : []) {
    if (o && typeof o.id === 'string' && !outputMap.has(o.id)) outputMap.set(o.id, o);
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
async function processDeepLRow(admin: AdminClient, row: PendingRow): Promise<RowOutcome> {
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
export async function translatePendingOpportunities(
  options: {
    /** TEST SEAM ONLY — replaces the Gemini call so the whole pass can be exercised
     *  with canned model responses (no live call, no free-tier quota). Production
     *  callers pass nothing. Supplying it selects the Gemini code path. */
    translate?: (jobs: BatchJobInput[]) => Promise<BatchTranslationOutput[]>;
  } = {}
): Promise<TranslationPassSummary> {
  const summary: TranslationPassSummary = {
    examined: 0,
    translated: 0,
    englishDetected: 0,
    errors: 0,
    deferred: 0,
    retranslated: 0,
    provider: 'none',
  };

  const hasGemini = Boolean(options.translate) || Boolean(process.env.GEMINI_API_KEY);
  const hasDeepL = isDeepLConfigured();

  if (hasGemini) {
    summary.provider = 'gemini';
  } else if (hasDeepL) {
    summary.provider = 'deepl';
  } else {
    console.warn('[translation] Neither GEMINI_API_KEY nor DEEPL_API_KEY is configured — translation pass is a no-op.');
    return summary;
  }

  if (!isSupabaseAdminConfigured) {
    console.warn('[translation] Supabase admin not configured — translation pass is a no-op.');
    return summary;
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    console.warn('[translation] Could not get Supabase admin client.');
    return summary;
  }

  try {
    // Freshness window: same 48h boundary the feed uses.
    const cutoff = new Date(Date.now() - 48 * 3600 * 1_000).toISOString();

    const { data, error } = await admin
      .from('opportunities')
      .select('id, title, description, content_hash, translation_status, translated_content_hash')
      .eq('status', 'active')
      .gte('posted_at', cutoff)
      // PostgREST cannot compare two COLUMNS: `translated_content_hash.neq.content_hash` compares the
      // column to the literal text "content_hash", which is true for every translated row — so every
      // already-translated row used to be re-sent to the model on every sync, burning the free-tier
      // request cap. Fetch the candidates and compare the two hashes below instead.
      .or('translation_status.is.null,translation_status.eq.ok');

    if (error) {
      console.error('[translation] Failed to query pending rows:', error.message);
      return summary;
    }

    const rawRows = ((data ?? []) as unknown as Record<string, unknown>[]).filter(
      (r) =>
        r.translation_status == null ||
        // translated, but the provider has since returned different content (hash changed)
        (r.translation_status === 'ok' && r.translated_content_hash != null && r.translated_content_hash !== r.content_hash)
    );
    const typedRows: PendingRow[] = rawRows.map((r) => ({
      uuid: r.id as string,
      title: r.title as string,
      description: r.description as string,
      content_hash: r.content_hash as string,
      translation_status: (r.translation_status as string | null) ?? null,
      translated_content_hash: (r.translated_content_hash as string | null) ?? null,
    }));

    summary.examined = typedRows.length;
    if (typedRows.length === 0) return summary;

    console.log(`[translation] Processing ${typedRows.length} pending rows using provider=${summary.provider}.`);

    if (summary.provider === 'gemini') {
      // Process in batches of 10. A batch that fails as a whole costs only its own rows.
      for (let i = 0; i < typedRows.length; i += GEMINI_BATCH_SIZE) {
        const batch = typedRows.slice(i, i + GEMINI_BATCH_SIZE);
        let results: RowOutcome[];
        try {
          results = await processGeminiBatch(admin, batch, options.translate);
        } catch (err) {
          console.warn(`[translation] Batch starting at row ${i} failed unexpectedly (${(err as Error)?.message ?? String(err)}) — its rows are left pending; later batches continue.`);
          results = batch.map(() => 'deferred' as const);
        }
        tally(summary, results);
      }
    } else {
      // DeepL concurrency
      for (let i = 0; i < typedRows.length; i += DEEPL_CONCURRENCY_LIMIT) {
        const batch = typedRows.slice(i, i + DEEPL_CONCURRENCY_LIMIT);
        const results = await Promise.all(batch.map((row) => processDeepLRow(admin, row)));
        tally(summary, results);
      }
    }
  } catch (err) {
    // Last line of defense; everything above is already isolated per row/batch.
    console.error(`[translation] Pass aborted unexpectedly (${(err as Error)?.message ?? String(err)}); returning what was completed.`);
  }

  console.log(
    `[translation] Done. translated=${summary.translated} (retranslated=${summary.retranslated}) ` +
    `english=${summary.englishDetected} errors=${summary.errors} deferred=${summary.deferred}`
  );

  return summary;
}

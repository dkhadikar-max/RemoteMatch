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
 * PROVIDER SUPPORT:
 *   1. Free Gemini Provider (Primary Free Default): uses GEMINI_API_KEY from Google
 *      AI Studio to batch translate jobs cleanly at zero cost.
 *   2. DeepL Provider: uses DEEPL_API_KEY if explicitly configured.
 */

import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '@/lib/supabase/admin';
import { isDeepLConfigured, deeplTranslate } from './deepl-client';
import { translateJobBatchWithGemini } from './gemini-translator';
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
  /** Rows where translation failed (translation_status = 'error'). */
  errors: number;
  /** Rows where translation was re-triggered because content_hash changed. */
  retranslated: number;
  /** Provider used ('gemini' | 'deepl' | 'none'). */
  provider: 'gemini' | 'deepl' | 'none';
}

interface PendingRow {
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

/**
 * Translates a batch using Gemini 3.5 Flash Lite (100% free with existing GEMINI_API_KEY).
 */
async function processGeminiBatch(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  batch: PendingRow[]
): Promise<Array<'translated' | 'english' | 'error' | 'retranslated'>> {
  const inputs = batch.map((r) => ({
    id: r.uuid,
    title: r.title,
    description: r.description,
  }));

  let outputs: Array<{ id: string; detectedLanguage: string; translatedTitle: string; translatedDescription: string }> = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      outputs = await translateJobBatchWithGemini(inputs);
      break;
    } catch (err) {
      console.warn(`[translation] Gemini batch attempt ${attempt} failed:`, (err as Error).message);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  const results: Array<'translated' | 'english' | 'error' | 'retranslated'> = [];
  const outputMap = new Map(outputs.map((o) => [o.id, o]));

  for (const row of batch) {
    const isRetranslation =
      row.translation_status === 'ok' &&
      row.translated_content_hash !== null &&
      row.content_hash !== row.translated_content_hash;

    const out = outputMap.get(row.uuid);
    if (!out) {
      console.warn(`[translation] Row ${row.uuid}: missing from batch translation output.`);
      await admin!
        .from('opportunities')
        .update({ translation_status: 'error' })
        .eq('id', row.uuid);
      results.push('error');
      continue;
    }

    const lang = (out.detectedLanguage || 'en').toLowerCase().split('-')[0];

    // English detected
    if (lang === 'en') {
      await admin!
        .from('opportunities')
        .update({
          source_language: 'en',
          translation_status: 'n/a',
          translated_at: new Date().toISOString(),
          translated_content_hash: row.content_hash,
          translation_model: 'gemini-3.5-flash-lite',
        })
        .eq('id', row.uuid);
      results.push('english');
      continue;
    }

    // Non-English: Validate
    const validation = validateTranslationPair(out.translatedTitle, out.translatedDescription, row.description);
    if (!validation.valid) {
      console.warn(`[translation] Row ${row.uuid} (${lang}): validation failed — ${validation.reason}`);
      await admin!
        .from('opportunities')
        .update({ translation_status: 'error' })
        .eq('id', row.uuid);
      results.push('error');
      continue;
    }

    // Success — write translation
    await admin!
      .from('opportunities')
      .update({
        title: out.translatedTitle.trim(),
        description: out.translatedDescription.trim(),
        original_title: row.title,
        original_description: row.description,
        source_language: lang,
        translation_status: 'ok',
        translated_at: new Date().toISOString(),
        translated_content_hash: row.content_hash,
        translation_model: 'gemini-3.5-flash-lite',
      })
      .eq('id', row.uuid);

    results.push(isRetranslation ? 'retranslated' : 'translated');
  }

  return results;
}

/**
 * DeepL fallback row processor.
 */
async function processDeepLRow(
  admin: ReturnType<typeof getSupabaseAdminClient>,
  row: PendingRow
): Promise<'translated' | 'english' | 'error' | 'retranslated'> {
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

  if (!result) {
    await admin!.from('opportunities').update({ translation_status: 'error' }).eq('id', row.uuid);
    return 'error';
  }

  const lang = result.detectedSourceLanguage.toUpperCase();
  if (lang === 'EN' || lang === 'EN-US' || lang === 'EN-GB') {
    await admin!
      .from('opportunities')
      .update({
        source_language: 'en',
        translation_status: 'n/a',
        translated_at: new Date().toISOString(),
        translated_content_hash: row.content_hash,
        translation_model: 'deepl-free',
      })
      .eq('id', row.uuid);
    return 'english';
  }

  const translatedTitle = result.translations[0];
  const translatedDescription = result.translations[1];

  const validation = validateTranslationPair(translatedTitle, translatedDescription, row.description);
  if (!validation.valid) {
    await admin!.from('opportunities').update({ translation_status: 'error' }).eq('id', row.uuid);
    return 'error';
  }

  const bcp47 = lang.toLowerCase().split('-')[0];
  await admin!
    .from('opportunities')
    .update({
      title: translatedTitle.trim(),
      description: translatedDescription.trim(),
      original_title: row.title,
      original_description: row.description,
      source_language: bcp47,
      translation_status: 'ok',
      translated_at: new Date().toISOString(),
      translated_content_hash: row.content_hash,
      translation_model: 'deepl-free',
    })
    .eq('id', row.uuid);

  return isRetranslation ? 'retranslated' : 'translated';
}

/**
 * Post-sync translation pass.
 *
 * Automatically chooses the best configured translation engine:
 *   1. Free Gemini 3.5 Flash Lite (via existing GEMINI_API_KEY) — fast, high-quality, free.
 *   2. DeepL Free (via DEEPL_API_KEY) if explicitly provided.
 */
export async function translatePendingOpportunities(): Promise<TranslationPassSummary> {
  const summary: TranslationPassSummary = {
    examined: 0,
    translated: 0,
    englishDetected: 0,
    errors: 0,
    retranslated: 0,
    provider: 'none',
  };

  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
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

  // Freshness window: same 48h boundary the feed uses.
  const cutoff = new Date(Date.now() - 48 * 3600 * 1_000).toISOString();

  const { data, error } = await admin
    .from('opportunities')
    .select('id, title, description, content_hash, translation_status, translated_content_hash')
    .eq('status', 'active')
    .gte('posted_at', cutoff)
    .or(
      'translation_status.is.null,' +
      'and(translation_status.eq.ok,translated_content_hash.neq.content_hash)'
    );

  if (error) {
    console.error('[translation] Failed to query pending rows:', error.message);
    return summary;
  }

  const rawRows = (data ?? []) as unknown as Record<string, unknown>[];
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
    // Process in batches of 10
    for (let i = 0; i < typedRows.length; i += GEMINI_BATCH_SIZE) {
      const batch = typedRows.slice(i, i + GEMINI_BATCH_SIZE);
      const results = await processGeminiBatch(admin, batch);
      for (const res of results) {
        if (res === 'translated') summary.translated++;
        else if (res === 'english') summary.englishDetected++;
        else if (res === 'error') summary.errors++;
        else if (res === 'retranslated') { summary.retranslated++; summary.translated++; }
      }
    }
  } else {
    // DeepL concurrency
    for (let i = 0; i < typedRows.length; i += DEEPL_CONCURRENCY_LIMIT) {
      const batch = typedRows.slice(i, i + DEEPL_CONCURRENCY_LIMIT);
      const results = await Promise.all(batch.map((row) => processDeepLRow(admin, row)));
      for (const res of results) {
        if (res === 'translated') summary.translated++;
        else if (res === 'english') summary.englishDetected++;
        else if (res === 'error') summary.errors++;
        else if (res === 'retranslated') { summary.retranslated++; summary.translated++; }
      }
    }
  }

  console.log(
    `[translation] Done. translated=${summary.translated} (retranslated=${summary.retranslated}) ` +
    `english=${summary.englishDetected} errors=${summary.errors}`
  );

  return summary;
}

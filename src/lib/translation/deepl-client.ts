/**
 * RemoteMatch — DeepL Free REST client
 * ==============================================================================
 * Thin, dependency-free wrapper over the DeepL Free translation API.
 * No npm SDK is used — a plain fetch() call is sufficient and avoids
 * adding a new dependency for a single API endpoint.
 *
 * The Free tier endpoint is https://api-free.deepl.com/v2/translate.
 * Authentication is via a Bearer token (DEEPL_API_KEY env var).
 *
 * Language detection: DeepL returns `detected_source_language` in every
 * response when source_lang is not specified. This gives us detection and
 * translation in ONE round-trip — no separate detection step, no separate
 * library, zero extra API calls.
 *
 * Batch contract: up to 50 `text` entries per request. We send title and
 * description as a 2-element array = 1 API call per job listing.
 *
 * Failure contract: every function in this module throws on unrecoverable
 * errors or returns a typed error result — it never silently swallows errors.
 * The caller (translate-pending.ts) is responsible for per-row catch blocks
 * that convert thrown errors into translation_status = 'error' marks.
 */

const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const REQUEST_TIMEOUT_MS = 10_000; // 10 s — generous for a REST call, matches DeepL's own guidance

export interface DeepLTranslationResult {
  /** BCP-47 code returned by DeepL, e.g. 'DE', 'ES', 'EN'. Upper-cased. */
  detectedSourceLanguage: string;
  /** Translated text strings, one per input `text` element, in order. */
  translations: string[];
}

export interface DeepLNotConfigured {
  configured: false;
}
export interface DeepLConfigured {
  configured: true;
}
export type DeepLConfigStatus = DeepLNotConfigured | DeepLConfigured;

/** Returns true iff DEEPL_API_KEY is present in the environment. */
export function isDeepLConfigured(): boolean {
  return Boolean(process.env.DEEPL_API_KEY);
}

/**
 * Translates one or more text strings from auto-detected source language
 * to English (EN-US). Returns the detected source language alongside each
 * translated string.
 *
 * @param texts - Up to 50 strings to translate (sent in a single API call).
 *                Pass title and description as a 2-element array to minimize
 *                API calls per listing.
 * @returns DeepLTranslationResult with detected language and translations.
 * @throws Error if the API key is missing, the request fails, or the
 *         response shape is unexpected. Never returns a partial result.
 */
export async function deeplTranslate(texts: string[]): Promise<DeepLTranslationResult> {
  const apiKey = process.env.DEEPL_API_KEY;
  if (!apiKey) {
    throw new Error('[deepl-client] DEEPL_API_KEY is not set — cannot translate.');
  }
  if (texts.length === 0) {
    throw new Error('[deepl-client] texts array must not be empty.');
  }
  if (texts.length > 50) {
    throw new Error('[deepl-client] DeepL allows at most 50 text strings per request.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(DEEPL_FREE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'RemoteMatch/1.0 (multilingual-translation; +https://remotematch.online)',
      },
      body: JSON.stringify({
        text: texts,
        target_lang: 'EN-US',
        // Omitting source_lang triggers DeepL auto-detection.
        // The response will include detected_source_language.
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new Error(`[deepl-client] Rate limit (429). Retry after backoff.`);
  }
  if (response.status === 456) {
    throw new Error(`[deepl-client] Quota exceeded (456). DeepL Free monthly limit reached.`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '(unreadable)');
    throw new Error(`[deepl-client] HTTP ${response.status}: ${body.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error('[deepl-client] Response was not valid JSON.');
  }

  // Validate shape
  if (
    typeof json !== 'object' ||
    json === null ||
    !Array.isArray((json as Record<string, unknown>).translations)
  ) {
    throw new Error('[deepl-client] Unexpected response shape — missing translations array.');
  }

  const rawTranslations = (json as { translations: unknown[] }).translations;
  if (rawTranslations.length !== texts.length) {
    throw new Error(
      `[deepl-client] Response translation count (${rawTranslations.length}) ` +
        `does not match input count (${texts.length}).`
    );
  }

  // Extract detected_source_language from the first translation item.
  // DeepL returns the same detected language for all items in a batch
  // (the batch is treated as one document). We take it from index 0.
  const firstItem = rawTranslations[0] as Record<string, unknown>;
  const detectedLang = firstItem.detected_source_language;
  if (typeof detectedLang !== 'string' || !detectedLang) {
    throw new Error('[deepl-client] Missing or non-string detected_source_language in response.');
  }

  const translatedTexts = rawTranslations.map((item, i) => {
    const t = (item as Record<string, unknown>).text;
    if (typeof t !== 'string') {
      throw new Error(`[deepl-client] Translation item ${i} missing text field.`);
    }
    return t;
  });

  return {
    detectedSourceLanguage: detectedLang.toUpperCase(),
    translations: translatedTexts,
  };
}

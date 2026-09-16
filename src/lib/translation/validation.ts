/**
 * RemoteMatch — translated content validation
 * ==============================================================================
 * Guards against bad translations before they overwrite stored title/description.
 * Every check is deterministic and has no external dependency — safe to run in
 * unit tests without any network or DB access.
 *
 * The three failure modes being guarded:
 *  1. Empty / near-empty result — DeepL returned whitespace or an empty string.
 *  2. Content destruction — translation stripped >70% of the description text
 *     (hallucination or truncation turned a 600-char description into 3 words).
 *  3. Structured field contamination — translation hallucinated salary figures,
 *     URLs, or HTML into the prose fields. These are a direct safety risk: a
 *     user reads "Salary: €80,000" in the description as a fact about the job.
 *
 * NOT checked here:
 *  - Whether the translation is fluent/high-quality English. That is out of
 *    scope for a validation gate — the purpose is rejection of clearly broken
 *    output, not quality scoring.
 *  - `required_skills` / `preferred_skills` — those arrays are never translated
 *    and are therefore never passed to this module.
 *  - `company`, `salary_*`, `remote_type`, etc. — not translated, not checked.
 */

/** Patterns that indicate hallucinated structured data in prose fields. */
const SALARY_PATTERN = /[\$€£¥₹]\s*\d/;
const URL_PATTERN = /https?:\/\/[^\s]{4,}/;
const HTML_TAG_PATTERN = /<[a-z][a-z0-9]*[\s/>]/i;

/**
 * Minimum ratio of translated-to-original length for descriptions.
 * A translation that is less than 30% of the original length is treated as
 * content destruction (truncation, hallucination returning an empty stub).
 */
const MIN_DESCRIPTION_LENGTH_RATIO = 0.3;

/** Minimum character length for a valid translated title. */
const MIN_TITLE_LENGTH = 2;

/** Minimum character length for a valid translated description. */
const MIN_DESCRIPTION_LENGTH = 10;

export interface TranslationValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates a translated title string.
 *
 * @param translatedTitle  - The text returned by the translation API.
 * @returns { valid: true } if acceptable, { valid: false, reason } if not.
 */
export function validateTranslatedTitle(
  translatedTitle: string,
  originalTitle?: string
): TranslationValidationResult {
  const trimmed = translatedTitle.trim();

  if (trimmed.length < MIN_TITLE_LENGTH) {
    return { valid: false, reason: `Translated title is too short (${trimmed.length} chars).` };
  }

  if (SALARY_PATTERN.test(trimmed) && (!originalTitle || !SALARY_PATTERN.test(originalTitle))) {
    return { valid: false, reason: 'Translated title contains a hallucinated salary figure.' };
  }

  if (URL_PATTERN.test(trimmed) && (!originalTitle || !URL_PATTERN.test(originalTitle))) {
    return { valid: false, reason: 'Translated title contains a URL (hallucination).' };
  }

  if (HTML_TAG_PATTERN.test(trimmed) && (!originalTitle || !HTML_TAG_PATTERN.test(originalTitle))) {
    return { valid: false, reason: 'Translated title contains HTML tags.' };
  }

  return { valid: true };
}

/**
 * Validates a translated description string against its original.
 *
 * @param translatedDescription  - The text returned by the translation API.
 * @param originalDescription    - The source-language description (for length comparison).
 * @returns { valid: true } if acceptable, { valid: false, reason } if not.
 */
export function validateTranslatedDescription(
  translatedDescription: string,
  originalDescription: string
): TranslationValidationResult {
  const trimmed = translatedDescription.trim();

  if (trimmed.length < MIN_DESCRIPTION_LENGTH) {
    return {
      valid: false,
      reason: `Translated description is too short (${trimmed.length} chars).`,
    };
  }

  // Length-ratio guard: translation must not lose more than 70% of the text.
  const originalLen = originalDescription.trim().length;
  if (originalLen > 0 && trimmed.length < originalLen * MIN_DESCRIPTION_LENGTH_RATIO) {
    return {
      valid: false,
      reason:
        `Translated description (${trimmed.length} chars) is less than ` +
        `${Math.round(MIN_DESCRIPTION_LENGTH_RATIO * 100)}% of original ` +
        `(${originalLen} chars) — possible truncation or hallucination.`,
    };
  }

  // Only reject salary/URL/HTML if it was NOT present in the original description
  if (SALARY_PATTERN.test(trimmed) && !SALARY_PATTERN.test(originalDescription)) {
    return {
      valid: false,
      reason: 'Translated description contains a hallucinated salary figure.',
    };
  }

  if (URL_PATTERN.test(trimmed) && !URL_PATTERN.test(originalDescription)) {
    return { valid: false, reason: 'Translated description contains a URL (hallucination).' };
  }

  if (HTML_TAG_PATTERN.test(trimmed) && !HTML_TAG_PATTERN.test(originalDescription)) {
    return { valid: false, reason: 'Translated description contains HTML tags.' };
  }

  return { valid: true };
}

/**
 * Validates both title and description together. Convenience wrapper
 * for the translate-pending pass which always validates the pair.
 *
 * @returns The first failing result, or { valid: true } if both pass.
 */
export function validateTranslationPair(
  translatedTitle: string,
  translatedDescription: string,
  originalDescription: string,
  originalTitle?: string
): TranslationValidationResult {
  const titleResult = validateTranslatedTitle(translatedTitle, originalTitle);
  if (!titleResult.valid) return titleResult;

  return validateTranslatedDescription(translatedDescription, originalDescription);
}


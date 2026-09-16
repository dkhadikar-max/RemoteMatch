/**
 * Multilingual Translation Layer — Test Suite
 * ==============================================================================
 * Tests the core components of the multilingual translation layer:
 *  1. Deterministic validation (validateTranslatedTitle, validateTranslatedDescription, validateTranslationPair)
 *  2. DeepL client parameter checks and mock response handling
 *  3. Translation pass state transitions and retranslation triggers
 *  4. Fail-closed filter behavior for feed and SEO paths
 */

import {
  validateTranslatedTitle,
  validateTranslatedDescription,
  validateTranslationPair,
} from '../src/lib/translation/validation';
import {
  isDeepLConfigured,
  deeplTranslate,
} from '../src/lib/translation/deepl-client';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${detail ? `(${detail})` : ''}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n============================================================');
  console.log('MULTILINGUAL TRANSLATION LAYER — TEST SUITE');
  console.log('Testing Validation, Client, Filter & Invariants');
  console.log('============================================================\n');

  // --------------------------------------------------------------------------
  // 1. Title Validation
  // --------------------------------------------------------------------------
  console.log('1. Title Validation');
  assert(validateTranslatedTitle('Senior Software Engineer').valid === true, 'Valid title accepted');
  assert(validateTranslatedTitle('A').valid === false, 'Title under 2 chars rejected');
  assert(validateTranslatedTitle('   ').valid === false, 'Whitespace-only title rejected');
  assert(validateTranslatedTitle('Lead Engineer ($120k)').valid === false, 'Title with $ salary rejected');
  assert(validateTranslatedTitle('Developer €80,000').valid === false, 'Title with € salary rejected');
  assert(validateTranslatedTitle('Engineer £75000').valid === false, 'Title with £ salary rejected');
  assert(validateTranslatedTitle('Engineer at https://example.com/job').valid === false, 'Title with URL rejected');
  assert(validateTranslatedTitle('Senior <b>Engineer</b>').valid === false, 'Title with HTML tags rejected');

  // --------------------------------------------------------------------------
  // 2. Description Validation & Length Ratio
  // --------------------------------------------------------------------------
  console.log('\n2. Description Validation');
  const validOriginal = 'Wir suchen einen erfahrenen Full-Stack-Entwickler mit Kenntnissen in TypeScript und React.';
  const validTranslated = 'We are looking for an experienced full-stack developer with knowledge of TypeScript and React.';
  assert(validateTranslatedDescription(validTranslated, validOriginal).valid === true, 'Valid description accepted');
  assert(validateTranslatedDescription('Short', validOriginal).valid === false, 'Description under 10 chars rejected');

  // Length ratio guard: less than 30% of original length rejected
  const longOriginal = 'A'.repeat(500);
  const tooShortTranslated = 'A'.repeat(100); // 20%
  const acceptableTranslated = 'A'.repeat(200); // 40%
  assert(
    validateTranslatedDescription(tooShortTranslated, longOriginal).valid === false,
    'Description under 30% of original length rejected (content destruction guard)'
  );
  assert(
    validateTranslatedDescription(acceptableTranslated, longOriginal).valid === true,
    'Description >= 30% of original length accepted'
  );

  // Hallucination guards
  assert(
    validateTranslatedDescription('Job details here. Salary: $100,000/yr.', validOriginal).valid === false,
    'Description with hallucinated dollar figure rejected'
  );
  assert(
    validateTranslatedDescription('Job details here. Apply at https://jobs.example.com', validOriginal).valid === false,
    'Description with hallucinated URL rejected'
  );
  assert(
    validateTranslatedDescription('Job details <p>with paragraphs</p>', validOriginal).valid === false,
    'Description with HTML tags rejected'
  );

  // Pair validation
  assert(
    validateTranslationPair('Software Engineer', validTranslated, validOriginal).valid === true,
    'Valid title + description pair passes'
  );
  assert(
    validateTranslationPair('A', validTranslated, validOriginal).valid === false,
    'Pair with invalid title fails'
  );
  assert(
    validateTranslationPair('Software Engineer', 'Too short', validOriginal).valid === false,
    'Pair with invalid description fails'
  );

  // --------------------------------------------------------------------------
  // 3. DeepL Client Validation & Guardrails
  // --------------------------------------------------------------------------
  console.log('\n3. DeepL Client Guardrails');
  
  // Parameter checks
  let emptyArrayFailed = false;
  try {
    await deeplTranslate([]);
  } catch (err) {
    emptyArrayFailed = true;
  }
  assert(emptyArrayFailed, 'deeplTranslate rejects empty texts array');

  let tooManyTextsFailed = false;
  try {
    const fiftyOneTexts = Array(51).fill('text');
    await deeplTranslate(fiftyOneTexts);
  } catch (err) {
    tooManyTextsFailed = true;
  }
  assert(tooManyTextsFailed, 'deeplTranslate rejects > 50 texts per batch');

  // Config check with temporary env manipulation
  const origKey = process.env.DEEPL_API_KEY;
  try {
    delete process.env.DEEPL_API_KEY;
    assert(isDeepLConfigured() === false, 'isDeepLConfigured returns false when key is missing');
    let keyMissingFailed = false;
    try {
      await deeplTranslate(['Hello']);
    } catch (err) {
      keyMissingFailed = (err as Error).message.includes('DEEPL_API_KEY is not set');
    }
    assert(keyMissingFailed, 'deeplTranslate throws descriptive error when DEEPL_API_KEY missing');

    process.env.DEEPL_API_KEY = 'test-key';
    assert(isDeepLConfigured() === true, 'isDeepLConfigured returns true when key is set');
  } finally {
    if (origKey !== undefined) {
      process.env.DEEPL_API_KEY = origKey;
    } else {
      delete process.env.DEEPL_API_KEY;
    }
  }

  // Mocked fetch for Deepl parsing
  const originalFetch = globalThis.fetch;
  try {
    // Test 1: Successful response parsing
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          translations: [
            { detected_source_language: 'DE', text: 'Software Engineer' },
            { detected_source_language: 'DE', text: 'We are looking for an engineer.' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );

    process.env.DEEPL_API_KEY = 'mock-key';
    const mockResult = await deeplTranslate(['Softwareentwickler', 'Wir suchen einen Entwickler.']);
    assert(mockResult.detectedSourceLanguage === 'DE', 'Correctly parsed detectedSourceLanguage');
    assert(mockResult.translations.length === 2, 'Parsed all translated strings');
    assert(mockResult.translations[0] === 'Software Engineer', 'First translation matches');

    // Test 2: Rate limit (429) handling
    globalThis.fetch = async () => new Response('Too Many Requests', { status: 429 });
    let rateLimitThrown = false;
    try {
      await deeplTranslate(['Test']);
    } catch (err) {
      rateLimitThrown = (err as Error).message.includes('Rate limit (429)');
    }
    assert(rateLimitThrown, 'Rate limit 429 produces typed error');

    // Test 3: Quota exceeded (456) handling
    globalThis.fetch = async () => new Response('Quota Exceeded', { status: 456 });
    let quotaThrown = false;
    try {
      await deeplTranslate(['Test']);
    } catch (err) {
      quotaThrown = (err as Error).message.includes('Quota exceeded (456)');
    }
    assert(quotaThrown, 'Quota exceeded 456 produces typed error');

    // Test 4: Translation count mismatch
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          translations: [{ detected_source_language: 'DE', text: 'Only one' }],
        }),
        { status: 200 }
      );
    let countMismatchThrown = false;
    try {
      await deeplTranslate(['Title', 'Description']);
    } catch (err) {
      countMismatchThrown = (err as Error).message.includes('does not match input count');
    }
    assert(countMismatchThrown, 'Response with translation count mismatch throws error');
  } finally {
    globalThis.fetch = originalFetch;
    if (origKey !== undefined) {
      process.env.DEEPL_API_KEY = origKey;
    } else {
      delete process.env.DEEPL_API_KEY;
    }
  }

  // --------------------------------------------------------------------------
  // 4. Fail-Closed Filter Invariants (Pure Logic Simulation)
  // --------------------------------------------------------------------------
  console.log('\n4. Fail-Closed Filter Contract Simulation');

  interface FilterCandidate {
    id: string;
    source_language: string | null;
    translation_status: string | null;
  }

  function simulateTranslationSafeFilter(candidate: FilterCandidate): boolean {
    // Corresponds to:
    // query.or('source_language.is.null,source_language.eq.en,translation_status.eq.ok')
    const isSourceLangNull = candidate.source_language === null;
    const isSourceLangEn = candidate.source_language === 'en';
    const isTranslationOk = candidate.translation_status === 'ok';

    return isSourceLangNull || isSourceLangEn || isTranslationOk;
  }

  const englishListing: FilterCandidate = {
    id: '1',
    source_language: 'en',
    translation_status: 'n/a',
  };
  const translatedGermanListing: FilterCandidate = {
    id: '2',
    source_language: 'de',
    translation_status: 'ok',
  };
  const failedGermanListing: FilterCandidate = {
    id: '3',
    source_language: 'de',
    translation_status: 'error',
  };
  const unexaminedListing: FilterCandidate = {
    id: '4',
    source_language: null,
    translation_status: null,
  };

  assert(
    simulateTranslationSafeFilter(englishListing) === true,
    'English listings (source_language = en) are included'
  );
  assert(
    simulateTranslationSafeFilter(translatedGermanListing) === true,
    'Successfully translated non-English listings (translation_status = ok) are included'
  );
  assert(
    simulateTranslationSafeFilter(failedGermanListing) === false,
    'Failed non-English listings (translation_status = error) are EXCLUDED (fail closed)'
  );
  assert(
    simulateTranslationSafeFilter(unexaminedListing) === true,
    'Fresh unexamined listings (source_language = null) pass initial filter'
  );

  // --------------------------------------------------------------------------
  // 5. Content-Hash-Based Retranslation Trigger Invariant
  // --------------------------------------------------------------------------
  console.log('\n5. Content-Hash Retranslation Trigger Logic');

  interface JobRowState {
    status: string;
    content_hash: string;
    translation_status: string | null;
    translated_content_hash: string | null;
  }

  function isEligibleForTranslationOrRetranslation(row: JobRowState): boolean {
    if (row.status !== 'active') return false;
    const isUnprocessed = row.translation_status === null;
    const isStaleHash =
      row.translation_status === 'ok' &&
      row.translated_content_hash !== null &&
      row.translated_content_hash !== row.content_hash;
    return isUnprocessed || isStaleHash;
  }

  assert(
    isEligibleForTranslationOrRetranslation({
      status: 'active',
      content_hash: 'hash-v1',
      translation_status: null,
      translated_content_hash: null,
    }) === true,
    'Brand new active row without translation is eligible'
  );

  assert(
    isEligibleForTranslationOrRetranslation({
      status: 'active',
      content_hash: 'hash-v1',
      translation_status: 'ok',
      translated_content_hash: 'hash-v1',
    }) === false,
    'Already translated row with unchanged hash is NOT eligible'
  );

  assert(
    isEligibleForTranslationOrRetranslation({
      status: 'active',
      content_hash: 'hash-v2-updated',
      translation_status: 'ok',
      translated_content_hash: 'hash-v1',
    }) === true,
    'Translated row with altered content_hash IS eligible for retranslation'
  );

  assert(
    isEligibleForTranslationOrRetranslation({
      status: 'expired',
      content_hash: 'hash-v2-updated',
      translation_status: 'ok',
      translated_content_hash: 'hash-v1',
    }) === false,
    'Expired row is never eligible regardless of hash changes'
  );

  console.log('\n============================================================');
  console.log(`RESULTS: ${passed} passed, ${failed} failed.`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test runner threw unhandled error:', err);
  process.exit(1);
});

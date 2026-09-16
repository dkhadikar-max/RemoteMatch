-- ==============================================================================
-- RemoteMatch — 028: multilingual translation layer
--
-- Adds 7 columns to `opportunities` supporting the translation pass
-- (translatePendingOpportunities in src/lib/translation/translate-pending.ts).
--
-- Design decisions (locked, per multilingual-translation-spec.md):
--   - Provider: DeepL Free (source_lang auto-detect + translate in one call)
--   - Fail-closed: untranslated non-English rows excluded from feed AND SEO
--   - Re-translation trigger: hash-based (translated_content_hash)
--   - Only title and description are translated — all structured fields
--     (salary, country lists, skills, remote_type, etc.) are untouched
--
-- Invariants preserved:
--   - content_hash is NOT overwritten by translation (it is the identity
--     fingerprint for deduplication, computed from original-language text)
--   - status lifecycle state machine is NOT changed
--   - RLS policy (status = 'active') is NOT changed
--   - C3 (Greenhouse/Lever/Ashby) rows will naturally receive
--     source_language = 'en' and translation_status = 'n/a'
-- ==============================================================================

ALTER TABLE opportunities
  -- BCP-47 language code of the source text as detected by DeepL.
  -- NULL means the translation pass has not yet run for this row.
  -- 'en' means English detected; no translation performed.
  -- Any other value means translation was attempted/applied.
  ADD COLUMN IF NOT EXISTS source_language      TEXT,

  -- Pre-translation title, preserved verbatim from the moment translation
  -- succeeds. NULL when source_language = 'en' (never had non-English content
  -- to preserve) or when the translation pass has not yet run.
  ADD COLUMN IF NOT EXISTS original_title       TEXT,

  -- Pre-translation description, preserved verbatim. Same NULL semantics
  -- as original_title. Enables re-translation and audit without losing
  -- the source text.
  ADD COLUMN IF NOT EXISTS original_description TEXT,

  -- The content_hash value at the time the translation was last performed.
  -- Re-translation is triggered when content_hash != translated_content_hash,
  -- meaning the provider returned updated content after the last translation.
  -- NULL until the first successful translation (or 'n/a' detection).
  ADD COLUMN IF NOT EXISTS translated_content_hash TEXT,

  -- UTC timestamp of the most recent successful translation (or 'en'
  -- detection). NULL until the first pass. Used for audit.
  ADD COLUMN IF NOT EXISTS translated_at        TIMESTAMPTZ,

  -- Identifier of the translation provider/model used.
  -- e.g. 'deepl-free', 'deepl-pro', 'google-translate-v2'.
  -- NULL until the first pass.
  ADD COLUMN IF NOT EXISTS translation_model    TEXT,

  -- Current translation lifecycle state.
  --   NULL        : translation pass has not yet run for this row
  --   'ok'        : title + description successfully translated to English
  --   'n/a'       : source language is English; no translation needed
  --   'error'     : translation attempted but failed (see logs)
  --                 original (non-English) title/description are in the DB
  --
  -- FEED + SEO FILTER CONTRACT (fail-closed):
  --   A row is publishable iff:
  --     source_language IS NULL          (not yet processed — briefly invisible)
  --     OR source_language = 'en'        (English, no translation needed)
  --     OR translation_status = 'ok'     (non-English, successfully translated)
  --   Any row with translation_status = 'error' and source_language != 'en'
  --   MUST be excluded from the feed and from SEO/sitemap paths.
  ADD COLUMN IF NOT EXISTS translation_status   TEXT
    CHECK (translation_status IN ('ok', 'error', 'n/a'));

-- Index: the translation pass queries by (status, translation_status,
-- source_language) — specifically looking for active rows that either have
-- translation_status IS NULL (not yet processed) or where the content_hash
-- has changed since last translation. A partial index on the common case
-- (NULL translation_status on active rows) keeps the pass fast even as
-- the catalog grows.
CREATE INDEX IF NOT EXISTS idx_opportunities_translation_pending
  ON opportunities (status, posted_at DESC)
  WHERE translation_status IS NULL;

-- Index to efficiently find rows needing re-translation (hash changed).
CREATE INDEX IF NOT EXISTS idx_opportunities_translation_stale
  ON opportunities (source_language, translation_status)
  WHERE source_language IS NOT NULL
    AND source_language != 'en'
    AND translation_status = 'ok';

COMMENT ON COLUMN opportunities.source_language IS
  'BCP-47 language code detected by DeepL auto-detect at translation time. '
  'NULL = translation pass not yet run. ''en'' = English, no translation performed. '
  'Any other value = non-English, translation was attempted.';

COMMENT ON COLUMN opportunities.translation_status IS
  'ok | error | n/a | NULL. '
  'Fail-closed contract: a non-English row with status != ''ok'' MUST be '
  'excluded from the user-facing feed AND from SEO/sitemap paths. '
  'See src/lib/ingestion/catalog-read.ts and src/lib/seo/data.ts.';

COMMENT ON COLUMN opportunities.translated_content_hash IS
  'The content_hash value at the moment translation was last successfully '
  'performed. When content_hash != translated_content_hash the provider has '
  'returned updated content and the row must be re-translated. Never recomputed '
  'or overwritten independently — only set by translatePendingOpportunities().';

COMMENT ON COLUMN opportunities.original_title IS
  'Verbatim title in the source language, captured at the moment the first '
  'successful translation was applied. NULL for English rows. Preserved '
  'permanently so translation can be re-run and the source text audited.';

COMMENT ON COLUMN opportunities.original_description IS
  'Verbatim description in the source language. Same semantics as '
  'original_title. Max length mirrors the Himalayas-stripped description '
  '(~1,500 chars) but is not artificially capped here.';

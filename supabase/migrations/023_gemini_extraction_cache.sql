-- ==============================================================================
-- RemoteMatch — 023: C5 Gemini extraction content-hash cache (AI Phase 1A)
--
-- docs/ai-phase1-implementation-plan.md §2/§6. Cross-sync, cross-employer
-- reusable cache keyed on the exact text handed to Gemini
-- (createContentHash() output, src/lib/ingestion/pipeline.ts:10, reused
-- as-is — this migration does not reimplement hashing). A posting's
-- extraction is a fact about the posting's text, not about which sync run
-- fetched it — this is the primary lever for reducing real Gemini
-- consumption against the shared daily ceiling (ai_quota_ledger,
-- migration 020).
--
-- Stores the RAW CareerPageExtraction (fields + evidence spans) — NEVER
-- the post-validation RawJobPayload candidate. This is the one design
-- constraint that must never be relaxed: extraction-validation.ts's
-- validateExtraction() re-runs against the CURRENT fetch's source text on
-- EVERY hit, cache or not. A cache hit is indistinguishable from a fresh
-- Gemini response to career-page.ts's caller by construction (same return
-- shape from extractJobFromCareerPageText()), which is what makes it
-- structurally impossible to accidentally skip validation on a hit.
--
-- officialUrl is deliberately NOT part of the cached value — it's
-- caller-supplied truth per career-page-extraction.ts's own existing
-- comment ("intentionally NOT evidence-checked... no fabrication vector"),
-- and a cache hit must reflect the CURRENT call's officialUrl, not
-- whatever URL happened to produce the original cache entry.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS gemini_extraction_cache (
  content_hash    text NOT NULL,
  schema_version  int NOT NULL DEFAULT 1,   -- bump only if CareerPageExtraction's shape changes
  extraction      jsonb NOT NULL,            -- CareerPageExtraction minus officialUrl
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, schema_version)
);

COMMENT ON TABLE gemini_extraction_cache IS
  'C5 content-hash cache of raw Gemini extractions (fields + evidence '
  'spans only, never officialUrl, never the post-validation candidate). '
  'Every read is still followed by a full, unmodified validateExtraction() '
  'against the current fetch''s source text — a cache hit never bypasses '
  'evidence validation.';

ALTER TABLE gemini_extraction_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE gemini_extraction_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY "gemini_extraction_cache_service_role_all" ON gemini_extraction_cache FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON gemini_extraction_cache FROM anon, authenticated;
GRANT ALL ON gemini_extraction_cache TO service_role;

-- ==============================================================================
-- DOWN:
--   DROP TABLE IF EXISTS gemini_extraction_cache;
--   -- Safe at any point — a cache-read error is already treated as a miss
--   -- by src/lib/ai/gemini-cache.ts's own contract, so dropping this table
--   -- while code still calls it degrades to "always miss, always call
--   -- Gemini fresh" rather than failing the extraction.
-- ==============================================================================

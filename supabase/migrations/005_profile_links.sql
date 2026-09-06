-- ==============================================================================
-- RemoteMatch — 005: optional professional profile links
--
-- Adds linkedin_url/github_url to `profiles`. These are plain profile
-- content (display links), not an auth/identity mechanism — no OAuth
-- provider, no verification. Scope confirmed against the current schema
-- before writing this: neither column existed anywhere in 001-004.
--
-- These are the first profile-CONTENT fields made Supabase-authoritative
-- (full_name/headline still live in the client-local `localStore` fixture,
-- per 003's explicit scoping) — deliberate: the whole point of this field
-- is surviving a device change via the linked account, which localStorage
-- cannot do. See the accompanying report for why that inconsistency is
-- being left in place rather than migrating full_name/headline too.
-- ==============================================================================

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS github_url TEXT;

-- Defense in depth at the DB layer in addition to app-level validation:
-- NULL/empty is always fine; a non-null value must be HTTPS.
ALTER TABLE profiles
  ADD CONSTRAINT profiles_linkedin_url_https
    CHECK (linkedin_url IS NULL OR linkedin_url LIKE 'https://%'),
  ADD CONSTRAINT profiles_github_url_https
    CHECK (github_url IS NULL OR github_url LIKE 'https://%');

-- Same column-level grant mechanism as 003 (RLS's `profiles_update_own_safe_columns`
-- policy already permits the owner to update their own row — RLS gates by
-- row, not column; this GRANT is what actually restricts which columns).
-- Re-issuing the full safe-column list rather than an incremental grant so
-- this migration is a complete, readable statement of what `authenticated`
-- may write to `profiles` as of this point in the migration history.
GRANT UPDATE (full_name, headline, avatar_url, raw_resume_text, resume_file_url, linkedin_url, github_url)
  ON profiles TO authenticated;

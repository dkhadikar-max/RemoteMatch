-- The public search RPC applies the same public-visibility predicates as
-- opportunities_select_active and normalizes/quotes every user-supplied term.
-- SECURITY DEFINER lets PostgreSQL plan against the existing partial GIN indexes
-- instead of the slower RLS-constrained status-index scan. EXECUTE remains
-- limited to anon, authenticated, and service_role; PUBLIC has no EXECUTE grant.
ALTER FUNCTION public.get_remote_job_search_page(text[], integer, integer) SECURITY DEFINER;
ALTER FUNCTION public.get_remote_job_search_page(text[], integer, integer) SET row_security = off;
COMMENT ON FUNCTION public.get_remote_job_search_page(text[], integer, integer) IS
'Public-facing search RPC. SECURITY DEFINER is intentional so PostgreSQL can use the partial public-search GIN indexes. The function must retain explicit active, non-superseded, language-valid filters; search terms are normalized and quoted before dynamic SQL. Keep these predicates aligned with opportunities_select_active. EXECUTE is restricted to anon, authenticated, and service_role.';

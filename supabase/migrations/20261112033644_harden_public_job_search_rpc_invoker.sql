-- The public job search RPC only reads rows already exposed to anon/authenticated
-- through the active-opportunity RLS policy. It does not need to bypass RLS.
ALTER FUNCTION public.get_remote_job_search_page(text[], integer, integer) SECURITY INVOKER;
ALTER FUNCTION public.get_remote_job_search_page(text[], integer, integer) RESET row_security;

-- The service-role write policy was PUBLIC-scoped, which added an unnecessary
-- service-role predicate to anonymous SELECT planning and prevented partial
-- public-search indexes from being considered. Scope the write policy to the
-- only role it is intended for. The public SELECT policy remains active-only.
ALTER POLICY opportunities_manage_service_role ON public.opportunities TO service_role;

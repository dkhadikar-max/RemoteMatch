-- Restrict the service-role management policy to the service_role database role.
-- Keeping this policy scoped to PUBLIC adds an auth.role() OR branch to anon
-- scans, preventing PostgreSQL from proving the predicates of the public-search
-- partial indexes and forcing a sequential scan of the entire opportunities table.
DROP POLICY IF EXISTS opportunities_manage_service_role ON public.opportunities;

CREATE POLICY opportunities_manage_service_role
  ON public.opportunities
  FOR ALL
  TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

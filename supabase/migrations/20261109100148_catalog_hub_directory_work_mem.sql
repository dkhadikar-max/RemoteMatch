-- Keep the materialized directory match set and its sorts in memory.
-- Production EXPLAIN showed the default work_mem spilling the shared CTE to
-- temporary files; 8MB reduced the deep worldwide page from ~3.7s to ~0.18s.
-- The setting is scoped to this SECURITY INVOKER function call only.
ALTER FUNCTION public.get_remote_job_hub_page(text, integer, integer)
  SET work_mem TO '8MB';

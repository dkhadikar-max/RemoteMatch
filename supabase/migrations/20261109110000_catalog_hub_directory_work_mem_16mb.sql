-- The 8MB function-local work_mem setting still caused sort/hash spills
-- under concurrent production load. 16MB removes the spill in representative
-- anonymous-role directory queries while keeping per-call memory bounded.
ALTER FUNCTION public.get_remote_job_hub_page(text, integer, integer)
  SET work_mem TO '16MB';

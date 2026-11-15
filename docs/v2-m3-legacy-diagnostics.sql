-- V2 M3: how many legacy employer applications exist, and what state are they in?
--
-- READ ONLY. Every statement is a SELECT. NOT RUN anywhere by the author. Running it on the
-- production project needs its own explicit approval (it is the "unknown scale" question in
-- the M3 finding). Returns counts only: no names, emails or resume links.
--
-- "Legacy" = no candidate link AND no recorded application_submitted event, i.e. created
-- before the atomic apply path existed.

-- 1. Legacy applications by employer status.
SELECT e.status, count(*) AS legacy_applications
FROM public.employer_job_applications e
WHERE e.candidate_application_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.hiring_decision_events h
    WHERE h.employer_application_id = e.id AND h.action = 'application_submitted'
  )
GROUP BY e.status
ORDER BY e.status;

-- 2. Of those, how many already have a candidate tracker row for the same job
--    (the rows a future backfill would have to reconcile), by that row's state.
SELECT a.status AS candidate_status, a.application_channel, count(*) AS legacy_with_tracker_row
FROM public.employer_job_applications e
JOIN public.opportunities o ON o.id = e.opportunity_id
JOIN public.applications a
  ON a.profile_id = e.candidate_profile_id AND a.opportunity_id = o.canonical_id
WHERE e.candidate_application_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.hiring_decision_events h
    WHERE h.employer_application_id = e.id AND h.action = 'application_submitted'
  )
GROUP BY a.status, a.application_channel
ORDER BY a.status, a.application_channel;

-- 3. Legacy rejected applications (the ones the old function could never reconsider).
SELECT count(*) AS legacy_rejected
FROM public.employer_job_applications e
WHERE e.status = 'rejected'
  AND e.candidate_application_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.hiring_decision_events h
    WHERE h.employer_application_id = e.id AND h.action = 'application_submitted'
  );

-- 4. Broken links: unlinked rows that DO have their submission event. Expected: 0.
SELECT count(*) AS unlinked_with_submission_event
FROM public.employer_job_applications e
WHERE e.candidate_application_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.hiring_decision_events h
    WHERE h.employer_application_id = e.id AND h.action = 'application_submitted'
  );

-- 5. Linked rejected applications with no recorded rejection event. Expected: 0.
SELECT count(*) AS linked_rejected_without_rejection_event
FROM public.employer_job_applications e
WHERE e.status = 'rejected'
  AND e.candidate_application_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.hiring_decision_events h
    WHERE h.employer_application_id = e.id AND h.action = 'application_rejected'
  );

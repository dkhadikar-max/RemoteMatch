import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedAdmin } from '@/lib/auth/get-authenticated-admin';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows, isMissingRelation, must, mustCount, QueryError } from '@/lib/supabase/query-helpers';
import { runSections, partialFailureResponse } from '@/lib/admin/sections';
import { classifyFeedPipeline, EXPECTED_INTERVAL_HOURS } from '@/lib/admin/sync-status';

const HOUR_MS = 3600 * 1000;
// The C1/C3 cadence thresholds and the status rules live in src/lib/admin/sync-status.ts (pure, tested). The
// schedule itself is configured in Railway and is not readable by this app — it is only ever OBSERVED.
/** A career-page source untouched for this long has no recurring schedule
 *  behind it. */
const C5_UNSCHEDULED_AFTER_HOURS = 48;

type PipelineStatus = 'healthy' | 'degraded' | 'stale' | 'no_evidence' | 'not_scheduled' | 'recent_activity' | 'unavailable';

interface SourceRow {
  id: string;
  platform_slug: string;
  consecutive_fetch_failures: number;
  last_fetch_attempt_at: string | null;
  last_successful_fetch_at: string | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

async function newestTimestamp(
  admin: NonNullable<ReturnType<typeof getSupabaseAdminClient>>,
  beforeIso: string | null
): Promise<string | null> {
  let q = admin
    .from('opportunities')
    .select('last_seen_in_feed_at')
    .not('last_seen_in_feed_at', 'is', null)
    .order('last_seen_in_feed_at', { ascending: false })
    .limit(1);
  if (beforeIso) q = q.lt('last_seen_in_feed_at', beforeIso);
  const res = must(await q, 'opportunities.last_seen_in_feed_at');
  return (res.data?.[0]?.last_seen_in_feed_at as string | undefined) ?? null;
}

/**
 * Per-pipeline status, derived ENTIRELY from real database state — no
 * fabricated run history and no invented schedule.
 *
 * What changed vs. the first version of this route, which was wrong:
 *  - It hard-coded C1/C3 as `cadence: 'manual'`, `enabled: false`, "not on a
 *    configured Railway cron". False: the sync cron has been running every 6
 *    hours (00/06/12/18 UTC) at the time. The cadence is now OBSERVED from the two most
 *    recent runs' newest `last_seen_in_feed_at` timestamps, and the run's
 *    age against that expectation drives healthy / degraded / stale.
 *  - It ignored every query error. A failed section is now reported as
 *    failed (HTTP 500 with partial data), never as an empty pipeline.
 *  - C6 reports `unavailable`, with the database's own message, when its
 *    staging table does not exist — instead of "0 records".
 */
export async function GET(req: NextRequest) {
  try {
    await getAuthenticatedAdmin(req);
  } catch (err) {
    const res = authErrorResponse(err);
    if (res) return res;
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });

  const now = Date.now();

  const { values, failed } = await runSections({
    sources: async () =>
      fetchAllRows<SourceRow>(
        (afterId, pageSize) => {
          let q = admin
            .from('supply_sources')
            .select('id, platform_slug, consecutive_fetch_failures, last_fetch_attempt_at, last_successful_fetch_at')
            .order('id', { ascending: true })
            .limit(pageSize);
          if (afterId) q = q.gt('id', afterId);
          return q;
        },
        { label: 'supply_sources' }
      ),

    feedRuns: async () => {
      const latest = await newestTimestamp(admin, null);
      if (!latest) return { latest: null, previous: null };
      // The previous run: newest activity that predates the latest run by
      // more than 90 minutes (a single run touches rows over a few minutes).
      const previous = await newestTimestamp(admin, new Date(new Date(latest).getTime() - 90 * 60 * 1000).toISOString());
      return { latest, previous };
    },

    careerPageJobs: async () =>
      mustCount(
        await admin.from('opportunities').select('id', { count: 'exact', head: true }).eq('source', 'careerpage'),
        'opportunities.careerpage'
      ),

    // A missing table is a REPORTED state of the C6 pipeline (HTTP 200), not
    // a section failure — that is the whole point of migration 026 being
    // visibly absent. Any other error is a real failure and is rethrown.
    discovery: async () => {
      try {
        const rows = await fetchAllRows<{ id: string; pipeline_stage: string; last_probed_at: string | null }>(
          (afterId, pageSize) => {
            let q = admin
              .from('supply_discovered_companies')
              .select('id, pipeline_stage, last_probed_at')
              .order('id', { ascending: true })
              .limit(pageSize);
            if (afterId) q = q.gt('id', afterId);
            return q;
          },
          { label: 'supply_discovered_companies' }
        );
        const byStage: Record<string, number> = {};
        let lastProbe: string | null = null;
        for (const r of rows) {
          byStage[r.pipeline_stage] = (byStage[r.pipeline_stage] ?? 0) + 1;
          if (r.last_probed_at && (!lastProbe || r.last_probed_at > lastProbe)) lastProbe = r.last_probed_at;
        }
        return { available: true as const, total: rows.length, byStage, lastProbe };
      } catch (err) {
        if (err instanceof QueryError && isMissingRelation({ message: err.message, code: err.code })) {
          return { available: false as const, message: err.message };
        }
        throw err;
      }
    },
  });

  const sources = values.sources;
  const c5Sources = sources?.filter((s) => s.platform_slug === 'careerpage');
  const c1c3Sources = sources?.filter((s) => s.platform_slug !== 'careerpage');
  const sectionFailure = (...names: string[]) => failed.find((f) => names.includes(f.section));

  const groupTimes = (rows: SourceRow[]) => {
    let lastAttempt: string | null = null;
    let lastSuccess: string | null = null;
    for (const s of rows) {
      if (s.last_fetch_attempt_at && (!lastAttempt || s.last_fetch_attempt_at > lastAttempt)) lastAttempt = s.last_fetch_attempt_at;
      if (s.last_successful_fetch_at && (!lastSuccess || s.last_successful_fetch_at > lastSuccess)) lastSuccess = s.last_successful_fetch_at;
    }
    return { lastAttempt, lastSuccess };
  };

  // ---- C1 aggregators + C3 ATS ----
  let c1c3: Record<string, unknown>;
  const c1c3Failure = sectionFailure('sources', 'feedRuns');
  if (c1c3Failure || !c1c3Sources || !values.feedRuns) {
    c1c3 = {
      id: 'c1_c3',
      label: 'C1 Aggregators + C3 ATS',
      status: 'unavailable' as PipelineStatus,
      cadence: 'unavailable',
      enabled: false,
      lastExecution: null,
      lastSuccess: null,
      recordsDiscovered: null,
      errors: null,
      note: `Could not be determined: ${c1c3Failure?.message ?? 'a required section failed'}`,
    };
  } else {
    const { latest, previous } = values.feedRuns;
    const ageHours = latest ? (now - new Date(latest).getTime()) / HOUR_MS : null;
    const observedInterval = latest && previous ? round1((new Date(latest).getTime() - new Date(previous).getTime()) / HOUR_MS) : null;

    // A recent run is NOT a schedule: "healthy" requires an observed ~6h cadence (see classifyFeedPipeline).
    const { status, enabled, cadence } = classifyFeedPipeline({ ageHours, observedIntervalHours: observedInterval });

    const times = groupTimes(c1c3Sources);
    c1c3 = {
      id: 'c1_c3',
      label: 'C1 Aggregators + C3 ATS',
      status,
      cadence,
      enabled,
      expectedIntervalHours: EXPECTED_INTERVAL_HOURS,
      observedIntervalHours: observedInterval,
      lastRunAgeHours: ageHours === null ? null : round1(ageHours),
      lastExecution: latest,
      lastSuccess: latest,
      registrySourcesLastAttempt: times.lastAttempt,
      recordsDiscovered: c1c3Sources.length,
      errors: c1c3Sources.filter((s) => s.consecutive_fetch_failures > 0).length,
      note:
        'Cadence and last run are inferred from the newest opportunity last_seen_in_feed_at (the schedule itself is configured in ' +
        'Railway and is not readable by the app). Only registry-backed ATS sources record per-source failures here; the aggregator ' +
        'feeds (Remotive, Arbeitnow, Jobicy, WeWorkRemotely, Himalayas, RemoteOK) do not record per-provider health yet.',
    };
  }

  // ---- C5 career pages ----
  let c5: Record<string, unknown>;
  const c5Failure = sectionFailure('sources', 'careerPageJobs');
  if (c5Failure || !c5Sources || values.careerPageJobs === undefined) {
    c5 = {
      id: 'c5',
      label: 'C5 Career-Page Pipeline',
      status: 'unavailable' as PipelineStatus,
      cadence: 'unavailable',
      enabled: false,
      lastExecution: null,
      lastSuccess: null,
      recordsDiscovered: null,
      errors: null,
      note: `Could not be determined: ${c5Failure?.message ?? 'a required section failed'}`,
    };
  } else {
    const times = groupTimes(c5Sources);
    const ageHours = times.lastAttempt ? (now - new Date(times.lastAttempt).getTime()) / HOUR_MS : null;
    const unscheduled = ageHours === null || ageHours > C5_UNSCHEDULED_AFTER_HOURS;
    c5 = {
      id: 'c5',
      label: 'C5 Career-Page Pipeline',
      status: (unscheduled ? 'not_scheduled' : 'recent_activity') as PipelineStatus,
      cadence: 'not scheduled',
      enabled: false,
      lastRunAgeHours: ageHours === null ? null : round1(ageHours),
      lastExecution: times.lastAttempt,
      lastSuccess: times.lastSuccess,
      recordsDiscovered: c5Sources.length,
      publishedJobs: values.careerPageJobs,
      errors: c5Sources.filter((s) => s.consecutive_fetch_failures > 0).length,
      note:
        `Not on a recurring schedule: ${ageHours === null ? 'no run has ever been recorded' : `the last attempt was ${round1(ageHours)}h ago`}, ` +
        `and ${values.careerPageJobs} career-page job${values.careerPageJobs === 1 ? ' has' : 's have'} ever been published. ` +
        'The C5 cron is intentionally off until its safety gate passes.',
    };
  }

  // ---- C6 discovery ----
  let c6: Record<string, unknown>;
  const c6Failure = sectionFailure('discovery');
  const discovery = values.discovery;
  if (c6Failure || !discovery) {
    c6 = {
      id: 'c6',
      label: 'C6 Automated Company Discovery',
      status: 'unavailable' as PipelineStatus,
      cadence: 'not scheduled',
      enabled: false,
      lastExecution: null,
      lastSuccess: null,
      recordsDiscovered: null,
      errors: null,
      note: `Could not be determined: ${c6Failure?.message ?? 'a required section failed'}`,
    };
  } else if (!discovery.available) {
    c6 = {
      id: 'c6',
      label: 'C6 Automated Company Discovery',
      status: 'unavailable' as PipelineStatus,
      cadence: 'not scheduled',
      enabled: false,
      lastExecution: null,
      lastSuccess: null,
      recordsDiscovered: null,
      errors: null,
      note:
        'Unavailable: the C6 staging tables do not exist in this database (migration 026 has not been applied), so no candidate ' +
        `can be stored or reviewed. Database message: ${discovery.message}`,
    };
  } else {
    c6 = {
      id: 'c6',
      label: 'C6 Automated Company Discovery',
      status: 'not_scheduled' as PipelineStatus,
      cadence: 'not scheduled',
      enabled: false,
      lastExecution: discovery.lastProbe,
      lastSuccess: discovery.lastProbe,
      recordsDiscovered: discovery.total,
      errors: 0,
      note: 'scripts/c6-*.ts are run manually, not on a scheduler. Automatic promotion stays disabled — every promotion is an admin action.',
      byStage: discovery.byStage,
    };
  }

  const body = { generatedAt: new Date(now).toISOString(), pipelines: [c1c3, c5, c6] };
  if (failed.length > 0) return partialFailureResponse(failed, body);
  return NextResponse.json(body);
}

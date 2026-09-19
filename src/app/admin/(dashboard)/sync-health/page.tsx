'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatusBadge, type StatusTone } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState } from '@/components/admin/States';

type PipelineStatus =
  | 'healthy'
  | 'degraded'
  | 'stale'
  | 'no_evidence'
  | 'not_scheduled'
  | 'recent_activity'
  | 'unavailable';

interface Pipeline {
  id: string;
  label: string;
  status: PipelineStatus;
  cadence: string;
  enabled: boolean;
  lastRunAgeHours?: number | null;
  publishedJobs?: number;
  lastExecution: string | null;
  lastSuccess: string | null;
  recordsDiscovered: number | null;
  errors: number | null;
  note: string;
}

interface FailedSection {
  section: string;
  message: string;
}

const STATUS_LABEL: Record<PipelineStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded — a run was missed',
  stale: 'Stale — no recent run',
  no_evidence: 'No run observed',
  not_scheduled: 'Not scheduled',
  recent_activity: 'Recent activity (no schedule)',
  unavailable: 'Unavailable',
};

const STATUS_TONE: Record<PipelineStatus, StatusTone> = {
  healthy: 'good',
  degraded: 'warn',
  stale: 'danger',
  no_evidence: 'warn',
  not_scheduled: 'neutral',
  recent_activity: 'neutral',
  unavailable: 'danger',
};

export default function SyncHealthPage() {
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [failed, setFailed] = useState<FailedSection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/sync-health');
      let json: { pipelines?: Pipeline[]; partial?: { pipelines?: Pipeline[] }; failedSections?: FailedSection[]; error?: string } = {};
      try {
        json = await res.json();
      } catch {
        /* non-JSON body — handled below */
      }
      if (res.ok && json.pipelines) {
        setPipelines(json.pipelines);
        setFailed([]);
      } else if (json.partial?.pipelines) {
        setPipelines(json.partial.pipelines);
        setFailed(json.failedSections ?? []);
      } else {
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!pipelines) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Sync Health</h1>
        <p className="text-xs text-[var(--muted)]">
          Status per pipeline, derived from real database state. C1/C3 cadence is observed from run timestamps — the
          schedule itself is configured in Railway. A pipeline that cannot be determined is shown as Unavailable, never as
          zero.
        </p>
      </div>

      {failed.length > 0 && (
        <div role="alert" className="rounded-xl border border-[var(--danger)] bg-[var(--surface-soft)] p-3 text-xs">
          <div className="font-semibold text-[var(--danger)]">Some sections could not be loaded.</div>
          <ul className="mt-1 space-y-0.5 text-[var(--muted)]">
            {failed.map((f) => (
              <li key={f.section}>
                <span className="font-mono">{f.section}</span>: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-3">
        {pipelines.map((p) => (
          <div key={p.id} className="soft-card border border-[var(--line)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-[var(--ink)]">{p.label}</h2>
              <div className="flex items-center gap-2">
                <StatusBadge label={STATUS_LABEL[p.status] ?? p.status} tone={STATUS_TONE[p.status] ?? 'neutral'} />
                <StatusBadge label={p.cadence} tone="neutral" />
                {p.errors !== null && p.errors > 0 && (
                  <StatusBadge label={`${p.errors} failing`} tone="danger" />
                )}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-[var(--muted)]">{p.note}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              <Field label="Last execution" value={p.lastExecution ? new Date(p.lastExecution).toLocaleString() : 'Never'} />
              <Field
                label="Last run age"
                value={p.lastRunAgeHours === undefined || p.lastRunAgeHours === null ? '—' : `${p.lastRunAgeHours}h`}
              />
              <Field
                label="Sources / records"
                value={p.recordsDiscovered === null ? 'Unavailable' : String(p.recordsDiscovered)}
              />
              <Field
                label="Currently failing"
                value={p.errors === null ? 'Unavailable' : String(p.errors)}
              />
              {p.publishedJobs !== undefined && <Field label="Jobs published" value={String(p.publishedJobs)} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-[var(--ink)]">{value}</div>
    </div>
  );
}

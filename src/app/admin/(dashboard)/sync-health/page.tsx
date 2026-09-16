'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState } from '@/components/admin/States';

interface Pipeline {
  id: string;
  label: string;
  cadence: string;
  enabled: boolean;
  lastExecution: string | null;
  lastSuccess: string | null;
  recordsDiscovered: number;
  errors: number;
  note: string;
}

export default function SyncHealthPage() {
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/sync-health');
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setPipelines(data.pipelines);
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
          Honest status per pipeline — cadence shown as "manual" is not a bug, it reflects that no pipeline is
          actually on a configured Railway cron today. Every timestamp is real, derived from source counters.
        </p>
      </div>

      <div className="space-y-3">
        {pipelines.map((p) => (
          <div key={p.id} className="soft-card border border-[var(--line)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-[var(--ink)]">{p.label}</h2>
              <div className="flex items-center gap-2">
                <StatusBadge label={p.cadence === 'manual' ? 'Manual / not scheduled' : p.cadence} tone="warn" />
                {p.errors > 0 && <StatusBadge label={`${p.errors} error${p.errors === 1 ? '' : 's'}`} tone="danger" />}
              </div>
            </div>
            <p className="mt-1 text-[11px] text-[var(--muted)]">{p.note}</p>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
              <Field label="Last execution" value={p.lastExecution ? new Date(p.lastExecution).toLocaleString() : 'Never'} />
              <Field label="Last success" value={p.lastSuccess ? new Date(p.lastSuccess).toLocaleString() : 'Never'} />
              <Field label="Sources / records" value={String(p.recordsDiscovered)} />
              <Field label="Currently failing" value={String(p.errors)} />
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

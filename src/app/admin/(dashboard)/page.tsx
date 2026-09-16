'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatCard } from '@/components/admin/StatCard';
import { LoadingState, ErrorState } from '@/components/admin/States';

interface DashboardData {
  opportunities: { total: number; active: number; fresh48h: number };
  supply: { activeEmployers: number; activeSources: number; failedSources: number };
  jobsBySource: Record<string, number>;
  jobsByRemoteScope: Record<string, number>;
  discovery: {
    byStage: Record<string, number>;
    candidatesTotal: number;
    awaitingReview: number;
    qualifiedRemote: number;
    promoted: number;
    rejected: number;
  };
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/dashboard');
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000); // manual-refresh-class polling, matching the /staging precedent
    return () => clearInterval(interval);
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <LoadingState label="Loading dashboard…" />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Dashboard</h1>
        <p className="text-xs text-[var(--muted)]">Live production metrics — refreshes every 30s.</p>
      </div>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Opportunities</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <StatCard label="Active" value={data.opportunities.active} />
          <StatCard label="Fresh (≤48h)" value={data.opportunities.fresh48h} tone="good" />
          <StatCard label="Total (all-time)" value={data.opportunities.total} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Supply</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <StatCard label="Active employers" value={data.supply.activeEmployers} />
          <StatCard label="Active sources" value={data.supply.activeSources} />
          <StatCard
            label="Sources with failures"
            value={data.supply.failedSources}
            tone={data.supply.failedSources > 0 ? 'warn' : 'good'}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">C6 Discovery</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Total candidates" value={data.discovery.candidatesTotal} />
          <StatCard label="Awaiting review" value={data.discovery.awaitingReview} tone="warn" />
          <StatCard label="Promoted" value={data.discovery.promoted} tone="good" />
          <StatCard label="Rejected" value={data.discovery.rejected} />
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Active jobs by source</h2>
          <BreakdownList data={data.jobsBySource} />
        </section>
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Active jobs by remote scope</h2>
          <BreakdownList data={data.jobsByRemoteScope} />
        </section>
      </div>
    </div>
  );
}

function BreakdownList({ data }: { data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return <p className="text-xs text-[var(--muted)]">No active rows.</p>;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <ul className="space-y-2">
      {entries.map(([key, count]) => (
        <li key={key} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 truncate text-[var(--ink)]">{key}</span>
          <div className="bar flex-1">
            <span style={{ width: `${(count / max) * 100}%` }} />
          </div>
          <span className="w-10 shrink-0 text-right tabular-nums text-[var(--muted)]">{count}</span>
        </li>
      ))}
    </ul>
  );
}

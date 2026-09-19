'use client';

import { useEffect, useState, useCallback } from 'react';
import { StatCard } from '@/components/admin/StatCard';
import { LoadingState, ErrorState } from '@/components/admin/States';

interface FailedSection {
  section: string;
  message: string;
}

interface DashboardData {
  opportunities?: { total?: number; active?: number; fresh48h?: number };
  supply?: { activeEmployers?: number; activeSources?: number; failedSources?: number };
  jobsBySource?: Record<string, number>;
  jobsByRemoteScope?: Record<string, number>;
  discovery?: {
    byStage: Record<string, number>;
    candidatesTotal: number;
    awaitingReview: number;
    careerFoundNotQualified: number;
    promoted: number;
    rejected: number;
  };
}

export default function AdminDashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState<FailedSection[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/dashboard');
      let json: { partial?: DashboardData; failedSections?: FailedSection[]; error?: string } & DashboardData = {};
      try {
        json = await res.json();
      } catch {
        /* non-JSON body — handled below */
      }
      if (res.ok) {
        setData(json);
        setFailed([]);
      } else if (json.partial) {
        // The server computed what it could and named what it could not —
        // render the healthy panels, mark the rest as failed.
        setData(json.partial);
        setFailed(json.failedSections ?? []);
      } else {
        throw new Error(json.error ?? `Request failed (${res.status})`);
      }
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

  // Which failed sections feed which panel.
  const failuresFor = (...sections: string[]) => failed.filter((f) => sections.includes(f.section));
  const discoveryFailures = failuresFor('discovery');
  const breakdownFailures = failuresFor('activeSnapshot', 'consistency');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Dashboard</h1>
        <p className="text-xs text-[var(--muted)]">Live production metrics — refreshes every 30s.</p>
      </div>

      {failed.length > 0 && (
        <div role="alert" className="rounded-xl border border-[var(--danger)] bg-[var(--surface-soft)] p-3 text-xs">
          <div className="font-semibold text-[var(--danger)]">
            {failed.length} dashboard section{failed.length === 1 ? '' : 's'} could not be loaded. Affected panels below are
            marked unavailable — they are NOT zero.
          </div>
          <ul className="mt-1 space-y-0.5 text-[var(--muted)]">
            {failed.map((f) => (
              <li key={f.section}>
                <span className="font-mono">{f.section}</span>: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Opportunities</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <MaybeStat label="Active" value={data.opportunities?.active} failures={failuresFor('activeSnapshot', 'consistency')} />
          <MaybeStat label="Fresh (≤48h)" value={data.opportunities?.fresh48h} tone="good" failures={failuresFor('activeSnapshot', 'consistency')} />
          <MaybeStat label="Total (all-time)" value={data.opportunities?.total} failures={failuresFor('totalOpportunities')} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Supply</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <MaybeStat label="Active employers" value={data.supply?.activeEmployers} failures={failuresFor('activeEmployers')} />
          <MaybeStat label="Active sources" value={data.supply?.activeSources} failures={failuresFor('activeSources')} />
          <MaybeStat
            label="Sources with failures"
            value={data.supply?.failedSources}
            failures={failuresFor('failedSources')}
            tone={(data.supply?.failedSources ?? 0) > 0 ? 'warn' : 'good'}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">C6 Discovery</h2>
        {data.discovery ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Total candidates" value={data.discovery.candidatesTotal} />
            <StatCard label="Awaiting review (qualified)" value={data.discovery.awaitingReview} tone="warn" />
            <StatCard label="Promoted" value={data.discovery.promoted} tone="good" />
            <StatCard label="Rejected" value={data.discovery.rejected} />
          </div>
        ) : (
          <Unavailable failures={discoveryFailures} />
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Active jobs by source</h2>
          {data.jobsBySource ? <BreakdownList data={data.jobsBySource} /> : <Unavailable failures={breakdownFailures} />}
        </section>
        <section className="soft-card border border-[var(--line)] p-4">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Active jobs by remote scope</h2>
          {data.jobsByRemoteScope ? <BreakdownList data={data.jobsByRemoteScope} /> : <Unavailable failures={breakdownFailures} />}
        </section>
      </div>
    </div>
  );
}

/** A stat that is either a real number or an explicit "unavailable" — never a
 *  skeleton or zero standing in for a failed query. */
function MaybeStat({
  label,
  value,
  failures,
  tone,
}: {
  label: string;
  value: number | undefined;
  failures: FailedSection[];
  tone?: 'good' | 'warn';
}) {
  if (value === undefined) {
    return (
      <div className="soft-card border border-[var(--danger)] p-3">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</div>
        <div className="mt-1 text-sm font-semibold text-[var(--danger)]">Unavailable</div>
        {failures.length > 0 && <div className="mt-0.5 text-[10px] text-[var(--muted)]">{failures[0].message}</div>}
      </div>
    );
  }
  return <StatCard label={label} value={value} tone={tone} />;
}

function Unavailable({ failures }: { failures: FailedSection[] }) {
  return (
    <div className="rounded-xl border border-[var(--danger)] p-3 text-xs">
      <div className="font-semibold text-[var(--danger)]">Unavailable</div>
      {failures.map((f) => (
        <div key={f.section} className="mt-0.5 text-[var(--muted)]">
          {f.message}
        </div>
      ))}
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

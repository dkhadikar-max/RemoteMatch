'use client';

import { useEffect, useState, useCallback } from 'react';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';

interface SourceRow {
  id: string;
  platform_slug: string;
  board: string;
  employer_name: string | null;
  acquisition_method: string;
  status: string;
  consecutive_fetch_failures: number;
  last_fetch_attempt_at: string | null;
  last_successful_fetch_at: string | null;
  lifetime_jobs_ingested: number;
  health: 'healthy' | 'failing' | 'stale' | 'never_run';
}

const HEALTH_TONE = { healthy: 'good', failing: 'danger', stale: 'warn', never_run: 'neutral' } as const;
const HEALTH_LABEL = { healthy: 'Healthy', failing: 'Failing', stale: 'Stale (>72h)', never_run: 'Never run' };

export default function SourcesPage() {
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [platform, setPlatform] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set('status', status);
    if (platform) params.set('platform', platform);
    try {
      const res = await fetch(`/api/admin/sources?${params}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setRows(data.sources);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, status, platform]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<SourceRow>[] = [
    { key: 'source', header: 'Source', render: (r) => (
      <div>
        <div className="font-medium text-[var(--ink)]">{r.employer_name || r.board || r.platform_slug}</div>
        <div className="text-[10px] text-[var(--muted)]">{r.platform_slug}{r.board ? ` / ${r.board}` : ''}</div>
      </div>
    )},
    { key: 'status', header: 'Status', render: (r) => <StatusBadge label={r.status} tone={r.status === 'active' ? 'good' : 'neutral'} /> },
    { key: 'health', header: 'Health', render: (r) => <StatusBadge label={HEALTH_LABEL[r.health]} tone={HEALTH_TONE[r.health]} /> },
    { key: 'failures', header: 'Consecutive failures', render: (r) => <span className="tabular-nums">{r.consecutive_fetch_failures}</span> },
    { key: 'last_attempt', header: 'Last attempt', render: (r) => r.last_fetch_attempt_at ? new Date(r.last_fetch_attempt_at).toLocaleString() : '—' },
    { key: 'last_success', header: 'Last success', render: (r) => r.last_successful_fetch_at ? new Date(r.last_successful_fetch_at).toLocaleString() : '—' },
    { key: 'lifetime', header: 'Lifetime ingested', render: (r) => <span className="tabular-nums">{r.lifetime_jobs_ingested}</span> },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Supply Sources</h1>
        <p className="text-xs text-[var(--muted)]">Per-source health, derived from real fetch counters — not a fabricated run log.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="proposed">Proposed</option>
          <option value="retired">Retired</option>
        </select>
        <select value={platform} onChange={(e) => { setPlatform(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All platforms</option>
          <option value="remotive">Remotive</option>
          <option value="arbeitnow">Arbeitnow</option>
          <option value="jobicy">Jobicy</option>
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
          <option value="careerpage">Career page</option>
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No sources match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
          <Pagination page={page} pageSize={30} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

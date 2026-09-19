'use client';

import { useEffect, useState, useCallback } from 'react';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface EmployerRow {
  id: string;
  canonical_name: string;
  official_domain: string;
  career_url: string;
  ats_provider: string | null;
  review_status: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  linked_source_id: string | null;
  created_at: string;
}

const STATUS_TONE = { approved: 'good', pending: 'warn', rejected: 'danger' } as const;

export default function EmployersPage() {
  const [rows, setRows] = useState<EmployerRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [reviewStatus, setReviewStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (reviewStatus) params.set('reviewStatus', reviewStatus);
    try {
      const res = await fetch(`/api/admin/employers?${params}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.employers);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, q, reviewStatus]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<EmployerRow>[] = [
    { key: 'name', header: 'Employer', render: (r) => (
      <div>
        <div className="font-medium text-[var(--ink)]">{r.canonical_name}</div>
        <div className="text-[10px] text-[var(--muted)]">{r.official_domain}</div>
      </div>
    )},
    { key: 'ats', header: 'ATS', render: (r) => r.ats_provider ?? <span className="text-[var(--muted)]">Direct/career-page</span> },
    { key: 'status', header: 'Review status', render: (r) => <StatusBadge label={r.review_status} tone={STATUS_TONE[r.review_status as keyof typeof STATUS_TONE] ?? 'neutral'} /> },
    { key: 'reviewed_by', header: 'Reviewed by', render: (r) => r.reviewed_by ?? '—' },
    { key: 'career_url', header: 'Career URL', render: (r) => (
      <a href={r.career_url} target="_blank" rel="noreferrer" className="text-[var(--red)] hover:underline">
        {(() => { try { return new URL(r.career_url).hostname; } catch { return r.career_url; } })()}
      </a>
    )},
    { key: 'created', header: 'Added', render: (r) => new Date(r.created_at).toLocaleDateString() },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Employers</h1>
        <p className="text-xs text-[var(--muted)]">The live allowlist_employers registry.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by name…" className="soft-input px-2.5 py-1.5 text-xs w-48" />
        <select value={reviewStatus} onChange={(e) => { setReviewStatus(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All statuses</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No employers match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
          <Pagination page={page} pageSize={30} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

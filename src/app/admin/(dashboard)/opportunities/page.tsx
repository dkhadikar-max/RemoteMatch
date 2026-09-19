'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface OpportunityRow {
  id: string;
  title: string;
  company: string;
  source: string;
  remote_type: string;
  status: string;
  posted_at: string;
  translation_status: string | null;
  source_language: string | null;
  quality_score: number;
}

const STATUS_TONE = { active: 'good', expired: 'danger', draft: 'warn', unknown: 'neutral' } as const;

export default function OpportunitiesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<OpportunityRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [company, setCompany] = useState('');
  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (company) params.set('company', company);
    if (source) params.set('source', source);
    if (status) params.set('status', status);
    try {
      const res = await fetch(`/api/admin/opportunities?${params}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.opportunities);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, q, company, source, status]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<OpportunityRow>[] = [
    { key: 'title', header: 'Title', render: (r) => <div className="font-medium text-[var(--ink)]">{r.title}</div> },
    { key: 'company', header: 'Company', render: (r) => r.company },
    { key: 'source', header: 'Source', render: (r) => <span className="tag">{r.source}</span> },
    { key: 'remote', header: 'Remote scope', render: (r) => r.remote_type },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge label={r.status} tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? 'neutral'} /> },
    { key: 'translation', header: 'Translation', render: (r) => r.translation_status ?? '—' },
    { key: 'posted', header: 'Posted', render: (r) => new Date(r.posted_at).toLocaleDateString() },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Opportunities</h1>
        <p className="text-xs text-[var(--muted)]">Search the live catalog. Click a row for the full record.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Title contains…" className="soft-input px-2.5 py-1.5 text-xs w-44" />
        <input value={company} onChange={(e) => { setCompany(e.target.value); setPage(1); }} placeholder="Company contains…" className="soft-input px-2.5 py-1.5 text-xs w-44" />
        <input value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} placeholder="Source (exact)…" className="soft-input px-2.5 py-1.5 text-xs w-36" />
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="expired">Expired</option>
          <option value="draft">Draft</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No opportunities match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/opportunities/${r.id}`)} />
          <Pagination page={page} pageSize={30} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

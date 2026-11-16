'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface CompanyRow {
  id: string;
  legal_name: string;
  official_domain: string;
  business_email: string;
  verification_status: string;
  verification_reviewed_at: string | null;
  verification_reviewed_by: string | null;
  created_at: string;
}

const STATUS_TONE = {
  verified: 'good',
  pending: 'warn',
  under_review: 'warn',
  rejected: 'danger',
  suspended: 'danger',
} as const;

/**
 * Direct Employer Supply, Phase 1 admin review queue. Deliberately named
 * "Company Verifications", not "Employers" — that nav label already names
 * the unrelated ATS-scrape allowlist (see the Phase 1 plan's Q1).
 */
export default function CompanyVerificationsPage() {
  const [rows, setRows] = useState<CompanyRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [verificationStatus, setVerificationStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (verificationStatus) params.set('verificationStatus', verificationStatus);
    try {
      const res = await fetch(`/api/admin/company-verifications?${params}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.companies);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, q, verificationStatus]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<CompanyRow>[] = [
    { key: 'name', header: 'Company', render: (r) => (
      <Link href={`/admin/company-verifications/${r.id}`} className="block">
        <div className="font-medium text-[var(--ink)] hover:underline">{r.legal_name}</div>
        <div className="text-[10px] text-[var(--muted)]">{r.official_domain}</div>
      </Link>
    )},
    { key: 'business_email', header: 'Business email', render: (r) => r.business_email },
    { key: 'status', header: 'Verification status', render: (r) => (
      <StatusBadge label={r.verification_status} tone={STATUS_TONE[r.verification_status as keyof typeof STATUS_TONE] ?? 'neutral'} />
    )},
    { key: 'reviewed_by', header: 'Reviewed by', render: (r) => r.verification_reviewed_by ?? '—' },
    { key: 'created', header: 'Registered', render: (r) => new Date(r.created_at).toLocaleDateString() },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Company Verifications</h1>
        <p className="text-xs text-[var(--muted)]">Direct employer self-registrations awaiting or completing verification.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by legal name…" className="soft-input px-2.5 py-1.5 text-xs w-56" />
        <select value={verificationStatus} onChange={(e) => { setVerificationStatus(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="under_review">Under review</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No companies match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
          <Pagination page={page} pageSize={30} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

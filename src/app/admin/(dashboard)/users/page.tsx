'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface UserRow {
  id: string;
  email: string | null;
  full_name: string | null;
  plan_tier: string;
  created_at: string;
  onboarding_completed_at: string | null;
  swipeCount: number;
  applicationCount: number;
}

export default function UsersPage() {
  const router = useRouter();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [planTier, setPlanTier] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (q) params.set('q', q);
    if (planTier) params.set('planTier', planTier);
    try {
      const res = await fetch(`/api/admin/users?${params}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.users);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, q, planTier]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<UserRow>[] = [
    { key: 'email', header: 'Email', render: (r) => (
      <div>
        <div className="font-medium text-[var(--ink)]">{r.email ?? '—'}</div>
        {r.full_name && <div className="text-[10px] text-[var(--muted)]">{r.full_name}</div>}
      </div>
    )},
    { key: 'plan', header: 'Plan', render: (r) => <StatusBadge label={r.plan_tier} tone={r.plan_tier === 'pro' ? 'good' : 'neutral'} /> },
    { key: 'onboarded', header: 'Onboarded', render: (r) => r.onboarding_completed_at ? 'Yes' : 'No' },
    { key: 'swipes', header: 'Swipes', render: (r) => <span className="tabular-nums">{r.swipeCount}</span> },
    { key: 'applications', header: 'Applications', render: (r) => <span className="tabular-nums">{r.applicationCount}</span> },
    { key: 'signup', header: 'Signed up', render: (r) => new Date(r.created_at).toLocaleDateString() },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Users</h1>
        <p className="text-xs text-[var(--muted)]">Directory. No resume text, Stripe IDs, or linked profiles are exposed here.</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by email…" className="soft-input px-2.5 py-1.5 text-xs w-52" />
        <select value={planTier} onChange={(e) => { setPlanTier(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All plans</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
        </select>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No users match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => router.push(`/admin/users/${r.id}`)} />
          <Pagination page={page} pageSize={30} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}

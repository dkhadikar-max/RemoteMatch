'use client';

import { useEffect, useState, useCallback } from 'react';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface AuditEntry {
  id: number;
  admin_email: string;
  action: string;
  target_type: string;
  target_id: string;
  before_state: unknown;
  after_state: unknown;
  reason: string | null;
  created_at: string;
}

const ACTION_TONE: Record<string, 'good' | 'danger' | 'neutral'> = {
  c6_promote: 'good',
  c6_reject: 'danger',
  opportunity_force_expire: 'danger',
  admin_grant: 'good',
  admin_revoke: 'danger',
};

export default function AuditLogPage() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditEntry | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (action) params.set('action', action);
    try {
      const res = await fetch(`/api/admin/audit-log?${params}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRows(data.entries);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, action]);

  useEffect(() => { load(); }, [load]);

  const columns: DataTableColumn<AuditEntry>[] = [
    { key: 'when', header: 'When', render: (r) => new Date(r.created_at).toLocaleString() },
    { key: 'admin', header: 'Admin', render: (r) => r.admin_email },
    { key: 'action', header: 'Action', render: (r) => <StatusBadge label={r.action} tone={ACTION_TONE[r.action] ?? 'neutral'} /> },
    { key: 'target', header: 'Target', render: (r) => <span className="text-[10px]">{r.target_type}<br />{r.target_id.slice(0, 8)}…</span> },
    { key: 'reason', header: 'Reason', render: (r) => r.reason ?? <span className="text-[var(--muted)]">—</span> },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">Audit Log</h1>
        <p className="text-xs text-[var(--muted)]">Every privileged admin mutation, append-only.</p>
      </div>

      <select value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
        <option value="">All actions</option>
        <option value="c6_promote">C6 promote</option>
        <option value="c6_reject">C6 reject</option>
        <option value="opportunity_force_expire">Opportunity force-expire</option>
        <option value="admin_grant">Admin grant</option>
        <option value="admin_revoke">Admin revoke</option>
      </select>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No audit entries yet." hint="Every promotion, rejection, and opportunity mutation will appear here." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => String(r.id)} onRowClick={setDetail} />
          <Pagination page={page} pageSize={40} total={total} onPageChange={setPage} />
        </div>
      )}

      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetail(null)}>
          <div className="soft-card animate-modal w-full max-w-lg border border-[var(--line)] p-5 text-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-bold text-[var(--ink)]">{detail.action} — {detail.target_type}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--muted)]">Before</div>
                <pre className="whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-2 text-[10px]">{JSON.stringify(detail.before_state, null, 2) ?? '—'}</pre>
              </div>
              <div>
                <div className="mb-1 text-[10px] font-semibold uppercase text-[var(--muted)]">After</div>
                <pre className="whitespace-pre-wrap rounded-lg bg-[var(--surface)] p-2 text-[10px]">{JSON.stringify(detail.after_state, null, 2) ?? '—'}</pre>
              </div>
            </div>
            <button onClick={() => setDetail(null)} className="soft-button secondary mt-4 w-full text-xs py-1.5">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

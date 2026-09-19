'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

export default function OpportunityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/opportunities/${id}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setRecord(data.opportunity);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const forceExpire = async (reason?: string) => {
    if (!reason) return;
    setActionPending(true);
    setActionError(null);
    const res = await fetch(`/api/admin/opportunities/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'force_expire', reason }),
    });
    setActionPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setActionError(body.error || 'Action failed.');
      return;
    }
    setConfirmOpen(false);
    load();
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!record) return <LoadingState />;

  const status = record.status as string;

  return (
    <div className="space-y-4">
      <Link href="/admin/opportunities" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)]">
        <ArrowLeft size={13} /> Back to Opportunities
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[var(--ink)]">{String(record.title)}</h1>
          <p className="text-xs text-[var(--muted)]">{String(record.company)} · {String(record.source)}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge label={status} tone={status === 'active' ? 'good' : status === 'expired' ? 'danger' : 'neutral'} />
          {status !== 'expired' && (
            <button onClick={() => setConfirmOpen(true)} className="rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
              Force-expire
            </button>
          )}
        </div>
      </div>

      {actionError && <p className="text-xs font-medium text-[var(--danger)]">{actionError}</p>}

      <div className="soft-card border border-[var(--line)] p-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-xs md:grid-cols-2">
          {Object.entries(record).map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{key}</dt>
              <dd className="mt-0.5 break-words text-[var(--ink)]">
                {value === null || value === undefined ? <span className="text-[var(--muted)]">—</span> :
                  typeof value === 'object' ? <pre className="whitespace-pre-wrap text-[10px]">{JSON.stringify(value, null, 2)}</pre> :
                  String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Force-expire this opportunity?"
        description="Marks it expired and permanently removed. Requires a reason, recorded in the audit log. This cannot be undone from this console."
        confirmLabel="Force-expire"
        requireReason
        pending={actionPending}
        onConfirm={forceExpire}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

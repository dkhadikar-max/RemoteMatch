'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { LoadingState, ErrorState } from '@/components/admin/States';
import { describeFailure } from '@/components/admin/api';

interface CompanyMember {
  id: string;
  profile_id: string;
  role: string;
  representative_name: string;
  representative_designation: string;
  representative_relationship: string;
  status: string;
  created_at: string;
}

type VerificationAction = 'mark_under_review' | 'verify' | 'reject' | 'suspend' | 'reinstate';

const ACTIONS_FOR_STATUS: Record<string, { action: VerificationAction; label: string; danger: boolean }[]> = {
  pending: [
    { action: 'mark_under_review', label: 'Mark under review', danger: false },
    { action: 'verify', label: 'Verify', danger: false },
    { action: 'reject', label: 'Reject', danger: true },
  ],
  under_review: [
    { action: 'verify', label: 'Verify', danger: false },
    { action: 'reject', label: 'Reject', danger: true },
  ],
  verified: [{ action: 'suspend', label: 'Suspend', danger: true }],
  suspended: [{ action: 'reinstate', label: 'Reinstate', danger: false }],
  rejected: [],
};

const STATUS_TONE = {
  verified: 'good',
  pending: 'warn',
  under_review: 'warn',
  rejected: 'danger',
  suspended: 'danger',
} as const;

export default function CompanyVerificationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [company, setCompany] = useState<Record<string, unknown> | null>(null);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ action: VerificationAction; label: string; danger: boolean } | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/company-verifications/${id}`);
      if (!res.ok) throw new Error(await describeFailure(res));
      const data = await res.json();
      setCompany(data.company);
      setMembers(data.members ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const runAction = async (reason?: string) => {
    if (!reason || !pendingAction) return;
    setActionPending(true);
    setActionError(null);
    const res = await fetch(`/api/admin/company-verifications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: pendingAction.action, reason }),
    });
    setActionPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setActionError(body.error || 'Action failed.');
      return;
    }
    setPendingAction(null);
    load();
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!company) return <LoadingState />;

  const status = String(company.verification_status);
  const availableActions = ACTIONS_FOR_STATUS[status] ?? [];

  return (
    <div className="space-y-4">
      <Link href="/admin/company-verifications" className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--ink)]">
        <ArrowLeft size={13} /> Back to Company Verifications
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-[var(--ink)]">{String(company.legal_name)}</h1>
          <p className="text-xs text-[var(--muted)]">{String(company.official_domain)}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge label={status} tone={STATUS_TONE[status as keyof typeof STATUS_TONE] ?? 'neutral'} />
          {availableActions.map((a) => (
            <button
              key={a.action}
              onClick={() => setPendingAction(a)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 ${a.danger ? 'bg-[var(--danger)]' : 'bg-[var(--red)]'}`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      {actionError && <p className="text-xs font-medium text-[var(--danger)]">{actionError}</p>}

      <div className="soft-card border border-[var(--line)] p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Registration</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-xs md:grid-cols-2">
          {Object.entries(company).map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{key}</dt>
              <dd className="mt-0.5 break-words text-[var(--ink)]">
                {value === null || value === undefined ? <span className="text-[var(--muted)]">—</span> : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="soft-card border border-[var(--line)] p-4">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Authorized representatives</h2>
        {members.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No members found.</p>
        ) : (
          <ul className="space-y-2">
            {members.map((m) => (
              <li key={m.id} className="text-xs">
                <span className="font-medium text-[var(--ink)]">{m.representative_name}</span>
                {' — '}
                {m.representative_designation} ({m.representative_relationship}), role: {m.role}
                {m.status !== 'active' && <span className="text-[var(--danger)]"> · {m.status}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? `${pendingAction.label} this company?` : ''}
        description="Requires a reason, recorded in the audit log."
        confirmLabel={pendingAction?.label ?? 'Confirm'}
        danger={pendingAction?.danger ?? false}
        requireReason
        pending={actionPending}
        onConfirm={runAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

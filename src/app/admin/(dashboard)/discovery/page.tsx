'use client';

import { useEffect, useState, useCallback } from 'react';
import { DataTable, Pagination, type DataTableColumn } from '@/components/admin/DataTable';
import { StatusBadge } from '@/components/admin/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { LoadingState, ErrorState, EmptyState } from '@/components/admin/States';

interface DiscoveredCompanyRow {
  id: string;
  canonical_name: string;
  raw_domain: string;
  resolved_root_domain: string | null;
  industry: string | null;
  discovery_source: string;
  pipeline_stage: string;
  rejection_reason: string | null;
  discovered_career_url: string | null;
  discovered_ats_platform: string | null;
  discovered_ats_board: string | null;
  has_json_ld_jobs: boolean | null;
  robots_permission: string | null;
  remote_evidence_snippet: string | null;
  confidence_score: number | null;
  first_seen_at: string | null;
  last_probed_at: string | null;
}

const STAGE_TONE: Record<string, 'good' | 'warn' | 'danger' | 'neutral'> = {
  discovered: 'neutral',
  website_verified: 'neutral',
  career_found: 'warn',
  qualified_remote: 'good',
  promoted_to_allowlist: 'good',
  rejected: 'danger',
};

const STAGES = ['discovered', 'website_verified', 'career_found', 'qualified_remote', 'promoted_to_allowlist', 'rejected'];

export default function DiscoveryPage() {
  const [rows, setRows] = useState<DiscoveredCompanyRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState('');
  const [atsProvider, setAtsProvider] = useState('');
  const [sector, setSector] = useState('');
  const [minConfidence, setMinConfidence] = useState('');
  const [evidenceFor, setEvidenceFor] = useState<DiscoveredCompanyRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DiscoveredCompanyRow | null>(null);
  const [promoteTarget, setPromoteTarget] = useState<DiscoveredCompanyRow | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const params = new URLSearchParams({ page: String(page) });
    if (stage) params.set('stage', stage);
    if (atsProvider) params.set('atsProvider', atsProvider);
    if (sector) params.set('sector', sector);
    if (minConfidence) params.set('minConfidence', minConfidence);
    try {
      const res = await fetch(`/api/admin/discovery?${params}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setRows(data.candidates);
      setTotal(data.total);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [page, stage, atsProvider, sector, minConfidence]);

  useEffect(() => {
    load();
  }, [load]);

  const doPromote = async () => {
    if (!promoteTarget) return;
    setActionPending(true);
    setActionError(null);
    const res = await fetch(`/api/admin/discovery/${promoteTarget.id}/promote`, { method: 'POST' });
    setActionPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setActionError(body.error || 'Promotion failed.');
      return;
    }
    setPromoteTarget(null);
    load();
  };

  const doReject = async (reason?: string) => {
    if (!rejectTarget || !reason) return;
    setActionPending(true);
    setActionError(null);
    const res = await fetch(`/api/admin/discovery/${rejectTarget.id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    setActionPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setActionError(body.error || 'Rejection failed.');
      return;
    }
    setRejectTarget(null);
    load();
  };

  const columns: DataTableColumn<DiscoveredCompanyRow>[] = [
    { key: 'name', header: 'Company', render: (r) => (
      <div>
        <div className="font-medium text-[var(--ink)]">{r.canonical_name}</div>
        <div className="text-[10px] text-[var(--muted)]">{r.resolved_root_domain ?? r.raw_domain}</div>
      </div>
    )},
    { key: 'stage', header: 'Stage', render: (r) => <StatusBadge label={r.pipeline_stage} tone={STAGE_TONE[r.pipeline_stage] ?? 'neutral'} /> },
    { key: 'ats', header: 'ATS', render: (r) => (
      <span className="text-[var(--ink)]">
        {r.discovered_ats_platform && r.discovered_ats_platform !== 'none' ? r.discovered_ats_platform : '—'}
        {r.discovered_ats_board && <span className="text-[var(--muted)]"> / {r.discovered_ats_board}</span>}
      </span>
    )},
    { key: 'career_url', header: 'Career URL', render: (r) => r.discovered_career_url ? (
      <a href={r.discovered_career_url} target="_blank" rel="noreferrer" className="text-[var(--red)] hover:underline">
        {new URL(r.discovered_career_url).hostname}
      </a>
    ) : <span className="text-[var(--muted)]">—</span> },
    { key: 'confidence', header: 'Confidence', render: (r) => <span className="tabular-nums">{r.confidence_score ?? '—'}</span> },
    { key: 'sector', header: 'Sector', render: (r) => r.industry ?? <span className="text-[var(--muted)]">—</span> },
    { key: 'discovered_at', header: 'Discovered', render: (r) => r.first_seen_at ? new Date(r.first_seen_at).toLocaleDateString() : '—' },
    { key: 'actions', header: '', render: (r) => (
      <div className="flex gap-1.5">
        <button onClick={() => setEvidenceFor(r)} className="soft-button secondary px-2 py-1 text-[11px]">Evidence</button>
        {r.pipeline_stage === 'qualified_remote' && (
          <>
            <button onClick={() => setPromoteTarget(r)} className="rounded-lg bg-[var(--green-dark)] px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90">Promote</button>
            <button onClick={() => setRejectTarget(r)} className="rounded-lg bg-[var(--danger)] px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90">Reject</button>
          </>
        )}
      </div>
    )},
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-[var(--ink)]">C6 Discovery Review</h1>
        <p className="text-xs text-[var(--muted)]">
          Human review of automated company discovery. Automatic promotion stays disabled — every promotion here requires this explicit click.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={atsProvider} onChange={(e) => { setAtsProvider(e.target.value); setPage(1); }} className="soft-input px-2.5 py-1.5 text-xs w-auto">
          <option value="">All ATS providers</option>
          <option value="greenhouse">Greenhouse</option>
          <option value="lever">Lever</option>
          <option value="ashby">Ashby</option>
          <option value="none">None</option>
        </select>
        <input value={sector} onChange={(e) => { setSector(e.target.value); setPage(1); }} placeholder="Sector contains…" className="soft-input px-2.5 py-1.5 text-xs w-40" />
        <input type="number" value={minConfidence} onChange={(e) => { setMinConfidence(e.target.value); setPage(1); }} placeholder="Min confidence" className="soft-input px-2.5 py-1.5 text-xs w-32" />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <EmptyState label="No discovery candidates match these filters." />
      ) : (
        <div className="soft-card border border-[var(--line)]">
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} />
          <Pagination page={page} pageSize={25} total={total} onPageChange={setPage} />
        </div>
      )}

      {evidenceFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEvidenceFor(null)}>
          <div className="soft-card animate-modal w-full max-w-md border border-[var(--line)] p-5 text-xs" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-3 text-sm font-bold text-[var(--ink)]">{evidenceFor.canonical_name} — evidence</h2>
            <dl className="space-y-2">
              <Row label="Discovery source" value={evidenceFor.discovery_source} />
              <Row label="Robots permission" value={evidenceFor.robots_permission ?? 'unknown'} />
              <Row label="Has JSON-LD jobs" value={evidenceFor.has_json_ld_jobs ? 'Yes' : 'No'} />
              <Row label="Remote evidence" value={evidenceFor.remote_evidence_snippet ?? '—'} />
              <Row label="Rejection reason" value={evidenceFor.rejection_reason ?? '—'} />
              <Row label="Last probed" value={evidenceFor.last_probed_at ? new Date(evidenceFor.last_probed_at).toLocaleString() : '—'} />
            </dl>
            <button onClick={() => setEvidenceFor(null)} className="soft-button secondary mt-4 w-full text-xs py-1.5">Close</button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!promoteTarget}
        title={`Promote ${promoteTarget?.canonical_name ?? ''}?`}
        description="This writes to allowlist_employers and supply_sources via the existing supervised-promotion mechanism, and is fully audit-logged."
        confirmLabel="Promote"
        danger={false}
        pending={actionPending}
        onConfirm={doPromote}
        onCancel={() => { setPromoteTarget(null); setActionError(null); }}
      />
      <ConfirmDialog
        open={!!rejectTarget}
        title={`Reject ${rejectTarget?.canonical_name ?? ''}?`}
        description="Marks this candidate rejected. Requires a reason, which is recorded in the audit log."
        confirmLabel="Reject"
        requireReason
        pending={actionPending}
        onConfirm={doReject}
        onCancel={() => { setRejectTarget(null); setActionError(null); }}
      />
      {actionError && <p className="text-xs font-medium text-[var(--danger)]">{actionError}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">{label}</dt>
      <dd className="text-[var(--ink)]">{value}</dd>
    </div>
  );
}

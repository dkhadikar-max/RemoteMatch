'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

type Applicant = {
  id: string;
  cover_note: string;
  status: string;
  submitted_at: string;
  employer_job_submissions: { title: string } | null;
  profiles: { id: string; email: string | null; full_name: string | null; headline: string | null; avatar_url: string | null; linkedin_url: string | null } | null;
};

const STATUSES = ['reviewing', 'shortlisted', 'interviewing', 'offered', 'rejected', 'hired'];
const CLOSED_STATUSES = new Set(['hired', 'withdrawn', 'offer_declined']);
const REASONS = [
  ['strong_experience', 'Strong relevant experience'],
  ['relevant_achievements', 'Relevant achievements'],
  ['strong_technical_skills', 'Strong technical skills'],
  ['transferable_capabilities', 'Transferable capabilities'],
  ['insufficient_experience', 'Insufficient experience'],
  ['missing_mandatory_qualification', 'Missing mandatory qualification'],
  ['location_ineligible', 'Location ineligible'],
  ['poor_role_fit', 'Poor role fit'],
  ['insufficient_evidence', 'Insufficient evidence'],
  ['position_filled', 'Position filled'],
  ['candidate_withdrew', 'Candidate withdrew'],
  ['other', 'Other recorded reason'],
] as const;

type PendingConfirmation = { row: Applicant; status: string; message: string };

export default function EmployerApplicationsPage() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<Applicant[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [confirming, setConfirming] = useState<PendingConfirmation | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/employer/companies/' + id + '/applications');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load applications.');
      setRows(data.applications || []);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const requestStatusChange = (row: Applicant, status: string) => {
    const reasonCode = reasons[row.id];
    const reasonRequired =
      status === 'rejected' ||
      (row.status === 'interviewing' && status === 'shortlisted') ||
      (row.status === 'rejected' && status === 'reviewing');
    if (reasonRequired && !reasonCode) {
      setError('Select a decision reason before making this transition.');
      return;
    }
    const message =
      status === 'hired'
        ? `Mark ${row.profiles?.full_name || 'this candidate'} as hired? This records a final hiring decision.`
        : status === 'rejected'
          ? `Reject ${row.profiles?.full_name || 'this candidate'}? The selected decision reason will be recorded in the audit history.`
          : null;
    if (message) {
      setConfirming({ row, status, message });
      return;
    }
    void performUpdate(row, status);
  };

  const performUpdate = async (row: Applicant, status: string) => {
    const reasonCode = reasons[row.id];
    const reasonRequired =
      status === 'rejected' ||
      (row.status === 'interviewing' && status === 'shortlisted') ||
      (row.status === 'rejected' && status === 'reviewing');

    setBusy(row.id); setError('');
    try {
      const response = await fetch('/api/employer/companies/' + id + '/applications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: row.id,
          expectedStatus: row.status,
          status,
          ...(reasonRequired ? { reasonCode } : {}),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'Could not update status.');
      setRows(current => current.map(item => item.id === row.id ? { ...item, status: data.status || status } : item));
      // A reason describes one decision only. Never carry it into a later
      // transition, including a reconsideration or an unrelated status change.
      setReasons(current => {
        const next = { ...current };
        delete next[row.id];
        return next;
      });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };

  return <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10 space-y-6 sm:space-y-8">
    <div className="space-y-2"><Link href="/employer" className="inline-flex min-h-10 items-center text-sm font-medium text-[var(--red)] hover:underline">← Employer workspace</Link>
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--ink)]">Job applications</h1>
      <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">Review candidates who applied directly through RemoteMatch. Compare candidate details, read their note and record the next decision.</p>
    </div>
    {error && <p role="alert" className="rounded-xl border border-[var(--danger)]/20 bg-[var(--danger)]/5 px-4 py-3 text-sm text-[var(--danger)]">{error}</p>}
    {loading ? <p className="text-sm text-[var(--muted)]">Loading applications…</p> :
      rows.length === 0 ? <div className="soft-card rounded-2xl border border-[var(--line)] p-8 sm:p-10 text-center"><p className="text-sm font-semibold text-[var(--ink)]">No applications received yet</p><p className="mt-1 text-sm text-[var(--muted)]">New candidate applications will appear here.</p></div> :
      <div className="space-y-3">{rows.map(row => <article key={row.id} className="soft-card rounded-2xl border border-[var(--line)] p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1"><h2 className="text-base font-semibold text-[var(--ink)]">{row.profiles?.full_name || 'Candidate'}</h2>
            <p className="text-xs text-[var(--muted)]">{row.profiles?.headline || 'No headline provided'}</p>
            <p className="text-sm text-[var(--muted)] break-words">{row.profiles?.email || 'Email unavailable'}</p><p className="text-xs font-medium text-[var(--ink)] break-words">Applied for: {row.employer_job_submissions?.title || 'Job'}</p>
            <p className="text-xs text-[var(--muted)]">Applied {new Date(row.submitted_at).toLocaleString()}</p>
          </div>
          {CLOSED_STATUSES.has(row.status) ? (
            <span className="inline-flex min-h-11 items-center rounded-lg border border-[var(--line)] px-3 text-sm font-semibold text-[var(--muted)]">
              {row.status.replace(/_/g, ' ')}
            </span>
          ) : (
            <select aria-label="Application status" className="soft-input min-h-11 w-full sm:w-auto px-3 py-2 text-sm font-medium" value={row.status}
              disabled={busy === row.id} onChange={e => requestStatusChange(row, e.target.value)}>
              {[row.status, ...STATUSES.filter(status => status !== row.status)].map(status => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
            </select>
          )}
        </div>
        {!CLOSED_STATUSES.has(row.status) && (
          <label className="block text-xs text-[var(--muted)]">Decision reason
            <select aria-label="Decision reason" className="soft-input mt-1 block min-h-11 w-full px-3 py-2 text-sm"
              value={reasons[row.id] || ''}
              disabled={busy === row.id}
              onChange={e => setReasons(current => ({ ...current, [row.id]: e.target.value }))}>
              <option value="">Choose only when applicable</option>
              {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        )}
        {row.cover_note && <div className="rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 text-sm leading-6 whitespace-pre-wrap break-words">{row.cover_note}</div>}
        <div className="flex flex-wrap gap-4 text-sm">
          {row.profiles?.linkedin_url && <a className="text-[var(--red)] underline" href={row.profiles.linkedin_url} target="_blank" rel="noreferrer">LinkedIn profile</a>}
          {row.profiles?.email && <a className="inline-flex min-h-11 items-center px-2 text-[var(--red)] underline" href={'mailto:' + row.profiles.email}>Email candidate</a>}
        </div>
      </article>)}</div>}
    {confirming && (
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-status-change-title" className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ink)]/40 p-4">
        <div className="soft-card w-full max-w-sm rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 shadow-lg space-y-4">
          <p id="confirm-status-change-title" className="text-sm leading-6 text-[var(--ink)]">{confirming.message}</p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="inline-flex min-h-10 items-center rounded-xl border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { const next = confirming; setConfirming(null); void performUpdate(next.row, next.status); }}
              className="inline-flex min-h-10 items-center rounded-xl bg-[var(--red)] px-4 text-sm font-semibold text-white hover:bg-[var(--red-dark)]"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    )}
  </main>;
}

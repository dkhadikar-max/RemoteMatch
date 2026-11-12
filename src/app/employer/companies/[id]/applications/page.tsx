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
  profiles: { id: string; email: string | null; full_name: string | null; headline: string | null; avatar_url: string | null; resume_file_url: string | null; linkedin_url: string | null } | null;
};

const STATUSES = ['reviewing', 'shortlisted', 'interviewing', 'offered', 'rejected', 'hired'];
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

export default function EmployerApplicationsPage() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<Applicant[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

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

  const updateStatus = async (row: Applicant, status: string) => {
    const reasonCode = reasons[row.id] || 'insufficient_evidence';
    setBusy(row.id); setError('');
    try {
      const response = await fetch('/api/employer/companies/' + id + '/applications', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          applicationId: row.id,
          expectedStatus: row.status,
          status,
          reasonCode,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || 'Could not update status.');
      setRows(current => current.map(item => item.id === row.id ? { ...item, status: data.status || status } : item));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };

  return <main className="mx-auto max-w-5xl px-4 py-10 space-y-6">
    <div><Link href="/employer" className="text-sm text-[var(--red)]">← Employer workspace</Link>
      <h1 className="mt-3 text-2xl font-bold text-[var(--ink)]">Job applications</h1>
      <p className="text-sm text-[var(--muted)]">Review candidates who applied directly through RemoteMatch.</p>
    </div>
    {error && <p role="alert" className="text-sm text-[var(--danger)]">{error}</p>}
    {loading ? <p className="text-sm text-[var(--muted)]">Loading applications…</p> :
      rows.length === 0 ? <div className="soft-card border border-[var(--line)] p-6 text-sm text-[var(--muted)]">No applications received yet.</div> :
      <div className="space-y-3">{rows.map(row => <article key={row.id} className="soft-card border border-[var(--line)] p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="font-semibold text-[var(--ink)]">{row.profiles?.full_name || 'Candidate'}</h2>
            <p className="text-xs text-[var(--muted)]">{row.profiles?.headline || 'No headline provided'}</p>
            <p className="text-xs text-[var(--muted)]">{row.profiles?.email || 'Email unavailable'} · {row.employer_job_submissions?.title || 'Job'}</p>
            <p className="text-xs text-[var(--muted)]">Applied {new Date(row.submitted_at).toLocaleString()}</p>
          </div>
          <select aria-label="Application status" className="soft-input px-3 py-2 text-sm" value={row.status}
            disabled={busy === row.id} onChange={e => updateStatus(row, e.target.value)}>
            {[row.status, ...STATUSES.filter(status => status !== row.status)].map(status => <option key={status} value={status}>{status.replace('_',' ')}</option>)}
          </select>
        </div>
        <label className="block text-xs text-[var(--muted)]">Decision reason
          <select aria-label="Decision reason" className="soft-input mt-1 block w-full px-3 py-2 text-sm"
            value={reasons[row.id] || 'insufficient_evidence'}
            disabled={busy === row.id}
            onChange={e => setReasons(current => ({ ...current, [row.id]: e.target.value }))}>
            {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {row.cover_note && <div className="rounded-lg bg-[var(--surface-soft)] p-3 text-sm whitespace-pre-wrap">{row.cover_note}</div>}
        <div className="flex flex-wrap gap-4 text-sm">
          {row.profiles?.resume_file_url && <a className="text-[var(--red)] underline" href={row.profiles.resume_file_url} target="_blank" rel="noreferrer">View resume</a>}
          {row.profiles?.linkedin_url && <a className="text-[var(--red)] underline" href={row.profiles.linkedin_url} target="_blank" rel="noreferrer">LinkedIn profile</a>}
          {row.profiles?.email && <a className="text-[var(--red)] underline" href={'mailto:' + row.profiles.email}>Email candidate</a>}
        </div>
      </article>)}</div>}
  </main>;
}

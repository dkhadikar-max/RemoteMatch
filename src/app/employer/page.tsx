'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type Company = { id: string; legal_name: string; official_domain: string; verification_status: string; verification_reason: string | null };
type Job = { id: string; title: string; status: string; review_reason: string | null; updated_at: string; published_opportunity_id: string | null };

export default function EmployerDashboardPage() {
  const [companies,setCompanies] = useState<Company[]>([]);
  const [companyId,setCompanyId] = useState('');
  const [jobs,setJobs] = useState<Job[]>([]);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/employer/companies');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load employer account.');
      const list = data.companies as Company[];
      setCompanies(list);
      const selected = list.find(c => c.id === companyId)?.id ?? list[0]?.id ?? '';
      setCompanyId(selected);
      if (selected) {
        const jr = await fetch('/api/employer/companies/' + selected + '/jobs');
        const jd = await jr.json();
        if (!jr.ok) throw new Error(jd.error || 'Could not load vacancies.');
        setJobs(jd.jobs ?? []);
      } else setJobs([]);
    } catch(e) { setError((e as Error).message); }
    finally { setLoading(false); }
  },[companyId]);

  useEffect(()=>{ load(); },[load]);

  const selected = companies.find(c=>c.id===companyId);
  const submitDraft = async (jobId:string) => {
    if (!companyId) return;
    setBusy(jobId); setError('');
    try {
      const res = await fetch('/api/employer/companies/' + companyId + '/jobs/' + jobId,{method:'POST'});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error || 'Could not submit vacancy.');
      await load();
    } catch(e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };

  if(loading) return <div className="mx-auto max-w-5xl px-4 py-12 text-sm text-[var(--muted)]">Loading employer workspace…</div>;
  if(!companies.length) return <div className="mx-auto max-w-2xl px-4 py-16 text-center space-y-4">
    <h1 className="text-2xl font-bold text-[var(--ink)]">Post a job on RemoteMatch</h1>
    <p className="text-sm text-[var(--muted)]">Register your company first. Our team reviews company identity before vacancies can be published.</p>
    <Link href="/employer/register" className="soft-button primary inline-flex">Register your company</Link>
  </div>;

  return <div className="mx-auto max-w-5xl px-4 py-10 space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold text-[var(--ink)]">Employer workspace</h1><p className="text-sm text-[var(--muted)]">Manage company verification and job vacancies.</p></div>
      <div className="flex flex-wrap gap-2"><Link href={'/employer/companies/' + companyId + '/applications'} className="soft-button secondary inline-flex">View applicants</Link><Link href={'/employer/jobs/new?companyId=' + companyId} className="soft-button primary inline-flex">Create a job</Link></div>
    </div>
    {error && <p className="rounded-xl border border-[var(--red-soft-border)] p-3 text-sm text-[var(--danger)]">{error}</p>}
    <section className="soft-card border border-[var(--line)] p-5 space-y-3">
      <label className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Company</label>
      <select className="soft-input w-full max-w-lg px-3 py-2 text-sm" value={companyId} onChange={e=>setCompanyId(e.target.value)}>
        {companies.map(c=><option key={c.id} value={c.id}>{c.legal_name}</option>)}
      </select>
      {selected && <div className="space-y-1 text-sm">
        <p><strong>Status:</strong> {selected.verification_status}</p>
        <p className="text-xs text-[var(--muted)]">{selected.official_domain}</p>
        {selected.verification_reason && <p className="text-xs text-[var(--danger)]">Review note: {selected.verification_reason}</p>}
        {selected.verification_status !== 'verified' && <p className="text-xs text-[var(--muted)]">You can prepare and save vacancy drafts now. Submission unlocks after company verification.</p>}
      </div>}
      <Link href={'/employer/companies/' + companyId} className="text-sm font-semibold text-[var(--red)] hover:underline">View company profile →</Link>
    </section>
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-[var(--ink)]">Your vacancies</h2>
      {!jobs.length ? <div className="soft-card border border-[var(--line)] p-6 text-sm text-[var(--muted)]">No vacancies yet. Create your first job draft.</div> :
      jobs.map(job=><article key={job.id} className="soft-card border border-[var(--line)] p-4 flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="font-semibold text-[var(--ink)]">{job.title}</h3><p className="text-xs text-[var(--muted)]">{job.status} · Updated {new Date(job.updated_at).toLocaleDateString()}</p>
          {job.review_reason && <p className="mt-1 text-xs text-[var(--danger)]">{job.review_reason}</p>}</div>
        <div className="flex items-center gap-3">
          {job.status==='draft' && selected?.verification_status==='verified' && <button onClick={()=>submitDraft(job.id)} disabled={busy===job.id} className="soft-button primary text-xs">{busy===job.id?'Submitting…':'Submit for review'}</button>}
          {job.status==='draft' && <Link href={'/employer/jobs/new?companyId='+companyId+'&jobId='+job.id} className="text-sm font-semibold text-[var(--red)]">Edit draft</Link>}
          {job.published_opportunity_id && <Link href={'/remote-jobs/view/'+encodeURIComponent(job.id)} className="text-sm font-semibold text-[var(--red)]">View listing</Link>}
        </div>
      </article>)}
    </section>
  </div>;
}

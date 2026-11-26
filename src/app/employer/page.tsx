'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, BriefcaseBusiness, Building2, CheckCircle2, Clock3, FileText, Plus, RefreshCw, Users } from 'lucide-react';

type Company = { id: string; legal_name: string; official_domain: string; verification_status: string; verification_reason: string | null };
type Job = { id: string; title: string; status: string; review_reason: string | null; updated_at: string; published_opportunity_id: string | null };

const statusStyles: Record<string, string> = {
  verified: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  pending: 'border-amber-200 bg-amber-50 text-amber-800',
  under_review: 'border-sky-200 bg-sky-50 text-sky-800',
  rejected: 'border-rose-200 bg-rose-50 text-rose-800',
  suspended: 'border-rose-200 bg-rose-50 text-rose-800',
  draft: 'border-slate-200 bg-slate-100 text-slate-700',
  published: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  approved: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  submitted: 'border-sky-200 bg-sky-50 text-sky-800',
};

function StatusPill({ value }: { value: string }) {
  const label = value.replace(/_/g, ' ');
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold capitalize ${statusStyles[value] ?? 'border-slate-200 bg-slate-50 text-slate-700'}`}>{label}</span>;
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: number; detail: string; icon: typeof BriefcaseBusiness }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-4 shadow-[0_2px_10px_rgba(32,30,29,0.03)] sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-[var(--muted)]">{label}</span>
        <span className="grid size-9 place-items-center rounded-xl bg-[var(--surface-soft)] text-[var(--red)]"><Icon size={17} /></span>
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight text-[var(--ink)]">{value}</p>
      <p className="mt-1 text-[11px] text-[var(--muted)]">{detail}</p>
    </div>
  );
}

export default function EmployerDashboardPage() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/employer/companies');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load employer account.');
      const list = data.companies as Company[];
      setCompanies(list);
      const selected = list.find((company) => company.id === companyId)?.id ?? list[0]?.id ?? '';
      setCompanyId(selected);
      if (selected) {
        const jobsRes = await fetch('/api/employer/companies/' + selected + '/jobs');
        const jobsData = await jobsRes.json();
        if (!jobsRes.ok) throw new Error(jobsData.error || 'Could not load vacancies.');
        setJobs(jobsData.jobs ?? []);
      } else {
        setJobs([]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const selected = companies.find((company) => company.id === companyId);
  const metrics = useMemo(() => ({
    total: jobs.length,
    drafts: jobs.filter((job) => job.status === 'draft').length,
    published: jobs.filter((job) => Boolean(job.published_opportunity_id)).length,
  }), [jobs]);

  const submitDraft = async (jobId: string) => {
    if (!companyId) return;
    setBusy(jobId);
    setError('');
    try {
      const res = await fetch('/api/employer/companies/' + companyId + '/jobs/' + jobId, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit vacancy.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8" aria-busy="true">
        <div className="animate-pulse space-y-5">
          <div className="h-8 w-56 rounded-lg bg-[var(--surface)]" />
          <div className="h-4 w-80 max-w-full rounded bg-[var(--surface)]" />
          <div className="grid gap-3 sm:grid-cols-3"><div className="h-28 rounded-2xl bg-[var(--surface)]" /><div className="h-28 rounded-2xl bg-[var(--surface)]" /><div className="h-28 rounded-2xl bg-[var(--surface)]" /></div>
          <div className="h-52 rounded-2xl bg-[var(--surface)]" />
        </div>
        <p className="sr-only">Loading employer workspace…</p>
      </main>
    );
  }

  if (!companies.length) {
    return (
      <main className="mx-auto flex min-h-[70vh] w-full max-w-3xl items-center px-4 py-12 sm:px-6">
        <section className="w-full rounded-3xl border border-[var(--line)] bg-white p-7 text-center shadow-sm sm:p-10">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--red)]"><Building2 size={25} /></span>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-[var(--red)]">Employer onboarding</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight text-[var(--ink)] sm:text-3xl">Set up your company workspace</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--muted)]">Register your company to create vacancies, manage applicants and build a trusted hiring presence. Company identity is reviewed before vacancies can be published.</p>
          <Link href="/employer/register" className="soft-button primary mt-6 inline-flex gap-2">Register your company <ArrowRight size={16} /></Link>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--red)]">Employer console</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--ink)] sm:text-3xl">Workspace overview</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[var(--muted)]">A clear view of your company status, vacancies and next hiring actions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={'/employer/companies/' + companyId + '/applications'} className="soft-button secondary inline-flex gap-2"><Users size={16} /> View applicants</Link>
          <Link href={'/employer/jobs/new?companyId=' + companyId} className="soft-button primary inline-flex gap-2"><Plus size={16} /> Create a job</Link>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-6 flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900 sm:flex-row sm:items-center sm:justify-between">
          <span>{error}</span>
          <button type="button" onClick={load} className="inline-flex min-h-10 shrink-0 items-center gap-2 font-semibold"><RefreshCw size={14} /> Try again</button>
        </div>
      )}

      <section aria-label="Vacancy summary" className="mt-7 grid gap-3 sm:grid-cols-3">
        <Metric label="Total vacancies" value={metrics.total} detail="Saved under this company" icon={BriefcaseBusiness} />
        <Metric label="Published listings" value={metrics.published} detail="Live listing records" icon={CheckCircle2} />
        <Metric label="Draft vacancies" value={metrics.drafts} detail="Can be edited before submission" icon={FileText} />
      </section>

      <section className="mt-7 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-[var(--ink)]">Your vacancies</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">Review status and continue where you left off.</p>
            </div>
            <button type="button" onClick={load} className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[var(--line)] bg-white px-3 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]"><RefreshCw size={14} /> Refresh</button>
          </div>

          {!jobs.length ? (
            <div className="rounded-2xl border border-dashed border-[var(--line)] bg-white p-7 text-center sm:p-10">
              <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--red)]"><BriefcaseBusiness size={22} /></span>
              <h3 className="mt-4 text-base font-bold text-[var(--ink)]">No vacancies yet</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[var(--muted)]">Create your first role draft. You can review the details before submitting it for approval.</p>
              <Link href={'/employer/jobs/new?companyId=' + companyId} className="soft-button primary mt-5 inline-flex gap-2"><Plus size={15} /> Create your first job</Link>
            </div>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <article key={job.id} className="rounded-2xl border border-[var(--line)] bg-white p-4 shadow-[0_2px_10px_rgba(32,30,29,0.03)] transition-shadow hover:shadow-md sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-bold text-[var(--ink)] sm:text-base">{job.title}</h3>
                        <StatusPill value={job.status} />
                      </div>
                      <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[var(--muted)]"><Clock3 size={13} /> Updated {new Date(job.updated_at).toLocaleDateString()}</p>
                      {job.review_reason && <p className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800">Review note: {job.review_reason}</p>}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {job.status === 'draft' && selected?.verification_status === 'verified' && (
                        <button type="button" onClick={() => submitDraft(job.id)} disabled={busy === job.id} className="soft-button primary text-xs disabled:cursor-wait disabled:opacity-60">{busy === job.id ? 'Submitting…' : 'Submit for review'}</button>
                      )}
                      {job.status === 'draft' && <Link href={'/employer/jobs/new?companyId=' + companyId + '&jobId=' + job.id} className="soft-button secondary text-xs">Edit draft</Link>}
                      {job.published_opportunity_id && <Link href={'/remote-jobs/view/' + encodeURIComponent(job.id)} className="soft-button secondary inline-flex gap-1 text-xs">View listing <ArrowRight size={13} /></Link>}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_2px_10px_rgba(32,30,29,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--muted)]">Company account</p>
                <h2 className="mt-2 truncate text-base font-bold text-[var(--ink)]">{selected?.legal_name}</h2>
                <p className="mt-1 truncate text-xs text-[var(--muted)]">{selected?.official_domain}</p>
              </div>
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--surface-soft)] text-[var(--red)]"><Building2 size={18} /></span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-[var(--muted)]">Verification</span>
              {selected && <StatusPill value={selected.verification_status} />}
            </div>
            {companies.length > 1 && (
              <label className="mt-5 block space-y-1.5">
                <span className="text-xs font-semibold text-[var(--ink)]">Switch company</span>
                <select aria-label="Select company" className="soft-input w-full px-3 py-2.5 text-sm" value={companyId} onChange={(event) => setCompanyId(event.target.value)}>
                  {companies.map((company) => <option key={company.id} value={company.id}>{company.legal_name}</option>)}
                </select>
              </label>
            )}
            {selected?.verification_reason && <p className="mt-4 rounded-xl border border-rose-100 bg-rose-50 p-3 text-xs leading-5 text-rose-800">Review note: {selected.verification_reason}</p>}
            {selected?.verification_status !== 'verified' && (
              <p className="mt-4 text-xs leading-5 text-[var(--muted)]">You can prepare and save vacancy drafts now. Submission unlocks after company verification.</p>
            )}
            <Link href={'/employer/companies/' + companyId} className="mt-5 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-xl border border-[var(--line)] px-3 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]">Manage company profile <ArrowRight size={14} /></Link>
          </section>

          <section className="rounded-2xl border border-[var(--red-soft-border)] bg-[var(--red-soft)] p-5">
            <p className="text-xs font-bold text-[var(--ink)]">What happens next?</p>
            <ol className="mt-3 space-y-3 text-xs leading-5 text-[var(--muted)]">
              <li className="flex gap-2"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-white font-bold text-[var(--red)]">1</span><span>Complete your company verification.</span></li>
              <li className="flex gap-2"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-white font-bold text-[var(--red)]">2</span><span>Create accurate role details and save a draft.</span></li>
              <li className="flex gap-2"><span className="grid size-5 shrink-0 place-items-center rounded-full bg-white font-bold text-[var(--red)]">3</span><span>Submit the vacancy for review before publication.</span></li>
            </ol>
          </section>
        </aside>
      </section>
    </main>
  );
}

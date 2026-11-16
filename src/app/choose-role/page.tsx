'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ArrowRight, BriefcaseBusiness, Building2 } from 'lucide-react';

function RoleChoice() {
  const params = useSearchParams();
  const requested = params.get('redirect') || '';
  const destination = requested.startsWith('/') && !requested.startsWith('//') ? requested : '';
  const candidateTarget = destination || '/onboarding';
  const employerTarget = destination.startsWith('/employer') ? destination : '/employer';

  const href = (role: 'candidate' | 'employer', mode: 'login' | 'signup') => {
    const query = new URLSearchParams({ role, redirect: role === 'employer' ? employerTarget : candidateTarget });
    return `/${mode}?${query.toString()}`;
  };

  return (
    <main className="flex min-h-[calc(100vh-68px)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-3xl space-y-8">
        <div className="text-center space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--red)]">Welcome to RemoteMatch</p>
          <h1 className="text-3xl font-bold tracking-tight text-[var(--ink)] sm:text-4xl">How will you use RemoteMatch?</h1>
          <p className="mx-auto max-w-xl text-sm leading-6 text-[var(--muted)]">Choose your path before signing in. You can use RemoteMatch as a candidate, an employer, or both.</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <section className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-sm">
            <span className="grid size-12 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]"><BriefcaseBusiness size={22} /></span>
            <h2 className="mt-5 text-xl font-bold text-[var(--ink)]">I’m looking for a job</h2>
            <p className="mt-2 min-h-12 text-sm leading-6 text-[var(--muted)]">Discover remote opportunities, see how they match your experience, and manage applications.</p>
            <div className="mt-6 grid gap-2">
              <Link href={href('candidate', 'login')} className="soft-button primary inline-flex min-h-11 items-center justify-center gap-2">Sign in as candidate <ArrowRight size={16} /></Link>
              <Link href={href('candidate', 'signup')} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]">Create candidate account</Link>
            </div>
          </section>

          <section className="rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 shadow-sm">
            <span className="grid size-12 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]"><Building2 size={22} /></span>
            <h2 className="mt-5 text-xl font-bold text-[var(--ink)]">I’m hiring</h2>
            <p className="mt-2 min-h-12 text-sm leading-6 text-[var(--muted)]">Register your company, publish remote vacancies, and manage candidate applications.</p>
            <div className="mt-6 grid gap-2">
              <Link href={href('employer', 'login')} className="soft-button primary inline-flex min-h-11 items-center justify-center gap-2">Sign in as employer <ArrowRight size={16} /></Link>
              <Link href={href('employer', 'signup')} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)]">Create employer account</Link>
            </div>
          </section>
        </div>
        <p className="text-center text-xs text-[var(--muted)]">One account can access both experiences. Your choice only determines where you go after authentication.</p>
      </div>
    </main>
  );
}

export default function ChooseRolePage() {
  return <Suspense fallback={<div className="p-12 text-center text-sm text-[var(--muted)]">Loading…</div>}><RoleChoice /></Suspense>;
}

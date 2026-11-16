'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BriefcaseBusiness, LayoutDashboard, Search } from 'lucide-react';

const links = [
  { href: '/employer', label: 'Workspace', icon: LayoutDashboard, exact: true },
  { href: '/employer/jobs/new', label: 'Post a job', icon: BriefcaseBusiness, exact: false },
];

export function EmployerNavbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur-md">
      <div className="mx-auto flex min-h-[68px] max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <Link href="/employer" className="flex min-h-11 shrink-0 items-center gap-2.5" aria-label="RemoteMatch employer workspace">
          <span className="grid size-8 place-items-center rounded-full bg-[var(--red)] text-white shadow-sm">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17L17 7" /><path d="M7 7h10v10" />
            </svg>
          </span>
          <span className="text-base font-bold tracking-tight text-[var(--ink)]">
            RemoteMatch <span className="font-medium text-[var(--muted)]">for Employers</span>
          </span>
        </Link>

        <nav aria-label="Employer navigation" className="flex w-full min-w-0 items-center gap-1 overflow-x-auto pb-0.5 sm:w-auto sm:gap-2">
          {links.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-semibold transition-colors sm:px-4 sm:text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--red)] ${
                  active
                    ? 'border border-[var(--red-soft-border)] bg-[var(--red-soft)] text-[var(--red)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                }`}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
              </Link>
            );
          })}
          <Link
            href="/remote-jobs"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-xs font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--surface-soft)] sm:px-4 sm:text-sm"
          >
            <Search size={16} aria-hidden="true" />
            <span className="hidden sm:inline">Candidate job directory</span>
            <span className="sm:hidden">Candidate view</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

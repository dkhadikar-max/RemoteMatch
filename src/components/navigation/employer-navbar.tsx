'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BriefcaseBusiness, Building2, LayoutDashboard, Search } from 'lucide-react';

const links = [
  { href: '/employer', label: 'Workspace', icon: LayoutDashboard, exact: true },
  { href: '/employer/jobs/new', label: 'Post a job', icon: BriefcaseBusiness, exact: false },
];

export function EmployerNavbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--bg)]/95 backdrop-blur-md">
      <div className="mx-auto flex min-h-[68px] max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/employer" className="flex shrink-0 items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-full bg-[var(--red)] text-white">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7" /><path d="M7 7h10v10" />
            </svg>
          </span>
          <span className="text-base font-bold tracking-tight text-[var(--ink)]">RemoteMatch <span className="font-medium text-[var(--muted)]">for Employers</span></span>
        </Link>

        <nav aria-label="Employer navigation" className="flex items-center gap-1 sm:gap-2">
          {links.map(({ href, label, icon: Icon, exact }) => {
            const active = exact ? pathname === href : pathname.startsWith(href);
            return (
              <Link key={href} href={href}
                className={`inline-flex min-h-10 items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition-colors sm:px-4 sm:text-sm ${active ? 'bg-[var(--red-soft)] text-[var(--red)]' : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'}`}>
                <Icon size={16} /><span>{label}</span>
              </Link>
            );
          })}
          <Link href="/remote-jobs" className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-[var(--line)] px-3 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] sm:px-4 sm:text-sm">
            <Search size={16} /><span className="hidden sm:inline">Find a job</span><span className="sm:hidden">Candidate</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

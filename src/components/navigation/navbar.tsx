'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Compass,
  BriefcaseBusiness,
  UserRound,
  Activity,
  ArrowUpRight,
} from 'lucide-react';

export function Navbar() {
  const pathname = usePathname();
  const [evaluationCount] = useState(3);
  const maxFreeSaves = 15;
  const savesRemaining = Math.max(maxFreeSaves - evaluationCount, 0);
  const isLanding = pathname === '/';
  const isPro = false; // localStore can supply or default to false

  return (
    <>
      {/* Desktop & Tablet Top Navigation */}
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--bg)]/90 backdrop-blur-md">
        <div className="container flex h-[68px] items-center justify-between gap-6">
          {/* Brand Logo */}
          <Link href="/" className="flex items-center gap-2.5 tracking-tight group">
            <span className="grid size-8 place-items-center rounded-full bg-[var(--red)] text-white shadow-sm transition-transform duration-150 group-hover:scale-105">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 17L17 7" />
                <path d="M7 7h10v10" />
              </svg>
            </span>
            <span className="text-lg font-bold tracking-tight text-[var(--ink)]">RemoteMatch</span>
          </Link>

          {/* Center Navigation Links */}
          <nav className="hidden items-center gap-1 md:flex">
            {isLanding ? (
              <>
                <Link
                  href="/feed"
                  className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
                >
                  Jobs
                </Link>
                <Link
                  href="/remote-jobs"
                  className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
                >
                  Directory
                </Link>
                <a
                  href="#how-it-works"
                  className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
                >
                  How It Works
                </a>
                <Link
                  href="/guide"
                  className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
                >
                  Guides
                </Link>
                <Link
                  href="/settings?tab=billing"
                  className="rounded-xl px-3.5 py-2 text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
                >
                  Pricing
                </Link>
              </>
            ) : (
              <>
                <Link
                  href="/feed"
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    pathname === '/feed' || pathname.startsWith('/match')
                      ? 'bg-[var(--surface)] text-[var(--red)] font-semibold shadow-sm border border-[var(--line)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                  }`}
                >
                  Jobs
                </Link>
                <Link
                  href="/tracker"
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    pathname === '/tracker'
                      ? 'bg-[var(--surface)] text-[var(--red)] font-semibold shadow-sm border border-[var(--line)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                  }`}
                >
                  Applications
                </Link>
                <Link
                  href="/settings"
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    pathname === '/settings'
                      ? 'bg-[var(--surface)] text-[var(--red)] font-semibold shadow-sm border border-[var(--line)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                  }`}
                >
                  Profile
                </Link>
              </>
            )}
          </nav>

          {/* Right Controls */}
          <div className="flex items-center gap-3">
            {isLanding ? (
              <>
                <Link
                  href="/feed"
                  className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors shadow-sm"
                >
                  Browse jobs
                </Link>
                <Link
                  href="/onboarding"
                  className="soft-button primary text-xs !py-2 !px-4"
                >
                  Find your matches →
                </Link>
              </>
            ) : (
              <>
                {isPro ? (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red-soft-border)] shadow-sm">
                    Pro
                  </span>
                ) : (
                  <div className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] bg-[var(--surface)] border border-[var(--line)] rounded-full px-3 py-1 shadow-sm">
                    <span className="size-1.5 rounded-full bg-[var(--red)]" />
                    <span>{savesRemaining} saves left today</span>
                  </div>
                )}

                <Link
                  href="/settings"
                  className="grid size-9 place-items-center rounded-full bg-[var(--red-soft-border)] text-xs font-bold text-[var(--red)] border border-[var(--red-soft-border)] shadow-sm hover:bg-[var(--red-soft-border)] transition-colors"
                >
                  A
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar (Thumb-friendly, 44px+ target) */}
      <nav className="fixed inset-x-4 bottom-4 z-40 flex items-center justify-around rounded-2xl border border-[var(--line)] bg-[color-mix(in_srgb,var(--surface)_95%,transparent)] p-1.5 shadow-[0_12px_35px_rgba(76,44,30,0.10)] backdrop-blur-md md:hidden">
        <Link
          href="/feed"
          className={`flex-1 flex flex-col items-center justify-center min-h-[48px] rounded-xl py-1 text-[11px] font-medium transition-colors ${
            pathname === '/feed' || pathname.startsWith('/match')
              ? 'text-[var(--red)] font-semibold bg-[var(--red-soft)]'
              : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <Compass size={19} />
          <span className="mt-0.5">Jobs</span>
        </Link>
        <Link
          href="/tracker"
          className={`flex-1 flex flex-col items-center justify-center min-h-[48px] rounded-xl py-1 text-[11px] font-medium transition-colors ${
            pathname === '/tracker'
              ? 'text-[var(--red)] font-semibold bg-[var(--red-soft)]'
              : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <BriefcaseBusiness size={19} />
          <span className="mt-0.5">Applications</span>
        </Link>
        <Link
          href="/settings"
          className={`flex-1 flex flex-col items-center justify-center min-h-[48px] rounded-xl py-1 text-[11px] font-medium transition-colors ${
            pathname === '/settings'
              ? 'text-[var(--red)] font-semibold bg-[var(--red-soft)]'
              : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <UserRound size={19} />
          <span className="mt-0.5">Profile</span>
        </Link>
      </nav>
    </>
  );
}

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, BriefcaseBusiness, UserRound } from 'lucide-react';
import {
  fetchServerEntitlement,
  ENTITLEMENT_CHANGED_EVENT,
  type ServerEntitlement,
} from '@/lib/entitlement/client';

/** The Supabase auth cookie is NOT httpOnly, so its absence is a reliable
 *  "definitely no session" signal — lets the navbar skip a guaranteed-401
 *  /api/profile call on genuinely public visits. */
function hasAuthCookie(): boolean {
  try {
    return document.cookie.split('; ').some((c) => /^sb-.*-auth-token(\.\d+)?=/.test(c));
  } catch {
    return false;
  }
}

export function Navbar() {
  const pathname = usePathname();
  const isLanding = pathname === '/';
  // /login is reachable with no session by construction (it's where an
  // unauthenticated visitor lands) — showing the authenticated app's nav
  // (Jobs/Applications/Profile, saves badge, avatar) there is misleading,
  // since none of it reflects real state for a signed-out visitor.
  const isAuthPage = pathname === '/login';
  // The public /remote-jobs SEO directory renders its own in-page category
  // navigation near the bottom of the initial mobile viewport; the fixed
  // app-shortcut bar (Jobs/Applications/Profile — all auth-gated
  // destinations a public-directory visitor may not even have a session
  // for) has been confirmed, via measured DOM overlap, to sit directly on
  // top of that in-page navigation on mobile, making the second row of
  // category chips untappable. Scoped to exactly this route family — the
  // authenticated app pages this bar actually serves are unaffected.
  const isRemoteJobsDirectory = pathname?.startsWith('/remote-jobs') ?? false;
  // Same overlap class of bug, confirmed via measured DOM coordinates on the
  // landing page itself: the fixed app-shortcut bar (Jobs/Applications/
  // Profile) sits directly over non-interactive section headings at several
  // scroll positions ("Find. Understand. Apply.", the pricing section
  // heading), since the landing page's own long-form marketing content was
  // never designed with this bar's fixed footprint in mind. Same fix as
  // /remote-jobs: an anonymous landing-page visitor doesn't have real
  // Applications/Profile state for this bar to reflect anyway.
  const isLandingForMobileNav = isLanding;

  // Server-authoritative entitlement. `null` until it resolves AND whenever
  // there is no session — the navbar never renders a fabricated quota/plan.
  const [ent, setEnt] = useState<ServerEntitlement | null>(null);
  const sessionPossible = !isLanding && !isAuthPage;

  const refresh = useCallback(async () => {
    if (!sessionPossible || !hasAuthCookie()) {
      setEnt(null);
      return;
    }
    const next = await fetchServerEntitlement();
    // A transient fetch failure (network blip, mid-flight token refresh) must
    // not blank a good pill/badge while the session cookie is still present —
    // keep the last known-good value; it only clears on a real sign-out
    // (cookie gone, handled above).
    setEnt((prev) => (next === null && prev !== null && hasAuthCookie() ? prev : next));
  }, [sessionPossible]);

  // Resolve on mount and on every route change.
  useEffect(() => {
    refresh();
  }, [refresh, pathname]);

  // Live refresh: same-tab signal (swipe / rewind / upgrade) + stale-tab
  // recovery on refocus. The event carries no data — we always refetch.
  useEffect(() => {
    const onSignal = () => refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener(ENTITLEMENT_CHANGED_EVENT, onSignal);
    window.addEventListener('focus', onSignal);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(ENTITLEMENT_CHANGED_EVENT, onSignal);
      window.removeEventListener('focus', onSignal);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const isPro = ent?.planTier === 'pro';
  const savesRemaining = ent
    ? Math.max(ent.rightSwipeLimit - ent.dailyRightSwipesCount, 0)
    : null;
  const avatarInitial = (() => {
    const email = ent?.email?.trim();
    const ch = email ? email.match(/[a-z0-9]/i)?.[0] : undefined;
    return (ch ?? '?').toUpperCase();
  })();

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

          {/* Center Navigation Links — omitted entirely on /login; see isAuthPage above */}
          {!isAuthPage && (
          <nav className="hidden items-center gap-1 md:flex">
            {isLanding ? (
              <>
                <Link
                  href="/feed"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  Jobs
                </Link>
                <Link
                  href="/remote-jobs"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  Directory
                </Link>
                <a
                  href="#how-it-works"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  How It Works
                </a>
                <Link
                  href="/guide"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  Guides
                </Link>
                <Link
                  href="/settings?tab=billing"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
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
                {/* LinkedIn Job Finder (Pro) — desktop nav only, omitted from
                    the mobile bottom bar to keep it at its existing 3
                    destinations (see the mobile nav block's own comment
                    below). Plan: vivid-hatching-kitten.md §26. */}
                <Link
                  href="/linkedin-jobs"
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    pathname === '/linkedin-jobs'
                      ? 'bg-[var(--surface)] text-[var(--red)] font-semibold shadow-sm border border-[var(--line)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                  }`}
                >
                  LinkedIn
                </Link>
              </>
            )}
          </nav>
          )}

          {/* Right Controls — omitted entirely on /login; brand/header only */}
          {!isAuthPage && (
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
                {isPro && (
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red-soft-border)] shadow-sm">
                    Pro
                  </span>
                )}
                {!isPro && savesRemaining !== null && (
                  <div className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] bg-[var(--surface)] border border-[var(--line)] rounded-full px-3 py-1 shadow-sm">
                    <span className="size-1.5 rounded-full bg-[var(--red)]" />
                    <span>{savesRemaining} saves left today</span>
                  </div>
                )}

                <Link
                  href="/settings"
                  className="grid size-9 place-items-center rounded-full bg-[var(--red-soft-border)] text-xs font-bold text-[var(--red)] border border-[var(--red-soft-border)] shadow-sm hover:bg-[var(--red-soft-border)] transition-colors"
                >
                  {avatarInitial}
                </Link>
              </>
            )}
          </div>
          )}
        </div>
      </header>

      {/* Mobile Bottom Navigation Bar (Thumb-friendly, 44px+ target) —
          omitted on /login for the same reason as the desktop right controls,
          on /remote-jobs where it overlaps that page's own category nav on
          mobile (see isRemoteJobsDirectory above), and on the landing page
          where it overlaps marketing section headings while scrolling (see
          isLandingForMobileNav above). */}
      {!isAuthPage && !isRemoteJobsDirectory && !isLandingForMobileNav && (
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
      )}
    </>
  );
}

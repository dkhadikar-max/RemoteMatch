'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, BriefcaseBusiness, UserRound, Linkedin } from 'lucide-react';
import {
  fetchServerEntitlement,
  ENTITLEMENT_CHANGED_EVENT,
  type ServerEntitlement,
} from '@/lib/entitlement/client';
import { isAdminHost } from '@/lib/auth/admin-host';
import { shouldFetchEntitlement } from '@/lib/entitlement/should-fetch';

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
  // Auth pages (/login, /signup, /forgot-password, /reset-password) are
  // focused conversion flows reachable with no session — showing the
  // authenticated app's nav (Jobs/Applications/Profile, saves badge, avatar)
  // or mobile bottom bar there is misleading and distracts from the auth task.
  const isAuthPage =
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password' ||
    pathname === '/reset-password';
  // The public /remote-jobs SEO directory renders its own in-page category
  // navigation near the bottom of the initial mobile viewport; the fixed
  // app-shortcut bar has been confirmed via measured DOM overlap to sit
  // directly on top of that in-page navigation on mobile.
  const isRemoteJobsDirectory = pathname?.startsWith('/remote-jobs') ?? false;
  const isGuideDirectory = pathname?.startsWith('/guide') ?? false;
  const isPublicRoute = isLanding || isRemoteJobsDirectory || isGuideDirectory;

  // Server-authoritative entitlement. `null` until it resolves AND whenever
  // there is no session — the navbar never renders a fabricated quota/plan.
  const [ent, setEnt] = useState<ServerEntitlement | null>(null);
  const sessionPossible = !isLanding && !isAuthPage;
  const showMarketingNav = isPublicRoute && !ent;
  const hideMobileBottomNav = isAuthPage || isPublicRoute || pathname === '/onboarding';

  // Admin-host detection deferred to an effect (not evaluated directly in the
  // render body) so the CLIENT'S FIRST render matches the SERVER'S: `window`
  // exists during hydration too, not just after mount, so checking it inline
  // here made hydration itself mismatch (server always renders the navbar,
  // client's first render already returned null) — React doesn't reliably
  // clean up that class of mismatch (a whole subtree present vs. absent) and
  // was leaving the server-rendered header permanently orphaned in the DOM
  // on admin.remotematch.online instead of removing it. Starting both
  // renders at `false` and flipping via a post-mount effect turns the
  // host-based hide into an ordinary re-render, which React handles cleanly.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    setIsAdmin(isAdminHost(window.location.host));
  }, []);

  const refresh = useCallback(async () => {
    // Never on the admin host: the navbar is hidden there and /api/profile 404s on every admin page load and every
    // focus / visibility event. Evaluated inside the callback — client-only — so hydration is unaffected.
    if (!shouldFetchEntitlement({ host: window.location.host, sessionPossible, hasAuthCookie: hasAuthCookie() })) {
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

  // Admin console (admin.remotematch.online) never shows the consumer nav —
  // its own layout (src/app/admin/layout.tsx) renders a sidebar instead.
  // Checked client-side (see the isAdmin effect above) rather than via a
  // server host-check in the shared root layout, deliberately: reading
  // headers() there would force the ENTIRE app into dynamic rendering,
  // costing every currently-static consumer page its static generation just
  // to support admin chrome. Called AFTER every hook above (never before)
  // so hook order stays identical between server and client renders — this
  // only ever changes what JSX is RETURNED, never how many hooks run. Cost
  // of this approach: on the admin host specifically, the consumer nav is
  // present in the initial server-rendered HTML and briefly visible until
  // the post-mount effect flips `isAdmin` — never occurring on the consumer
  // host (isAdmin stays false there for the page's whole lifetime).
  if (isAdmin) {
    return null;
  }

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

          {/* Center Navigation Links — omitted entirely on auth pages; see isAuthPage above */}
          {!isAuthPage && (
          <nav className="hidden items-center gap-1 md:flex">
            {showMarketingNav ? (
              <>
                <Link
                  href="/feed"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  Jobs
                </Link>
                <Link
                  href="/remote-jobs"
                  className={`rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors lg:px-3.5 ${
                    pathname?.startsWith('/remote-jobs')
                      ? 'text-[var(--red)] font-semibold'
                      : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                  }`}
                >
                  Directory
                </Link>
                <a
                  href="/#how-it-works"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  How It Works
                </a>
                <Link
                  href="/guide"
                  className={`rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap transition-colors lg:px-3.5 ${
                    pathname?.startsWith('/guide')
                      ? 'text-[var(--red)] font-semibold'
                      : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                  }`}
                >
                  Guides
                </Link>
                <a
                  href="/#pricing"
                  className="rounded-xl px-2.5 py-2 text-sm font-medium whitespace-nowrap text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors lg:px-3.5"
                >
                  Pricing
                </a>
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
                {/* LinkedIn Job Finder — desktop nav entry. The mobile bottom
                    bar has its own matching "LinkedIn" tab (below); it was
                    originally omitted there, which left phone users no way
                    to reach the page except typing the URL. */}
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

          {/* Right Controls — omitted entirely on auth pages; brand/header only */}
          {!isAuthPage && (
          <div className="flex items-center gap-3">
            {showMarketingNav ? (
              <>
                {/* Hidden below sm: on a narrow viewport this pair wrapped
                    onto multiple lines next to the logo (no responsive
                    treatment here, unlike the center nav's `hidden md:flex`)
                    — both CTAs are already duplicated prominently in the
                    hero below, so the header keeps only the primary one on
                    small screens. */}
                <Link
                  href="/feed"
                  className="hidden sm:inline-flex rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors shadow-sm"
                >
                  Browse jobs
                </Link>
                <Link
                  href="/onboarding"
                  className="soft-button primary text-xs !py-2 !px-4 whitespace-nowrap"
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
          omitted on auth pages, on public content routes where it overlaps
          in-page category nav/content, and on onboarding wizard. */}
      {!hideMobileBottomNav && (
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
          href="/linkedin-jobs"
          className={`flex-1 flex flex-col items-center justify-center min-h-[48px] rounded-xl py-1 text-[11px] font-medium transition-colors ${
            pathname === '/linkedin-jobs' || pathname.startsWith('/linkedin-jobs/')
              ? 'text-[var(--red)] font-semibold bg-[var(--red-soft)]'
              : 'text-[var(--muted)] hover:text-[var(--ink)]'
          }`}
        >
          <Linkedin size={19} />
          <span className="mt-0.5">LinkedIn</span>
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

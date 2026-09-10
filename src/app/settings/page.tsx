'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { localStore } from '@/lib/db/mock-seed';
import { fetchServerEntitlement, type ServerEntitlement } from '@/lib/entitlement/client';
import type { ServerOnboarding } from '@/lib/profile/hydrate';
import { computeProfileCompleteness } from '@/lib/profile/completeness';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import { normalizeProfileUrl } from '@/lib/profile-links/validate';
import { signOutCurrentSession } from '@/lib/auth/auth-flow';
import {
  User,
  CheckCircle2,
  CreditCard,
  Save,
  ArrowUpRight,
  Sliders,
  Settings as SettingsIcon,
  ShieldCheck,
  Linkedin,
  Github,
  LogOut,
} from 'lucide-react';

/**
 * F — Settings data-source alignment. /settings renders SERVER-authoritative
 * state only:
 *   - `/api/profile`    → email, plan tier, quota counters, LinkedIn/GitHub
 *   - `/api/onboarding` → name, headline, employment, target roles, experience,
 *                         work preference, country, timezone, skills, salary
 * No value is read from `localStore` / the demo fixture for DISPLAY, and there
 * are no fabricated fallbacks — an unfilled field shows "Not set", never an
 * invented number. A clean browser / new device / cleared localStorage shows
 * exactly the same thing.
 *
 * The only WRITE here (full_name / headline) goes to the `profiles` table via
 * the user's RLS-scoped session (migration 003/005 safe-columns grant), then
 * the UI re-reads the server response. `localStore` is updated afterwards only
 * as a compatibility cache for the still-fixture-backed feed/match pages.
 */

const NOT_SET = 'Not set';

function humanWorkPreference(wp: string | null | undefined): string | null {
  switch (wp) {
    case 'worldwide':
      return 'Worldwide';
    case 'my_country':
      return 'My country only';
    case 'selected_countries':
      return 'Selected countries';
    default:
      return null;
  }
}

/** "Worldwide · Full-time, Contract" — or null when nothing is set. */
function summarizePreferences(srv: ServerOnboarding | null): string | null {
  if (!srv) return null;
  const parts: string[] = [];
  const wp = humanWorkPreference(srv.workPreference);
  if (wp) parts.push(wp);
  if (srv.employmentTypes.length) parts.push(srv.employmentTypes.join(', '));
  return parts.length ? parts.join(' · ') : null;
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get('tab') || 'profile';

  const [activeTab, setActiveTab] = useState<'profile' | 'preferences' | 'billing' | 'settings'>(
    initialTab === 'billing' ? 'billing' : 'profile'
  );

  // Server-authoritative state. Null while loading; a load failure leaves it
  // null and the page renders a neutral "couldn't load" rather than fixture data.
  const [ent, setEnt] = useState<ServerEntitlement | null>(null);
  const [srv, setSrv] = useState<ServerOnboarding | null>(null);
  const [loadError, setLoadError] = useState(false);
  const seeded = useRef(false);

  const [fullName, setFullName] = useState('');
  const [headline, setHeadline] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);

  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [isSavingLinks, setIsSavingLinks] = useState(false);
  const [linksSaved, setLinksSaved] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Career direction (Career Transition Matching). Server-authoritative via
  // /api/profile; written by POST /api/profile/career-direction.
  const [savingDirection, setSavingDirection] = useState<'continue' | 'change_fields' | null>(null);
  const [directionError, setDirectionError] = useState<string | null>(null);
  const careerDirection = ent?.careerDirection ?? 'continue';

  /** Refresh both server snapshots. Returns the onboarding snapshot (or null). */
  const refreshServer = async (): Promise<ServerOnboarding | null> => {
    let entitlement: ServerEntitlement | null = null;
    let onboarding: ServerOnboarding | null = null;
    try {
      const [e, oRes] = await Promise.all([
        fetchServerEntitlement(),
        fetch('/api/onboarding', { cache: 'no-store' }),
      ]);
      entitlement = e;
      if (oRes.ok) onboarding = (await oRes.json()) as ServerOnboarding;
    } catch {
      /* handled below */
    }
    setEnt(entitlement);
    setSrv(onboarding);
    setLoadError(!entitlement && !onboarding);
    if (entitlement) {
      setLinkedinUrl(entitlement.linkedinUrl ?? '');
      setGithubUrl(entitlement.githubUrl ?? '');
    }
    return onboarding;
  };

  useEffect(() => {
    (async () => {
      const o = await refreshServer();
      if (o && !seeded.current) {
        seeded.current = true;
        setFullName(o.fullName ?? '');
        setHeadline(o.headline ?? '');
      }
    })();
  }, []);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await signOutCurrentSession();
    window.location.replace('/login');
  };

  const handleSetCareerDirection = async (next: 'continue' | 'change_fields') => {
    if (next === careerDirection || savingDirection) return;
    setDirectionError(null);
    setSavingDirection(next);
    try {
      const res = await fetch('/api/profile/career-direction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction: next }),
      });
      if (!res.ok) {
        setDirectionError('Could not update that just now. Try again.');
        return;
      }
      // Repaint from the authoritative server value, not the local click.
      await refreshServer();
    } catch {
      setDirectionError('Could not update that just now. Try again.');
    } finally {
      setSavingDirection(null);
    }
  };

  useEffect(() => {
    // A `session_id` in the URL means Stripe redirected back — it is not proof
    // of payment; the server verifies it against Stripe before planTier changes.
    const sessionId = searchParams?.get('session_id');
    if (!sessionId) return;

    (async () => {
      try {
        const res = await fetch('/api/stripe/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success) {
          setUpgradeSuccess(true);
          setActiveTab('billing');
        }
      } finally {
        await refreshServer();
      }
    })();
  }, [searchParams]);

  /**
   * The one write on this page. full_name / headline persist to `profiles` via
   * the user's own session (RLS safe-columns). The DB write is authoritative —
   * the UI is then repainted from a fresh server read, not from the local
   * values we sent. `localStore` is updated afterwards only so the still-
   * fixture-backed feed/match pages don't lag until their own hydrate runs.
   */
  const handleSaveProfile = async () => {
    setNameError(null);
    setProfileSaveError(null);
    const name = fullName.trim();
    if (!name) {
      setNameError('Name can’t be empty.');
      return;
    }

    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      setProfileSaveError('Service not available. Try again.');
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setProfileSaveError('Your session expired — sign in again.');
      return;
    }

    setIsSavingProfile(true);
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: name, headline: headline.trim() || null })
      .eq('id', user.id);

    if (error) {
      setIsSavingProfile(false);
      setProfileSaveError('Could not save right now. Please try again.');
      return;
    }

    const fresh = await refreshServer();
    setIsSavingProfile(false);
    if (fresh) {
      setFullName(fresh.fullName ?? '');
      setHeadline(fresh.headline ?? '');
      // compat cache for feed/match (still fixture-backed)
      localStore.updateProfile({ fullName: fresh.fullName, headline: fresh.headline });
    }
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  const handleSaveProfileLinks = async () => {
    const linkedin = normalizeProfileUrl(linkedinUrl);
    const github = normalizeProfileUrl(githubUrl);
    setLinkedinError(linkedin.error ?? null);
    setGithubError(github.error ?? null);
    if (linkedin.error || github.error) return;

    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    setIsSavingLinks(true);
    const { error } = await supabase
      .from('profiles')
      .update({ linkedin_url: linkedin.value, github_url: github.value })
      .eq('id', user.id);
    setIsSavingLinks(false);

    if (error) {
      setGithubError('Could not save right now. Please try again.');
      return;
    }
    setLinkedinUrl(linkedin.value ?? '');
    setGithubUrl(github.value ?? '');
    setLinksSaved(true);
    setTimeout(() => setLinksSaved(false), 2500);
  };

  const handleUpgradeToPro = async () => {
    setIsUpgrading(true);
    setUpgradeError(null);
    try {
      const res = await fetch('/api/stripe/checkout', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url;
        return;
      }
      setUpgradeError('Could not start checkout. Please try again.');
    } catch (err) {
      setUpgradeError('Could not start checkout. Please try again.');
    } finally {
      setIsUpgrading(false);
    }
  };

  // ---- derived, server-only display values (no fixture, no fabrication) ----
  const planTier = ent?.planTier ?? 'free';
  const rightSwipes = ent?.dailyRightSwipesCount ?? 0;
  const proposals = ent?.dailyProposalsCount ?? 0;
  const email = ent?.email ?? '';
  const skillCount = srv?.skills.length ?? 0;
  const completeness = computeProfileCompleteness({
    fullName: srv?.fullName,
    headline: srv?.headline,
    skillCount,
    targetRoleCount: srv?.targetRoles.length ?? 0,
    employmentTypeCount: srv?.employmentTypes.length ?? 0,
    currentCountry: srv?.currentCountry,
    currentTimezone: srv?.currentTimezone,
  });
  const prefsSummary = summarizePreferences(srv);
  const loading = ent === null && srv === null && !loadError;

  const accountCard = (
    <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
      <h2 className="text-lg font-bold text-[var(--ink)] flex items-center gap-2">
        <ShieldCheck size={18} className="text-[#059669]" />
        Account
      </h2>
      <p className="text-xs text-[var(--muted)]">
        Signed in as <span className="font-semibold text-[var(--ink)]">{email || '…'}</span>.
      </p>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--muted)] hover:text-[var(--ink)] text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px] disabled:opacity-50"
      >
        <LogOut size={13} />
        <span>{isSigningOut ? 'Signing out…' : 'Sign out'}</span>
      </button>
    </div>
  );

  const prefRow = (label: string, value: string | null | undefined) => (
    <div className="flex items-baseline justify-between gap-4 py-2 border-b border-[var(--line)] last:border-0">
      <span className="text-xs font-semibold text-[var(--muted)]">{label}</span>
      <span className={`text-xs text-right ${value ? 'text-[var(--ink)] font-medium' : 'text-[var(--muted)] italic'}`}>
        {value || NOT_SET}
      </span>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-8 items-start">
        <aside className="bg-[var(--surface)] rounded-2xl border border-[var(--line)] p-1.5 md:p-4 shadow-sm flex flex-row md:flex-col gap-1.5 overflow-x-auto scrollbar-none">
          {([
            ['profile', 'Profile', User],
            ['preferences', 'Preferences', Sliders],
            ['billing', 'Subscription', CreditCard],
            ['settings', 'Settings', SettingsIcon],
          ] as const).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 md:flex-initial md:w-full flex items-center justify-center md:justify-start gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] whitespace-nowrap transition-colors ${
                activeTab === key
                  ? 'bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)]'
                  : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] border border-transparent'
              }`}
            >
              <Icon size={15} className="shrink-0" />
              <span>{label}</span>
            </button>
          ))}
        </aside>

        <div className="space-y-6">
          {loadError && (
            <div className="soft-card p-5 border border-[var(--red-soft-border)] bg-[var(--red-soft)] text-xs text-[var(--ink)]">
              Couldn’t load your profile just now. Refresh the page to try again.
            </div>
          )}

          {activeTab === 'profile' && (
            <>
              <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">Your profile</h1>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      Everything here is saved to your account, not this device.
                    </p>
                  </div>
                </div>

                {/* Profile completeness — a simple filled/5 count, NOT a match score. */}
                <div className="rounded-2xl bg-[var(--surface-soft)] p-5 space-y-2 border border-[var(--line)]">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--ink)]">
                      Profile completeness{loading ? '' : ` — ${completeness.completed} of 5`}
                    </span>
                    <span className="mono font-bold text-[var(--red)]">
                      {loading ? '—' : `${completeness.percent}%`}
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--red)] rounded-full transition-all duration-300"
                      style={{ width: `${loading ? 0 : completeness.percent}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-[var(--muted)] pt-0.5">
                    Name, headline, skills, work preferences, and location — one point each.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 pt-1">
                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Experience</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The seniority band you selected during onboarding.
                    </p>
                    <div className="pt-1 text-[11px] font-medium text-[var(--ink)]">
                      {srv?.yearsOfExperience ? `${srv.yearsOfExperience} yrs` : <span className="italic text-[var(--muted)]">{NOT_SET}</span>}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Skills</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The skills on your profile.
                    </p>
                    <div className="pt-1 text-[11px] font-medium text-[var(--ink)]">
                      {skillCount > 0 ? `${skillCount} added` : <span className="italic text-[var(--muted)]">Not added</span>}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Preferences</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The work setup you're looking for.
                    </p>
                    <div className="pt-1 text-[11px] font-medium text-[var(--ink)]">
                      {prefsSummary ?? <span className="italic text-[var(--muted)]">{NOT_SET}</span>}
                    </div>
                  </div>
                </div>
              </div>

              {/* Plan / usage — server entitlement only */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="soft-card p-6 border border-[var(--line)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Your plan</span>
                    <span className="text-[11px] font-semibold text-[var(--red)] bg-[var(--surface-soft)] border border-[var(--red-soft-border)] px-2 py-0.5 rounded-full capitalize">
                      {planTier}
                    </span>
                  </div>
                  <div className="mono text-2xl font-bold text-[var(--ink)]">
                    {planTier === 'pro' ? 'Unlimited' : `${Math.max(15 - rightSwipes, 0)} saves left today`}
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {planTier === 'pro'
                      ? 'Unlimited saves, rewinds, tailored materials, and advanced filters.'
                      : `${rightSwipes} of 15 saves and ${proposals} of 5 proposals used today.`}
                  </p>
                  <button
                    onClick={() => setActiveTab('billing')}
                    className="w-full rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-2.5 transition-colors shadow-sm min-h-[44px]"
                  >
                    {planTier === 'pro' ? 'Manage subscription' : 'Upgrade plan'}
                  </button>
                </div>

                <div className="soft-card p-6 border border-[var(--line)] space-y-3">
                  <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Preferences</span>
                  <div className="text-base font-bold text-[var(--ink)]">
                    {prefsSummary ?? 'Not set yet'}
                  </div>
                  <p className="text-xs text-[var(--muted)] leading-relaxed">
                    {srv?.onboardingCompletedAt
                      ? 'Set during onboarding. See the Preferences tab for the full breakdown.'
                      : 'Finish onboarding to set your target roles, work preference, and location.'}
                  </p>
                  <button
                    onClick={() => setActiveTab('preferences')}
                    className="block w-full text-center rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-xs font-semibold text-[var(--ink)] py-2.5 transition-colors shadow-sm min-h-[44px]"
                  >
                    View preferences
                  </button>
                </div>
              </div>

              {/* Editable identity — the only write on this page */}
              <div className="soft-card p-6 sm:p-8 space-y-5 border border-[var(--line)]">
                <h3 className="text-sm font-semibold text-[var(--ink)] uppercase tracking-wider">Your details</h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] block mb-1">Full name</label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => {
                        setFullName(e.target.value);
                        setNameError(null);
                      }}
                      disabled={loading}
                      className="soft-input py-2 px-3 text-xs"
                    />
                    {nameError && <p className="text-[11px] text-[var(--red)] mt-1">{nameError}</p>}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] block mb-1">Email address</label>
                    <input
                      type="email"
                      value={email}
                      disabled
                      className="soft-input py-2 px-3 text-xs bg-[var(--surface-soft)] text-[var(--muted)] cursor-not-allowed"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-[var(--ink)] block mb-1">Professional headline</label>
                  <input
                    type="text"
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    disabled={loading}
                    placeholder="e.g. Senior Full Stack Engineer & Cloud Architect"
                    className="soft-input py-2 px-3 text-xs"
                  />
                  <p className="text-[11px] text-[var(--muted)] mt-1">Shown on your application materials.</p>
                </div>

                <div className="pt-2 flex items-center justify-between gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={isSavingProfile || loading}
                    className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-50 text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <Save size={13} />
                    <span>{isSavingProfile ? 'Saving…' : isSaved ? 'Changes saved!' : 'Save changes'}</span>
                  </button>
                  {isSaved && (
                    <span className="text-xs font-medium text-[#059669] flex items-center gap-1">
                      <CheckCircle2 size={13} />
                      <span>Saved to your account</span>
                    </span>
                  )}
                  {profileSaveError && <span className="text-xs font-medium text-[var(--red)]">{profileSaveError}</span>}
                </div>
              </div>

              {/* Career direction — drives Career Transition Matching. Saved to
                  profile_intents server-side; affects only the additive
                  transition-explanation layer, never eligibility or fit score. */}
              <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ink)] uppercase tracking-wider">Career direction</h3>
                  <p className="text-[11px] text-[var(--muted)] mt-1">
                    Tell RemoteMatch whether you want to keep building on your experience or move into a new field.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {([
                    ['continue', 'Continue in my field', 'Find roles that build on my existing experience.'],
                    ['change_fields', 'Change fields', 'Find roles I could realistically transition into.'],
                  ] as const).map(([value, title, sub]) => {
                    const selected = careerDirection === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleSetCareerDirection(value)}
                        disabled={loading || savingDirection !== null}
                        className={`text-left rounded-2xl border p-4 transition-colors disabled:opacity-60 ${
                          selected
                            ? 'border-[var(--red)] bg-[var(--red-soft)]'
                            : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-bold text-[var(--ink)]">{title}</span>
                          {selected && <CheckCircle2 size={14} className="text-[var(--red)] shrink-0" />}
                          {savingDirection === value && (
                            <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent shrink-0" />
                          )}
                        </div>
                        <p className="text-[11px] text-[var(--muted)] mt-1 leading-relaxed">{sub}</p>
                      </button>
                    );
                  })}
                </div>

                {careerDirection === 'change_fields' && (
                  <p className="text-[11px] text-[var(--muted)]">
                    Your feed now also shows how your experience could transfer to roles in your target field —
                    what fits, and what may be missing.
                  </p>
                )}
                {directionError && <p className="text-[11px] text-[var(--red)]">{directionError}</p>}
              </div>

              {/* Professional links — already server-backed (migration 005) */}
              <div className="soft-card p-6 sm:p-8 space-y-5 border border-[var(--line)]">
                <h3 className="text-sm font-semibold text-[var(--ink)] uppercase tracking-wider">Professional links</h3>
                <p className="text-[11px] text-[var(--muted)] -mt-3">Optional. Shown on your profile — not used for sign-in.</p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] mb-1 flex items-center gap-1.5">
                      <Linkedin size={13} />
                      <span>LinkedIn</span>
                    </label>
                    <input
                      type="text"
                      value={linkedinUrl}
                      onChange={(e) => {
                        setLinkedinUrl(e.target.value);
                        setLinkedinError(null);
                      }}
                      placeholder="linkedin.com/in/you"
                      className="soft-input py-2 px-3 text-xs"
                    />
                    {linkedinError && <p className="text-[11px] text-[var(--red)] mt-1">{linkedinError}</p>}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] mb-1 flex items-center gap-1.5">
                      <Github size={13} />
                      <span>GitHub</span>
                    </label>
                    <input
                      type="text"
                      value={githubUrl}
                      onChange={(e) => {
                        setGithubUrl(e.target.value);
                        setGithubError(null);
                      }}
                      placeholder="github.com/you"
                      className="soft-input py-2 px-3 text-xs"
                    />
                    {githubError && <p className="text-[11px] text-[var(--red)] mt-1">{githubError}</p>}
                  </div>
                </div>

                <div className="pt-1 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleSaveProfileLinks}
                    disabled={isSavingLinks}
                    className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-50 text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <Save size={13} />
                    <span>{isSavingLinks ? 'Saving…' : linksSaved ? 'Saved!' : 'Save links'}</span>
                  </button>
                  {linksSaved && (
                    <span className="text-xs font-medium text-[#059669] flex items-center gap-1">
                      <CheckCircle2 size={13} />
                      <span>Links updated</span>
                    </span>
                  )}
                </div>
              </div>

              {accountCard}
            </>
          )}

          {/* PREFERENCES — read-only view of the server onboarding snapshot */}
          {activeTab === 'preferences' && (
            <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
              <div>
                <h2 className="text-lg font-bold text-[var(--ink)]">Search &amp; matching preferences</h2>
                <p className="text-xs text-[var(--muted)] mt-1">
                  Set during onboarding. Editing preferences from here is coming soon.
                </p>
              </div>

              {loading ? (
                <p className="text-xs text-[var(--muted)]">Loading…</p>
              ) : (
                <div className="text-xs">
                  {prefRow('Target roles', srv?.targetRoles.length ? srv.targetRoles.join(', ') : null)}
                  {prefRow('Employment type', srv?.employmentTypes.length ? srv.employmentTypes.join(', ') : null)}
                  {prefRow('Work preference', humanWorkPreference(srv?.workPreference))}
                  {prefRow('Years of experience', srv?.yearsOfExperience ? `${srv.yearsOfExperience} yrs` : null)}
                  {prefRow('Location', srv?.currentCountry || null)}
                  {prefRow('Timezone', srv?.currentTimezone || null)}
                  {srv?.minSalary
                    ? prefRow(
                        'Minimum salary',
                        `${srv.minSalary.toLocaleString('en-US')} ${srv.preferredCurrency || 'USD'}`
                      )
                    : null}
                </div>
              )}
            </div>
          )}

          {/* BILLING */}
          {activeTab === 'billing' && (
            <div className="space-y-6">
              {upgradeSuccess && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-[#a7f3d0] bg-[#ecfdf5] text-xs">
                  <CheckCircle2 size={18} className="text-[#059669] shrink-0" />
                  <div>
                    <span className="font-semibold text-[var(--ink)]">Welcome to RemoteMatch Pro</span>
                    <p className="text-[var(--muted)] mt-0.5">
                      Your account has been upgraded to unlimited daily match checks and full access to all features.
                    </p>
                  </div>
                </div>
              )}

              <div className="soft-card p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-[var(--line)]">
                <div className="space-y-1">
                  <span className="status good text-xs">Current subscription</span>
                  <div className="flex items-center gap-2 mt-1">
                    <h3 className="text-2xl font-bold text-[var(--ink)] capitalize">{planTier} tier</h3>
                    {planTier === 'pro' && (
                      <span className="rounded-full bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)] px-2.5 py-0.5 text-[11px] font-bold">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {planTier === 'pro'
                      ? 'Unlimited saves, tailored proposals, rewinds, and advanced filters.'
                      : `${Math.max(15 - rightSwipes, 0)} saves and ${Math.max(5 - proposals, 0)} proposal generations left today.`}
                  </p>
                </div>

                {planTier === 'free' && (
                  <button
                    type="button"
                    onClick={handleUpgradeToPro}
                    disabled={isUpgrading}
                    className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <span>{isUpgrading ? 'Connecting…' : 'Upgrade to Pro ($12/mo)'}</span>
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
                  <div className="space-y-1 border-b border-[var(--line)] pb-4">
                    <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">RemoteMatch Free</span>
                    <div className="text-3xl font-bold text-[var(--ink)] mono">$0</div>
                    <p className="text-xs text-[var(--muted)]">Get started for free.</p>
                  </div>
                  <ul className="space-y-2.5 text-xs text-[var(--muted)] pt-1">
                    {['15 saves per day', '5 proposal generations per day', 'Role, remote policy & seniority filters', 'Application tracker'].map((f) => (
                      <li key={f} className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/feed"
                    className="block w-full text-center rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] hover:bg-[var(--surface)] text-xs font-semibold text-[var(--ink)] py-2.5 transition-colors shadow-sm min-h-[44px] flex items-center justify-center"
                  >
                    Start finding jobs →
                  </Link>
                </div>

                <div className="soft-card p-6 space-y-4 relative border-2 border-[var(--red)] shadow-md">
                  <div className="absolute top-4 right-4 rounded-full bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    Recommended
                  </div>
                  <div className="space-y-1 border-b border-[var(--line)] pb-4">
                    <span className="text-xs font-semibold text-[var(--red)] uppercase tracking-wider">RemoteMatch Pro</span>
                    <div className="text-3xl font-bold text-[var(--ink)] mono">
                      $12 <span className="text-xs font-normal text-[var(--muted)]">/month</span>
                    </div>
                    <p className="text-xs text-[var(--muted)]">More ways to find the right job.</p>
                  </div>
                  <ul className="space-y-2.5 text-xs text-[var(--ink)] font-medium pt-1">
                    {['Unlimited saves', 'Unlimited proposal materials', 'Rewind accidental passes', 'Precision location, salary & timezone filters'].map((f) => (
                      <li key={f} className="flex items-center gap-2">
                        <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    onClick={handleUpgradeToPro}
                    disabled={isUpgrading}
                    className="w-full mt-4 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-2.5 transition-colors shadow-sm flex items-center justify-center gap-1.5 min-h-[44px]"
                  >
                    <span>{planTier === 'pro' ? 'Manage billing' : 'Upgrade to Pro →'}</span>
                    <ArrowUpRight size={13} />
                  </button>
                  {upgradeError && <p className="mt-2 text-xs font-medium text-[var(--red)]">{upgradeError}</p>}
                </div>
              </div>
            </div>
          )}

          {/* SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              {accountCard}
              <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
                <h2 className="text-lg font-bold text-[var(--ink)]">Account preferences</h2>
                <p className="text-xs text-[var(--muted)]">Manage notifications and privacy preferences.</p>
                <div className="pt-2">
                  <span className="text-xs font-semibold text-[#059669] bg-[#ecfdf5] border border-[#a7f3d0] px-3 py-1.5 rounded-xl inline-flex items-center gap-1.5">
                    <ShieldCheck size={14} />
                    Privacy Protected · Zero Third-Party Tracking
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="size-6 animate-spin rounded-full border-2 border-[var(--red)] border-t-transparent" />
        </div>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}

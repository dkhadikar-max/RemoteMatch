'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { PersonProfile } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { fetchServerEntitlement } from '@/lib/entitlement/client';
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
  Check,
  Linkedin,
  Github,
  LogOut,
} from 'lucide-react';

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get('tab') || 'profile';

  const [activeTab, setActiveTab] = useState<'profile' | 'preferences' | 'billing' | 'settings'>(
    initialTab === 'billing' ? 'billing' : 'profile'
  );
  const [profile, setProfile] = useState<PersonProfile>(localStore.getProfile());
  const [fullName, setFullName] = useState(profile.fullName);
  const [headline, setHeadline] = useState(profile.headline || '');
  const [isSaved, setIsSaved] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  // The two professional-link fields are server-authoritative (see
  // supabase/migrations/005_profile_links.sql) — unlike fullName/headline,
  // which stay on the local fixture below. `authEmail` is the verified
  // account's email, always present now that every session reaching this
  // page has already passed the middleware/API verified-account gate.
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [linkedinUrl, setLinkedinUrl] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [linkedinError, setLinkedinError] = useState<string | null>(null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [isSavingLinks, setIsSavingLinks] = useState(false);
  const [linksSaved, setLinksSaved] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  // Merges local, non-authoritative profile CONTENT with the
  // server-authoritative entitlement fields — see feed/page.tsx for the
  // same pattern and its rationale. `planTier` displayed anywhere on this
  // page must come from this merge, never from a raw `localStore` read.
  const loadProfile = async () => {
    const localProfile = localStore.getProfile();
    const entitlement = await fetchServerEntitlement();
    const merged: PersonProfile = entitlement
      ? {
          ...localProfile,
          planTier: entitlement.planTier,
          dailyRightSwipesCount: entitlement.dailyRightSwipesCount,
          dailyProposalsCount: entitlement.dailyProposalsCount,
          usageDate: entitlement.usageDate,
          isAnonymous: entitlement.isAnonymous,
          linkedinUrl: entitlement.linkedinUrl,
          githubUrl: entitlement.githubUrl,
        }
      : localProfile;
    setProfile(merged);
    if (entitlement) {
      setAuthEmail(entitlement.email);
      setLinkedinUrl(entitlement.linkedinUrl ?? '');
      setGithubUrl(entitlement.githubUrl ?? '');
    }
    return merged;
  };

  useEffect(() => {
    loadProfile();
  }, []);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await signOutCurrentSession();
    router.push('/login');
  };

  useEffect(() => {
    // A `session_id` in the URL means Stripe redirected back here — it is
    // NOT itself proof of payment. It must be handed to the server, which
    // verifies it against Stripe (or, only when Stripe isn't configured,
    // recognizes the mock flow for THIS authenticated user) before
    // planTier changes. There is deliberately no client-side branch here
    // that sets planTier directly from a URL parameter.
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
        await loadProfile();
      }
    })();
  }, [searchParams]);

  const handleSaveProfile = () => {
    localStore.updateProfile({
      fullName,
      headline,
    });
    setProfile((prev) => ({
      ...localStore.getProfile(),
      // Entitlement fields are server-authoritative and must survive a
      // content-only save unchanged.
      planTier: prev.planTier,
      dailyRightSwipesCount: prev.dailyRightSwipesCount,
      dailyProposalsCount: prev.dailyProposalsCount,
      usageDate: prev.usageDate,
    }));
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  // Unlike handleSaveProfile above (localStore, client-only), these two
  // fields write to the real `profiles` table — see migration 005. The
  // profiles_update_own_safe_columns RLS policy (auth.uid() = id) and the
  // column-level GRANT are what actually authorize this, but PostgREST
  // itself independently refuses to send an UPDATE with no WHERE clause at
  // all (a safety guard, unrelated to RLS) — `.eq('id', user.id)` is
  // required for the request to be accepted, not for authorization.
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
      // Deliberately no fallback that grants Pro locally on failure — a
      // failed/unreachable checkout call must never itself be treated as a
      // successful upgrade.
      setUpgradeError('Could not start checkout. Please try again.');
    } catch (err) {
      setUpgradeError('Could not start checkout. Please try again.');
    } finally {
      setIsUpgrading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      {/* Settings Grid Layout matching Screen 5 */}
      <div className="grid grid-cols-1 md:grid-cols-[240px_1fr] gap-8 items-start">
        {/* Left Navigation: Horizontal Tab Selector on Mobile, Sidebar on Desktop */}
        <aside className="bg-[var(--surface)] rounded-2xl border border-[var(--line)] p-1.5 md:p-4 shadow-sm flex flex-row md:flex-col gap-1.5 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('profile')}
            className={`flex-1 md:flex-initial md:w-full flex items-center justify-center md:justify-start gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] whitespace-nowrap transition-colors ${
              activeTab === 'profile'
                ? 'bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] border border-transparent'
            }`}
          >
            <User size={15} className="shrink-0" />
            <span>Profile</span>
          </button>

          <button
            onClick={() => setActiveTab('preferences')}
            className={`flex-1 md:flex-initial md:w-full flex items-center justify-center md:justify-start gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] whitespace-nowrap transition-colors ${
              activeTab === 'preferences'
                ? 'bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] border border-transparent'
            }`}
          >
            <Sliders size={15} className="shrink-0" />
            <span>Preferences</span>
          </button>

          <button
            onClick={() => setActiveTab('billing')}
            className={`flex-1 md:flex-initial md:w-full flex items-center justify-center md:justify-start gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] whitespace-nowrap transition-colors ${
              activeTab === 'billing'
                ? 'bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] border border-transparent'
            }`}
          >
            <CreditCard size={15} className="shrink-0" />
            <span>Subscription</span>
          </button>

          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 md:flex-initial md:w-full flex items-center justify-center md:justify-start gap-2 px-3.5 py-2.5 rounded-xl text-xs font-semibold min-h-[44px] whitespace-nowrap transition-colors ${
              activeTab === 'settings'
                ? 'bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)]'
                : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] border border-transparent'
            }`}
          >
            <SettingsIcon size={15} className="shrink-0" />
            <span>Settings</span>
          </button>
        </aside>

        {/* Right Main Content (Screen 5) */}
        <div className="space-y-6">
          {activeTab === 'profile' && (
            <>
              {/* Profile Card with Strength Bar & Actions */}
              <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">
                      Build a stronger profile
                    </h1>
                    <p className="text-xs text-[var(--muted)] mt-1">
                      Give employers a clearer picture of what you can do.
                    </p>
                  </div>

                  <Link
                    href="/onboarding"
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm self-start sm:self-auto min-h-[44px]"
                  >
                    <span>Improve your matches</span>
                  </Link>
                </div>

                {/* Profile Completeness Bar (Coral-Red) */}
                <div className="rounded-2xl bg-[var(--surface-soft)] p-5 space-y-2 border border-[var(--line)]">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-[var(--ink)]">Profile completeness — {profile.profileStrength || 85}%</span>
                    <span className="mono font-bold text-[var(--red)]">
                      {profile.profileStrength || 85}%
                    </span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-[var(--line)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--red)] rounded-full transition-all duration-300"
                      style={{ width: `${profile.profileStrength || 85}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-[var(--muted)] pt-0.5">
                    Complete your profile to find better matches.
                  </p>
                </div>

                {/* 3 Core Profile Sections matching Master Plan */}
                <div className="grid gap-3 sm:grid-cols-3 pt-1">
                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Your experience</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The roles, projects, and experience that shape your profile.
                    </p>
                    <div className="pt-1 flex items-center gap-1.5 text-[#059669] font-medium text-[11px]">
                      <CheckCircle2 size={13} className="shrink-0" />
                      <span>{profile.intent?.yearsOfExperience || '4-6'} yrs verified</span>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Your skills</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The skills you've demonstrated through your experience.
                    </p>
                    <div className="pt-1 flex items-center gap-1.5 text-[#059669] font-medium text-[11px]">
                      <CheckCircle2 size={13} className="shrink-0" />
                      <span>{profile.skills.length || 5} skills added</span>
                    </div>
                  </div>

                  <div className="rounded-2xl bg-[var(--surface)] border border-[var(--line)] p-4 text-xs space-y-1.5 shadow-sm">
                    <p className="font-bold text-sm text-[var(--ink)]">Your preferences</p>
                    <p className="text-[11px] text-[var(--muted)] leading-relaxed">
                      The roles, locations, and work setup you're looking for.
                    </p>
                    <div className="pt-1 flex items-center gap-1.5 text-[#059669] font-medium text-[11px]">
                      <CheckCircle2 size={13} className="shrink-0" />
                      <span>Remote · Full-time</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Your Plan Card (Screen 5) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="soft-card p-6 border border-[var(--line)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Your Plan</span>
                    <span className="text-[11px] font-semibold text-[var(--red)] bg-[var(--surface-soft)] border border-[var(--red-soft-border)] px-2 py-0.5 rounded-full capitalize">
                      {profile.planTier}
                    </span>
                  </div>
                  <div className="mono text-2xl font-bold text-[var(--ink)]">
                    {profile.planTier === 'pro'
                      ? 'Unlimited'
                      : `${Math.max(15 - (profile.dailyRightSwipesCount || 0), 0)} saves left today`}
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {profile.planTier === 'pro'
                      ? 'Unlimited saves, rewinds, tailored materials, and advanced filters.'
                      : `${profile.dailyRightSwipesCount || 0} of 15 saves and ${profile.dailyProposalsCount || 0} of 5 proposals used today.`}
                  </p>
                  <button
                    onClick={() => setActiveTab('billing')}
                    className="w-full rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-2.5 transition-colors shadow-sm min-h-[44px]"
                  >
                    Upgrade plan
                  </button>
                </div>

                <div className="soft-card p-6 border border-[var(--line)] space-y-3">
                  <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Profile Status</span>
                  <div className="text-base font-bold text-[var(--ink)]">
                    Improve your matches
                  </div>
                  <p className="text-xs text-[var(--muted)] leading-relaxed">
                    Complete your profile to find better matches and give employers a clearer picture of your experience.
                  </p>
                  <Link
                    href="/onboarding"
                    className="block w-full text-center rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-xs font-semibold text-[var(--ink)] py-2.5 transition-colors shadow-sm min-h-[44px] flex items-center justify-center"
                  >
                    Improve your matches
                  </Link>
                </div>
              </div>

              {/* Edit Identity Card */}
              <div className="soft-card p-6 sm:p-8 space-y-5 border border-[var(--line)]">
                <h3 className="text-sm font-semibold text-[var(--ink)] uppercase tracking-wider">
                  Your details
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] block mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="soft-input py-2 px-3 text-xs"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-[var(--ink)] block mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      value={profile.email}
                      disabled
                      className="soft-input py-2 px-3 text-xs bg-[var(--surface-soft)] text-[var(--muted)] cursor-not-allowed"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-[var(--ink)] block mb-1">
                    Professional Headline
                  </label>
                  <input
                    type="text"
                    value={headline}
                    onChange={(e) => setHeadline(e.target.value)}
                    placeholder="e.g. Senior Full Stack Engineer & Cloud Architect"
                    className="soft-input py-2 px-3 text-xs"
                  />
                  <p className="text-[11px] text-[var(--muted)] mt-1">
                    Shown on your application materials.
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <Save size={13} />
                    <span>{isSaved ? 'Changes Saved!' : 'Save changes'}</span>
                  </button>

                  {isSaved && (
                    <span className="text-xs font-medium text-[#059669] flex items-center gap-1">
                      <CheckCircle2 size={13} />
                      <span>Profile updated successfully</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Professional links — display data only, not an auth
                  mechanism (see src/lib/profile-links/validate.ts). Kept
                  as its own card + save action since these persist to the
                  real profiles table, unlike fullName/headline above. */}
              <div className="soft-card p-6 sm:p-8 space-y-5 border border-[var(--line)]">
                <h3 className="text-sm font-semibold text-[var(--ink)] uppercase tracking-wider">
                  Professional links
                </h3>
                <p className="text-[11px] text-[var(--muted)] -mt-3">
                  Optional. Shown on your profile — not used for sign-in.
                </p>

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
                    {linkedinUrl && !linkedinError && (
                      <a href={linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-[var(--muted)] hover:text-[var(--red)] mt-1 inline-block truncate max-w-full">
                        {linkedinUrl}
                      </a>
                    )}
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
                    {githubUrl && !githubError && (
                      <a href={githubUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-[var(--muted)] hover:text-[var(--red)] mt-1 inline-block truncate max-w-full">
                        {githubUrl}
                      </a>
                    )}
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

            </>
          )}

          {/* PREFERENCES TAB */}
          {activeTab === 'preferences' && (
            <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)]">
              <h2 className="text-lg font-bold text-[var(--ink)]">Search & Matching Preferences</h2>
              <div className="space-y-4 text-xs">
                <div>
                  <label className="font-semibold block mb-1">Target Roles</label>
                  <input
                    type="text"
                    defaultValue={profile.intent?.targetRoles.join(', ')}
                    className="soft-input py-2 px-3 text-xs"
                  />
                </div>
                <div>
                  <label className="font-semibold block mb-1">Remote Preference</label>
                  <select defaultValue="worldwide" className="soft-input py-2 px-3 text-xs">
                    <option value="worldwide">Worldwide Only</option>
                    <option value="timezone">Timezone Overlap</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* BILLING TAB */}
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

              {/* Current Status Card */}
              <div className="soft-card p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-[var(--line)]">
                <div className="space-y-1">
                  <span className="status good text-xs">Current Subscription</span>
                  <div className="flex items-center gap-2 mt-1">
                    <h3 className="text-2xl font-bold text-[var(--ink)] capitalize">
                      {profile.planTier} Tier
                    </h3>
                    {profile.planTier === 'pro' && (
                      <span className="rounded-full bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)] px-2.5 py-0.5 text-[11px] font-bold">
                        ACTIVE
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    {profile.planTier === 'pro'
                      ? 'Unlimited saves, tailored proposals, rewinds, and advanced filters.'
                      : `${Math.max(15 - (profile.dailyRightSwipesCount || 0), 0)} saves and ${Math.max(5 - (profile.dailyProposalsCount || 0), 0)} proposal generations left today.`}
                  </p>
                </div>

                {profile.planTier === 'free' && (
                  <button
                    type="button"
                    onClick={handleUpgradeToPro}
                    disabled={isUpgrading}
                    className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    <span>{isUpgrading ? 'Connecting...' : 'Upgrade to Pro ($12/mo)'}</span>
                    <ArrowUpRight size={13} />
                  </button>
                )}
              </div>

              {/* Pricing Comparison Table */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Free Tier */}
                <div className="soft-card p-6 space-y-4 border border-[var(--line)]">
                  <div className="space-y-1 border-b border-[var(--line)] pb-4">
                    <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">RemoteMatch Free</span>
                    <div className="text-3xl font-bold text-[var(--ink)] mono">$0</div>
                    <p className="text-xs text-[var(--muted)]">
                      Get started for free.
                    </p>
                  </div>

                  <ul className="space-y-2.5 text-xs text-[var(--muted)] pt-1">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>15 saves per day</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>5 proposal generations per day</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Role, remote policy & seniority filters</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Application tracker</span>
                    </li>
                  </ul>

                  <Link
                    href="/feed"
                    className="block w-full text-center rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] hover:bg-[var(--surface)] text-xs font-semibold text-[var(--ink)] py-2.5 transition-colors shadow-sm min-h-[44px] flex items-center justify-center"
                  >
                    Start finding jobs →
                  </Link>
                </div>

                {/* Pro Tier */}
                <div className="soft-card p-6 space-y-4 relative border-2 border-[var(--red)] shadow-md">
                  <div className="absolute top-4 right-4 rounded-full bg-[var(--surface-soft)] text-[var(--red)] border border-[var(--red-soft-border)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider">
                    Recommended
                  </div>

                  <div className="space-y-1 border-b border-[var(--line)] pb-4">
                    <span className="text-xs font-semibold text-[var(--red)] uppercase tracking-wider">RemoteMatch Pro</span>
                    <div className="text-3xl font-bold text-[var(--ink)] mono">
                      $12 <span className="text-xs font-normal text-[var(--muted)]">/month</span>
                    </div>
                    <p className="text-xs text-[var(--muted)]">
                      More ways to find the right job.
                    </p>
                  </div>

                  <ul className="space-y-2.5 text-xs text-[var(--ink)] font-medium pt-1">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Unlimited saves</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Unlimited proposal materials</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Rewind accidental passes</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-[#059669] shrink-0" />
                      <span>Precision location, salary & timezone filters</span>
                    </li>
                  </ul>

                  <button
                    type="button"
                    onClick={handleUpgradeToPro}
                    disabled={isUpgrading}
                    className="w-full mt-4 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold py-2.5 transition-colors shadow-sm flex items-center justify-center gap-1.5 min-h-[44px]"
                  >
                    <span>{profile.planTier === 'pro' ? 'Manage Billing' : 'Upgrade to Pro →'}</span>
                    <ArrowUpRight size={13} />
                  </button>
                  {upgradeError && (
                    <p className="mt-2 text-xs font-medium text-[var(--red)]">{upgradeError}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === 'settings' && (
            <div className="space-y-6">
              {/* Every session reaching this page has already passed the
                  verified-account gate (middleware + getAuthenticatedUser) —
                  there is no "secure your account" prompt anymore because
                  there is no lesser-verified state left to prompt about. */}
              <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
                <h2 className="text-lg font-bold text-[var(--ink)] flex items-center gap-2">
                  <ShieldCheck size={18} className="text-[#059669]" />
                  Account
                </h2>
                <p className="text-xs text-[var(--muted)]">
                  Signed in as <span className="font-semibold text-[var(--ink)]">{authEmail}</span>.
                </p>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={isSigningOut}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--muted)] hover:text-[var(--ink)] text-xs font-semibold px-3.5 py-2 transition-colors min-h-[44px]"
                >
                  <LogOut size={13} />
                  <span>{isSigningOut ? 'Signing out…' : 'Sign out'}</span>
                </button>
              </div>

              <div className="soft-card p-6 sm:p-8 space-y-4 border border-[var(--line)]">
                <h2 className="text-lg font-bold text-[var(--ink)]">Account Preferences</h2>
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

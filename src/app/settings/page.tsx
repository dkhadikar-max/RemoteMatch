'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { PersonProfile } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { createCheckoutSession } from '@/lib/stripe';
import {
  User,
  Sparkles,
  CheckCircle2,
  CreditCard,
  Save,
} from 'lucide-react';

function SettingsContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams?.get('tab') || 'profile';

  const [activeTab, setActiveTab] = useState<'profile' | 'billing'>(
    initialTab === 'billing' ? 'billing' : 'profile'
  );
  const [profile, setProfile] = useState<PersonProfile>(localStore.getProfile());
  const [fullName, setFullName] = useState(profile.fullName);
  const [headline, setHeadline] = useState(profile.headline || '');
  const [isSaved, setIsSaved] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState(false);

  useEffect(() => {
    // Check if redirected from Stripe
    if (searchParams?.get('tier') === 'pro' || searchParams?.get('session_id')) {
      localStore.updateProfile({ planTier: 'pro' });
      setProfile(localStore.getProfile());
      setUpgradeSuccess(true);
      setActiveTab('billing');
    }
  }, [searchParams]);

  const handleSaveProfile = () => {
    localStore.updateProfile({
      fullName,
      headline,
    });
    setProfile(localStore.getProfile());
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  const handleUpgradeToPro = async () => {
    setIsUpgrading(true);
    try {
      const res = await createCheckoutSession({
        userId: profile.id,
        userEmail: profile.email,
        returnUrl: typeof window !== 'undefined' ? window.location.origin + '/settings' : '',
      });

      if (res.url) {
        window.location.href = res.url;
      } else {
        // Fallback simulate upgrade
        localStore.updateProfile({ planTier: 'pro' });
        setProfile(localStore.getProfile());
        setUpgradeSuccess(true);
      }
    } catch (err) {
      console.error('Upgrade error:', err);
    } finally {
      setIsUpgrading(false);
    }
  };

  const remainingEvaluations = Math.max(20 - (profile.dailyEvaluationsCount || 0), 0);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
          Account & Preferences
        </h1>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Manage your BYN person profile, matching parameters, and subscription plan.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-border pb-3">
        <button
          onClick={() => setActiveTab('profile')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'profile'
              ? 'bg-secondary text-foreground font-bold'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <User className="h-4 w-4" />
          <span>BYN Profile</span>
        </button>

        <button
          onClick={() => setActiveTab('billing')}
          className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-colors ${
            activeTab === 'billing'
              ? 'bg-secondary text-foreground font-bold'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <CreditCard className="h-4 w-4" />
          <span>Billing & Plan</span>
        </button>
      </div>

      {/* TAB 1: PROFILE */}
      {activeTab === 'profile' && (
        <div className="p-6 rounded-2xl border border-border bg-card shadow-md space-y-6">
          <div className="flex items-center gap-4">
            <img
              src={profile.avatarUrl || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=120&h=120&fit=crop&crop=faces'}
              alt={profile.fullName}
              className="h-16 w-16 rounded-2xl object-cover border border-border bg-secondary"
            />
            <div>
              <h3 className="font-bold text-lg text-foreground">{profile.fullName}</h3>
              <span className="text-xs text-muted-foreground">{profile.email}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                Full Name
              </label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                Headline / Specialization
              </label>
              <input
                type="text"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                className="w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          {/* Current Intent & Skills snapshot */}
          <div className="p-4 rounded-xl bg-secondary/30 border border-border space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
                Target Intent & Capabilities
              </span>
              <a
                href="/onboarding"
                className="text-xs font-semibold text-primary hover:underline"
              >
                Re-run Onboarding Wizard
              </a>
            </div>

            <div className="text-xs text-muted-foreground space-y-1">
              <div>
                <span className="font-medium text-foreground">Target Roles: </span>
                {profile.intent?.targetRoles.join(', ')}
              </div>
              <div>
                <span className="font-medium text-foreground">Employment Types: </span>
                {profile.intent?.employmentTypes.join(', ')}
              </div>
              <div>
                <span className="font-medium text-foreground">Verified Skills: </span>
                {profile.skills.map((s) => s.skillName).join(', ')}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end pt-2">
            <button
              onClick={handleSaveProfile}
              className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-all"
            >
              <Save className="h-4 w-4" />
              <span>{isSaved ? 'Changes Saved!' : 'Save Profile'}</span>
            </button>
          </div>
        </div>
      )}

      {/* TAB 2: BILLING & UPGRADE */}
      {activeTab === 'billing' && (
        <div className="space-y-6">
          {/* Success banner if just upgraded */}
          {upgradeSuccess && (
            <div className="flex items-center gap-3 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs">
              <CheckCircle2 className="h-5 w-5 text-emerald-400 flex-shrink-0" />
              <div>
                <span className="font-bold">Welcome to RemoteMatch Pro!</span>
                <p className="opacity-90">
                  Your account has been upgraded to unlimited daily evaluations and full AI application kit intelligence.
                </p>
              </div>
            </div>
          )}

          {/* Current Status Card */}
          <div className="p-6 rounded-2xl border border-border bg-card shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Current Subscription
              </span>
              <div className="flex items-center gap-2">
                <h3 className="text-xl font-bold text-foreground capitalize">
                  {profile.planTier} Tier
                </h3>
                {profile.planTier === 'pro' && (
                  <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-500/30">
                    ACTIVE
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {profile.planTier === 'pro'
                  ? 'Unlimited evaluations, advanced AI tailoring, and priority job ingestion.'
                  : `${remainingEvaluations} free daily job evaluations remaining today.`}
              </p>
            </div>

            {profile.planTier === 'free' && (
              <button
                type="button"
                onClick={handleUpgradeToPro}
                disabled={isUpgrading}
                className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-500/20 hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                <span>{isUpgrading ? 'Redirecting to Stripe...' : 'Upgrade to Pro ($12/mo)'}</span>
              </button>
            )}
          </div>

          {/* Pricing Comparison Table */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Free Tier */}
            <div className="p-6 rounded-2xl border border-border bg-card space-y-4">
              <div className="space-y-1">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                  Free
                </span>
                <div className="text-2xl font-bold text-foreground">$0</div>
                <p className="text-xs text-muted-foreground">
                  Essential remote screening for casual job seekers.
                </p>
              </div>

              <ul className="space-y-2 text-xs text-muted-foreground pt-2">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span>20 job evaluations per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span>Basic Fit Score & strengths overview</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span>Direct official apply links</span>
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-primary" />
                  <span>Application tracker & notes</span>
                </li>
              </ul>
            </div>

            {/* Pro Tier */}
            <div className="p-6 rounded-2xl border-2 border-emerald-500/40 bg-gradient-to-b from-card to-emerald-950/20 space-y-4 relative shadow-xl">
              <div className="absolute -top-3 right-4 rounded-full bg-emerald-500 px-3 py-0.5 text-[10px] font-bold text-white uppercase tracking-wider shadow-sm">
                Recommended
              </div>

              <div className="space-y-1">
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  RemoteMatch Pro
                </span>
                <div className="text-2xl font-bold text-foreground">
                  $12 <span className="text-xs font-normal text-muted-foreground">/ month</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  High-conviction intelligence for active remote professionals.
                </p>
              </div>

              <ul className="space-y-2 text-xs text-muted-foreground pt-2">
                <li className="flex items-center gap-2 text-foreground font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>Unlimited daily job evaluations</span>
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>Deep AI gap analysis & "Why This Job" reasoning</span>
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>Tailored resume bullet rewrites</span>
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>Custom cover letters & proposals with tone controls</span>
                </li>
                <li className="flex items-center gap-2 text-foreground font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>Downloadable Application Kits (.txt & print-to-PDF)</span>
                </li>
              </ul>

              <button
                type="button"
                onClick={handleUpgradeToPro}
                disabled={isUpgrading}
                className="w-full mt-4 flex items-center justify-center gap-2 rounded-xl bg-primary py-3 text-xs font-bold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                <span>{profile.planTier === 'pro' ? 'Manage Billing' : 'Upgrade to Pro'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex-1 flex items-center justify-center p-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}

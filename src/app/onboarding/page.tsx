'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Plus,
  X,
  Briefcase,
  Target,
  FileText,
  UploadCloud,
  Check,
  ShieldCheck,
} from 'lucide-react';
import { localStore } from '@/lib/db/mock-seed';
import { parseResumeWithGemini } from '@/lib/ai/resume';
import { analyzeResumeWithAI } from '@/lib/ai/resume-intelligence';
import { ResumeIntelligenceDashboard } from '@/components/onboarding/resume-intelligence-dashboard';
import { EmploymentType, ProfileStrengthAnalysis, AIUncertaintyItem } from '@/types/byn';
import {
  OnboardingPayload,
  validateOnboardingPayload,
  YearsOfExperience,
  WorkPreference,
} from '@/lib/onboarding/contract';

export default function OnboardingPage() {
  const [step, setStep] = useState(1);

  // Step 1: Intent
  const [employmentTypes, setEmploymentTypes] = useState<EmploymentType[]>([
    'Full-time',
    'Contract',
  ]);

  // Step 2: Roles
  const [targetRoles, setTargetRoles] = useState<string[]>([
    'Full Stack Engineer',
    'Frontend Engineer',
  ]);
  const [customRole, setCustomRole] = useState('');

  // Step 3: Skills
  const [skills, setSkills] = useState<string[]>([
    'React',
    'TypeScript',
    'Next.js',
    'Node.js',
    'PostgreSQL',
  ]);
  const [customSkill, setCustomSkill] = useState('');

  // Step 4: Experience
  const [yearsOfExperience, setYearsOfExperience] = useState<'0-1' | '2-3' | '4-6' | '7-10' | '10+'>('4-6');

  // Step 5: Location
  const [workPreference, setWorkPreference] = useState<'worldwide' | 'my_country' | 'selected_countries'>('worldwide');
  const [currentCountry, setCurrentCountry] = useState('Worldwide');
  const [currentTimezone, setCurrentTimezone] = useState('UTC');
  const [willingTimezones, setWillingTimezones] = useState<string[]>(['UTC', 'EST', 'PST']);

  // Step 6: Resume
  const [resumeText, setResumeText] = useState(
    `Alex Chen - Senior Full Stack Engineer
Experience:
Senior Software Engineer at TechFlow Cloud (2022 - Present)
- Architected high-concurrency web applications with Next.js App Router and TypeScript.
- Scaled distributed Postgres database supporting 200k+ monthly active users.
- Collaborated across distributed teams using async git-driven workflows.

Frontend Engineer at PixelCraft Studio (2020 - 2022)
- Built modern client platforms in React, Tailwind CSS, and Node.js.
- Developed component systems in Figma and React for 15+ web applications.`
  );
  const [isParsing, setIsParsing] = useState(false);
  const [fullName, setFullName] = useState('Alex Chen');
  const [headline, setHeadline] = useState('Senior Full Stack Engineer');
  const [hasParsed, setHasParsed] = useState(false);

  // Resume Intelligence Analysis State
  const [intelligenceAnalysis, setIntelligenceAnalysis] = useState<ProfileStrengthAnalysis | null>(null);

  // AFC: onboarding is persisted to the DB (complete_onboarding RPC) before the
  // feed is reachable. These track that final submit.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Prefill from the server for a returning, not-yet-onboarded user (e.g. they
  // started onboarding, closed the tab, came back). No-op for a brand-new user.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/onboarding', { cache: 'no-store' });
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        if (d.fullName) setFullName(d.fullName);
        if (d.headline) setHeadline(d.headline);
        if (typeof d.rawResumeText === 'string' && d.rawResumeText) setResumeText(d.rawResumeText);
        if (Array.isArray(d.employmentTypes) && d.employmentTypes.length) setEmploymentTypes(d.employmentTypes);
        if (Array.isArray(d.targetRoles) && d.targetRoles.length) setTargetRoles(d.targetRoles);
        if (Array.isArray(d.skills) && d.skills.length) {
          setSkills(d.skills.map((s: { name: string }) => s.name));
        }
        if (['0-1', '2-3', '4-6', '7-10', '10+'].includes(d.yearsOfExperience)) {
          setYearsOfExperience(d.yearsOfExperience);
        }
        if (['worldwide', 'my_country', 'selected_countries'].includes(d.workPreference)) {
          setWorkPreference(d.workPreference);
        }
        if (d.currentCountry) setCurrentCountry(d.currentCountry);
        if (d.currentTimezone) setCurrentTimezone(d.currentTimezone);
        if (Array.isArray(d.willingTimezones) && d.willingTimezones.length) {
          setWillingTimezones(d.willingTimezones);
        }
      } catch {
        /* best-effort prefill */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleEmploymentType = (type: EmploymentType) => {
    if (employmentTypes.includes(type)) {
      if (employmentTypes.length > 1) {
        setEmploymentTypes(employmentTypes.filter((t) => t !== type));
      }
    } else {
      setEmploymentTypes([...employmentTypes, type]);
    }
  };

  const addCustomRole = () => {
    if (customRole.trim() && !targetRoles.includes(customRole.trim())) {
      setTargetRoles([...targetRoles, customRole.trim()]);
      setCustomRole('');
    }
  };

  const addCustomSkill = () => {
    if (customSkill.trim() && !skills.includes(customSkill.trim())) {
      setSkills([...skills, customSkill.trim()]);
      setCustomSkill('');
    }
  };

  // Run 5-Dimension Intelligence Analysis
  const handleAnalyzeIntelligence = async () => {
    setIsParsing(true);
    const mockProfile = {
      ...localStore.getProfile(),
      fullName,
      headline,
      skills: skills.map((s, idx) => ({
        id: `s-${idx}`,
        profileId: 'demo-user-1',
        skillName: s,
        isPrimary: idx < 4,
      })),
      intent: {
        id: 'intent-temp',
        profileId: 'demo-user-1',
        employmentTypes,
        targetRoles,
        yearsOfExperience,
        preferredCurrency: 'USD',
        availabilityStatus: 'immediately',
        updatedAt: new Date().toISOString(),
      },
    };

    const analysis = await analyzeResumeWithAI(mockProfile, resumeText);
    setIntelligenceAnalysis(analysis);
    setIsParsing(false);
    setStep(7); // Move to Intelligence Dashboard view
  };

  const handleResolveUncertainty = (
    item: AIUncertaintyItem,
    resolution: 'added' | 'not_relevant' | 'no',
    whereUsed?: string
  ) => {
    if (resolution === 'added') {
      setSkills((prev) =>
        prev.includes(item.skill) ? prev : [...prev, item.skill]
      );
      localStore.updateProfile({
        skills: localStore.getProfile().skills.map((s) =>
          s.skillName.toLowerCase() === item.skill.toLowerCase()
            ? { ...s, evidenceLevel: 'strong', whereUsed }
            : s
        ),
      });
    } else if (resolution === 'no') {
      setSkills((prev) => prev.filter((s) => s.toLowerCase() !== item.skill.toLowerCase()));
      localStore.updateProfile({
        skills: localStore.getProfile().skills.filter(
          (s) => s.skillName.toLowerCase() !== item.skill.toLowerCase()
        ),
      });
    }
  };

  // Persist onboarding to the DB (server-authoritative), then redirect to Feed
  // with a full-document navigation (see the window.location.replace below).
  // The localStore write is a client echo so the feed (decision 7a — still
  // localStore-backed) reflects the new profile immediately.
  const handleFinalFinish = async (improvedScore?: number) => {
    const finalScore = improvedScore || intelligenceAnalysis?.overallScore || 78;

    const payload: OnboardingPayload = {
      fullName,
      headline,
      employmentTypes,
      targetRoles,
      yearsOfExperience: yearsOfExperience as YearsOfExperience,
      preferredCurrency: 'USD',
      skills: skills.map((s, idx) => ({ name: s, isPrimary: idx < 4 })),
      workPreference: workPreference as WorkPreference,
      currentCountry,
      currentTimezone,
      allowedCountries: workPreference === 'worldwide' ? ['Worldwide'] : [currentCountry],
      willingTimezones,
      rawResumeText: resumeText,
    };

    const clientErrors = validateOnboardingPayload(payload);
    if (clientErrors.length > 0) {
      setSubmitError(clientErrors[0].message);
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        const fieldMsg = Array.isArray((body as { fields?: { message?: string }[] }).fields)
          ? (body as { fields: { message?: string }[] }).fields[0]?.message
          : undefined;
        setSubmitError(fieldMsg || (body as { error?: string }).error || 'Could not save your profile. Please try again.');
        setIsSubmitting(false);
        return;
      }
    } catch {
      setSubmitError('Could not reach the server. Please try again.');
      setIsSubmitting(false);
      return;
    }

    localStore.updateProfile({
      fullName,
      headline,
      rawResumeText: resumeText,
      profileStrength: finalScore,
      intent: {
        id: 'intent-user',
        profileId: localStore.getProfile().id,
        employmentTypes,
        targetRoles,
        yearsOfExperience,
        preferredCurrency: 'USD',
        availabilityStatus: 'immediately',
        updatedAt: new Date().toISOString(),
      },
      skills: skills.map((s, idx) => {
        const hasEvidence = resumeText.toLowerCase().includes(s.toLowerCase());
        return {
          id: `s-${idx}`,
          profileId: localStore.getProfile().id,
          skillName: s,
          yearsUsed: 3,
          isPrimary: idx < 4,
          evidenceLevel: hasEvidence ? 'strong' : 'missing',
        };
      }),
      location: {
        id: 'loc-user',
        profileId: localStore.getProfile().id,
        currentCountry,
        currentTimezone,
        workPreference,
        allowedCountries: workPreference === 'worldwide' ? ['Worldwide'] : [currentCountry],
        willingTimezones,
      },
    });

    // Full-document navigation, NOT router.push: onboarding_completed_at is
    // committed by the RPC above, but middleware's onboarding-state check for
    // /feed reads it server-side on a fresh request. A client push can serve
    // a stale Router Cache entry for /feed (cached while still un-onboarded,
    // i.e. its own redirect back to /onboarding) and strand the user here.
    // `replace` so Back doesn't return to the spent review screen.
    window.location.replace('/feed');
  };

  const popularRoles = [
    'Software Engineer',
    'Frontend Engineer',
    'Full Stack Engineer',
    'Backend Engineer',
    'Product Manager',
    'Product Designer',
    'DevOps / SRE',
    'Data Engineer',
    'AI / ML Engineer',
    'Growth & Marketing',
  ];

  const popularSkills = [
    'React',
    'TypeScript',
    'Next.js',
    'Node.js',
    'Python',
    'PostgreSQL',
    'Go',
    'Docker',
    'Kubernetes',
    'Figma',
    'GraphQL',
    'AWS',
    'Tailwind CSS',
    'PyTorch',
    'LLMs',
  ];

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--ink)] py-10 px-4 sm:px-6">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm font-medium text-[var(--muted)] hover:text-[var(--ink)] transition-colors inline-block">
          ← Back to overview
        </Link>

        {/* Header & Step Tracker */}
        <div className="mt-6 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-[var(--red)]">Profile Setup</p>
            <p className="mt-0.5 text-sm text-[var(--muted)]">One decision at a time</p>
          </div>
          <span className="font-mono text-sm text-[var(--muted)]">
            {step === 7 ? 'Review' : `Stage ${step} / 6`}
          </span>
        </div>

        {/* 6-step progress bar */}
        <div className="mt-4 flex gap-2">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <span
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-colors ${
                i <= step ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
              }`}
            />
          ))}
        </div>

        {step === 7 && intelligenceAnalysis ? (
          <div className="mt-8">
            <ResumeIntelligenceDashboard
              analysis={intelligenceAnalysis}
              onResolveUncertainty={handleResolveUncertainty}
              onContinue={handleFinalFinish}
              isSubmitting={isSubmitting}
              submitError={submitError}
            />
          </div>
        ) : (
          <section className="soft-card mt-8 p-6 sm:p-8 space-y-6">
            {/* STEP 1: INTENT */}
            {step === 1 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 01 · Intent</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    What employment arrangements are acceptable?
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    We&apos;ll only show you jobs that match these criteria.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {(['Full-time', 'Contract', 'Freelance', 'Part-time'] as EmploymentType[]).map((type) => {
                    const isSelected = employmentTypes.includes(type);
                    return (
                      <button
                        type="button"
                        key={type}
                        onClick={() => toggleEmploymentType(type)}
                        className={`rounded-2xl border p-4 text-left transition-all flex items-center justify-between ${
                          isSelected
                            ? 'border-[var(--red)] bg-[var(--red-soft)]'
                            : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <Briefcase className={`size-4 ${isSelected ? 'text-[var(--red)]' : 'text-[var(--muted)]'}`} />
                          <span className="font-semibold text-sm text-[var(--ink)]">{type}</span>
                        </div>
                        {isSelected && <CheckCircle2 className="size-4 text-[var(--red)]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* STEP 2: ROLES */}
            {step === 2 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 02 · Target Roles</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    What titles match your capability and intent?
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Roles are matched via semantic taxonomy rather than raw keyword hits.
                  </p>
                </div>

                {/* Selected Roles */}
                <div className="flex flex-wrap gap-2">
                  {targetRoles.map((role) => (
                    <span
                      key={role}
                      className="tag !bg-[var(--red-soft)] !text-[var(--red)] !border-[var(--red-soft-border)] inline-flex items-center gap-1.5"
                    >
                      <span>{role}</span>
                      <button
                        type="button"
                        onClick={() => setTargetRoles(targetRoles.filter((r) => r !== role))}
                        className="hover:opacity-75"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Custom Role Input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customRole}
                    onChange={(e) => setCustomRole(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomRole()}
                    placeholder="Add custom role title (e.g. Founding Engineer)..."
                    className="soft-input flex-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCustomRole}
                    className="soft-button secondary flex items-center gap-1.5"
                  >
                    <Plus className="size-3.5" />
                    <span>Add</span>
                  </button>
                </div>

                {/* Suggestions */}
                <div>
                  <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-2.5">
                    Common Roles
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {popularRoles.map((role) => {
                      const isSelected = targetRoles.includes(role);
                      return (
                        <button
                          key={role}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setTargetRoles(targetRoles.filter((r) => r !== role));
                            } else {
                              setTargetRoles([...targetRoles, role]);
                            }
                          }}
                          className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                            isSelected
                              ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)]'
                              : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                          }`}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 3: SKILLS */}
            {step === 3 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 03 · Core Capabilities</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    What are your proven technical skills?
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    We&apos;ll check which skills are backed by your resume.
                  </p>
                </div>

                {/* Selected Skills */}
                <div className="flex flex-wrap gap-2">
                  {skills.map((skill) => (
                    <span
                      key={skill}
                      className="tag !bg-[var(--red-soft)] !text-[var(--red)] !border-[var(--red-soft-border)] inline-flex items-center gap-1.5"
                    >
                      <span>{skill}</span>
                      <button
                        type="button"
                        onClick={() => setSkills(skills.filter((s) => s !== skill))}
                        className="hover:opacity-75"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>

                {/* Custom Skill Input */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={customSkill}
                    onChange={(e) => setCustomSkill(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addCustomSkill()}
                    placeholder="Add skill or technology (e.g. Distributed SQL, Kafka)..."
                    className="soft-input flex-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={addCustomSkill}
                    className="soft-button secondary flex items-center gap-1.5"
                  >
                    <Plus className="size-3.5" />
                    <span>Add</span>
                  </button>
                </div>

                {/* Suggestions */}
                <div>
                  <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider mb-2.5">
                    Industry Benchmarks
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {popularSkills.map((sk) => {
                      const isSelected = skills.includes(sk);
                      return (
                        <button
                          key={sk}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setSkills(skills.filter((s) => s !== sk));
                            } else {
                              setSkills([...skills, sk]);
                            }
                          }}
                          className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                            isSelected
                              ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)]'
                              : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                          }`}
                        >
                          {sk}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 4: EXPERIENCE */}
            {step === 4 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 04 · Seniority</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    Years of relevant professional experience?
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Helps us match you with the right level of roles.
                  </p>
                </div>

                <div className="space-y-2.5">
                  {(['0-1', '2-3', '4-6', '7-10', '10+'] as const).map((tier) => {
                    const isSelected = yearsOfExperience === tier;
                    const labels: Record<string, string> = {
                      '0-1': '0–1 years (Entry / Junior tier)',
                      '2-3': '2–3 years (Mid-level tier)',
                      '4-6': '4–6 years (Senior engineer tier)',
                      '7-10': '7–10 years (Lead / Staff architect tier)',
                      '10+': '10+ years (Principal / Engineering Director tier)',
                    };
                    return (
                      <button
                        type="button"
                        key={tier}
                        onClick={() => setYearsOfExperience(tier)}
                        className={`w-full rounded-2xl border p-4 text-left transition-all flex items-center justify-between ${
                          isSelected
                            ? 'border-[var(--red)] bg-[var(--red-soft)]'
                            : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]'
                        }`}
                      >
                        <span className="font-semibold text-sm text-[var(--ink)]">
                          {labels[tier]}
                        </span>
                        {isSelected && <CheckCircle2 className="size-4 text-[var(--red)]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* STEP 5: LOCATION & TIMEZONE */}
            {step === 5 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 05 · Geography & Eligibility</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    Remote Residency & Working Hours
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    We&apos;ll verify you&apos;re eligible based on employer location requirements.
                  </p>
                </div>

                {/* Where can you work? */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block">
                    Residency Scope
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {[
                      { id: 'worldwide', label: 'Worldwide' },
                      { id: 'my_country', label: 'My country only' },
                      { id: 'selected_countries', label: 'Selected countries' },
                    ].map((scope) => (
                      <button
                        key={scope.id}
                        type="button"
                        onClick={() => setWorkPreference(scope.id as any)}
                        className={`rounded-2xl border p-3 text-xs font-semibold transition-all text-center ${
                          workPreference === scope.id
                            ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)]'
                            : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                        }`}
                      >
                        {scope.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Current Country & Timezone */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block mb-1.5">
                      Current Residency Country
                    </label>
                    <input
                      type="text"
                      value={currentCountry}
                      onChange={(e) => setCurrentCountry(e.target.value)}
                      placeholder="e.g. India, United States, Germany"
                      className="soft-input w-full text-sm"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block mb-1.5">
                      Primary Timezone
                    </label>
                    <input
                      type="text"
                      value={currentTimezone}
                      onChange={(e) => setCurrentTimezone(e.target.value)}
                      placeholder="e.g. UTC, EST, CET, IST"
                      className="soft-input w-full text-sm"
                    />
                  </div>
                </div>

                {/* Timezone overlap willingness */}
                <div>
                  <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block mb-2">
                    Acceptable Overlap Bands
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {['UTC', 'US EST', 'US PST', 'Europe CET', 'Asia IST'].map((tz) => {
                      const isSelected = willingTimezones.includes(tz);
                      return (
                        <button
                          key={tz}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              setWillingTimezones(willingTimezones.filter((t) => t !== tz));
                            } else {
                              setWillingTimezones([...willingTimezones, tz]);
                            }
                          }}
                          className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${
                            isSelected
                              ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)]'
                              : 'border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)]'
                          }`}
                        >
                          {tz}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* STEP 6: RESUME UPLOAD & EXTRACTION */}
            {step === 6 && (
              <div className="space-y-6">
                <div>
                  <span className="tag">Stage 06 · Resume & History</span>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">
                    Resume & Career History
                  </h1>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    We&apos;ll review your experience and highlight your strengths.
                  </p>
                </div>

                {/* Paste Experience Area */}
                <div className="space-y-2">
                  <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block">
                    Resume Content
                  </label>
                  <textarea
                    value={resumeText}
                    onChange={(e) => setResumeText(e.target.value)}
                    placeholder="Paste your resume, past roles, bullet points, tech stack, and achievements..."
                    rows={8}
                    className="w-full rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 text-xs font-mono text-[var(--ink)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--red)] resize-none leading-relaxed"
                  />
                </div>

                {/* Editable Confirmation Box */}
                <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3">
                  <span className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block">
                    Identity Confirmation
                  </span>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-[var(--muted)] block mb-1">
                        Full Name
                      </label>
                      <input
                        type="text"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        className="soft-input w-full text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--muted)] block mb-1">
                        Headline
                      </label>
                      <input
                        type="text"
                        value={headline}
                        onChange={(e) => setHeadline(e.target.value)}
                        className="soft-input w-full text-xs"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Navigation Buttons */}
            <div className="flex items-center justify-between pt-6 border-t border-[var(--line)] mt-8">
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => setStep(step - 1)}
                  className="soft-button secondary flex items-center gap-2"
                >
                  <ArrowLeft className="size-3.5" />
                  <span>Previous</span>
                </button>
              ) : (
                <div />
              )}

              {step < 6 ? (
                <button
                  type="button"
                  onClick={() => setStep(step + 1)}
                  className="soft-button primary flex items-center gap-2"
                >
                  <span>Continue</span>
                  <ArrowRight className="size-3.5" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleAnalyzeIntelligence}
                  disabled={isParsing || !resumeText.trim()}
                  className="soft-button primary flex items-center gap-2 disabled:opacity-50"
                >
                  <ShieldCheck className="size-4" />
                  <span>{isParsing ? 'Analyzing profile...' : 'Analyze my profile'}</span>
                </button>
              )}
            </div>
          </section>
        )}

        {/* Reassurance Footer */}
        <p className="mt-8 flex items-center justify-center gap-2 text-xs text-[var(--muted)]">
          <Check size={14} className="text-[#059669]" />
          <span>No achievements or claims are invented when details are missing.</span>
        </p>
      </div>
    </main>
  );
}

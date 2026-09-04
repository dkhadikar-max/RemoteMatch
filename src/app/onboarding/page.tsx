'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Plus,
  X,
  Briefcase,
} from 'lucide-react';
import { localStore } from '@/lib/db/mock-seed';
import { parseResumeWithGemini } from '@/lib/ai/resume';
import { analyzeResumeWithAI } from '@/lib/ai/resume-intelligence';
import { ResumeIntelligenceDashboard } from '@/components/onboarding/resume-intelligence-dashboard';
import { EmploymentType, ProfileStrengthAnalysis, AIUncertaintyItem } from '@/types/byn';

export default function OnboardingPage() {
  const router = useRouter();
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
  const [headline, setHeadline] = useState('Senior Full Stack & AI Engineer');
  const [hasParsed, setHasParsed] = useState(false);

  // Resume Intelligence Analysis State
  const [intelligenceAnalysis, setIntelligenceAnalysis] = useState<ProfileStrengthAnalysis | null>(null);

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

  // Parse Resume trigger
  const handleParseResume = async () => {
    if (!resumeText.trim()) return;
    setIsParsing(true);
    try {
      const extracted = await parseResumeWithGemini(resumeText);
      if (extracted.fullName) setFullName(extracted.fullName);
      if (extracted.headline) setHeadline(extracted.headline);
      if (extracted.skills && extracted.skills.length > 0) {
        setSkills(Array.from(new Set([...skills, ...extracted.skills])));
      }
      if (extracted.targetRoles && extracted.targetRoles.length > 0) {
        setTargetRoles(Array.from(new Set([...targetRoles, ...extracted.targetRoles])));
      }
      if (extracted.yearsOfExperience) {
        setYearsOfExperience(extracted.yearsOfExperience);
      }
      setHasParsed(true);
    } catch (err) {
      console.error('Resume parsing failed:', err);
    } finally {
      setIsParsing(false);
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
      // Elevate skill with whereUsed note in component state & store
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
      // Remove from profile in state & store
      setSkills((prev) => prev.filter((s) => s.toLowerCase() !== item.skill.toLowerCase()));
      localStore.updateProfile({
        skills: localStore.getProfile().skills.filter(
          (s) => s.skillName.toLowerCase() !== item.skill.toLowerCase()
        ),
      });
    }
  };

  // Save everything and redirect to Feed
  const handleFinalFinish = (improvedScore?: number) => {
    const finalScore = improvedScore || intelligenceAnalysis?.overallScore || 78;
    localStore.updateProfile({
      fullName,
      headline,
      rawResumeText: resumeText,
      profileStrength: finalScore,
      intent: {
        id: 'intent-user',
        profileId: 'demo-user-1',
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
          profileId: 'demo-user-1',
          skillName: s,
          yearsUsed: 3,
          isPrimary: idx < 4,
          evidenceLevel: hasEvidence ? 'strong' : 'missing',
        };
      }),
      location: {
        id: 'loc-user',
        profileId: 'demo-user-1',
        currentCountry,
        currentTimezone,
        workPreference,
        allowedCountries: workPreference === 'worldwide' ? ['Worldwide'] : [currentCountry],
        willingTimezones,
      },
    });

    router.push('/feed');
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
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
      {/* Progress Bar & Steps indicator */}
      <div className="mb-8">
        <div className="flex items-center justify-between text-xs font-semibold text-muted-foreground mb-2">
          <span>{step === 7 ? 'RESUME INTELLIGENCE' : `STEP ${step} OF 6`}</span>
          <span>
            {step === 1
              ? 'Intent'
              : step === 2
              ? 'Roles'
              : step === 3
              ? 'Skills'
              : step === 4
              ? 'Experience'
              : step === 5
              ? 'Location & Timezone'
              : step === 6
              ? 'Resume Upload'
              : 'Profile Strength & Suggestions'}
          </span>
        </div>
        <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${(Math.min(step, 6) / 6) * 100}%` }}
          />
        </div>
      </div>

      {step === 7 && intelligenceAnalysis ? (
        <ResumeIntelligenceDashboard
          analysis={intelligenceAnalysis}
          onResolveUncertainty={handleResolveUncertainty}
          onContinue={handleFinalFinish}
        />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-xl">
          {/* STEP 1: INTENT */}
          {step === 1 && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  What are you looking for?
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Select all employment types that interest you. RemoteMatch will filter out mismatched listings.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(['Full-time', 'Contract', 'Freelance', 'Part-time'] as EmploymentType[]).map((type) => {
                  const isSelected = employmentTypes.includes(type);
                  return (
                    <div
                      key={type}
                      onClick={() => toggleEmploymentType(type)}
                      className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${
                        isSelected
                          ? 'border-emerald-500 bg-emerald-500/10 shadow-sm'
                          : 'border-border bg-secondary/40 hover:bg-secondary'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Briefcase className={`h-5 w-5 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        <span className="font-semibold text-sm text-foreground">{type}</span>
                      </div>
                      {isSelected && <CheckCircle2 className="h-5 w-5 text-primary" />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 2: ROLES */}
          {step === 2 && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  What roles are you targeting?
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Select your preferred job titles or add custom ones.
                </p>
              </div>

              {/* Selected Roles */}
              <div className="flex flex-wrap gap-2">
                {targetRoles.map((role) => (
                  <span
                    key={role}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary"
                  >
                    <span>{role}</span>
                    <button
                      type="button"
                      onClick={() => setTargetRoles(targetRoles.filter((r) => r !== role))}
                      className="hover:opacity-75"
                    >
                      <X className="h-3.5 w-3.5" />
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
                  className="flex-1 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={addCustomRole}
                  className="flex items-center gap-1 rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-foreground border border-border hover:bg-secondary/80"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add</span>
                </button>
              </div>

              {/* Suggestions */}
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                  Popular Roles
                </span>
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
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors border ${
                          isSelected
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
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
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  What are your core skills?
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Our Resume Intelligence engine will cross-check these against your resume for evidence levels.
                </p>
              </div>

              {/* Selected Skills */}
              <div className="flex flex-wrap gap-2">
                {skills.map((skill) => (
                  <span
                    key={skill}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-primary/10 border border-primary/30 px-3 py-1.5 text-xs font-semibold text-primary"
                  >
                    <span>{skill}</span>
                    <button
                      type="button"
                      onClick={() => setSkills(skills.filter((s) => s !== skill))}
                      className="hover:opacity-75"
                    >
                      <X className="h-3.5 w-3.5" />
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
                  placeholder="Add skill or tool (e.g. Tailwind, Kafka, Snowflake)..."
                  className="flex-1 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                />
                <button
                  type="button"
                  onClick={addCustomSkill}
                  className="flex items-center gap-1 rounded-xl bg-secondary px-3 py-2 text-xs font-semibold text-foreground border border-border hover:bg-secondary/80"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add</span>
                </button>
              </div>

              {/* Suggestions */}
              <div>
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                  Common Tech & Tools
                </span>
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
                        className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors border ${
                          isSelected
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
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
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  Years of professional experience?
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Used to evaluate seniority requirements and salary benchmarks.
                </p>
              </div>

              <div className="space-y-2.5">
                {(['0-1', '2-3', '4-6', '7-10', '10+'] as const).map((tier) => {
                  const isSelected = yearsOfExperience === tier;
                  const labels: Record<string, string> = {
                    '0-1': '0–1 years (Entry / Junior)',
                    '2-3': '2–3 years (Mid-level)',
                    '4-6': '4–6 years (Senior)',
                    '7-10': '7–10 years (Lead / Staff)',
                    '10+': '10+ years (Principal / Director)',
                  };
                  return (
                    <div
                      key={tier}
                      onClick={() => setYearsOfExperience(tier)}
                      className={`flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${
                        isSelected
                          ? 'border-emerald-500 bg-emerald-500/10 shadow-sm'
                          : 'border-border bg-secondary/40 hover:bg-secondary'
                      }`}
                    >
                      <span className="font-semibold text-sm text-foreground">
                        {labels[tier]}
                      </span>
                      {isSelected && <CheckCircle2 className="h-5 w-5 text-primary" />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* STEP 5: LOCATION & TIMEZONE */}
          {step === 5 && (
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  Location & Remote Scope
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Enforces the hard eligibility gate so you never waste time on restricted positions.
                </p>
              </div>

              {/* Where can you work? */}
              <div className="space-y-3">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                  Where can you work?
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
                      className={`p-3 rounded-xl border text-xs font-semibold transition-all ${
                        workPreference === scope.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border bg-secondary/40 text-muted-foreground hover:text-foreground'
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
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                    Current Country
                  </label>
                  <input
                    type="text"
                    value={currentCountry}
                    onChange={(e) => setCurrentCountry(e.target.value)}
                    placeholder="e.g. India, United States, Germany, Worldwide"
                    className="w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
                    Current Timezone
                  </label>
                  <input
                    type="text"
                    value={currentTimezone}
                    onChange={(e) => setCurrentTimezone(e.target.value)}
                    placeholder="e.g. UTC, EST, CET, IST"
                    className="w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
                  />
                </div>
              </div>

              {/* Timezone overlap willingness */}
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block mb-2">
                  Willing to overlap with specific timezones?
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
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors border ${
                          isSelected
                            ? 'border-primary bg-primary/15 text-primary'
                            : 'border-border bg-secondary/50 text-muted-foreground hover:text-foreground'
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
            <div className="space-y-6 animate-in fade-in duration-200">
              <div>
                <h2 className="text-2xl font-bold text-foreground">
                  Resume & Experience Text
                </h2>
                <p className="text-xs sm:text-sm text-muted-foreground mt-1">
                  Paste your resume text below. Our AI will analyze your Profile Strength, check skill evidence, and generate personalized suggestions.
                </p>
              </div>

              {/* Paste Experience Area */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">
                  Resume Content
                </label>
                <textarea
                  value={resumeText}
                  onChange={(e) => setResumeText(e.target.value)}
                  placeholder="Paste work experience, past roles, bullet points, tech stack, and achievements..."
                  rows={7}
                  className="w-full rounded-xl border border-border bg-secondary/30 p-3.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary resize-none font-mono leading-relaxed"
                />
              </div>

              {/* Editable Confirmation Box */}
              <div className="p-4 rounded-xl border border-border bg-secondary/20 space-y-3">
                <span className="text-xs font-bold text-primary uppercase tracking-wider block">
                  Identity Confirmation
                </span>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="w-full rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-muted-foreground block mb-1">
                      Headline
                    </label>
                    <input
                      type="text"
                      value={headline}
                      onChange={(e) => setHeadline(e.target.value)}
                      className="w-full rounded-lg border border-border bg-secondary/40 px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex items-center justify-between pt-6 border-t border-border mt-8">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-4 py-2.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>Back</span>
              </button>
            ) : (
              <div />
            )}

            {step < 6 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-5 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-all"
              >
                <span>Continue</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleAnalyzeIntelligence}
                disabled={isParsing || !resumeText.trim()}
                className="flex items-center gap-1.5 rounded-xl bg-primary px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-600 disabled:opacity-50 transition-all"
              >
                <Sparkles className="h-4 w-4" />
                <span>{isParsing ? 'Analyzing Resume Intelligence...' : 'Analyze Profile Strength'}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

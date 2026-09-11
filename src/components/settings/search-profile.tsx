'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Save, CheckCircle2, Plus, X } from 'lucide-react';
import type { ServerOnboarding } from '@/lib/profile/hydrate';
import type { EmploymentType } from '@/types/byn';

const EMPLOYMENT_TYPES: EmploymentType[] = ['Full-time', 'Contract', 'Freelance', 'Part-time'];
const YEARS_OF_EXPERIENCE = ['0-1', '2-3', '4-6', '7-10', '10+'] as const;
const WORK_PREFERENCES: { value: 'worldwide' | 'my_country' | 'selected_countries'; label: string }[] = [
  { value: 'worldwide', label: 'Worldwide' },
  { value: 'my_country', label: 'My country only' },
  { value: 'selected_countries', label: 'Selected countries' },
];

interface CareerDirectionProps {
  careerDirection: 'continue' | 'change_fields';
  savingDirection: 'continue' | 'change_fields' | null;
  directionError: string | null;
  onSetCareerDirection: (next: 'continue' | 'change_fields') => void;
}

interface Props extends CareerDirectionProps {
  srv: ServerOnboarding | null;
  loading: boolean;
  /** The parent's refreshServer() — re-fetches /api/onboarding + /api/profile
   *  and hands this component back a fresh ServerOnboarding via the `srv` prop.
   *  This component never maintains its own copy of server truth. */
  onSaved: () => Promise<ServerOnboarding | null>;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

const chipBase =
  'px-3 py-1.5 rounded-xl text-xs font-medium transition-colors border';
const chipOn = 'bg-[var(--red)] text-white border-[var(--red)] shadow-sm';
const chipOff =
  'bg-[var(--surface)] border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]';

/**
 * J — Unified Search Profile ("Search profile"). Settings → Preferences.
 *
 * Server-authoritative: every field here is seeded from `srv` (the same
 * GET /api/onboarding snapshot Settings already fetches — no second read, no
 * second store) and saved via POST /api/profile/search-preferences ->
 * update_search_preferences() (migration 017). Only fields the user actually
 * changed are sent; `srv` is the single source of truth this component
 * compares against and reseeds from after every save.
 *
 * Skills are deliberately NOT editable here — they stay exclusively behind
 * onboarding + the "Grow your matches" add flow (profile_skills /
 * add_profile_skill), so there is never a second skills-write surface.
 */
export function SearchProfile({
  srv,
  loading,
  onSaved,
  careerDirection,
  savingDirection,
  directionError,
  onSetCareerDirection,
}: Props) {
  const [targetRoles, setTargetRoles] = useState<string[]>([]);
  const [roleInput, setRoleInput] = useState('');
  const [employmentTypes, setEmploymentTypes] = useState<EmploymentType[]>([]);
  const [workPreference, setWorkPreference] = useState<'worldwide' | 'my_country' | 'selected_countries'>('worldwide');
  const [currentCountry, setCurrentCountry] = useState('');
  const [minSalaryInput, setMinSalaryInput] = useState('');
  const [yearsOfExperience, setYearsOfExperience] = useState<(typeof YEARS_OF_EXPERIENCE)[number] | ''>('');

  const dirtyRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed (and RE-seed after a successful save) from the server snapshot —
  // never while the user has an unsaved edit in flight.
  useEffect(() => {
    if (!srv || dirtyRef.current) return;
    setTargetRoles(srv.targetRoles ?? []);
    setEmploymentTypes((srv.employmentTypes as EmploymentType[]) ?? []);
    setWorkPreference(
      srv.workPreference === 'my_country' || srv.workPreference === 'selected_countries'
        ? srv.workPreference
        : 'worldwide',
    );
    setCurrentCountry(srv.currentCountry ?? '');
    setMinSalaryInput(srv.minSalary ? String(srv.minSalary) : '');
    setYearsOfExperience(
      (YEARS_OF_EXPERIENCE as readonly string[]).includes(srv.yearsOfExperience ?? '')
        ? (srv.yearsOfExperience as (typeof YEARS_OF_EXPERIENCE)[number])
        : '',
    );
  }, [srv]);

  const markDirty = () => {
    dirtyRef.current = true;
    setSaved(false);
  };

  const addRole = () => {
    const v = roleInput.trim();
    if (v && !targetRoles.includes(v)) {
      setTargetRoles([...targetRoles, v]);
      markDirty();
    }
    setRoleInput('');
  };
  const removeRole = (role: string) => {
    setTargetRoles(targetRoles.filter((r) => r !== role));
    markDirty();
  };
  const toggleEmploymentType = (type: EmploymentType) => {
    if (employmentTypes.includes(type)) {
      if (employmentTypes.length > 1) setEmploymentTypes(employmentTypes.filter((t) => t !== type));
    } else {
      setEmploymentTypes([...employmentTypes, type]);
    }
    markDirty();
  };

  const handleSave = async () => {
    if (!srv) return;
    setSaveError(null);

    const payload: Record<string, unknown> = {};
    if (targetRoles.length > 0 && !arraysEqual(targetRoles, srv.targetRoles ?? [])) {
      payload.targetRoles = targetRoles;
    }
    if (employmentTypes.length > 0 && !arraysEqual(employmentTypes, srv.employmentTypes ?? [])) {
      payload.employmentTypes = employmentTypes;
    }
    if (yearsOfExperience && yearsOfExperience !== srv.yearsOfExperience) {
      payload.yearsOfExperience = yearsOfExperience;
    }
    if (workPreference !== srv.workPreference) {
      payload.workPreference = workPreference;
    }
    if (currentCountry.trim() && currentCountry.trim() !== (srv.currentCountry ?? '')) {
      payload.currentCountry = currentCountry.trim();
    }
    const salaryNum = minSalaryInput.trim() === '' ? null : Number(minSalaryInput);
    if (salaryNum !== null && Number.isFinite(salaryNum) && salaryNum !== (srv.minSalary ?? null)) {
      payload.minSalary = salaryNum;
    }

    if (Object.keys(payload).length === 0) {
      dirtyRef.current = false;
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch('/api/profile/search-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setSaveError('Could not save right now. Please try again.');
        return;
      }
      dirtyRef.current = false; // allow the next effect run to reseed from the fresh server value
      await onSaved();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      setSaveError('Could not save right now. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="soft-card p-6 sm:p-8 space-y-6 border border-[var(--line)]">
      <div>
        <h2 className="text-lg font-bold text-[var(--ink)]">Search profile</h2>
        <p className="text-xs text-[var(--muted)] mt-1">
          What RemoteMatch uses to find and score jobs for you. Saved to your account, not this device.
        </p>
      </div>

      {loading ? (
        <p className="text-xs text-[var(--muted)]">Loading…</p>
      ) : (
        <>
          {/* WHAT YOU'RE LOOKING FOR */}
          <div className="space-y-4">
            <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
              What you&rsquo;re looking for
            </h3>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--ink)]">Target roles</label>
              <div className="flex flex-wrap gap-1.5">
                {targetRoles.map((role) => (
                  <span key={role} className={`${chipBase} ${chipOn} flex items-center gap-1.5`}>
                    {role}
                    <button type="button" onClick={() => removeRole(role)} aria-label={`Remove ${role}`}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5 pt-1">
                <input
                  type="text"
                  value={roleInput}
                  onChange={(e) => setRoleInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addRole();
                    }
                  }}
                  placeholder="Add a target role"
                  className="soft-input py-1.5 px-3 text-xs flex-1"
                />
                <button
                  type="button"
                  onClick={addRole}
                  className="rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] p-2 text-[var(--ink)]"
                  aria-label="Add role"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--ink)]">Employment type</label>
              <div className="flex flex-wrap gap-1.5">
                {EMPLOYMENT_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleEmploymentType(type)}
                    className={`${chipBase} ${employmentTypes.includes(type) ? chipOn : chipOff}`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--ink)]">Work preference</label>
              <div className="flex flex-wrap gap-1.5">
                {WORK_PREFERENCES.map((wp) => (
                  <button
                    key={wp.value}
                    type="button"
                    onClick={() => {
                      setWorkPreference(wp.value);
                      markDirty();
                    }}
                    className={`${chipBase} ${workPreference === wp.value ? chipOn : chipOff}`}
                  >
                    {wp.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[var(--ink)]">Location</label>
                <input
                  type="text"
                  value={currentCountry}
                  onChange={(e) => {
                    setCurrentCountry(e.target.value);
                    markDirty();
                  }}
                  placeholder="Your current country"
                  className="soft-input py-2 px-3 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[var(--ink)]">Salary preference</label>
                <input
                  type="number"
                  min={0}
                  value={minSalaryInput}
                  onChange={(e) => {
                    setMinSalaryInput(e.target.value);
                    markDirty();
                  }}
                  placeholder="e.g. 120000"
                  className="soft-input py-2 px-3 text-xs"
                />
                <p className="text-[11px] text-[var(--muted)]">
                  What you&rsquo;re looking for — separate from the Pro discovery filters.
                </p>
              </div>
            </div>
          </div>

          {/* WHAT YOU BRING */}
          <div className="space-y-4 pt-2 border-t border-[var(--line)]">
            <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider pt-4">What you bring</h3>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--ink)]">Years of experience</label>
              <div className="flex flex-wrap gap-1.5">
                {YEARS_OF_EXPERIENCE.map((yoe) => (
                  <button
                    key={yoe}
                    type="button"
                    onClick={() => {
                      setYearsOfExperience(yoe);
                      markDirty();
                    }}
                    className={`${chipBase} ${yearsOfExperience === yoe ? chipOn : chipOff}`}
                  >
                    {yoe} yrs
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[var(--ink)]">Skills</label>
              {(srv?.skills.length ?? 0) === 0 ? (
                <p className="text-[11px] italic text-[var(--muted)]">None added yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {srv?.skills.map((s) => (
                    <span key={s.name} className="tag bg-[var(--surface-soft)] border-[var(--line)] text-[#5c5550]">
                      {s.name}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[var(--muted)]">
                Add more via &ldquo;Grow your matches&rdquo; on the Profile tab.
              </p>
            </div>
          </div>

          {/* CAREER DIRECTION — relocated here from the Profile tab (UI move
              only; same state, same set_career_direction() RPC). */}
          <div className="space-y-4 pt-2 border-t border-[var(--line)]">
            <div className="pt-4">
              <h3 className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">Career direction</h3>
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
                    onClick={() => onSetCareerDirection(value)}
                    disabled={savingDirection !== null}
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
                Your feed now also shows how your experience could transfer to roles in your target field — what
                fits, and what may be missing.
              </p>
            )}
            {directionError && <p className="text-[11px] text-[var(--red)]">{directionError}</p>}
          </div>

          <div className="pt-2 flex items-center justify-between gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-50 text-white text-xs font-semibold px-4 py-2.5 transition-colors shadow-sm flex items-center gap-1.5"
            >
              <Save size={13} />
              <span>{isSaving ? 'Saving…' : saved ? 'Saved!' : 'Save search profile'}</span>
            </button>
            {saved && (
              <span className="text-xs font-medium text-[#059669] flex items-center gap-1">
                <CheckCircle2 size={13} />
                <span>Saved to your account</span>
              </span>
            )}
            {saveError && <span className="text-xs font-medium text-[var(--red)]">{saveError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

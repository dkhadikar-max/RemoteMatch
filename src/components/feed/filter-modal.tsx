'use client';

import React, { useState, useEffect } from 'react';
import { X, Check, Lock, RotateCcw, MapPin } from 'lucide-react';
import { OpportunityFilters } from '@/types/byn';

interface FilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters: OpportunityFilters;
  onApplyFilters: (filters: OpportunityFilters) => void;
  planTier: 'free' | 'pro';
  onRequireUpgrade: (reason: 'filters') => void;
}

const ROLES = [
  'All Roles',
  'Full Stack Engineer',
  'Senior Frontend Engineer',
  'Backend Engineer',
  'DevOps / Cloud Engineer',
  'Staff Software Engineer',
];

const REMOTE_TYPES = ['All Remote', 'Worldwide', 'US', 'EU/EEA'];

const SENIORITIES = [
  'All Seniorities',
  'Entry / Junior',
  'Mid-Level (2-4 yrs)',
  'Senior (4-7 yrs)',
  'Staff / Lead (7+ yrs)',
  'Principal',
];

const SPECIFIC_LOCATIONS = [
  'Any Specific Location',
  'United States (US Only)',
  'United Kingdom',
  'Germany',
  'Canada',
  'European Union (EU/EEA)',
];

const SALARY_OPTIONS = [
  { label: 'Any Salary', value: 0 },
  { label: '$100k+ USD', value: 100000 },
  { label: '$120k+ USD', value: 120000 },
  { label: '$140k+ USD', value: 140000 },
  { label: '$160k+ USD', value: 160000 },
];

const TIMEZONES = ['Any Timezone', 'UTC / Europe', 'Americas (EST/PST)', 'APAC'];

export function FilterModal({
  isOpen,
  onClose,
  filters,
  onApplyFilters,
  planTier,
  onRequireUpgrade,
}: FilterModalProps) {
  const [draft, setDraft] = useState<OpportunityFilters>(filters);

  useEffect(() => {
    setDraft(filters);
  }, [filters, isOpen]);

  if (!isOpen) return null;

  const isPro = planTier === 'pro';

  const handleAdvancedClick = (callback: () => void) => {
    if (!isPro) {
      onRequireUpgrade('filters');
      return;
    }
    callback();
  };

  const handleReset = () => {
    const empty: OpportunityFilters = {};
    setDraft(empty);
    onApplyFilters(empty);
    onClose();
  };

  const handleSave = () => {
    onApplyFilters(draft);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-lg max-h-[90vh] rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 sm:p-7 shadow-[0_20px_50px_rgba(76,44,30,0.12)] space-y-5 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--line)] pb-3">
          <div>
            <h3 className="text-lg font-bold text-[var(--ink)]">Filter Matches</h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Basic job discovery is free. Precision targeting is Pro.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors shrink-0 ml-2"
          >
            <X size={15} />
          </button>
        </div>

        {/* Section 1: Basic Preferences (Free & Pro) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
              Basic Preferences
            </span>
            <span className="text-[11px] font-medium text-[#059669] bg-[#ecfdf5] border border-[#a7f3d0] px-2 py-0.5 rounded-full">
              Free & Pro
            </span>
          </div>

          {/* Target Role */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--ink)]">Target Role</label>
            <div className="flex flex-wrap gap-1.5">
              {ROLES.map((role) => {
                const isSelected =
                  (!draft.targetRole && role === 'All Roles') || draft.targetRole === role;
                return (
                  <button
                    key={role}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        targetRole: role === 'All Roles' ? undefined : role,
                      }))
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {role}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Remote Policy */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--ink)]">Remote Policy</label>
            <div className="flex flex-wrap gap-1.5">
              {REMOTE_TYPES.map((type) => {
                const isSelected =
                  (!draft.remoteType && type === 'All Remote') || draft.remoteType === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        remoteType: type === 'All Remote' ? undefined : type,
                      }))
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {type}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Seniority Level (Free for all users) */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[var(--ink)]">Seniority Level</label>
            <div className="flex flex-wrap gap-1.5">
              {SENIORITIES.map((lvl) => {
                const isSelected =
                  (!draft.seniority && lvl === 'All Seniorities') || draft.seniority === lvl;
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        seniority: lvl === 'All Seniorities' ? undefined : lvl,
                      }))
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {lvl}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Section 2: Precision Targeting (Pro Only) */}
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--bg)] p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider">
              Precision Targeting
            </span>
            <span className="text-[10px] font-bold text-[var(--red)] bg-[var(--red-soft)] border border-[var(--red-soft-border)] px-2 py-0.5 rounded-full flex items-center gap-1">
              {!isPro && <Lock size={10} />}
              <span>PRO</span>
            </span>
          </div>

          {/* Specific Location (Pro) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--ink)] flex items-center gap-1">
                <MapPin size={12} className="text-[var(--red)]" />
                <span>Specific Location / Jurisdiction</span>
              </label>
              {!isPro && <span className="text-[11px] text-[var(--muted)]">Pro feature</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SPECIFIC_LOCATIONS.map((loc) => {
                const isSelected =
                  (!draft.specificLocation && loc === 'Any Specific Location') ||
                  draft.specificLocation === loc;
                return (
                  <button
                    key={loc}
                    type="button"
                    onClick={() =>
                      handleAdvancedClick(() =>
                        setDraft((prev) => ({
                          ...prev,
                          specificLocation:
                            loc === 'Any Specific Location' ? undefined : loc,
                        }))
                      )
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {loc}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Minimum Salary (Pro) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--ink)]">Minimum Salary</label>
              {!isPro && <span className="text-[11px] text-[var(--muted)]">Pro feature</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SALARY_OPTIONS.map((sal) => {
                const isSelected =
                  (!draft.minSalary && sal.value === 0) || draft.minSalary === sal.value;
                return (
                  <button
                    key={sal.label}
                    type="button"
                    onClick={() =>
                      handleAdvancedClick(() =>
                        setDraft((prev) => ({
                          ...prev,
                          minSalary: sal.value === 0 ? undefined : sal.value,
                        }))
                      )
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {sal.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Strict Timezone (Pro) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-[var(--ink)]">Strict Timezone Region</label>
              {!isPro && <span className="text-[11px] text-[var(--muted)]">Pro feature</span>}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {TIMEZONES.map((tz) => {
                const isSelected =
                  (!draft.strictTimezone && tz === 'Any Timezone') || draft.strictTimezone === tz;
                return (
                  <button
                    key={tz}
                    type="button"
                    onClick={() =>
                      handleAdvancedClick(() =>
                        setDraft((prev) => ({
                          ...prev,
                          strictTimezone: tz === 'Any Timezone' ? undefined : tz,
                        }))
                      )
                    }
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                      isSelected
                        ? 'bg-[var(--red)] text-white shadow-sm'
                        : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                    }`}
                  >
                    {tz}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-2 border-t border-[var(--line)]">
          <button
            type="button"
            onClick={handleReset}
            className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] font-semibold transition-colors"
          >
            <RotateCcw size={13} />
            <span>Reset filters</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-4 py-2 text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              className="soft-button primary text-xs font-semibold px-5 py-2 min-h-[38px] flex items-center gap-1.5 shadow-sm"
            >
              <Check size={14} strokeWidth={2.5} />
              <span>Apply filters</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

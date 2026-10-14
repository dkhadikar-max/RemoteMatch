'use client';

import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, Info, Check, X } from 'lucide-react';
import type { ResumeCheck } from '@/lib/resume/resume-check';

/**
 * Onboarding review step (replaces the old "Resume Intelligence" dashboard).
 *
 * Shows ONLY facts: the user's declared profile, and a plain text search of their resume for the skills they listed.
 * No score, no "strengths", no "improvements", no "verified" language — and an explicit statement that matching uses
 * the declared profile, not the resume. See src/lib/resume/resume-check.ts.
 */
interface ResumeCheckSummaryProps {
  check: ResumeCheck;
  targetRoles: string[];
  /** The user's CURRENT declared skills (shrinks when they remove one here). */
  skills: string[];
  onRemoveSkill: (skill: string) => void;
  onBack: () => void;
  onContinue: () => void | Promise<void>;
  /** The "Enter feed" step persists onboarding to the DB first. */
  isSubmitting?: boolean;
  submitError?: string | null;
}

export function ResumeCheckSummary({
  check,
  targetRoles,
  skills,
  onRemoveSkill,
  onBack,
  onContinue,
  isSubmitting = false,
  submitError = null,
}: ResumeCheckSummaryProps) {
  // "Keep" simply dismisses the row; it changes nothing in the profile.
  const [kept, setKept] = useState<Set<string>>(new Set());
  const current = new Set(skills.map((s) => s.toLowerCase()));
  const found = check.found.filter((s) => current.has(s.toLowerCase()));
  const notFound = check.notFound.filter((s) => current.has(s.toLowerCase()));
  const undecided = notFound.filter((s) => !kept.has(s.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="soft-card p-6 sm:p-8 space-y-4">
        <span className="tag">Review</span>
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)]">Review your profile</h2>

        <div role="note" className="flex items-start gap-3 rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4">
          <Info size={18} className="mt-0.5 shrink-0 text-[var(--muted)]" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-[var(--ink)]">
            <strong>How matching works today.</strong> Your matches are based on the skills, target roles and preferences
            you entered. Your resume is saved with your profile for reference — it isn&apos;t analysed for accuracy or
            used to score jobs yet.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 pt-1">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Target roles you entered</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {targetRoles.length === 0 ? (
                <li className="text-xs text-[var(--muted)]">None</li>
              ) : (
                targetRoles.map((r) => <li key={r} className="tag">{r}</li>)
              )}
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Skills you entered ({skills.length})</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {skills.length === 0 ? (
                <li className="text-xs text-[var(--muted)]">None</li>
              ) : (
                skills.map((s) => <li key={s} className="tag">{s}</li>)
              )}
            </ul>
          </div>
        </div>
      </div>

      <div className="soft-card p-6 sm:p-8 space-y-4">
        <span className="tag">Resume text check</span>

        {check.status === 'ok' && (
          <>
            <p className="text-sm leading-relaxed text-[var(--ink)]">
              We searched your resume text ({check.wordCount.toLocaleString()} words) for the skills you listed. This is a
              plain text search — it doesn&apos;t judge your experience, its quality or how recent it is.
            </p>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                Appear in your resume text ({found.length})
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {found.length === 0 ? (
                  <li className="text-xs text-[var(--muted)]">None of the skills you listed</li>
                ) : (
                  found.map((s) => (
                    <li key={s} className="tag flex items-center gap-1">
                      <Check size={12} className="text-[#04714f]" aria-hidden="true" />
                      {s}
                    </li>
                  ))
                )}
              </ul>
            </div>

            {notFound.length > 0 && (
              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Not found in your resume text ({notFound.length})
                </p>
                <p className="text-xs leading-relaxed text-[var(--muted)]">
                  That can simply be different wording (for example &quot;JS&quot; for JavaScript). Your matches use the
                  skills you listed either way — keep or remove each one as you prefer.
                </p>
                <ul className="space-y-2">
                  {notFound.map((s) => {
                    const decided = kept.has(s.toLowerCase());
                    return (
                      <li
                        key={s}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-3"
                      >
                        <span className="text-sm font-medium text-[var(--ink)]">{s}</span>
                        {decided ? (
                          <span className="text-xs text-[var(--muted)]">Kept</span>
                        ) : (
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setKept((prev) => new Set(prev).add(s.toLowerCase()))}
                              aria-label={`Keep ${s} in my profile`}
                              className="soft-button secondary text-xs min-h-[40px]"
                            >
                              Keep
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemoveSkill(s)}
                              aria-label={`Remove ${s} from my profile`}
                              className="soft-button secondary text-xs min-h-[40px] flex items-center gap-1"
                            >
                              <X size={12} aria-hidden="true" />
                              Remove
                            </button>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {undecided.length === 0 && (
                  <p className="text-xs text-[var(--muted)]">Nothing left to review.</p>
                )}
              </div>
            )}
          </>
        )}

        {check.status === 'too_short' && (
          <p className="text-sm leading-relaxed text-[var(--ink)]">
            Your resume text is very short ({check.wordCount} {check.wordCount === 1 ? 'word' : 'words'}), so we can&apos;t
            tell whether your skills appear in it. You can go back and add more text, or continue — matching uses what you
            entered.
          </p>
        )}

        {check.status === 'empty' && (
          <p className="text-sm leading-relaxed text-[var(--ink)]">
            No resume text was provided, so there is nothing to check. You can go back to add it, or continue — matching
            uses what you entered.
          </p>
        )}

        {check.status === 'error' && (
          <p className="text-sm leading-relaxed text-[var(--ink)]">
            We couldn&apos;t check your resume text. This doesn&apos;t affect your profile — you can continue.
          </p>
        )}
      </div>

      <div className="soft-card p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <span className="tag">Next</span>
          <h3 className="mt-1.5 text-lg font-semibold text-[var(--ink)]">Save your profile and see jobs</h3>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-[var(--muted)]">
            Your profile is saved when you continue. You can change your skills, roles and preferences later in Settings.
          </p>
        </div>

        <div className="flex flex-col items-stretch gap-2 self-stretch sm:self-auto">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onBack}
              disabled={isSubmitting}
              className="soft-button secondary flex items-center justify-center gap-2 text-xs min-h-[44px] disabled:opacity-50"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              <span>Back</span>
            </button>
            <button
              type="button"
              onClick={() => onContinue()}
              disabled={isSubmitting}
              className="soft-button primary flex flex-1 items-center justify-center gap-2 whitespace-nowrap min-h-[44px] disabled:opacity-50"
            >
              <span>{isSubmitting ? 'Saving…' : 'Save profile and enter feed'}</span>
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </div>
          {submitError && (
            <p role="alert" className="max-w-[300px] text-center text-[11px] font-medium text-[var(--danger)]">
              {submitError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

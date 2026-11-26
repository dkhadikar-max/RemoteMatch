'use client';

import React, { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  FileText,
  Loader2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Pencil,
  CircleCheck,
  AlertTriangle,
  Info,
} from 'lucide-react';
import type {
  AnalysisMode,
  CriterionRating,
  Finding,
  ResumeAnalysis,
} from '@/types/resume-intelligence';
import { submitSuggestionDecision } from '@/lib/resume/decision-client';

/**
 * Resume Intelligence panel (PR B). docs/resume-intelligence-design.md §8.
 * One page, reachable from onboarding ("See full resume review"), Settings
 * ("Resume" section) and Match Detail ("Tailor resume for this job" ->
 * ?job=<opportunityId>). General and This-job are separate tabs with
 * independently cached results; This-job never changes the match score —
 * said explicitly in the UI, not just implied by placement.
 *
 * Every AI-sourced sentence is labelled a suggestion until the candidate
 * accepts it; "Automated checks" (source: 'rules') items are never
 * presented as if a model wrote them. The original resume text is never
 * edited in place here — accepting/editing creates a NEW version.
 */

type PanelState =
  | { phase: 'loading_resume' }
  | { phase: 'no_resume' }
  | { phase: 'ready'; resumeText: string; versionId: string }
  | { phase: 'analyzing'; versionId: string }
  | { phase: 'result'; versionId: string; analysisId: string; analysis: ResumeAnalysis; cached: boolean; quota?: { allowed: boolean; limit: number; remaining: number; planTier: string } }
  | { phase: 'error'; message: string };

type DecisionState = 'accepted' | 'rejected' | 'edited' | null;

function RatingPill({ rating }: { rating: CriterionRating }) {
  const style: Record<CriterionRating, string> = {
    meets: 'bg-[var(--green-soft)] text-[var(--green-dark)] border-[var(--green-border)]',
    partly: 'bg-[var(--amber-soft)] text-[#92400e] border-[var(--amber-border)]',
    not_yet: 'bg-[var(--red-soft)] text-[var(--red)] border-[var(--red-soft-border)]',
    not_applicable: 'bg-[var(--surface-soft)] text-[var(--muted)] border-[var(--line)]',
  };
  const label: Record<CriterionRating, string> = {
    meets: 'Meets',
    partly: 'Partly',
    not_yet: 'Not yet',
    not_applicable: 'N/A',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style[rating]}`}>
      {label[rating]}
    </span>
  );
}

function SourceTag({ source }: { source: 'ai' | 'rules' }) {
  return source === 'ai' ? (
    <span className="inline-flex items-center rounded-full bg-[var(--red-soft)] border border-[var(--red-soft-border)] text-[var(--red)] text-[11px] font-semibold px-2 py-0.5">
      Suggestion
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full bg-[var(--surface-soft)] border border-[var(--line)] text-[var(--muted)] text-[11px] font-semibold px-2 py-0.5">
      Automated check
    </span>
  );
}

function FindingRow({ f }: { f: Finding }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2 border-b border-[var(--line)] last:border-0">
      <p className="text-sm text-[var(--ink)] leading-relaxed flex-1">{f.text}</p>
      <SourceTag source={f.source} />
    </div>
  );
}

function BulletRewriteCard({
  rewrite,
  decision,
  disabled,
  saving,
  error,
  onDecide,
}: {
  rewrite: ResumeAnalysis['bulletRewrites'][number];
  /** The LAST decision the SERVER confirmed — never set optimistically (audit fix, Finding B). */
  decision: DecisionState;
  disabled?: boolean;
  /** True while a decision request for THIS suggestion is in flight — disables the buttons so a
   *  second click cannot fire a concurrent duplicate request from the same card. */
  saving?: boolean;
  /** Set when the last decision attempt for this suggestion failed to save; cleared on the next
   *  attempt or once one succeeds. */
  error?: string | null;
  /** Resolves true only once the server has confirmed the write — the card uses this (not an
   *  optimistic assumption) to decide whether to close the edit box. */
  onDecide: (d: 'accepted' | 'rejected' | 'edited', finalText?: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rewrite.proposed);
  const busy = disabled || saving;

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3">
      <div>
        <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Original</p>
        <p className="text-sm text-[var(--ink)] mt-1">{rewrite.original}</p>
      </div>
      <p className="text-xs text-[var(--muted)]">{rewrite.problem}</p>
      <div>
        <p className="text-[11px] font-semibold text-[var(--red)] uppercase tracking-wider">Suggested rewrite</p>
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="soft-input mt-1 text-sm"
          />
        ) : (
          <p className="text-sm text-[var(--ink)] mt-1">{decision === 'edited' ? draft : rewrite.proposed}</p>
        )}
      </div>
      <p className="text-xs text-[var(--muted)]">{rewrite.rationale}</p>
      {rewrite.missingFacts.length > 0 && (
        <div className="rounded-xl bg-[var(--amber-soft)] border border-[var(--amber-border)] p-3">
          <p className="text-[11px] font-semibold text-[#92400e] uppercase tracking-wider">Would make this stronger</p>
          <ul className="mt-1 space-y-0.5">
            {rewrite.missingFacts.map((q, i) => (
              <li key={i} className="text-xs text-[#92400e]">{q}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center gap-2 pt-1">
        {editing ? (
          <>
            <button
              onClick={async () => { const ok = await onDecide('edited', draft); if (ok) setEditing(false); }}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-3 py-2 transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {saving ? 'Saving…' : 'Save edit'}
            </button>
            <button onClick={() => setEditing(false)} disabled={saving} className="text-xs font-semibold text-[var(--muted)] px-3 py-2 disabled:opacity-50">Cancel</button>
          </>
        ) : (
          <>
            <button
              onClick={() => void onDecide('accepted')}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-xl text-xs font-semibold px-3 py-2 transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed ${decision === 'accepted' ? 'bg-[var(--green)] text-white' : 'bg-[var(--surface-soft)] border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--surface)]'}`}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} {decision === 'accepted' ? 'Accepted' : 'Accept'}
            </button>
            <button
              onClick={() => setEditing(true)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--surface-soft)] border border-[var(--line)] text-[var(--ink)] hover:bg-[var(--surface)] text-xs font-semibold px-3 py-2 transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Pencil size={13} /> Edit
            </button>
            <button
              onClick={() => void onDecide('rejected')}
              disabled={busy}
              className={`inline-flex items-center gap-1.5 rounded-xl text-xs font-semibold px-3 py-2 transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed ${decision === 'rejected' ? 'bg-[var(--surface-soft)] text-[var(--muted)] border border-[var(--line)]' : 'text-[var(--muted)] hover:text-[var(--ink)]'}`}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />} {decision === 'rejected' ? 'Rejected' : 'Reject'}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="text-[11px] font-medium text-[var(--danger)] flex items-center gap-1"><AlertTriangle size={12} /> {error}</p>
      )}
    </div>
  );
}

function SectionAccordion({ section }: { section: ResumeAnalysis['sectionReviews'][number] }) {
  const [open, setOpen] = useState(false);
  const itemCount = section.criteria.length + section.findings.length + section.recommendations.length;
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-[var(--ink)]">{section.heading}</span>
        <span className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
          {itemCount} item{itemCount === 1 ? '' : 's'}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--line)] pt-3">
          {section.criteria.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {section.criteria.map((c) => (
                <div key={c.id} className="inline-flex items-center gap-1.5">
                  <span className="text-[11px] text-[var(--muted)]">{c.id}</span>
                  <RatingPill rating={c.rating} />
                </div>
              ))}
            </div>
          )}
          {[...section.findings, ...section.recommendations].map((f) => <FindingRow key={f.id} f={f} />)}
          {itemCount === 0 && <p className="text-xs text-[var(--muted)] italic">Nothing to flag here.</p>}
        </div>
      )}
    </div>
  );
}

function ResumeIntelligenceInner() {
  const searchParams = useSearchParams();
  const opportunityId = searchParams?.get('job') || null;

  const [mode, setMode] = useState<AnalysisMode>(opportunityId ? 'target_job' : 'general');
  const [state, setState] = useState<PanelState>({ phase: 'loading_resume' });
  // AUDIT FIX (Finding E): resumeText/versionId used to live only inside the 'ready'/'result'
  // branches of PanelState, so switching to an uncached mode from a 'result' phase lost the
  // displayed text (it isn't 'ready', so the old ternary silently fell back to ''). They're the
  // SAME resume regardless of which phase is currently showing, so they're tracked once here —
  // switchMode no longer needs to recover them from whatever `state` happens to be.
  const [resumeText, setResumeText] = useState('');
  const [versionId, setVersionId] = useState('');
  const [resultsByMode, setResultsByMode] = useState<Partial<Record<AnalysisMode, PanelState & { phase: 'result' }>>>({});
  const [decisions, setDecisions] = useState<Record<string, DecisionState>>({});
  const [decisionBusy, setDecisionBusy] = useState<Record<string, boolean>>({});
  const [decisionErrors, setDecisionErrors] = useState<Record<string, string>>({});
  const [pasteText, setPasteText] = useState('');
  const [candidateAnswers, setCandidateAnswers] = useState<Record<string, string>>({});

  const loadResume = useCallback(async () => {
    setState({ phase: 'loading_resume' });
    try {
      // FIX (browser verification, 2026-11-07): a resume saved through THIS panel (paste, or a
      // prior accepted edit) is a real resume_versions row from the moment it's saved — check for
      // one first, so a reload doesn't lose it and force a re-paste. Only when no version exists
      // yet (first-ever visit) do we fall back to profiles.raw_resume_text from onboarding, same
      // as before.
      const existingRes = await fetch('/api/resume/versions', { cache: 'no-store' });
      if (existingRes.ok) {
        const existing = await existingRes.json();
        if (typeof existing.content === 'string' && existing.content.trim() && typeof existing.versionId === 'string') {
          setResumeText(existing.content);
          setVersionId(existing.versionId);
          setState({ phase: 'ready', resumeText: existing.content, versionId: existing.versionId });
          return;
        }
      }

      const res = await fetch('/api/onboarding', { cache: 'no-store' });
      if (!res.ok) {
        setState({ phase: 'error', message: 'Could not load your profile.' });
        return;
      }
      const data = await res.json();
      const text = typeof data.rawResumeText === 'string' ? data.rawResumeText.trim() : '';
      if (!text) {
        setState({ phase: 'no_resume' });
        return;
      }
      const versionRes = await fetch('/api/resume/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, source: 'onboarding' }),
      });
      if (!versionRes.ok) {
        setState({ phase: 'error', message: 'Could not save your resume for analysis.' });
        return;
      }
      const versionData = await versionRes.json();
      setResumeText(text);
      setVersionId(versionData.versionId);
      setState({ phase: 'ready', resumeText: text, versionId: versionData.versionId });
    } catch {
      setState({ phase: 'error', message: 'Something went wrong loading your resume.' });
    }
  }, []);

  useEffect(() => { loadResume(); }, [loadResume]);

  const runAnalysis = useCallback(async (forVersionId: string, forMode: AnalysisMode, answers: Record<string, string> = {}, questions: ResumeAnalysis['questionsForCandidate'] = []) => {
    setState({ phase: 'analyzing', versionId: forVersionId });
    try {
      const res = await fetch('/api/resume/analyses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resumeVersionId: forVersionId,
          mode: forMode,
          ...(forMode === 'target_job' && opportunityId ? { opportunityId } : {}),
          candidateAnswers: Object.entries(answers)
            .map(([questionId, answer]) => ({
              questionId,
              question: questions.find((item) => item.id === questionId)?.question ?? '',
              answer: answer.trim(),
            }))
            .filter((item) => item.answer.length > 0 && item.question.length > 0),
        }),
      });
      if (res.status === 503) {
        setState({ phase: 'error', message: 'Resume Intelligence is not yet available.' });
        return;
      }
      if (!res.ok) {
        setState({ phase: 'error', message: 'The analysis could not be completed. Please try again.' });
        return;
      }
      const data = await res.json();
      const result: PanelState & { phase: 'result' } = {
        phase: 'result',
        versionId: forVersionId,
        analysisId: typeof data.analysisId === 'string' ? data.analysisId : '',
        analysis: data.analysis as ResumeAnalysis,
        cached: !!data.cached,
        quota: data.quota,
      };
      setResultsByMode((prev) => ({ ...prev, [forMode]: result }));
      setState(result);
    } catch {
      setState({ phase: 'error', message: 'Something went wrong running the analysis.' });
    }
  }, [opportunityId]);

  const switchMode = (m: AnalysisMode) => {
    setMode(m);
    const cached = resultsByMode[m];
    if (cached) {
      setState(cached);
    } else if (versionId) {
      // resumeText/versionId come from the top-level state above, not from the phase being left —
      // correct regardless of whether the previous phase was 'ready' or 'result' (Finding E).
      setState({ phase: 'ready', resumeText, versionId });
    }
  };

  const savePastedResume = async () => {
    if (!pasteText.trim()) return;
    setState({ phase: 'loading_resume' });
    const versionRes = await fetch('/api/resume/versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: pasteText.trim(), source: 'paste' }),
    });
    if (!versionRes.ok) {
      setState({ phase: 'error', message: 'Could not save this resume.' });
      return;
    }
    const versionData = await versionRes.json();
    setResumeText(pasteText.trim());
    setVersionId(versionData.versionId);
    setState({ phase: 'ready', resumeText: pasteText.trim(), versionId: versionData.versionId });
  };

  /**
   * Audit fix (Finding B): the UI used to flip to "Accepted"/"Rejected" the instant the button
   * was clicked, before the request even left the browser, and never looked at the response —
   * a failed save looked identical to a successful one. Now `decisions` (the confirmed state
   * BulletRewriteCard renders) is set ONLY from a successful response; a non-ok response sets a
   * per-suggestion error message instead and leaves the prior confirmed decision (if any)
   * untouched. `decisionBusy` disables the card's buttons for the duration of the request, so a
   * second click on the same card cannot fire a concurrent duplicate from the client side — the
   * server is idempotent either way (record_resume_suggestion_decision upserts on
   * (analysis_id, suggestion_id)), this is purely to avoid two in-flight requests racing in the UI.
   * Returns whether it succeeded, so BulletRewriteCard can decide whether to close its edit box.
   */
  const handleDecision = async (analysisId: string, suggestionId: string, decision: 'accepted' | 'rejected' | 'edited', finalText?: string): Promise<boolean> => {
    if (decisionBusy[suggestionId]) return false; // already in flight for this suggestion
    setDecisionBusy((prev) => ({ ...prev, [suggestionId]: true }));
    setDecisionErrors((prev) => ({ ...prev, [suggestionId]: '' }));
    const outcome = await submitSuggestionDecision(fetch, analysisId, suggestionId, decision, finalText);
    setDecisionBusy((prev) => ({ ...prev, [suggestionId]: false }));
    if (!outcome.ok) {
      setDecisionErrors((prev) => ({ ...prev, [suggestionId]: outcome.errorMessage ?? 'Could not save this — please try again.' }));
      return false;
    }
    setDecisions((prev) => ({ ...prev, [suggestionId]: outcome.decision ?? decision }));
    return true;
  };

  const analysisForMode = resultsByMode[mode];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between mb-6">
        <Link href="/settings" className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)]">
          <ArrowLeft size={14} /> Back to settings
        </Link>
      </div>

      <div className="soft-card p-6 sm:p-8 border border-[var(--line)] space-y-2 mb-6">
        <div className="flex items-center gap-2">
          <FileText size={20} className="text-[var(--red)]" />
          <h1 className="text-2xl font-bold tracking-tight text-[var(--ink)]">Resume Intelligence</h1>
        </div>
        <p className="text-sm text-[var(--muted)]">
          A writing checklist for your resume, grounded in what it actually says. This is not a prediction of interview or hiring success, and it never changes your match score.
        </p>
      </div>

      {opportunityId && (
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => switchMode('general')}
            className={`flex-1 rounded-xl px-4 py-2.5 text-xs font-semibold transition-colors min-h-[44px] ${mode === 'general' ? 'bg-[var(--red)] text-white' : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'}`}
          >
            General review
          </button>
          <button
            onClick={() => switchMode('target_job')}
            className={`flex-1 rounded-xl px-4 py-2.5 text-xs font-semibold transition-colors min-h-[44px] ${mode === 'target_job' ? 'bg-[var(--red)] text-white' : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]'}`}
          >
            This job
          </button>
        </div>
      )}

      {state.phase === 'loading_resume' && (
        <div className="soft-card p-8 border border-[var(--line)] flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
          <Loader2 size={16} className="animate-spin" /> Loading your resume…
        </div>
      )}

      {state.phase === 'no_resume' && (
        <div className="soft-card p-6 border border-[var(--line)] space-y-3">
          <p className="text-sm text-[var(--ink)] font-semibold">No resume on file yet.</p>
          <p className="text-xs text-[var(--muted)]">Paste your resume text below, or add one in onboarding.</p>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={10}
            placeholder="Paste your resume text here…"
            className="soft-input text-xs font-mono"
          />
          <button
            onClick={savePastedResume}
            disabled={!pasteText.trim()}
            className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-50 text-white text-xs font-semibold px-4 py-2.5 min-h-[44px]"
          >
            Save and continue
          </button>
        </div>
      )}

      {state.phase === 'error' && (
        <div className="soft-card p-6 border border-[var(--red-soft-border)] bg-[var(--red-soft)] space-y-2">
          <p className="text-sm text-[var(--red)] font-semibold flex items-center gap-1.5"><AlertTriangle size={14} /> {state.message}</p>
          <button onClick={loadResume} className="text-xs font-semibold text-[var(--red)] underline">Try again</button>
        </div>
      )}

      {state.phase === 'ready' && (
        <div className="soft-card p-6 border border-[var(--line)] space-y-4">
          <p className="text-sm text-[var(--ink)]">
            {mode === 'target_job' ? 'Analyze your resume against this job.' : 'Ready to run a general review of your resume.'}
          </p>
          <details className="text-xs">
            <summary className="cursor-pointer font-semibold text-[var(--muted)]">Resume text being analyzed</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[11px] text-[var(--ink)] bg-[var(--surface-soft)] rounded-xl p-3 max-h-64 overflow-y-auto">{state.resumeText}</pre>
          </details>
          <button
            onClick={() => runAnalysis(state.versionId, mode)}
            className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-sm font-semibold px-5 py-3 min-h-[44px]"
          >
            {analysisForMode ? 'Rerun analysis' : 'Analyze my resume'}
          </button>
        </div>
      )}

      {state.phase === 'analyzing' && (
        <div className="soft-card p-8 border border-[var(--line)] flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
          <Loader2 size={16} className="animate-spin" /> Analyzing…
        </div>
      )}

      {state.phase === 'result' && (
        <div className="space-y-5">
          {state.analysis.analysisStatus === 'unavailable' && (
            <div className="soft-card p-4 border border-[var(--amber-border)] bg-[var(--amber-soft)] text-xs text-[#92400e] flex items-center gap-2">
              <Info size={14} /> AI analysis is unavailable right now. The automated checks below are still accurate.
            </div>
          )}
          {state.quota && !state.quota.allowed && (
            <div className="soft-card p-4 border border-[var(--amber-border)] bg-[var(--amber-soft)] text-xs text-[#92400e] flex items-center gap-2">
              <Info size={14} /> You've used today's {state.quota.limit} AI-assisted analyses ({state.quota.planTier} plan). Automated checks are still shown below.
            </div>
          )}
          {state.cached && (
            <p className="text-[11px] text-[var(--muted)]">Showing a saved result for this resume.</p>
          )}

          <div className="soft-card p-6 border border-[var(--line)] space-y-2">
            <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Overview</p>
            <p className="text-sm text-[var(--ink)]">{state.analysis.overallSummary.text || 'No summary available for this resume yet.'}</p>
            {state.analysis.resumeType.roleFamily !== 'unknown' && (
              <p className="text-xs text-[var(--muted)]">
                Read as: <span className="font-semibold text-[var(--ink)]">{state.analysis.resumeType.roleFamily}</span>
                {state.analysis.resumeType.confidence !== 'high' && <span className="italic"> ({state.analysis.resumeType.confidence} confidence)</span>}
              </p>
            )}
          </div>

          {state.analysis.strengths.length > 0 && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-1">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">Strengths</p>
              {state.analysis.strengths.map((f) => <FindingRow key={f.id} f={f} />)}
            </div>
          )}

          {state.analysis.improvements.length > 0 && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-1">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">Priority improvements</p>
              {[...state.analysis.improvements].sort((a, b) => a.priority - b.priority).map((f) => <FindingRow key={f.id} f={f} />)}
            </div>
          )}

          {state.analysis.sectionReviews.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider px-1">By section</p>
              {state.analysis.sectionReviews.map((s) => <SectionAccordion key={s.sectionId} section={s} />)}
            </div>
          )}

          {state.analysis.bulletRewrites.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider px-1">Bullet comparisons</p>
              {state.analysis.bulletRewrites.map((r) => (
                <BulletRewriteCard
                  key={r.id}
                  rewrite={r}
                  decision={decisions[r.id] ?? null}
                  disabled={!state.analysisId}
                  saving={decisionBusy[r.id] ?? false}
                  error={decisionErrors[r.id] || null}
                  onDecide={(d, finalText) => state.analysisId ? handleDecision(state.analysisId, r.id, d, finalText) : Promise.resolve(false)}
                />
              ))}
            </div>
          )}

          {state.analysis.mode === 'target_job' && state.analysis.targetJobFit && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-3">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Requirements for this job</p>
              {state.analysis.targetJobFit.requirements.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-3 py-1.5 border-b border-[var(--line)] last:border-0">
                  <span className="text-sm text-[var(--ink)]">{r.requirement}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                    r.status === 'supported' ? 'bg-[var(--green-soft)] text-[var(--green-dark)] border-[var(--green-border)]'
                    : r.status === 'transferable' ? 'bg-[var(--amber-soft)] text-[#92400e] border-[var(--amber-border)]'
                    : r.status === 'present_but_unclear' ? 'bg-[var(--surface-soft)] text-[var(--muted)] border-[var(--line)]'
                    : 'bg-[var(--red-soft)] text-[var(--red)] border-[var(--red-soft-border)]'
                  }`}>
                    {r.status.replace(/_/g, ' ')}
                  </span>
                </div>
              ))}
              {state.analysis.targetJobFit.interviewPrep.length > 0 && (
                <>
                  <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider pt-2">Interview prep</p>
                  {state.analysis.targetJobFit.interviewPrep.map((f) => <FindingRow key={f.id} f={f} />)}
                </>
              )}
            </div>
          )}

          {state.analysis.skillsEvidence.notEvidenced.length > 0 && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-2">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Skills not demonstrated in this resume</p>
              <div className="flex flex-wrap gap-1.5">
                {state.analysis.skillsEvidence.notEvidenced.map((s) => (
                  <span key={s.skill} className="tag bg-[var(--surface-soft)] border-[var(--line)] text-[var(--muted)]">{s.skill}</span>
                ))}
              </div>
            </div>
          )}

          {state.analysis.formattingIssues.length > 0 && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-1">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider mb-2">Formatting</p>
              {state.analysis.formattingIssues.map((f) => <FindingRow key={f.id} f={f} />)}
            </div>
          )}

          {state.analysis.questionsForCandidate.length > 0 && (
            <div className="soft-card p-6 border border-[var(--line)] space-y-2">
              <p className="text-[11px] font-semibold text-[var(--muted)] uppercase tracking-wider">Questions that would help</p>
              <p className="text-xs text-[var(--muted)]">Answers are used to refine this analysis and do not change your saved resume.</p>
              {state.analysis.questionsForCandidate.map((q) => (
                <div key={q.id} className="py-2 border-b border-[var(--line)] last:border-0 space-y-2">
                  <p className="text-sm text-[var(--ink)]">{q.question}</p>
                  <p className="text-[11px] text-[var(--muted)]">{q.why}</p>
                  <textarea
                    value={candidateAnswers[q.id] ?? ''}
                    onChange={(event) => setCandidateAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                    maxLength={1200}
                    rows={2}
                    placeholder="Your answer (optional). Add only details you can verify."
                    className="soft-input text-sm"
                  />
                  <p className="text-[10px] text-[var(--muted)] text-right">{(candidateAnswers[q.id] ?? '').length}/1200</p>
                </div>
              ))}
              {Object.values(candidateAnswers).some((answer) => answer.trim().length > 0) && (
                <>
                  <button
                    onClick={() => runAnalysis(state.versionId, mode, candidateAnswers, state.analysis.questionsForCandidate)}
                    disabled={state.analysis.questionsForCandidate.reduce((total, q) => total + q.question.length + (candidateAnswers[q.id] ?? '').trim().length, 0) > 4000}
                    className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-xs font-semibold px-4 py-2.5 min-h-[40px] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Use answers & rerun analysis
                  </button>
                  {state.analysis.questionsForCandidate.reduce((total, q) => total + q.question.length + (candidateAnswers[q.id] ?? '').trim().length, 0) > 4000 && (
                    <p className="text-[11px] text-[var(--danger)]">Keep the combined questions and answers under 4,000 characters.</p>
                  )}
                </>
              )}
            </div>
          )}

          {state.analysis.limitations.length > 0 && (
            <div className="text-[11px] text-[var(--muted)] space-y-1 px-1">
              {state.analysis.limitations.map((l, i) => <p key={i}>{l.message}</p>)}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => runAnalysis(state.versionId, mode)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[var(--surface)] border border-[var(--line)] hover:bg-[var(--surface-soft)] text-[var(--ink)] text-xs font-semibold px-4 py-2.5 min-h-[44px]"
            >
              <RefreshCw size={13} /> Rerun analysis
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ResumeIntelligencePage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl px-4 py-8 text-sm text-[var(--muted)]">Loading…</div>}>
      <ResumeIntelligenceInner />
    </Suspense>
  );
}

'use client';

import React, { useState } from 'react';
import {
  ProfileStrengthAnalysis,
  AIUncertaintyItem,
} from '@/types/byn';
import {
  CheckCircle2,
  HelpCircle,
  Check,
  X,
  Plus,
  ArrowRight,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
} from 'lucide-react';

interface ResumeIntelligenceDashboardProps {
  analysis: ProfileStrengthAnalysis;
  onResolveUncertainty: (
    item: AIUncertaintyItem,
    resolution: 'added' | 'not_relevant' | 'no',
    whereUsed?: string
  ) => void;
  onContinue: (improvedScore?: number) => void;
}

interface ActionableImprovement {
  id: string;
  title: string;
  points: number;
  explanation: string;
  action: string;
  accepted: boolean;
  dismissed: boolean;
  evidenceProvided?: string;
}

export function ResumeIntelligenceDashboard({
  analysis,
  onResolveUncertainty,
  onContinue,
}: ResumeIntelligenceDashboardProps) {
  const [currentScore, setCurrentScore] = useState(analysis.overallScore);
  const [uncertainties, setUncertainties] = useState<AIUncertaintyItem[]>(analysis.uncertainties);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const [whereUsedInput, setWhereUsedInput] = useState('');
  const [showImprovementPanel, setShowImprovementPanel] = useState(false);
  const [editingImprovementId, setEditingImprovementId] = useState<string | null>(null);
  const [improvementEvidenceInput, setImprovementEvidenceInput] = useState('');
  const [improvements, setImprovements] = useState<ActionableImprovement[]>([
    {
      id: 'imp-1',
      title: 'Add details for target role',
      points: 4,
      explanation: 'Your target role requires clear strategic scope; your resume currently emphasizes execution over architecture leadership.',
      action: 'Add system architecture ownership and cross-functional design decisions to your recent role.',
      accepted: false,
      dismissed: false,
    },
    {
      id: 'imp-2',
      title: 'Add Measurable Business Outcomes',
      points: 4,
      explanation: 'Several experience points describe responsibilities without showing business impact or metrics.',
      action: 'Incorporate quantifiable metrics (e.g. latency reduced by 25%, 200k+ active users scaled).',
      accepted: false,
      dismissed: false,
    },
    {
      id: 'imp-3',
      title: 'Elevate Distributed Systems Positioning',
      points: 3,
      explanation: 'Surface your cloud architecture foundation in your headline to align with international remote standards.',
      action: 'Update headline to feature distributed cloud architecture and async team collaboration.',
      accepted: false,
      dismissed: false,
    },
  ]);

  const handleResolve = (
    item: AIUncertaintyItem,
    resolution: 'added' | 'not_relevant' | 'no',
    whereUsed?: string
  ) => {
    onResolveUncertainty(item, resolution, whereUsed);
    setUncertainties((prev) =>
      prev.map((u) =>
        u.id === item.id ? { ...u, resolved: true, resolution, whereUsed } : u
      )
    );
    if (resolution === 'added') {
      setCurrentScore((prev) => Math.min(prev + 3, 98));
    }
    setActivePromptId(null);
    setWhereUsedInput('');
  };

  const handleConfirmImprovement = (id: string, pts: number, evidenceText: string) => {
    setImprovements((prev) =>
      prev.map((imp) =>
        imp.id === id
          ? { ...imp, accepted: true, evidenceProvided: evidenceText }
          : imp
      )
    );
    setCurrentScore((prev) => Math.min(prev + pts, 98));
    setEditingImprovementId(null);
    setImprovementEvidenceInput('');
  };

  const handleDismissImprovement = (id: string) => {
    setImprovements((prev) =>
      prev.map((imp) => (imp.id === id ? { ...imp, dismissed: true } : imp))
    );
    if (editingImprovementId === id) {
      setEditingImprovementId(null);
      setImprovementEvidenceInput('');
    }
  };

  const pendingImprovements = improvements.filter((i) => !i.accepted && !i.dismissed);
  const acceptedImprovements = improvements.filter((i) => i.accepted);

  const dimensions = [
    analysis.dimensions.relevance,
    analysis.dimensions.evidence,
    analysis.dimensions.impact,
    analysis.dimensions.atsReadability,
    analysis.dimensions.targetAlignment,
  ];

  return (
    <div className="space-y-6">
      {/* Hero: Profile Strength vs Job Fit Explanation */}
      <div className="soft-card p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="space-y-1.5">
          <span className="tag">Profile Review</span>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[var(--ink)] mt-1">
            Profile Strength: {currentScore} / 100
          </h2>
          <p className="text-xs text-[var(--muted)] max-w-md leading-relaxed mt-1">
            Measures how effectively your resume demonstrates your capabilities. (Note: This is separate from specific <strong>Job Fit</strong>, which is calculated per vacancy).
          </p>

          {pendingImprovements.length > 0 && !showImprovementPanel && (
            <button
              type="button"
              onClick={() => setShowImprovementPanel(true)}
              className="mt-3 soft-button secondary text-xs inline-flex items-center gap-2"
            >
              <span>Review {pendingImprovements.length} Profile Improvements</span>
              <ChevronDown size={14} />
            </button>
          )}
        </div>

        {/* Big Score Dial */}
        <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-5 text-center min-w-[130px]">
          <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Readiness</p>
          <p className="font-mono text-4xl font-semibold text-[var(--red)] mt-1">{currentScore}%</p>
          <div className="mt-1.5">
            <span className={`status ${currentScore >= 70 ? 'good' : 'caution'} text-[10px]`}>
              ● {currentScore >= 85 ? 'High Proof' : currentScore >= 70 ? 'Competitive' : 'Needs Proof'}
            </span>
          </div>
        </div>
      </div>

      {/* Recalculation Notice if improvements were accepted */}
      {acceptedImprovements.length > 0 && (
        <div className="rounded-2xl p-4 border border-[#a7f3d0] bg-[#ecfdf5] text-xs space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-[var(--ink)]">
              <CheckCircle2 size={16} className="text-[#059669]" />
              <span>
                Profile Strength recalculated from <strong>{analysis.overallScore}</strong> to <strong>{currentScore}</strong> ({acceptedImprovements.length} profile updates added).
              </span>
            </div>
            <span className="tag !bg-[var(--surface)]">Updated</span>
          </div>
          <div className="pl-6 space-y-1 text-[11px] text-[var(--muted)]">
            {acceptedImprovements.map((imp) => (
              <div key={imp.id}>
                • <strong>{imp.title}:</strong> {imp.evidenceProvided}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interactive "Improve My Profile" Workflow Panel */}
      {showImprovementPanel && pendingImprovements.length > 0 && (
        <div className="soft-card p-6 sm:p-8 space-y-4">
          <div className="flex items-center justify-between border-b border-[var(--line)] pb-3">
            <div>
              <span className="tag">Profile Review</span>
              <h3 className="font-semibold text-base text-[var(--ink)] mt-1.5">
                Suggested Profile Improvements
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setShowImprovementPanel(false)}
              className="text-xs text-[var(--muted)] hover:text-[var(--ink)]"
            >
              <ChevronUp size={16} />
            </button>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Add details or metrics to strengthen your profile. Points are added as you provide context:
          </p>

          <div className="space-y-3 pt-1">
            {pendingImprovements.map((imp) => (
              <div
                key={imp.id}
                className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-xs text-[var(--ink)]">
                    {imp.title}
                  </span>
                  <span className="font-mono text-xs font-semibold text-[var(--red)]">
                    +{imp.points} pts
                  </span>
                </div>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  {imp.explanation}
                </p>
                <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)] p-3 text-xs text-[var(--ink)] font-medium">
                  Recommendation: {imp.action}
                </div>

                {editingImprovementId === imp.id ? (
                  <div className="mt-3 rounded-xl border border-[var(--red)] bg-[var(--surface)] p-3.5 space-y-2.5">
                    <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block">
                      Add context or details (required):
                    </label>
                    <textarea
                      value={improvementEvidenceInput}
                      onChange={(e) => setImprovementEvidenceInput(e.target.value)}
                      placeholder="E.g., Architected multi-tenant Postgres DB, reducing query latency by 35% across 500k users..."
                      rows={2}
                      className="soft-input w-full text-xs"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingImprovementId(null);
                          setImprovementEvidenceInput('');
                        }}
                        className="soft-button secondary text-xs"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!improvementEvidenceInput.trim()}
                        onClick={() =>
                          handleConfirmImprovement(imp.id, imp.points, improvementEvidenceInput.trim())
                        }
                        className="soft-button primary text-xs disabled:opacity-50"
                      >
                        <span>Save & Recalculate</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleDismissImprovement(imp.id)}
                      className="px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingImprovementId(imp.id);
                        setImprovementEvidenceInput('');
                      }}
                      className="soft-button secondary text-xs"
                    >
                      Add Details
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5-Dimension Readiness Breakdown */}
      <div className="soft-card p-6 sm:p-8 space-y-5">
        <span className="tag">5-Dimension Readiness Breakdown</span>

        <div className="space-y-4 pt-2">
          {dimensions.map((dim, idx) => (
            <div key={idx} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-[var(--ink)]">{dim.name}</span>
                <span className="font-mono font-semibold text-[var(--red)]">{dim.score}%</span>
              </div>
              <div className="bar">
                <span style={{ width: `${dim.score}%` }} />
              </div>
              <p className="text-[11px] text-[var(--muted)] leading-relaxed">{dim.feedback}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Skill Verification */}
      {uncertainties.filter((u) => !u.resolved).length > 0 && (
        <div className="soft-card p-6 sm:p-8 space-y-4">
          <div className="flex items-center gap-2">
            <HelpCircle size={16} className="text-[var(--red)]" />
            <span className="tag">Clarify Skills</span>
          </div>
          <p className="text-xs text-[var(--muted)] leading-relaxed">
            A few skills you selected weren't found in your resume text. Clarifying these helps us find the right matches for you:
          </p>

          <div className="space-y-3 pt-1">
            {uncertainties
              .filter((u) => !u.resolved)
              .map((item) => (
                <div
                  key={item.id}
                  className="rounded-2xl border border-[var(--line)] bg-[var(--surface-soft)] p-4 space-y-3"
                >
                  <p className="text-xs font-semibold text-[var(--ink)]">
                    {item.prompt}
                  </p>

                  {activePromptId === item.id ? (
                    <div className="space-y-2 pt-1">
                      <label className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider block">
                        Where did you use {item.skill}?
                      </label>
                      <input
                        type="text"
                        value={whereUsedInput}
                        onChange={(e) => setWhereUsedInput(e.target.value)}
                        placeholder="e.g. Side project, client contract, recent production system..."
                        className="soft-input w-full text-xs"
                      />
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={!whereUsedInput.trim()}
                          onClick={() => handleResolve(item, 'added', whereUsedInput)}
                          className="soft-button primary text-xs disabled:opacity-50"
                        >
                          Confirm & Add Details (+3 pts)
                        </button>
                        <button
                          type="button"
                          onClick={() => setActivePromptId(null)}
                          className="soft-button secondary text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setActivePromptId(item.id)}
                        className="rounded-xl border border-[var(--red)] bg-[var(--red-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--red)] hover:bg-[var(--red)] hover:text-white transition-all"
                      >
                        Yes — Add Details
                      </button>

                      <button
                        type="button"
                        onClick={() => handleResolve(item, 'not_relevant')}
                        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-all"
                      >
                        Yes — But Not Relevant
                      </button>

                      <button
                        type="button"
                        onClick={() => handleResolve(item, 'no')}
                        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--muted)] hover:text-red-600 hover:bg-[var(--surface-soft)] transition-all"
                      >
                        No — Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Personalized Resume Suggestions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Strong Areas */}
        <div className="soft-card p-6 space-y-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={16} className="text-[#059669]" />
            <span className="tag">Verified Strengths</span>
          </div>
          <ul className="space-y-2 text-xs text-[var(--muted)] pt-1">
            {analysis.strongAreas.map((area, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-[#059669] font-bold">✓</span>
                <span className="text-[var(--ink)] font-medium">{area}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Improvement Areas */}
        <div className="soft-card p-6 space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp size={16} className="text-[var(--amber)]" />
            <span className="tag !bg-[var(--amber-soft)] !text-[var(--amber)] !border-[#f0d08a]">Improvement Opportunities</span>
          </div>
          <div className="space-y-3 text-xs pt-1">
            {analysis.improvementAreas.map((item, idx) => (
              <div key={idx} className="space-y-0.5">
                <span className="font-semibold text-[var(--ink)] block">
                  {idx + 1}. {item.title}
                </span>
                <p className="text-[var(--muted)] text-[11px] leading-relaxed">
                  {item.explanation}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Save & Enter Feed CTA */}
      <div className="soft-card p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <span className="tag">Ready for Matches</span>
          <h4 className="font-semibold text-lg sm:text-xl text-[var(--ink)] mt-1.5">
            Profile Verified ({currentScore} / 100)
          </h4>
          <p className="text-xs text-[var(--muted)] mt-1 max-w-md leading-relaxed">
            Your preferences and profile details are saved. Enter your feed to explore matches tailored to you.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onContinue(currentScore)}
          className="soft-button primary flex items-center justify-center gap-2 whitespace-nowrap self-stretch sm:self-auto"
        >
          <span>Enter Remote Job Feed</span>
          <ArrowRight size={15} />
        </button>
      </div>
    </div>
  );
}

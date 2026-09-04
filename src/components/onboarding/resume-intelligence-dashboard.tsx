'use client';

import React, { useState } from 'react';
import {
  ProfileStrengthAnalysis,
  AIUncertaintyItem,
} from '@/types/byn';
import {
  Sparkles,
  CheckCircle2,
  HelpCircle,
  Check,
  X,
  Plus,
  ArrowRight,
  TrendingUp,
  Wand2,
  ChevronDown,
  ChevronUp,
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
      title: 'Strengthen Target Role Evidence',
      points: 4,
      explanation: 'Your target role requires clear strategic scope, but your resume currently emphasizes execution over architecture leadership.',
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
      title: 'Elevate SaaS Positioning Statement',
      points: 3,
      explanation: 'Surface your cloud SaaS foundation in your headline to align with modern international remote standards.',
      action: 'Update headline to feature distributed cloud architecture and async team collaboration.',
      accepted: false,
      dismissed: false,
    },
  ]);

  const scoreColor =
    currentScore >= 80
      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
      : currentScore >= 65
      ? 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30'
      : 'text-amber-400 bg-amber-500/10 border-amber-500/30';

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
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Hero: Profile Strength vs Job Fit Explanation */}
      <div className="p-6 rounded-2xl border border-border bg-card shadow-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
              AI Resume Intelligence
            </span>
          </div>
          <h2 className="text-2xl font-bold text-foreground">
            Profile Strength: {currentScore} / 100
          </h2>
          <p className="text-xs text-muted-foreground max-w-md leading-relaxed">
            Measures how effectively your resume demonstrates your capabilities. (Note: This is separate from specific <strong>Job Fit</strong>, which is calculated per vacancy).
          </p>

          {/* Quick CTA to Improve Profile */}
          {pendingImprovements.length > 0 && !showImprovementPanel && (
            <button
              type="button"
              onClick={() => setShowImprovementPanel(true)}
              className="mt-2 inline-flex items-center gap-2 rounded-xl bg-primary/15 border border-primary/40 px-3.5 py-1.5 text-xs font-bold text-primary hover:bg-primary/25 transition-colors"
            >
              <Wand2 className="h-3.5 w-3.5" />
              <span>Improve My Profile ({pendingImprovements.length} Upgrades Available)</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Big Score Dial */}
        <div className={`flex flex-col items-center justify-center h-20 w-28 rounded-2xl border ${scoreColor} transition-all duration-300`}>
          <span className="text-3xl font-black">{currentScore}</span>
          <span className="text-[10px] font-bold uppercase tracking-wide opacity-90">
            {currentScore >= 85 ? 'Robust Profile' : currentScore >= 70 ? 'Competitive' : 'Needs Polish'}
          </span>
        </div>
      </div>

      {/* Recalculation Notice if improvements were accepted */}
      {acceptedImprovements.length > 0 && (
        <div className="p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              <span>
                Profile Strength recalculated from <strong>{analysis.overallScore}</strong> to <strong>{currentScore}</strong> ({acceptedImprovements.length} evidence improvements applied)!
              </span>
            </div>
            <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 px-2 py-0.5 rounded border border-emerald-500/30">
              Updated
            </span>
          </div>
          <div className="pl-6 space-y-1">
            {acceptedImprovements.map((imp) => (
              <div key={imp.id} className="text-[11px] text-emerald-200/80">
                • <strong>{imp.title}:</strong> {imp.evidenceProvided}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Interactive "Improve My Profile" Workflow Panel */}
      {showImprovementPanel && pendingImprovements.length > 0 && (
        <div className="p-6 rounded-2xl border-2 border-primary/40 bg-gradient-to-b from-card to-emerald-950/20 shadow-xl space-y-4 animate-in fade-in duration-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wand2 className="h-5 w-5 text-emerald-400" />
              <h3 className="font-bold text-base text-foreground">
                Improve My Profile (Evidence-Grounded Review)
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setShowImprovementPanel(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Provide concrete evidence or metrics to strengthen your candidate profile. Score points are only awarded upon adding verified context:
          </p>

          <div className="space-y-3 pt-1">
            {pendingImprovements.map((imp) => (
              <div
                key={imp.id}
                className="p-4 rounded-xl border border-border bg-card shadow-sm space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-foreground">
                    {imp.title}
                  </span>
                  <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                    +{imp.points} pts
                  </span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {imp.explanation}
                </p>
                <div className="p-2.5 rounded-lg bg-secondary/50 border border-border text-xs text-foreground/90 font-medium">
                  Recommendation: {imp.action}
                </div>

                {editingImprovementId === imp.id ? (
                  <div className="mt-3 p-3.5 rounded-xl border border-primary/30 bg-primary/5 space-y-2.5 animate-in fade-in duration-150">
                    <label className="text-xs font-semibold text-foreground block">
                      Provide concrete context or evidence (required):
                    </label>
                    <textarea
                      value={improvementEvidenceInput}
                      onChange={(e) => setImprovementEvidenceInput(e.target.value)}
                      placeholder="E.g., Architected multi-tenant Postgres DB, reducing query latency by 35% across 500k users..."
                      rows={2}
                      className="w-full rounded-lg border border-border bg-card p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingImprovementId(null);
                          setImprovementEvidenceInput('');
                        }}
                        className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={!improvementEvidenceInput.trim()}
                        onClick={() =>
                          handleConfirmImprovement(imp.id, imp.points, improvementEvidenceInput.trim())
                        }
                        className="flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>Verify Evidence & Recalculate</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => handleDismissImprovement(imp.id)}
                      className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingImprovementId(imp.id);
                        setImprovementEvidenceInput('');
                      }}
                      className="flex items-center gap-1.5 rounded-lg bg-primary/15 border border-primary/40 px-3.5 py-1.5 text-xs font-bold text-primary hover:bg-primary/25 transition-all"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Apply Improvement</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 5-Dimension Readiness Breakdown */}
      <div className="p-6 rounded-2xl border border-border bg-card shadow-md space-y-4">
        <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
          5-Dimension Readiness Breakdown
        </h3>

        <div className="space-y-3">
          {dimensions.map((dim, idx) => (
            <div key={idx} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-foreground">{dim.name}</span>
                <span className="font-mono font-bold text-emerald-400">{dim.score}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-500 rounded-full"
                  style={{ width: `${dim.score}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">{dim.feedback}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Resolve AI Uncertainty (Skill Interview) */}
      {uncertainties.filter((u) => !u.resolved).length > 0 && (
        <div className="p-6 rounded-2xl border border-indigo-500/30 bg-indigo-950/20 backdrop-blur-sm space-y-4">
          <div className="flex items-center gap-2 text-indigo-400">
            <HelpCircle className="h-5 w-5" />
            <h3 className="font-bold text-sm text-foreground">
              Resolve AI Uncertainty (Profile Interview)
            </h3>
          </div>
          <p className="text-xs text-muted-foreground">
            We noticed you selected certain capabilities that aren't explicitly proven in your resume text. Confirming these ensures our matching engine treats them accurately:
          </p>

          <div className="space-y-3">
            {uncertainties
              .filter((u) => !u.resolved)
              .map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-xl border border-border bg-card space-y-3"
                >
                  <p className="text-xs font-semibold text-foreground">
                    {item.prompt}
                  </p>

                  {activePromptId === item.id ? (
                    <div className="space-y-2 pt-1 animate-in fade-in duration-200">
                      <label className="text-[11px] text-muted-foreground block">
                        Where did you use {item.skill}?
                      </label>
                      <input
                        type="text"
                        value={whereUsedInput}
                        onChange={(e) => setWhereUsedInput(e.target.value)}
                        placeholder="e.g. Side project, client contract, recent production system..."
                        className="w-full rounded-xl border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary"
                      />
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          disabled={!whereUsedInput.trim()}
                          onClick={() => handleResolve(item, 'added', whereUsedInput)}
                          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors"
                        >
                          Confirm & Add Evidence (+3 pts)
                        </button>
                        <button
                          type="button"
                          onClick={() => setActivePromptId(null)}
                          className="rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/80"
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
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span>Yes — Add Evidence</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleResolve(item, 'not_relevant')}
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <span>Yes — But Not Relevant</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleResolve(item, 'no')}
                        className="flex items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20 transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                        <span>No — Remove</span>
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
        <div className="p-6 rounded-2xl border border-border bg-card shadow-md space-y-3">
          <div className="flex items-center gap-2 text-emerald-400">
            <CheckCircle2 className="h-5 w-5" />
            <h3 className="font-bold text-sm text-foreground">
              Your Resume is Strong In
            </h3>
          </div>
          <ul className="space-y-2 text-xs text-muted-foreground">
            {analysis.strongAreas.map((area, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <span className="text-emerald-400">✓</span>
                <span className="text-foreground font-medium">{area}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Improvement Areas */}
        <div className="p-6 rounded-2xl border border-border bg-card shadow-md space-y-3">
          <div className="flex items-center gap-2 text-amber-400">
            <TrendingUp className="h-5 w-5" />
            <h3 className="font-bold text-sm text-foreground">
              High-Impact Improvements
            </h3>
          </div>
          <div className="space-y-3 text-xs">
            {analysis.improvementAreas.map((item, idx) => (
              <div key={idx} className="space-y-0.5">
                <span className="font-semibold text-foreground block">
                  {idx + 1}. {item.title}
                </span>
                <p className="text-muted-foreground text-[11px] leading-relaxed">
                  {item.explanation}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Save & Enter Feed CTA */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-6 rounded-2xl border border-emerald-500/30 bg-emerald-950/20 gap-4">
        <div>
          <h4 className="font-bold text-base text-foreground">
            Now let's find jobs you're actually qualified for
          </h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            Your Profile Strength is <strong>{currentScore}/100</strong>. Enter the swipe feed to discover verified remote opportunities with pre-computed Fit Scores.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onContinue(currentScore)}
          className="flex items-center gap-2 rounded-xl bg-primary px-6 py-3 text-xs sm:text-sm font-bold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-600 active:scale-95 transition-all whitespace-nowrap self-stretch sm:self-auto justify-center"
        >
          <span>Enter Remote Job Feed</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

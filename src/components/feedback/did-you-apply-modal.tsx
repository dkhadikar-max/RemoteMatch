'use client';

import React, { useState } from 'react';
import { FeedbackOutcome } from '@/types/byn';
import { CheckCircle2, XCircle, AlertCircle, Clock, Sparkles, X } from 'lucide-react';

interface DidYouApplyModalProps {
  isOpen: boolean;
  companyName: string;
  onClose: () => void;
  onSubmitFeedback: (outcome: FeedbackOutcome, notes?: string) => void;
}

export function DidYouApplyModal({
  isOpen,
  companyName,
  onClose,
  onSubmitFeedback,
}: DidYouApplyModalProps) {
  const [selectedOutcome, setSelectedOutcome] = useState<FeedbackOutcome>('applied');
  const [notes, setNotes] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  if (!isOpen) return null;

  const options: Array<{
    id: FeedbackOutcome;
    label: string;
    description: string;
    icon: React.ElementType;
    color: string;
  }> = [
    {
      id: 'applied',
      label: 'Yes, I Submitted My Application',
      description: 'Mark status as Applied in your tracker & log event.',
      icon: CheckCircle2,
      color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    },
    {
      id: 'did_not_apply',
      label: "Didn't Apply Yet (Saved for Later)",
      description: 'Keep in Interested list to review materials later.',
      icon: Clock,
      color: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/30',
    },
    {
      id: 'not_eligible',
      label: 'Not Eligible Upon Review',
      description: 'Found location, visa, or citizenship restriction on their site.',
      icon: AlertCircle,
      color: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
    },
    {
      id: 'expired',
      label: 'Position Already Closed / Expired',
      description: 'The vacancy was marked filled or 404.',
      icon: XCircle,
      color: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
    },
    {
      id: 'changed_mind',
      label: 'Changed My Mind',
      description: 'Role details differed from expectations.',
      icon: X,
      color: 'text-muted-foreground bg-secondary border-border',
    },
  ];

  const handleSubmit = () => {
    onSubmitFeedback(selectedOutcome, notes);
    setIsSubmitted(true);
    setTimeout(() => {
      setIsSubmitted(false);
      onClose();
    }, 1200);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="relative flex flex-col w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95 duration-200 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-bold text-lg text-foreground">
                Did You Apply?
              </h3>
              <p className="text-xs text-muted-foreground">
                {companyName} Application Feedback
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Question Prompt */}
        <p className="text-xs text-muted-foreground leading-relaxed">
          Closing the feedback loop trains the BYN matching engine to surface higher-probability remote opportunities.
        </p>

        {/* Options List */}
        <div className="space-y-2">
          {options.map((opt) => {
            const Icon = opt.icon;
            const isSelected = selectedOutcome === opt.id;
            return (
              <label
                key={opt.id}
                onClick={() => setSelectedOutcome(opt.id)}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-500/10 shadow-sm'
                    : 'border-border bg-secondary/30 hover:bg-secondary/60'
                }`}
              >
                <div className={`mt-0.5 rounded-lg p-1 border ${opt.color}`}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="space-y-0.5">
                  <div className="font-semibold text-xs text-foreground">
                    {opt.label}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {opt.description}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        {/* Optional Notes */}
        <div>
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1">
            Optional Notes
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Applied via Lever, recruiter name, compensation discussed..."
            className="w-full rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-border bg-secondary px-4 py-2.5 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-colors"
          >
            Ask Me Later
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-all"
          >
            {isSubmitted ? 'Saved!' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

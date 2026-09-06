'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FeedbackOutcome } from '@/types/byn';
import { CheckCircle2, XCircle, AlertCircle, Clock, X, ArrowRight } from 'lucide-react';

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
  const router = useRouter();
  const [selectedOutcome, setSelectedOutcome] = useState<FeedbackOutcome>('applied');
  const [notes, setNotes] = useState('');
  const [isSubmitted, setIsSubmitted] = useState(false);

  if (!isOpen) return null;

  const options: Array<{
    id: FeedbackOutcome;
    label: string;
    description: string;
    icon: React.ElementType;
  }> = [
    {
      id: 'applied',
      label: 'Submitted Application',
      description: 'Mark status as Applied in your applications tracker.',
      icon: CheckCircle2,
    },
    {
      id: 'did_not_apply',
      label: 'Saved for Later Review',
      description: 'Keep in Interested list to review materials later.',
      icon: Clock,
    },
    {
      id: 'not_eligible',
      label: 'Not Eligible Upon Review',
      description: 'Found unlisted location, visa, or citizenship restriction.',
      icon: AlertCircle,
    },
    {
      id: 'expired',
      label: 'Position Closed or Inactive',
      description: 'The vacancy was marked filled or 404.',
      icon: XCircle,
    },
    {
      id: 'changed_mind',
      label: 'Passed / Changed Mind',
      description: 'Requirements or team scope differed from expectation.',
      icon: X,
    },
  ];

  const handleSubmit = () => {
    onSubmitFeedback(selectedOutcome, notes);
    setIsSubmitted(true);

    if (selectedOutcome === 'applied') {
      setTimeout(() => {
        router.push('/tracker');
        onClose();
      }, 1600);
    } else {
      setTimeout(() => {
        setIsSubmitted(false);
        onClose();
      }, 1000);
    }
  };

  const handleTrackDirectly = () => {
    router.push('/tracker');
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-md rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 sm:p-7 shadow-[0_20px_50px_rgba(76,44,30,0.12)] animate-modal space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {isSubmitted && selectedOutcome === 'applied' ? (
          /* Success Confirmation & Obvious Next Step */
          <div className="py-6 flex flex-col items-center text-center space-y-4 animate-in zoom-in-95 duration-200">
            <div className="grid size-14 place-items-center rounded-2xl bg-[#ecfdf5] text-[#059669] border border-[#a7f3d0]">
              <CheckCircle2 size={30} />
            </div>
            <div>
              <h3 className="text-xl font-bold text-[var(--ink)]">
                Application Recorded
              </h3>
              <p className="text-xs text-[var(--muted)] mt-1 max-w-xs">
                {companyName} is now tracked in your pipeline. Taking you to your Applications Tracker...
              </p>
            </div>
            <button
              type="button"
              onClick={handleTrackDirectly}
              className="soft-button primary w-full text-xs font-semibold py-3 flex items-center justify-center gap-1.5 min-h-[44px]"
            >
              <span>Track application</span>
              <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start justify-between pb-3.5 border-b border-[var(--line)]">
              <div>
                <span className="status good text-[11px] py-0.5 px-2.5">Outcome Record</span>
                <h3 className="text-lg font-bold text-[var(--ink)] mt-1.5">
                  Did you submit your application?
                </h3>
                <p className="text-xs text-[var(--muted)] mt-0.5">
                  {companyName} · Decision verification
                </p>
              </div>

              <button
                onClick={onClose}
                className="grid size-8 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            {/* Question Prompt */}
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Recording the actual outcome ties the decision-time fit prediction to empirical ground truth.
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
                    className={`flex items-start gap-3 p-3.5 rounded-2xl border cursor-pointer transition-all ${
                      isSelected
                        ? 'border-[var(--red)] bg-[var(--red-soft)]'
                        : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)]'
                    }`}
                  >
                    <div className="mt-0.5">
                      <Icon
                        size={16}
                        className={isSelected ? 'text-[var(--red)]' : 'text-[var(--muted)]'}
                      />
                    </div>
                    <div className="space-y-0.5">
                      <div className="font-semibold text-xs text-[var(--ink)]">
                        {opt.label}
                      </div>
                      <div className="text-[11px] text-[var(--muted)] leading-snug">
                        {opt.description}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Optional Notes */}
            <div>
              <label className="text-xs font-semibold text-[var(--muted)] block mb-1">
                Optional Notes
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Applied via official portal, compensation discussed..."
                className="soft-input py-2.5 px-3 text-xs"
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="soft-button secondary flex-1 text-xs font-semibold py-2.5 border-[var(--line)] min-h-[44px]"
              >
                Decide Later
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                className="soft-button primary flex-1 text-xs font-semibold py-2.5 min-h-[44px]"
              >
                Confirm Outcome
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

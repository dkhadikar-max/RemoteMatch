'use client';

import React, { useState } from 'react';
import { ApplicationRecord, ApplicationStatus } from '@/types/byn';
import { X, Calendar, User, CheckCircle2, ArrowRight, Award } from 'lucide-react';

interface InterviewModalProps {
  isOpen: boolean;
  application: ApplicationRecord | null;
  onClose: () => void;
  onUpdateStatus: (opportunityId: string, status: ApplicationStatus, notes: string) => void;
}

const INTERVIEW_STAGES = [
  { id: 'Screening', label: 'Screening', desc: 'Recruiter chat / culture fit' },
  { id: 'Technical', label: 'Technical', desc: 'Coding / live exercise' },
  { id: 'System Design', label: 'System Design', desc: 'Architecture & scaling' },
  { id: 'Behavioral', label: 'Behavioral', desc: 'Leadership & collaboration' },
  { id: 'Final Round', label: 'Final Round', desc: 'Executive / team wrap-up' },
];

export function InterviewModal({
  isOpen,
  application,
  onClose,
  onUpdateStatus,
}: InterviewModalProps) {
  const opp = application?.opportunity;

  const [stage, setStage] = useState('Technical');
  const [dateTime, setDateTime] = useState('');
  const [interviewer, setInterviewer] = useState('');
  const [interviewerRole, setInterviewerRole] = useState('');
  const [prepNotes, setPrepNotes] = useState(application?.notes || '');
  const [isOfferSaved, setIsOfferSaved] = useState(false);

  if (!isOpen || !application || !opp) return null;

  const handleSave = (targetStatus: ApplicationStatus = 'interview') => {
    const formattedNotes = [
      `[Round: ${stage}]`,
      dateTime ? `Date/Time: ${dateTime}` : null,
      interviewer ? `Interviewer: ${interviewer} (${interviewerRole || 'Interviewer'})` : null,
      prepNotes ? `Notes: ${prepNotes}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    onUpdateStatus(opp.id, targetStatus, formattedNotes);
    if (targetStatus === 'offer') {
      setIsOfferSaved(true);
      setTimeout(() => {
        setIsOfferSaved(false);
        onClose();
      }, 1200);
    } else {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-lg rounded-3xl border border-[var(--line)] bg-[var(--surface)] p-6 sm:p-7 shadow-[0_20px_50px_rgba(76,44,30,0.12)] animate-modal space-y-5 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between pb-3.5 border-b border-[var(--line)]">
          <div>
            <h3 className="text-xl font-bold text-[var(--ink)]">
              Interview Details
            </h3>
            <p className="text-xs text-[var(--muted)] mt-0.5">
              Keep the important details in one place. ({opp.company} · {opp.title})
            </p>
          </div>

          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--surface-soft)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Stage Selector */}
        <div>
          <label className="text-xs font-bold text-[var(--ink)] uppercase tracking-wider block mb-2">
            Interview Stage
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {INTERVIEW_STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStage(s.id)}
                className={`p-2.5 rounded-xl border text-left transition-all ${
                  stage === s.id
                    ? 'border-[var(--red)] bg-[var(--red-soft)] text-[var(--red)] font-semibold'
                    : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-soft)] text-[var(--muted)]'
                }`}
              >
                <div className="text-xs font-semibold">{s.label}</div>
                <div className="text-[10px] opacity-75 line-clamp-1">{s.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Date & Time + Interviewer Inputs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-[var(--muted)] block mb-1">
              Date & Time
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-3 size-4 text-[var(--muted)]" />
              <input
                type="text"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
                placeholder="e.g. Thu, 2:00 PM EST"
                className="soft-input py-2 pl-9 pr-3 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-[var(--muted)] block mb-1">
              Interviewer & Role
            </label>
            <div className="relative">
              <User className="absolute left-3 top-3 size-4 text-[var(--muted)]" />
              <input
                type="text"
                value={interviewer}
                onChange={(e) => setInterviewer(e.target.value)}
                placeholder="e.g. Sarah Chen (Hiring Manager)"
                className="soft-input py-2 pl-9 pr-3 text-xs"
              />
            </div>
          </div>
        </div>

        {/* Preparation Focus Points */}
        <div className="p-3.5 rounded-2xl bg-[var(--surface-soft)] border border-[var(--line)] space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[var(--ink)]">
            <CheckCircle2 size={15} className="text-[#059669]" />
            <span>What should you prepare for?</span>
          </div>
          <ul className="text-xs text-[#5c5550] space-y-1.5 list-disc pl-4">
            <li>
              Emphasize proven experience with{' '}
              <span className="font-semibold text-[var(--ink)]">
                {opp.requiredSkills.slice(0, 3).join(', ')}
              </span>.
            </li>
            <li>Address async team coordination and production reliability.</li>
            <li>Prepare questions regarding team roadmap and tech stack ownership.</li>
          </ul>
        </div>

        {/* Notes / Debrief */}
        <div>
          <label className="text-xs font-semibold text-[var(--muted)] block mb-1">
            Notes
          </label>
          <textarea
            value={prepNotes}
            onChange={(e) => setPrepNotes(e.target.value)}
            placeholder="Record questions asked, feedback received, or follow-up items..."
            className="soft-input py-2.5 px-3 text-xs resize-none"
            rows={3}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-2 border-t border-[var(--line)]">
          <button
            type="button"
            onClick={() => handleSave('offer')}
            className="w-full sm:flex-1 rounded-xl bg-[#ecfdf5] hover:bg-[#d1fae5] border border-[#a7f3d0] text-[#059669] text-xs font-bold py-3 flex items-center justify-center gap-1.5 transition-colors shadow-sm min-h-[44px]"
          >
            <Award size={15} />
            <span>{isOfferSaved ? 'Offer Recorded! 🎉' : 'Record Offer Received'}</span>
          </button>

          <button
            type="button"
            onClick={() => handleSave('interview')}
            className="w-full sm:flex-1 soft-button primary text-xs font-semibold py-3 min-h-[44px]"
          >
            <span>Save interview</span>
            <ArrowRight size={14} className="ml-1" />
          </button>
        </div>
      </div>
    </div>
  );
}

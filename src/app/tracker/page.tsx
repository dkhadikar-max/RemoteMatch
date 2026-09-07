'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ApplicationRecord, ApplicationStatus } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import { InterviewModal } from '@/components/tracker/interview-modal';
import {
  ArrowRight,
  MessageSquareText,
  Search,
  BriefcaseBusiness,
  CheckCircle2,
  Calendar,
  Award,
} from 'lucide-react';

// Shape returned by GET /api/applications — the server-authoritative
// lifecycle state, joined with the fit-score-at-decision-time snapshot
// recorded by finalize_interested_swipe(). Deliberately does not carry the
// full `opportunity`/`match` objects ApplicationRecord allows for — those
// are looked up from the (legitimately client-local) opportunity catalog
// per-render, same as before.
interface ServerApplication {
  id: string;
  opportunityId: string;
  status: ApplicationStatus;
  appliedAt: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
  decisionSnapshot: { fitScore?: number } | null;
}

export default function TrackerPage() {
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [interviewModalApp, setInterviewModalApp] = useState<ApplicationRecord | null>(null);
  const [isInterviewModalOpen, setIsInterviewModalOpen] = useState(false);

  const loadApplications = async () => {
    const res = await fetch('/api/applications');
    if (!res.ok) return;
    const data = await res.json();
    const apps: ApplicationRecord[] = (data.applications as ServerApplication[]).map((a) => ({
      id: a.id,
      profileId: '',
      opportunityId: a.opportunityId,
      status: a.status,
      appliedAt: a.appliedAt ?? undefined,
      notes: a.notes,
      // Only `fitScore` is populated server-side today (see ServerApplication
      // above) — cast through `unknown` since this is deliberately a partial
      // DecisionSnapshot, not the full shape the type otherwise implies.
      decisionSnapshot: (a.decisionSnapshot ?? undefined) as unknown as ApplicationRecord['decisionSnapshot'],
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));
    setApplications(apps);
  };

  useEffect(() => {
    loadApplications();
  }, []);

  // The server is the only authority on whether a transition is valid —
  // this call can be rejected (e.g. 409 invalid_transition, or 409
  // status_conflict if the application changed since it was last loaded)
  // and the local list is only updated from what the server actually
  // accepted, via the re-fetch, never optimistically. `currentStatus` is
  // the status this screen actually observed — required so the server can
  // detect a stale view instead of silently transitioning from whatever
  // the row happens to be at now (see 007_application_transition_cas.sql).
  const handleStatusChange = async (
    opportunityId: string,
    currentStatus: ApplicationStatus,
    newStatus: ApplicationStatus,
    notes?: string
  ) => {
    const res = await fetch('/api/applications/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId, expectedStatus: currentStatus, status: newStatus, notes }),
    });
    if (!res.ok) return;
    await loadApplications();
  };

  const handleNotesChange = async (opportunityId: string, notes: string) => {
    const res = await fetch('/api/applications/notes', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opportunityId, notes }),
    });
    if (!res.ok) return;
    await loadApplications();
  };

  const openInterviewModal = (app: ApplicationRecord) => {
    setInterviewModalApp(app);
    setIsInterviewModalOpen(true);
  };

  const activeCount = applications.filter((a) => a.status === 'applied' || a.status === 'interested').length || 12;
  const interviewCount = applications.filter((a) => a.status === 'interview').length || 4;
  const offerCount = applications.filter((a) => a.status === 'offer').length || 1;
  // "withdrawn" joins the existing "Not selected" bucket for display — a
  // genuine, distinct outcome underneath (see get_application_outcome() in
  // 006_outcome_lifecycle.sql), just grouped with rejected/archived here so
  // the tracker's existing 4-tab UX doesn't need a 5th tab for it.
  const notSelectedCount =
    applications.filter((a) => a.status === 'rejected' || a.status === 'withdrawn' || a.status === 'archived').length || 3;
  const totalCount = activeCount + interviewCount + offerCount + notSelectedCount;

  const filtered = applications.filter((app) => {
    const matchesTab =
      activeTab === 'all'
        ? true
        : activeTab === 'active'
        ? app.status === 'applied' || app.status === 'interested'
        : activeTab === 'interview'
        ? app.status === 'interview'
        : activeTab === 'offer'
        ? app.status === 'offer'
        : app.status === 'rejected' || app.status === 'withdrawn' || app.status === 'archived';

    const opp = app.opportunity || localStore.getOpportunityById(app.opportunityId);
    const titleMatch = opp?.title.toLowerCase().includes(searchQuery.toLowerCase()) || false;
    const companyMatch = opp?.company.toLowerCase().includes(searchQuery.toLowerCase()) || false;
    return matchesTab && (titleMatch || companyMatch || searchQuery === '');
  });

  return (
    <main className="page">
      <div className="container py-8 max-w-5xl space-y-7">
        {/* Header */}
        <div className="pb-4 border-b border-[var(--line)]">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-[var(--ink)]">
            Your applications, all in one place.
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)] leading-relaxed">
            Track every job from application to offer.
          </p>
        </div>

        {/* 4 Outcome Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Card 1: Active */}
          <div className="soft-card p-5 border border-[var(--line)] bg-[var(--surface)] rounded-3xl">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Active</p>
            <p className="mono mt-2 text-3xl font-bold text-[var(--ink)]">
              {activeCount}
            </p>
            <p className="mt-1 text-[11px] text-[var(--muted)]">In progress</p>
          </div>

          {/* Card 2: Interviews (Soft Red) */}
          <div className="rounded-3xl p-5 border border-[var(--red-soft-border)] bg-[var(--red-soft)]">
            <p className="text-xs font-semibold text-[var(--red)] uppercase tracking-wider">Interviews</p>
            <p className="mono mt-2 text-3xl font-bold text-[var(--red)]">
              {interviewCount}
            </p>
            <p className="mt-1 text-[11px] text-[var(--red)]">Upcoming</p>
          </div>

          {/* Card 3: Offers (Soft Green) */}
          <div className="rounded-3xl p-5 border border-[#a7f3d0] bg-[#ecfdf5]">
            <p className="text-xs font-semibold text-[#059669] uppercase tracking-wider">Offers</p>
            <p className="mono mt-2 text-3xl font-bold text-[#059669]">
              {offerCount}
            </p>
            <p className="mt-1 text-[11px] text-[#059669]">Received</p>
          </div>

          {/* Card 4: Not selected */}
          <div className="soft-card p-5 border border-[var(--line)] bg-[var(--surface)] rounded-3xl">
            <p className="text-xs font-semibold text-[var(--muted)] uppercase tracking-wider">Not selected</p>
            <p className="mono mt-2 text-3xl font-bold text-[var(--ink)]">
              {notSelectedCount}
            </p>
            <p className="mt-1 text-[11px] text-[var(--muted)]">Closed</p>
          </div>
        </div>

        {/* Search & Tabs */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 w-full sm:w-auto scrollbar-none">
            {[
              { id: 'all', label: `All (${totalCount})` },
              { id: 'active', label: `Active (${activeCount})` },
              { id: 'interview', label: `Interviews (${interviewCount})` },
              { id: 'offer', label: `Offers (${offerCount})` },
              { id: 'rejected', label: `Not selected (${notSelectedCount})` },
            ].map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3.5 py-1.5 text-xs font-semibold rounded-full transition-colors min-h-[36px] ${
                    isActive
                      ? 'bg-[var(--red)] text-white shadow-sm'
                      : 'bg-[var(--surface)] border border-[var(--line)] text-[var(--muted)] hover:bg-[var(--surface-soft)] hover:text-[var(--ink)]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3.5 top-3 size-3.5 text-[var(--muted)]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search applications..."
              className="soft-input py-2 pl-9 pr-3 text-xs border-[var(--line)]"
            />
          </div>
        </div>

        {/* Application Cards List */}
        {filtered.length === 0 ? (
          <div className="soft-card p-12 text-center space-y-3 border border-[var(--line)] rounded-3xl">
            <div className="grid size-12 place-items-center rounded-2xl bg-[var(--surface-soft)] text-[var(--muted)] mx-auto">
              <BriefcaseBusiness size={20} />
            </div>
            <h3 className="font-bold text-base text-[var(--ink)]">
              No applications matching this filter
            </h3>
            <p className="text-xs text-[var(--muted)] max-w-sm mx-auto">
              Save or evaluate opportunities in your feed to inspect matches and track interview outcomes.
            </p>
            <div className="pt-2">
              <Link href="/feed" className="soft-button primary text-xs min-h-[44px]">
                Explore Opportunities
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((app) => {
              const opp = app.opportunity || localStore.getOpportunityById(app.opportunityId);
              if (!opp) return null;

              // Prefer the score actually recorded at the moment this
              // application was created (swipes.decision_snapshot, joined in
              // by GET /api/applications) over the opportunity catalog's
              // live-recomputed fitScore — the decision-time value is what
              // P0's outcome data is keyed on, so the tracker should show
              // the same number the dataset uses.
              const fitScore = app.decisionSnapshot?.fitScore ?? opp.fitScore ?? 92;
              const status = app.status;

              // Step indicator active status
              const isApplied = status === 'applied' || status === 'interview' || status === 'offer';
              const isScreening = status === 'interview' || status === 'offer';
              const isInterview = status === 'interview' || status === 'offer';
              const isOffer = status === 'offer';

              return (
                <article key={app.id} className="soft-card p-5 sm:p-6 space-y-4 border border-[var(--line)] rounded-3xl">
                  {/* Top Bar: Company, Role & Status Tag */}
                  <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs text-[var(--ink)] uppercase tracking-wider">
                          {opp.company}
                        </span>
                        <span className="text-xs text-[var(--muted)]/40">·</span>
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--red)] bg-[var(--red-soft)] border border-[var(--red-soft-border)] px-2 py-0.5 rounded-full">
                          {fitScore}% match
                        </span>
                      </div>
                      <h2 className="text-lg font-bold text-[var(--ink)] mt-0.5">
                        {opp.title}
                      </h2>
                      <p className="text-xs text-[var(--muted)] mt-0.5">
                        Remote · {opp.remoteType || 'Worldwide'} · {opp.salaryMin ? `$${Math.round(opp.salaryMin/1000)}k–$${Math.round((opp.salaryMax || 0)/1000)}k` : '$140k–$180k'}
                      </p>
                    </div>

                    {/* Status Dropdown */}
                    <div className="flex items-center gap-2 self-start sm:self-auto">
                      <select
                        value={app.status}
                        onChange={(e) =>
                          handleStatusChange(opp.id, app.status, e.target.value as ApplicationStatus)
                        }
                        className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)] shadow-sm cursor-pointer outline-none focus:border-[var(--red)] min-h-[36px]"
                      >
                        <option value="interested">Interested</option>
                        <option value="applied">Applied</option>
                        <option value="interview">Interview</option>
                        <option value="offer">Offer</option>
                        <option value="rejected">Rejected</option>
                        <option value="withdrawn">Withdrawn</option>
                        <option value="archived">Archived</option>
                      </select>
                    </div>
                  </div>

                  {/* Stepper with red dots & labels */}
                  <div className="pt-2 pb-1">
                    <div className="grid grid-cols-4 gap-2 text-[11px] font-medium text-[var(--muted)]">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span
                            className={`size-2.5 rounded-full ${
                              isApplied ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                            }`}
                          />
                          <span className={`block h-1 flex-1 rounded-full ${
                            isApplied ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                          }`} />
                        </div>
                        <span className={isApplied ? 'font-semibold text-[var(--ink)]' : ''}>Applied</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span
                            className={`size-2.5 rounded-full ${
                              isScreening ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                            }`}
                          />
                          <span className={`block h-1 flex-1 rounded-full ${
                            isScreening ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                          }`} />
                        </div>
                        <span className={isScreening ? 'font-semibold text-[var(--ink)]' : ''}>Screening</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span
                            className={`size-2.5 rounded-full ${
                              isInterview ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                            }`}
                          />
                          <span className={`block h-1 flex-1 rounded-full ${
                            isInterview ? 'bg-[var(--red)]' : 'bg-[var(--line)]'
                          }`} />
                        </div>
                        <span className={isInterview ? 'font-semibold text-[var(--ink)]' : ''}>Interview</span>
                      </div>
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span
                            className={`size-2.5 rounded-full ${
                              isOffer ? 'bg-[#059669]' : 'bg-[var(--line)]'
                            }`}
                          />
                          <span className={`block h-1 flex-1 rounded-full ${
                            isOffer ? 'bg-[#059669]' : 'bg-[var(--line)]'
                          }`} />
                        </div>
                        <span className={isOffer ? 'font-semibold text-[#059669]' : ''}>Offer</span>
                      </div>
                    </div>
                  </div>

                  {/* Immediate Next Action Guidance Bar */}
                  <div className="rounded-2xl bg-[var(--surface-soft)] border border-[var(--line)] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2.5">
                      {status === 'interview' ? (
                        <>
                          <Calendar size={15} className="text-[var(--red)] shrink-0" />
                          <span>
                            <strong className="text-[var(--ink)]">Interview Active:</strong> Review customized prep points & notes.
                          </span>
                        </>
                      ) : status === 'applied' ? (
                        <>
                          <CheckCircle2 size={15} className="text-[#059669] shrink-0" />
                          <span>
                            <strong className="text-[var(--ink)]">Applied:</strong> Ready for recruiter screening outreach.
                          </span>
                        </>
                      ) : status === 'offer' ? (
                        <>
                          <Award size={15} className="text-[#059669] shrink-0" />
                          <span>
                            <strong className="text-[#059669]">Offer Extended:</strong> Review compensation and terms.
                          </span>
                        </>
                      ) : (
                        <div>
                          <p className="font-semibold text-xs text-[var(--ink)]">Ready when you are</p>
                          <p className="text-[var(--muted)] text-[11px] mt-0.5">
                            This job looks like a strong match for you.
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Action button corresponding to stage */}
                    <div>
                      {status === 'interview' ? (
                        <button
                          type="button"
                          onClick={() => openInterviewModal(app)}
                          className="soft-button primary text-xs font-semibold !py-2 !px-3.5 min-h-[36px] w-full sm:w-auto"
                        >
                          <span>Prepare / Add interview details</span>
                          <ArrowRight size={13} className="ml-1" />
                        </button>
                      ) : status === 'applied' ? (
                        <button
                          type="button"
                          onClick={() => openInterviewModal(app)}
                          className="rounded-xl border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--bg)] text-[var(--ink)] font-semibold px-3.5 py-1.5 text-xs shadow-sm transition-colors min-h-[36px] w-full sm:w-auto flex items-center justify-center gap-1.5"
                        >
                          <Calendar size={13} className="text-[var(--red)]" />
                          <span>Schedule Interview</span>
                        </button>
                      ) : status === 'offer' ? (
                        <button
                          type="button"
                          onClick={() => openInterviewModal(app)}
                          className="rounded-xl bg-[#ecfdf5] hover:bg-[#d1fae5] border border-[#a7f3d0] text-[#059669] font-semibold px-3.5 py-1.5 text-xs shadow-sm transition-colors min-h-[36px] w-full sm:w-auto"
                        >
                          View offer details
                        </button>
                      ) : (
                        <Link
                          href={`/match/${opp.id}`}
                          className="soft-button primary text-xs font-semibold !py-2 !px-3.5 min-h-[36px] w-full sm:w-auto flex items-center justify-center gap-1"
                        >
                          <span>View match & apply →</span>
                        </Link>
                      )}
                    </div>
                  </div>

                  {/* Bottom Actions & Notes */}
                  <div className="flex items-center justify-between border-t border-[var(--line)] pt-3 text-xs">
                    <button
                      onClick={() =>
                        setEditingNotesId(editingNotesId === app.id ? null : app.id)
                      }
                      className="flex items-center gap-1.5 font-medium text-[var(--muted)] hover:text-[var(--ink)] transition-colors min-h-[32px]"
                    >
                      <MessageSquareText size={14} />
                      <span>{app.notes ? 'Edit notes' : 'Add notes'}</span>
                    </button>

                    <Link
                      href={`/match/${opp.id}`}
                      className="inline-flex items-center gap-1 font-semibold text-[var(--red)] hover:text-[var(--red-dark)] transition-colors min-h-[32px]"
                    >
                      <span>View match details</span>
                      <ArrowRight size={14} />
                    </Link>
                  </div>

                  {/* Notes Drawer */}
                  {editingNotesId === app.id && (
                    <div className="pt-2 space-y-1.5 animate-in fade-in duration-150">
                      <label className="text-[11px] font-semibold text-[var(--muted)] block">
                        Notes
                      </label>
                      <textarea
                        defaultValue={app.notes || ''}
                        onBlur={(e) => handleNotesChange(opp.id, e.target.value)}
                        placeholder="E.g., Recruiter screening passed, technical round scheduled for Thursday..."
                        className="soft-input text-xs py-2 px-3 resize-none border-[var(--line)]"
                        rows={2}
                      />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* Actionable Interview Modal */}
      <InterviewModal
        isOpen={isInterviewModalOpen}
        application={interviewModalApp}
        onClose={() => setIsInterviewModalOpen(false)}
        onUpdateStatus={handleStatusChange}
      />
    </main>
  );
}

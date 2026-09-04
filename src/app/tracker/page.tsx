'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { ApplicationRecord, ApplicationStatus } from '@/types/byn';
import { localStore } from '@/lib/db/mock-seed';
import {
  Briefcase,
  ExternalLink,
  Search,
  Sparkles,
  FileText,
  Clock,
  CheckCircle2,
  Calendar,
  Layers,
  ChevronRight,
} from 'lucide-react';

const statusTabs: Array<{ id: string; label: string; countStatus?: ApplicationStatus }> = [
  { id: 'all', label: 'All Applications' },
  { id: 'interested', label: 'Interested', countStatus: 'interested' },
  { id: 'applied', label: 'Applied', countStatus: 'applied' },
  { id: 'interview', label: 'Interview', countStatus: 'interview' },
  { id: 'offer', label: 'Offer', countStatus: 'offer' },
  { id: 'rejected', label: 'Rejected', countStatus: 'rejected' },
  { id: 'archived', label: 'Archived', countStatus: 'archived' },
];

export default function TrackerPage() {
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [activeTab, setActiveTab] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);

  useEffect(() => {
    // Initial fetch from store
    const apps = localStore.getAllApplications();
    setApplications(apps);
  }, []);

  const handleStatusChange = (opportunityId: string, newStatus: ApplicationStatus) => {
    localStore.updateApplicationStatus(opportunityId, newStatus);
    setApplications(localStore.getAllApplications());
  };

  const handleNotesChange = (opportunityId: string, notes: string) => {
    localStore.updateApplicationStatus(opportunityId, undefined as any, notes);
    setApplications(localStore.getAllApplications());
  };

  const filtered = applications.filter((app) => {
    const matchesTab = activeTab === 'all' || app.status === activeTab;
    const opp = app.opportunity || localStore.getOpportunityById(app.opportunityId);
    const titleMatch = opp?.title.toLowerCase().includes(searchQuery.toLowerCase()) || false;
    const companyMatch = opp?.company.toLowerCase().includes(searchQuery.toLowerCase()) || false;
    return matchesTab && (titleMatch || companyMatch || searchQuery === '');
  });

  const getStatusBadge = (status: ApplicationStatus) => {
    switch (status) {
      case 'applied':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'interview':
        return 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30';
      case 'offer':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30 font-bold';
      case 'rejected':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'archived':
        return 'bg-secondary text-muted-foreground border-border';
      default:
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
            Application Tracker
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Track opportunities you've marked as interested, record interviews, and log outcomes.
          </p>
        </div>

        <Link
          href="/feed"
          className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-xs sm:text-sm font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-all self-start sm:self-auto"
        >
          <Layers className="h-4 w-4" />
          <span>Discover More Jobs</span>
        </Link>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <div className="relative flex-1 w-full">
          <Search className="absolute left-3.5 top-3 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by company, role title, or skills..."
            className="w-full rounded-xl border border-border bg-card py-2.5 pl-10 pr-4 text-xs sm:text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 scrollbar-none">
        {statusTabs.map((tab) => {
          const count =
            tab.id === 'all'
              ? applications.length
              : applications.filter((a) => a.status === tab.countStatus).length;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold whitespace-nowrap transition-colors border ${
                isActive
                  ? 'bg-secondary border-primary/40 text-foreground shadow-sm'
                  : 'border-transparent text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                  isActive ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Applications List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center p-12 rounded-2xl border border-border bg-card text-center space-y-4 shadow-sm">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-muted-foreground">
            <Briefcase className="h-6 w-6" />
          </div>
          <div>
            <h3 className="font-bold text-base text-foreground">
              No applications in "{activeTab}" tab
            </h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Swipe right on opportunities in the feed to save them here, generate tailored materials, and track your applications.
            </p>
          </div>
          <Link
            href="/feed"
            className="rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-600 transition-colors"
          >
            Start Swiping
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((app) => {
            const opp = app.opportunity || localStore.getOpportunityById(app.opportunityId);
            if (!opp) return null;

            const fitScore = opp.fitScore ?? 84;

            return (
              <div
                key={app.id}
                className="flex flex-col md:flex-row md:items-center justify-between gap-5 p-5 rounded-2xl border border-border bg-card shadow-md hover:border-border/80 transition-all"
              >
                {/* Left: Info */}
                <div className="flex items-start gap-4 flex-1">
                  {opp.companyLogo ? (
                    <img
                      src={opp.companyLogo}
                      alt={opp.company}
                      className="h-12 w-12 rounded-xl object-cover border border-border bg-secondary flex-shrink-0"
                    />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary border border-border text-foreground font-bold text-base flex-shrink-0">
                      {opp.company.slice(0, 2).toUpperCase()}
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-primary">{opp.company}</span>
                      <span className="text-[10px] text-muted-foreground">• {opp.remoteType}</span>
                    </div>
                    <h3 className="text-base font-bold text-foreground">
                      {opp.title}
                    </h3>

                    {/* Notes in-place editor */}
                    <div className="pt-1">
                      <input
                        type="text"
                        defaultValue={app.notes}
                        onBlur={(e) => handleNotesChange(app.opportunityId, e.target.value)}
                        placeholder="Add personal note (interviewer name, follow-up date, salary notes)..."
                        className="text-xs text-muted-foreground hover:text-foreground focus:text-foreground bg-transparent border-b border-transparent hover:border-border focus:border-primary focus:outline-none w-full max-w-md placeholder:text-muted-foreground/60 transition-colors"
                      />
                    </div>
                  </div>
                </div>

                {/* Right: Status selector & Action Buttons */}
                <div className="flex flex-wrap items-center gap-3 pt-3 md:pt-0 border-t md:border-t-0 border-border">
                  {/* Status Dropdown */}
                  <div className="flex items-center gap-2">
                    <select
                      value={app.status}
                      onChange={(e) =>
                        handleStatusChange(app.opportunityId, e.target.value as ApplicationStatus)
                      }
                      className={`rounded-xl border px-3 py-1.5 text-xs font-semibold uppercase tracking-wider focus:outline-none cursor-pointer ${getStatusBadge(
                        app.status
                      )}`}
                    >
                      <option value="interested">Interested</option>
                      <option value="applied">Applied</option>
                      <option value="interview">Interview</option>
                      <option value="offer">Offer</option>
                      <option value="rejected">Rejected</option>
                      <option value="archived">Archived</option>
                    </select>
                  </div>

                  {/* View Match & Application Kit Link */}
                  <Link
                    href={`/match/${opp.id}`}
                    className="flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80 transition-colors"
                  >
                    <FileText className="h-3.5 w-3.5 text-indigo-400" />
                    <span>View Kit</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>

                  {/* Apply Official External */}
                  <a
                    href={opp.officialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-bold text-white shadow-md shadow-emerald-500/20 hover:bg-emerald-600 transition-colors"
                  >
                    <span>Official Apply</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

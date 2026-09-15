'use client';

import React, { useState, useEffect } from 'react';
import { Search, Link2, ExternalLink, Loader2 } from 'lucide-react';
import { fetchServerEntitlement, ServerEntitlement } from '@/lib/entitlement/client';
import { UpgradeModal, UpgradeReason } from '@/components/premium/upgrade-modal';
import { LinkedInMatchView } from '@/components/linkedin-jobs/linkedin-match-view';
import { buildLinkedInJobSearchUrl } from '@/lib/linkedin-jobs/deep-links';
import type { LinkedInJobSearchFilters } from '@/types/linkedin-jobs';
import type { LinkedInSearchResultItem } from '@/lib/linkedin-jobs/search';
import type { PastedJobAnalysis } from '@/lib/linkedin-jobs/analyze';

/**
 * LinkedIn Job Finder — main page (plan §26). Three modes of the same
 * page, matching the plan exactly:
 *   A — "Find LinkedIn Jobs": automated vendor-backed search (Pro, small
 *       Free daily allowance) — THE PRIMARY v1 experience per Deep's
 *       explicit authorization.
 *   B — "Paste a job": user supplies a specific job themselves (Free).
 *   C — "Search on LinkedIn directly": pure link-builder, opens LinkedIn's
 *       own search in a new tab, zero data returned to RemoteMatch.
 */

type TabId = 'search' | 'paste' | 'linkedin';

const EMPTY_FILTERS: LinkedInJobSearchFilters = {
  keywords: '',
  location: '',
  remoteOnly: false,
  experienceLevel: '',
  datePosted: 'any',
  company: '',
  jobType: '',
};

export default function LinkedInJobsPage() {
  const [tab, setTab] = useState<TabId>('search');
  const [ent, setEnt] = useState<ServerEntitlement | null>(null);
  const [upgradeReason, setUpgradeReason] = useState<UpgradeReason | null>(null);

  // Mode A state
  const [filters, setFilters] = useState<LinkedInJobSearchFilters>(EMPTY_FILTERS);
  const [searchResults, setSearchResults] = useState<LinkedInSearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [vendorConfigured, setVendorConfigured] = useState<boolean | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Mode B state
  const [pasteText, setPasteText] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteResult, setPasteResult] = useState<PastedJobAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    fetchServerEntitlement().then(setEnt);
  }, []);

  const isPro = ent?.planTier === 'pro';

  const runSearch = async () => {
    setIsSearching(true);
    setSearchError(null);
    try {
      const res = await fetch('/api/linkedin-jobs/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
      });
      const data = await res.json();
      if (res.status === 403 && data.upgradeRequired) {
        setUpgradeReason('linkedinSearch');
        return;
      }
      if (!res.ok) {
        setSearchError(data.error || 'Search failed');
        return;
      }
      setVendorConfigured(data.vendorConfigured);
      setSearchResults(data.results || []);
    } catch {
      setSearchError('Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  const runPasteAnalysis = async () => {
    setIsAnalyzing(true);
    try {
      const res = await fetch('/api/linkedin-jobs/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText: pasteText, linkedinUrl: pasteUrl }),
      });
      const data = await res.json();
      if (data.result) {
        setPasteResult(data.result);
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const generateConnectionMessage = async (job: { title: string; company: string; description: string; linkedinUrl: string; location?: string }) => {
    const res = await fetch('/api/linkedin-jobs/connection-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    const data = await res.json();
    if (res.status === 403) {
      setUpgradeReason('linkedinPeopleConnect');
      return '';
    }
    return data.message || '';
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--ink)]">Find LinkedIn Jobs</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          Discover real LinkedIn postings and see why they fit — RemoteMatch never scrapes or stores LinkedIn directly.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[var(--line)]">
        {([
          ['search', 'Find LinkedIn Jobs', Search],
          ['paste', 'Paste a job', Link2],
          ['linkedin', 'Search on LinkedIn', ExternalLink],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === id
                ? 'border-[var(--red)] text-[var(--red)]'
                : 'border-transparent text-[var(--muted)] hover:text-[var(--ink)]'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Shared filters — used by Mode A (search) and Mode C (link-builder) */}
      {(tab === 'search' || tab === 'linkedin') && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            placeholder="Job title / keywords"
            value={filters.keywords}
            onChange={(e) => setFilters({ ...filters, keywords: e.target.value })}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <input
            placeholder="Location"
            value={filters.location}
            onChange={(e) => setFilters({ ...filters, location: e.target.value })}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <input
            placeholder="Company"
            value={filters.company}
            onChange={(e) => setFilters({ ...filters, company: e.target.value })}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <input
            placeholder="Experience level"
            value={filters.experienceLevel}
            onChange={(e) => setFilters({ ...filters, experienceLevel: e.target.value })}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <select
            value={filters.datePosted}
            onChange={(e) => setFilters({ ...filters, datePosted: e.target.value as LinkedInJobSearchFilters['datePosted'] })}
            className="rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          >
            <option value="any">Any time</option>
            <option value="past24h">Past 24 hours</option>
            <option value="pastWeek">Past week</option>
            <option value="pastMonth">Past month</option>
          </select>
          <label className="inline-flex items-center gap-2 text-sm text-[var(--ink)] px-1">
            <input
              type="checkbox"
              checked={filters.remoteOnly}
              onChange={(e) => setFilters({ ...filters, remoteOnly: e.target.checked })}
            />
            Remote only
          </label>
        </div>
      )}

      {tab === 'search' && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={runSearch}
            disabled={isSearching}
            className="soft-button primary text-xs font-semibold py-3 px-5 flex items-center gap-2 disabled:opacity-60"
          >
            {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            Search LinkedIn Jobs
          </button>

          {searchError && <p className="text-sm text-red-600">{searchError}</p>}
          {vendorConfigured === false && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5">
              Automated search isn&apos;t connected yet — use &quot;Paste a job&quot; in the meantime.
            </p>
          )}

          <div className="space-y-3">
            {searchResults.map((r) => (
              <LinkedInMatchView
                key={r.id}
                title={r.title}
                company={r.company}
                location={r.location}
                linkedinUrl={r.linkedinUrl}
                provenance={r.provenance}
                descriptionConfidence={r.descriptionConfidence}
                match={r.match}
                isPro={isPro}
                onRequireUpgrade={setUpgradeReason}
                onGenerateConnectionMessage={() =>
                  generateConnectionMessage({
                    title: r.title,
                    company: r.company,
                    description: r.description,
                    linkedinUrl: r.linkedinUrl,
                    location: r.location,
                  })
                }
              />
            ))}
          </div>
        </div>
      )}

      {tab === 'paste' && (
        <div className="space-y-4">
          <textarea
            placeholder="Paste the LinkedIn job posting text here..."
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={8}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <input
            placeholder="The LinkedIn job URL"
            value={pasteUrl}
            onChange={(e) => setPasteUrl(e.target.value)}
            className="w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--ink)]"
          />
          <button
            type="button"
            onClick={runPasteAnalysis}
            disabled={isAnalyzing || !pasteText.trim() || !pasteUrl.trim()}
            className="soft-button primary text-xs font-semibold py-3 px-5 flex items-center gap-2 disabled:opacity-60"
          >
            {isAnalyzing ? <Loader2 size={14} className="animate-spin" /> : null}
            Analyze this job
          </button>

          {pasteResult && (
            <LinkedInMatchView
              title={pasteResult.title}
              company={pasteResult.company}
              linkedinUrl={pasteResult.linkedinUrl}
              provenance="user_pasted"
              descriptionConfidence={pasteResult.descriptionConfidence}
              match={pasteResult.match}
              isPro={isPro}
              onRequireUpgrade={setUpgradeReason}
              onGenerateConnectionMessage={() =>
                generateConnectionMessage({
                  title: pasteResult.title,
                  company: pasteResult.company,
                  description: pasteResult.description,
                  linkedinUrl: pasteResult.linkedinUrl,
                })
              }
            />
          )}
        </div>
      )}

      {tab === 'linkedin' && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--muted)]">
            Opens LinkedIn&apos;s own search in a new tab — nothing is sent to RemoteMatch.
          </p>
          <a
            href={buildLinkedInJobSearchUrl(filters)}
            target="_blank"
            rel="noopener noreferrer"
            className="soft-button primary text-xs font-semibold py-3 px-5 inline-flex items-center gap-2"
          >
            Search on LinkedIn <ExternalLink size={14} />
          </a>
        </div>
      )}

      <UpgradeModal
        isOpen={upgradeReason !== null}
        onClose={() => setUpgradeReason(null)}
        reason={upgradeReason ?? undefined}
        onUpgraded={() => fetchServerEntitlement().then(setEnt)}
      />
    </div>
  );
}

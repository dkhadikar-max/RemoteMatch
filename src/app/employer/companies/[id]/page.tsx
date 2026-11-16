'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import { EMPLOYER_INDUSTRIES, EMPLOYER_COMPANY_SIZES } from '@/lib/employer/taxonomy';

interface Company {
  id: string;
  legal_name: string;
  official_website: string;
  official_domain: string;
  business_email: string;
  country_of_registration: string;
  registration_number: string | null;
  linkedin_url: string | null;
  industry: string | null;
  company_size: string | null;
  description: string | null;
  headquarters: string | null;
  verification_status: string;
  verification_reason: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending review',
  under_review: 'Under review',
  verified: 'Verified',
  rejected: 'Rejected',
  suspended: 'Suspended',
};

const EDITABLE_FIELDS: { key: keyof Company; label: string }[] = [
  { key: 'description', label: 'Company description' },
  { key: 'headquarters', label: 'Headquarters' },
  { key: 'industry', label: 'Industry' },
  { key: 'company_size', label: 'Company size' },
  { key: 'linkedin_url', label: 'LinkedIn company profile' },
];

/**
 * Direct Employer Supply, Phase 1 — minimal company profile view/edit.
 * Editable fields are cosmetic-only (Phase 1 plan Q6) — identity fields
 * (legal name, domain, business email, registration number) have no edit
 * route at all and are rendered read-only here.
 */
export default function EmployerCompanyPage() {
  const { id } = useParams<{ id: string }>();
  const [company, setCompany] = useState<Company | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Partial<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/employer/companies/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load company.');
      setCompany(data.company);
      setRole(data.role);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const canEdit = role === 'owner' || role === 'admin';

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/employer/companies/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: edits.description,
          headquarters: edits.headquarters,
          industry: edits.industry,
          companySize: edits.company_size,
          linkedinUrl: edits.linkedin_url,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed.');
      setCompany(data.company);
      setEdits({});
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error) return <div className="p-8 text-sm font-medium text-[var(--danger)]">{error}</div>;
  if (!company) return <div className="p-8 text-sm text-[var(--muted)]">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-xl font-bold text-[var(--ink)]">{company.legal_name}</h1>
        <p className="text-sm text-[var(--muted)]">{company.official_domain}</p></div>
        <a href={"/employer/jobs/new?companyId=" + id} className="soft-button primary inline-flex">Create job draft</a>
      </div>

      <div className="soft-card border border-[var(--line)] p-4">
        <p className="text-sm font-semibold text-[var(--ink)]">
          Status: {STATUS_LABEL[company.verification_status] ?? company.verification_status}
        </p>
        {company.verification_status === 'pending' && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            Your registration is awaiting admin review. You&apos;ll be notified once it&apos;s verified.
          </p>
        )}
        {company.verification_status === 'rejected' && company.verification_reason && (
          <p className="mt-1 text-xs text-[var(--danger)]">Reason: {company.verification_reason}</p>
        )}
        {company.verification_status === 'suspended' && company.verification_reason && (
          <p className="mt-1 text-xs text-[var(--danger)]">Reason: {company.verification_reason}</p>
        )}
      </div>

      <div className="soft-card border border-[var(--line)] p-4 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Registration (read-only)</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-[var(--muted)]">Official website</dt><dd className="text-[var(--ink)]">{company.official_website}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Business email</dt><dd className="text-[var(--ink)]">{company.business_email}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Country of registration</dt><dd className="text-[var(--ink)]">{company.country_of_registration}</dd></div>
          <div><dt className="text-xs text-[var(--muted)]">Registration number</dt><dd className="text-[var(--ink)]">{company.registration_number ?? '—'}</dd></div>
        </dl>
      </div>

      <div className="soft-card border border-[var(--line)] p-4 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Company profile</h2>
        {EDITABLE_FIELDS.map(({ key, label }) => (
          <div key={key}>
            <label className="text-sm font-medium text-[var(--ink)] block mb-1.5">{label}</label>
            {(key === 'industry' || key === 'company_size') ? (
              <select
                disabled={!canEdit}
                value={edits[key] ?? (company[key] as string) ?? ''}
                onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                className="soft-input py-2 px-3 text-sm w-full disabled:opacity-60"
              >
                <option value="">Select {key === 'industry' ? 'industry' : 'employee range'}</option>
                {(key === 'industry' ? EMPLOYER_INDUSTRIES : EMPLOYER_COMPANY_SIZES).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            ) : (
              <input
                disabled={!canEdit}
                value={edits[key] ?? (company[key] as string) ?? ''}
                onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                className="soft-input py-2 px-3 text-sm w-full disabled:opacity-60"
              />
            )}
          </div>
        ))}
        {canEdit && (
          <>
            {saveError && <p className="text-xs font-medium text-[var(--danger)]">{saveError}</p>}
            <button
              onClick={save}
              disabled={saving || Object.keys(edits).length === 0}
              className="rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-sm font-semibold px-3.5 py-2 transition-colors"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

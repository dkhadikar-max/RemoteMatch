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

  if (error) return <main className="mx-auto max-w-3xl px-4 py-8"><div role="alert" className="rounded-xl border border-[var(--danger)]/20 bg-[var(--danger)]/5 p-4 text-sm text-[var(--danger)]">{error}</div></main>;
  if (!company) return <main className="mx-auto max-w-3xl px-4 py-8"><div role="status" className="soft-card rounded-2xl border border-[var(--line)] p-6 text-sm text-[var(--muted)]">Loading company profile…</div></main>;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-10 space-y-6 sm:space-y-8">
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Company profile</p>
          <h1 className="break-words text-2xl sm:text-3xl font-bold tracking-tight text-[var(--ink)]">{company.legal_name}</h1>
          <p className="text-sm text-[var(--muted)] break-words">{company.official_domain}</p>
        </div>
        <a href={"/employer/jobs/new?companyId=" + id} className="soft-button primary inline-flex min-h-11 w-full sm:w-auto items-center justify-center">Create job draft</a>
      </header>

      <section className="soft-card rounded-2xl border border-[var(--line)] p-4 sm:p-5 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--ink)]">Verification status</h2>
          <span className="inline-flex min-h-8 items-center rounded-full border border-[var(--line)] bg-[var(--surface-soft)] px-3 text-xs font-semibold text-[var(--ink)]">
            {STATUS_LABEL[company.verification_status] ?? company.verification_status}
          </span>
        </div>
        {company.verification_status === 'pending' && <p className="text-sm leading-6 text-[var(--muted)]">Your registration is awaiting admin review. You&apos;ll be notified once it&apos;s verified.</p>}
        {company.verification_status === 'rejected' && company.verification_reason && <p className="text-sm leading-6 text-[var(--danger)]">Reason: {company.verification_reason}</p>}
        {company.verification_status === 'suspended' && company.verification_reason && <p className="text-sm leading-6 text-[var(--danger)]">Reason: {company.verification_reason}</p>}
      </section>

      <section className="soft-card rounded-2xl border border-[var(--line)] p-4 sm:p-6 space-y-4">
        <div><h2 className="text-sm font-semibold text-[var(--ink)]">Registration details</h2><p className="mt-1 text-xs text-[var(--muted)]">Identity information is read-only.</p></div>
        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">Official website</dt><dd className="mt-1 break-words text-[var(--ink)]">{company.official_website}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">Business email</dt><dd className="mt-1 break-words text-[var(--ink)]">{company.business_email}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">Country of registration</dt><dd className="mt-1 break-words text-[var(--ink)]">{company.country_of_registration}</dd></div>
          <div className="min-w-0"><dt className="text-xs text-[var(--muted)]">Registration number</dt><dd className="mt-1 break-words text-[var(--ink)]">{company.registration_number ?? '—'}</dd></div>
        </dl>
      </section>

      <section className="soft-card rounded-2xl border border-[var(--line)] p-4 sm:p-6 space-y-5">
        <div><h2 className="text-sm font-semibold text-[var(--ink)]">Company profile</h2><p className="mt-1 text-xs text-[var(--muted)]">Keep your public company information accurate and current.</p></div>
        {EDITABLE_FIELDS.map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <label className="block text-sm font-medium text-[var(--ink)]">{label}
              {(key === 'industry' || key === 'company_size') ? (
                <select
                  disabled={!canEdit}
                  value={edits[key] ?? (company[key] as string) ?? ''}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="soft-input mt-1.5 min-h-11 w-full px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="">Select {key === 'industry' ? 'industry' : 'employee range'}</option>
                  {(key === 'industry' ? EMPLOYER_INDUSTRIES : EMPLOYER_COMPANY_SIZES).map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              ) : (
                <input
                  disabled={!canEdit}
                  value={edits[key] ?? (company[key] as string) ?? ''}
                  onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                  className="soft-input mt-1.5 min-h-11 w-full px-3 py-2 text-sm disabled:opacity-60"
                />
              )}
            </label>
          </div>
        ))}
        {!canEdit && <p className="text-xs leading-5 text-[var(--muted)]">Only company owners and admins can edit these details.</p>}
        {canEdit && (
          <div className="border-t border-[var(--line)] pt-4 space-y-3">
            {saveError && <p role="alert" className="rounded-xl border border-[var(--danger)]/20 bg-[var(--danger)]/5 px-4 py-3 text-sm text-[var(--danger)]">{saveError}</p>}
            <button onClick={save} disabled={saving || Object.keys(edits).length === 0} className="soft-button primary min-h-11 w-full sm:w-auto justify-center disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

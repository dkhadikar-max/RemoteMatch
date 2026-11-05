'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2 } from 'lucide-react';

interface FormState {
  legalName: string;
  officialWebsite: string;
  businessEmail: string;
  countryOfRegistration: string;
  registrationNumber: string;
  linkedinUrl: string;
  industry: string;
  companySize: string;
  description: string;
  headquarters: string;
  representativeName: string;
  representativeDesignation: string;
  representativeRelationship: string;
}

const EMPTY_FORM: FormState = {
  legalName: '',
  officialWebsite: '',
  businessEmail: '',
  countryOfRegistration: '',
  registrationNumber: '',
  linkedinUrl: '',
  industry: '',
  companySize: '',
  description: '',
  headquarters: '',
  representativeName: '',
  representativeDesignation: '',
  representativeRelationship: '',
};

const REQUIRED_FIELDS: (keyof FormState)[] = [
  'legalName',
  'officialWebsite',
  'businessEmail',
  'countryOfRegistration',
  'representativeName',
  'representativeDesignation',
  'representativeRelationship',
];

function Field({
  label,
  name,
  value,
  onChange,
  required,
  type = 'text',
  placeholder,
}: {
  label: string;
  name: keyof FormState;
  value: string;
  onChange: (name: keyof FormState, value: string) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium text-[var(--ink)] block mb-1.5">
        {label}
        {required && <span className="text-[var(--red)]"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(name, e.target.value)}
        className="soft-input py-2.5 px-3.5 text-sm w-full"
      />
    </div>
  );
}

/**
 * Direct Employer Supply, Phase 1 — employer self-registration. Submits to
 * POST /api/employer/register, which creates a `pending` companies row +
 * the caller's own `company_members` row (role 'owner'). No business-email
 * verification here (Phase 1 plan Q2) — the registration simply moves into
 * the admin review queue.
 */
export default function EmployerRegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (name: keyof FormState, value: string) => setForm((f) => ({ ...f, [name]: value }));

  const missingRequired = REQUIRED_FIELDS.filter((f) => !form[f].trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (missingRequired.length > 0) {
      setError('Please fill in all required fields.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/employer/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed.');
        setSubmitting(false);
        return;
      }
      router.push(`/employer/companies/${data.companyId}`);
    } catch {
      setError('Registration failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-1.5">
          <div className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--red-soft)] text-[var(--red)]">
            <Building2 size={20} />
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-[var(--ink)]">Register your company</h1>
          <p className="text-sm text-[var(--muted)]">
            Submit your company for verification. Once verified, you&apos;ll be able to publish vacancies directly on RemoteMatch.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="soft-card p-6 space-y-4 border border-[var(--line)]">
          <Field label="Legal / registered company name" name="legalName" value={form.legalName} onChange={update} required />
          <Field label="Official website" name="officialWebsite" value={form.officialWebsite} onChange={update} required placeholder="https://example.com" />
          <Field label="Business email" name="businessEmail" value={form.businessEmail} onChange={update} required type="email" placeholder="you@example.com" />
          <Field label="Country of registration" name="countryOfRegistration" value={form.countryOfRegistration} onChange={update} required />
          <Field label="Company registration number" name="registrationNumber" value={form.registrationNumber} onChange={update} />
          <Field label="LinkedIn company profile" name="linkedinUrl" value={form.linkedinUrl} onChange={update} />
          <Field label="Industry" name="industry" value={form.industry} onChange={update} />
          <Field label="Company size" name="companySize" value={form.companySize} onChange={update} placeholder="e.g. 11-50" />
          <Field label="Headquarters" name="headquarters" value={form.headquarters} onChange={update} />
          <div>
            <label className="text-sm font-medium text-[var(--ink)] block mb-1.5">Company description</label>
            <textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              rows={3}
              className="soft-input py-2.5 px-3.5 text-sm w-full"
            />
          </div>

          <div className="border-t border-[var(--line)] pt-4 space-y-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Authorized representative (you)</p>
            <Field label="Your name" name="representativeName" value={form.representativeName} onChange={update} required />
            <Field label="Your designation" name="representativeDesignation" value={form.representativeDesignation} onChange={update} required placeholder="e.g. Head of Talent" />
            <Field label="Your relationship with the company" name="representativeRelationship" value={form.representativeRelationship} onChange={update} required placeholder="e.g. Employee, Founder, Agency partner" />
          </div>

          {error && <p className="text-sm font-medium text-[var(--danger)]">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] disabled:opacity-40 text-white text-sm font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]"
          >
            {submitting ? 'Submitting…' : 'Submit for verification'}
          </button>
        </form>
      </div>
    </div>
  );
}

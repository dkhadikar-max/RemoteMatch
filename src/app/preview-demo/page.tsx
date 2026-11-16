import Link from 'next/link';
import { DEMO_COMPANY_ID } from '@/lib/preview-demo/fixtures';

const screens = [
  { href: '/preview-demo/employer', label: 'Employer dashboard' },
  { href: `/preview-demo/employer/jobs/new?companyId=${DEMO_COMPANY_ID}`, label: 'Employer job creation form' },
  { href: `/preview-demo/employer/companies/${DEMO_COMPANY_ID}/applications`, label: 'Employer application review' },
  { href: `/preview-demo/employer/companies/${DEMO_COMPANY_ID}`, label: 'Employer company profile' },
  { href: '/preview-demo/onboarding', label: 'Candidate onboarding' },
];

export default function PreviewDemoIndexPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 space-y-4">
      <h1 className="text-2xl font-bold">PR #137 preview — static demo screens</h1>
      <p className="text-sm text-[var(--muted)]">
        Each link below renders the real, unmodified page component from this PR, backed by static mock
        data instead of a live session. No production data or credentials are involved.
      </p>
      <ul className="space-y-2">
        {screens.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="text-[var(--red)] underline">
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

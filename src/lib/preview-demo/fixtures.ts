// Static fixtures for the /preview-demo route tree only. Not imported by any
// real page or API route — see src/lib/preview-demo/mock-fetch.ts for how
// these are served.

export const DEMO_COMPANY_ID = 'demo-company-1';
export const DEMO_JOB_ID = 'demo-job-1';

export const demoCompany = {
  id: DEMO_COMPANY_ID,
  legal_name: 'Northwind Labs Inc.',
  official_website: 'https://northwindlabs.example.com',
  official_domain: 'northwindlabs.example.com',
  business_email: 'hiring@northwindlabs.example.com',
  country_of_registration: 'United States',
  registration_number: 'DE-00123456',
  linkedin_url: 'https://www.linkedin.com/company/northwindlabs',
  industry: 'Information Technology & Software',
  company_size: '51-200',
  description: 'Northwind Labs builds workflow automation tools for distributed teams.',
  headquarters: 'Austin, TX',
  verification_status: 'verified',
  verification_reason: null as string | null,
};

export const demoJobs = [
  {
    id: DEMO_JOB_ID,
    title: 'Senior Product Designer',
    status: 'published',
    review_reason: null as string | null,
    updated_at: '2026-11-10T09:00:00.000Z',
    published_opportunity_id: 'opp_demo_1',
  },
  {
    id: 'demo-job-2',
    title: 'Backend Engineer (Node.js)',
    status: 'draft',
    review_reason: null as string | null,
    updated_at: '2026-11-14T15:30:00.000Z',
    published_opportunity_id: null as string | null,
  },
  {
    id: 'demo-job-3',
    title: 'Customer Success Manager',
    status: 'submitted',
    review_reason: null as string | null,
    updated_at: '2026-11-12T11:00:00.000Z',
    published_opportunity_id: null as string | null,
  },
];

export const demoApplications = [
  {
    id: 'demo-app-1',
    cover_note:
      "I've led three remote design teams end-to-end and shipped a design system used across 40+ engineers. Excited about Northwind's async-first culture.",
    status: 'reviewing',
    submitted_at: '2026-11-13T10:15:00.000Z',
    employer_job_submissions: { title: 'Senior Product Designer' },
    profiles: {
      id: 'demo-profile-1',
      email: 'avery.chen@example.com',
      full_name: 'Avery Chen',
      headline: 'Senior Product Designer · 8 yrs',
      avatar_url: null as string | null,
      linkedin_url: 'https://www.linkedin.com/in/averychen',
    },
  },
  {
    id: 'demo-app-2',
    cover_note: 'Strong background in design systems and accessibility audits. Open to relocating within the same timezone band.',
    status: 'shortlisted',
    submitted_at: '2026-11-12T08:40:00.000Z',
    employer_job_submissions: { title: 'Senior Product Designer' },
    profiles: {
      id: 'demo-profile-2',
      email: 'jordan.lee@example.com',
      full_name: 'Jordan Lee',
      headline: 'Product Designer · 5 yrs',
      avatar_url: null as string | null,
      linkedin_url: null as string | null,
    },
  },
];

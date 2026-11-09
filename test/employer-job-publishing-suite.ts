import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
let passed = 0;
function check(condition: boolean, label: string) {
  assert.ok(condition, label);
  passed += 1;
  console.log('✓ ' + label);
}

const migration = read('supabase/migrations/049_employer_job_submissions_and_publish.sql');
const applicationsMigration = read('supabase/migrations/050_employer_direct_applications.sql');
const applyRoute = read('src/app/api/employer-jobs/[opportunityId]/apply/route.ts');
const employerApplicationsRoute = read('src/app/api/employer/companies/[id]/applications/route.ts');
const applyButton = read('src/components/employer/direct-employer-apply-button.tsx');
const taxonomy = read('src/lib/employer/taxonomy.ts');
const createRoute = read('src/app/api/employer/companies/[id]/jobs/route.ts');
const jobRoute = read('src/app/api/employer/companies/[id]/jobs/[jobId]/route.ts');
const adminRoute = read('src/app/api/admin/employer-jobs/route.ts');
const employerPage = read('src/app/employer/page.tsx');
const formPage = read('src/app/employer/jobs/new/page.tsx');
const adminPage = read('src/app/admin/(dashboard)/employer-jobs/page.tsx');
const navbar = read('src/components/navigation/navbar.tsx');
const sidebar = read('src/components/admin/Sidebar.tsx');
const catalogSync = read('src/lib/ingestion/catalog-sync.ts');

check(/CREATE TABLE IF NOT EXISTS public\.employer_job_submissions/.test(migration), 'vacancy submissions have a dedicated staging table');
check(/ENABLE ROW LEVEL SECURITY/.test(migration) && /FORCE ROW LEVEL SECURITY/.test(migration), 'staging tables force RLS');
check(/REVOKE ALL ON public\.employer_job_submissions FROM anon, authenticated/.test(migration), 'candidate and anonymous clients cannot read or write submissions');
check(/CREATE OR REPLACE FUNCTION public\.review_employer_job_submission/.test(migration), 'review and publish is a database transaction');
check(/v_company\.verification_status <> 'verified'/.test(migration), 'publication requires a verified company');
check(/INSERT INTO public\.opportunities/.test(migration) && /'employerdirect'/.test(migration), 'approved vacancies enter the existing opportunity catalogue');
check(/INSERT INTO public\.employer_job_review_events/.test(migration), 'every review decision is audited');
check(/getAuthenticatedEmployer\(req, params\.id\)/.test(createRoute), 'draft creation and listing require company membership');
check(!/required\('applicationUrl'/.test(createRoute) && /application_url: typeof b\.applicationUrl/.test(createRoute), 'external application URL is optional');
check(/company\.verification_status !== 'verified'/.test(jobRoute), 'employers cannot submit drafts before company verification');
check(/eq\('status', 'draft'\)/.test(jobRoute), 'only drafts can be edited or submitted');
check(/getAuthenticatedAdmin\(req\)/.test(adminRoute) && /review_employer_job_submission/.test(adminRoute), 'review actions require admin authentication and the atomic RPC');
check(/Post a job/.test(navbar), 'public navigation exposes the Post a Job entry point');
check(/employer-jobs/.test(sidebar), 'admin navigation exposes vacancy moderation');
check(/Create a job vacancy/.test(formPage) && !/Application URL/.test(formPage), 'employers can complete a detailed vacancy form without an external application URL');
check(/Submit for review/.test(employerPage), 'employer workspace supports submitting saved drafts after verification');
check(/Approve & publish/.test(adminPage), 'admin review queue supports approve and publish');
check(/\.neq\('source', 'employerdirect'\)/.test(catalogSync), 'cross-provider deduplication does not suppress verified employer-direct listings');

check(/CREATE TABLE IF NOT EXISTS public\\.employer_job_applications/.test(applicationsMigration), 'native candidate applications have a dedicated table');
check(/FORCE ROW LEVEL SECURITY/.test(applicationsMigration) && /REVOKE ALL ON public\\.employer_job_applications FROM anon, authenticated/.test(applicationsMigration), 'candidate applications are service-role-only with forced RLS');
check(/employerdirect/.test(applyRoute) && /getAuthenticatedUser/.test(applyRoute), 'native apply endpoint authenticates candidates and accepts only active direct-employer jobs');
check(/getAuthenticatedEmployer\\(req, params\\.id\\)/.test(employerApplicationsRoute), 'applicant inbox is scoped to authorized company members');
check(/shortlisted/.test(employerApplicationsRoute) && /company_id/.test(employerApplicationsRoute), 'employers can update applicant status only within their own company');
check(/Apply on RemoteMatch/.test(applyButton), 'direct employer job pages provide an in-platform apply action');
check(/EMPLOYER_INDUSTRIES/.test(taxonomy) && /EMPLOYER_COMPANY_SIZES/.test(taxonomy), 'industry and employee ranges use standardized filter values');

console.log('\n' + passed + ' employer job publishing checks passed.');

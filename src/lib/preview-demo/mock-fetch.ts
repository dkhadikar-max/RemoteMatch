import {
  demoCompany,
  demoJobs,
  demoApplications,
  DEMO_COMPANY_ID,
} from './fixtures';

type JsonInit = { status?: number };

function json(body: unknown, init: JsonInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

type DemoJob = {
  id: string;
  title: string;
  status: string;
  review_reason: string | null;
  updated_at: string;
  published_opportunity_id: string | null;
  [key: string]: unknown;
};

let jobs: DemoJob[] = [...demoJobs];
let company = { ...demoCompany };
let applications = [...demoApplications];

function resetDemoState() {
  jobs = [...demoJobs];
  company = { ...demoCompany };
  applications = [...demoApplications];
}

async function readJsonBody(
  request: Request,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = init?.body !== undefined
      ? typeof init.body === 'string' ? init.body : String(init.body)
      : await request.clone().text();

    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handleMockRequest(
  path: string,
  method: string,
  request: Request,
  init?: RequestInit,
): Promise<Response | null> {
  if (path === '/api/employer/companies') {
    if (method === 'GET') return json({ companies: [company] });
    return error('Method not allowed in preview', 405);
  }

  const companyDetail = /^\/api\/employer\/companies\/([^/]+)$/.exec(path);

  if (companyDetail) {
    if (companyDetail[1] !== DEMO_COMPANY_ID) {
      return error('Demo company not found', 404);
    }

    if (method === 'GET') return json({ company, role: 'owner' });

    if (method === 'PATCH') {
      const body = await readJsonBody(request, init);
      if (!body) return error('Invalid JSON body', 400);

      company = {
        ...company,
        description: typeof body.description === 'string' ? body.description : company.description,
        headquarters: typeof body.headquarters === 'string' ? body.headquarters : company.headquarters,
        industry: typeof body.industry === 'string' ? body.industry : company.industry,
        company_size: typeof body.companySize === 'string' ? body.companySize : company.company_size,
        linkedin_url: typeof body.linkedinUrl === 'string' ? body.linkedinUrl : company.linkedin_url,
      };

      return json({ company });
    }

    return error('Method not allowed in preview', 405);
  }

  const jobsList = /^\/api\/employer\/companies\/([^/]+)\/jobs$/.exec(path);

  if (jobsList) {
    if (jobsList[1] !== DEMO_COMPANY_ID) {
      return error('Demo company not found', 404);
    }

    if (method === 'GET') return json({ jobs });

    if (method === 'POST') {
      const body = await readJsonBody(request, init);
      if (!body) return error('Invalid JSON body', 400);

      const title = typeof body.title === 'string' && body.title.trim()
        ? body.title.trim()
        : 'Untitled role';

      const newJob = {
        id: `demo-job-${Date.now()}`,
        title,
        description: typeof body.description === 'string' ? body.description : '',
        responsibilities: typeof body.responsibilities === 'string' ? body.responsibilities : '',
        employment_type: typeof body.employmentType === 'string' ? body.employmentType : '',
        remote_type: typeof body.remoteType === 'string' ? body.remoteType : '',
        location: typeof body.location === 'string' ? body.location : '',
        eligible_countries: Array.isArray(body.eligibleCountries) ? body.eligibleCountries : [],
        salary_min: typeof body.salaryMin === 'number' ? body.salaryMin : null,
        salary_max: typeof body.salaryMax === 'number' ? body.salaryMax : null,
        salary_currency: typeof body.salaryCurrency === 'string' ? body.salaryCurrency : '',
        required_skills: Array.isArray(body.requiredSkills) ? body.requiredSkills : [],
        preferred_skills: Array.isArray(body.preferredSkills) ? body.preferredSkills : [],
        experience_requirement: typeof body.experienceRequirement === 'string' ? body.experienceRequirement : '',
        status: 'draft',
        review_reason: null,
        updated_at: new Date().toISOString(),
        published_opportunity_id: null,
      };

      jobs = [newJob, ...jobs];
      return json({ job: newJob });
    }

    return error('Method not allowed in preview', 405);
  }

  const jobDetail = /^\/api\/employer\/companies\/([^/]+)\/jobs\/([^/]+)$/.exec(path);

  if (jobDetail) {
    if (jobDetail[1] !== DEMO_COMPANY_ID) {
      return error('Demo company not found', 404);
    }

    const jobId = jobDetail[2];
    const found = jobs.find((job) => job.id === jobId);

    if (!found) return error('Demo job not found', 404);

    if (method === 'GET') return json({ job: found });

    if (method === 'PATCH') {
      const body = await readJsonBody(request, init);
      if (!body) return error('Invalid JSON body', 400);

      jobs = jobs.map((job) =>
        job.id === jobId
          ? {
              ...job,
              title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : job.title,
              description: typeof body.description === 'string' ? body.description : job.description,
              responsibilities: typeof body.responsibilities === 'string' ? body.responsibilities : job.responsibilities,
              employment_type: typeof body.employmentType === 'string' ? body.employmentType : job.employment_type,
              remote_type: typeof body.remoteType === 'string' ? body.remoteType : job.remote_type,
              location: typeof body.location === 'string' ? body.location : job.location,
              eligible_countries: Array.isArray(body.eligibleCountries) ? body.eligibleCountries : job.eligible_countries,
              salary_min: typeof body.salaryMin === 'number' || body.salaryMin === null ? body.salaryMin : job.salary_min,
              salary_max: typeof body.salaryMax === 'number' || body.salaryMax === null ? body.salaryMax : job.salary_max,
              salary_currency: typeof body.salaryCurrency === 'string' ? body.salaryCurrency : job.salary_currency,
              required_skills: Array.isArray(body.requiredSkills) ? body.requiredSkills : job.required_skills,
              preferred_skills: Array.isArray(body.preferredSkills) ? body.preferredSkills : job.preferred_skills,
              experience_requirement: typeof body.experienceRequirement === 'string' ? body.experienceRequirement : job.experience_requirement,
              updated_at: new Date().toISOString(),
            }
          : job,
      );

      return json({ job: jobs.find((job) => job.id === jobId) });
    }

    if (method === 'POST') {
      jobs = jobs.map((job) =>
        job.id === jobId ? { ...job, status: 'submitted' } : job,
      );

      return json({ job: jobs.find((job) => job.id === jobId) });
    }

    return error('Method not allowed in preview', 405);
  }

  const applicationsList =
    /^\/api\/employer\/companies\/([^/]+)\/applications$/.exec(path);

  if (applicationsList) {
    if (applicationsList[1] !== DEMO_COMPANY_ID) {
      return error('Demo company not found', 404);
    }

    if (method === 'GET') return json({ applications });

    if (method === 'PATCH') {
      const body = await readJsonBody(request, init);
      if (!body) return error('Invalid JSON body', 400);

      const applicationId =
        typeof body.applicationId === 'string' ? body.applicationId : '';
      const expectedStatus =
        typeof body.expectedStatus === 'string' ? body.expectedStatus : '';
      const status = typeof body.status === 'string' ? body.status : '';
      const reasonCode =
        typeof body.reasonCode === 'string' ? body.reasonCode.trim() : '';
      const idempotencyKey =
        typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';

      if (!applicationId || !expectedStatus || !status || !idempotencyKey) {
        return error(
          'applicationId, expectedStatus, status and idempotencyKey are required',
          400,
        );
      }

      const validStatuses = [
        'reviewing',
        'shortlisted',
        'interviewing',
        'offered',
        'rejected',
        'hired',
      ];

      const validReasons = [
        'strong_experience',
        'relevant_achievements',
        'strong_technical_skills',
        'transferable_capabilities',
        'insufficient_experience',
        'missing_mandatory_qualification',
        'location_ineligible',
        'poor_role_fit',
        'insufficient_evidence',
        'position_filled',
        'candidate_withdrew',
        'other',
      ];

      if (!validStatuses.includes(status) || !validStatuses.includes(expectedStatus)) {
        return error('Invalid application status', 400);
      }

      if (reasonCode && !validReasons.includes(reasonCode)) {
        return error('Invalid decision reason', 400);
      }

      const application = applications.find(
        (item) => item.id === applicationId,
      );

      if (!application) {
        return error('Demo application not found', 404);
      }

      if (application.status !== expectedStatus) {
        return error(
          'Application status has changed. Refresh and try again.',
          409,
        );
      }

      const reasonRequired =
        status === 'rejected' ||
        (expectedStatus === 'interviewing' && status === 'shortlisted') ||
        (expectedStatus === 'rejected' && status === 'reviewing');

      if (reasonRequired && !reasonCode) {
        return error(
          'A decision reason is required for this transition',
          400,
        );
      }

      applications = applications.map((item) =>
        item.id === applicationId ? { ...item, status } : item,
      );

      return json({ status });
    }

    return error('Method not allowed in preview', 405);
  }


  if (path === '/api/onboarding') {
    if (method === 'GET') {
      return error('No demo profile exists yet', 404);
    }

    if (method === 'POST') {
      const body = await readJsonBody(request, init);
      if (!body) return error('Invalid JSON body', 400);
      return json({ ok: true });
    }

    return error('Method not allowed in preview', 405);
  }

  return null;
}

let originalFetch: typeof window.fetch | null = null;

export function installPreviewDemoFetchMock() {
  if (typeof window === 'undefined' || originalFetch) return;

  resetDemoState();

  originalFetch = window.fetch.bind(window);
  const realFetch = originalFetch;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(new URL(String(input), window.location.origin), init);

    const url = new URL(request.url, window.location.origin);
    const method = (init?.method ?? request.method ?? 'GET').toUpperCase();

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const mocked = await handleMockRequest(
        url.pathname,
        method,
        request,
        init,
      );

      // Fail closed: no API request from the preview can reach a live backend.
      return mocked ?? error('This API is not available in the static preview', 404);
    }

    return realFetch(input, init);
  };
}

export function uninstallPreviewDemoFetchMock() {
  if (typeof window === 'undefined' || !originalFetch) return;

  window.fetch = originalFetch;
  originalFetch = null;
}

export { DEMO_COMPANY_ID };

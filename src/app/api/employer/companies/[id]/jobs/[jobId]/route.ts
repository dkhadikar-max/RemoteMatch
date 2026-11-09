import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedEmployer } from '@/lib/auth/get-authenticated-employer';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

const COLUMNS = 'id,company_id,title,description,responsibilities,employment_type,remote_type,location,eligible_countries,salary_min,salary_max,salary_currency,required_skills,preferred_skills,experience_requirement,application_url,status,review_reason,published_opportunity_id,created_at,updated_at,submitted_at';
const allowed = ['title','description','responsibilities','employmentType','remoteType','location','eligibleCountries','salaryMin','salaryMax','salaryCurrency','requiredSkills','preferredSkills','experienceRequirement'];
function valid(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !allowed.includes(k))) return false;
  const required = (k: string, max: number) => typeof b[k] === 'string' && Boolean((b[k] as string).trim()) && (b[k] as string).length <= max;
  const optional = (k: string, max: number) => b[k] === undefined || b[k] === null || (typeof b[k] === 'string' && (b[k] as string).length <= max);
  const arr = (k: string) => b[k] === undefined || (Array.isArray(b[k]) && (b[k] as unknown[]).length <= 50 && (b[k] as unknown[]).every(x => typeof x === 'string' && x.length <= 80));
  const num = (k: string) => b[k] === undefined || b[k] === null || (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) >= 0);
  return required('title',180) && required('description',20000) && (String(b.description).trim().length >= 30) && optional('responsibilities',10000) &&
    required('employmentType',30) && ['Full-time','Part-time','Contract','Temporary','Internship'].includes(String(b.employmentType)) &&
    required('remoteType',20) && ['Remote','Hybrid','On-site'].includes(String(b.remoteType)) &&
    required('location',180) && arr('eligibleCountries') && num('salaryMin') && num('salaryMax') &&
    optional('salaryCurrency',3) && (b.salaryCurrency === undefined || /^[A-Z]{3}$/.test(String(b.salaryCurrency).toUpperCase())) && arr('requiredSkills') && arr('preferredSkills') &&
    optional('experienceRequirement',180) && required('applicationUrl',1000);
}
function toRow(b: Record<string, unknown>) {
  return {
    title: (b.title as string).trim(), description: (b.description as string).trim(),
    responsibilities: typeof b.responsibilities === 'string' ? b.responsibilities.trim() : '',
    employment_type: b.employmentType, remote_type: b.remoteType,
    location: (b.location as string).trim(), eligible_countries: b.eligibleCountries ?? [],
    salary_min: b.salaryMin ?? null, salary_max: b.salaryMax ?? null,
    salary_currency: typeof b.salaryCurrency === 'string' ? b.salaryCurrency.toUpperCase() : 'USD',
    required_skills: b.requiredSkills ?? [], preferred_skills: b.preferredSkills ?? [],
    experience_requirement: b.experienceRequirement ?? null, application_url: (b.applicationUrl as string).trim(),
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string; jobId: string } }) {
  try { await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const job = must(await db.from('employer_job_submissions').select(COLUMNS)
      .eq('company_id', params.id).eq('id', params.jobId).maybeSingle(), 'employer_job_submissions').data;
    return job ? NextResponse.json({ job }) : NextResponse.json({ error: 'Job not found.' }, { status: 404 });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string; jobId: string } }) {
  let employer;
  try { employer = await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  if (employer.role === 'member') return NextResponse.json({ error: 'Only company owners and admins can edit vacancies.' }, { status: 403 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  if (!valid(body)) return NextResponse.json({ error: 'Complete all required job fields with valid values.' }, { status: 400 });
  if (body.salaryMin != null && body.salaryMax != null && Number(body.salaryMax) < Number(body.salaryMin)) return NextResponse.json({ error: 'Maximum salary must be greater than or equal to minimum salary.' }, { status: 400 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const job = must(await db.from('employer_job_submissions').update({ ...toRow(body), updated_at: new Date().toISOString() })
      .eq('company_id', params.id).eq('id', params.jobId).eq('status', 'draft').select(COLUMNS).maybeSingle(), 'employer_job_submissions').data;
    return job ? NextResponse.json({ job }) : NextResponse.json({ error: 'Only a draft can be edited.' }, { status: 409 });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Could not update draft.' }, { status: 500 }); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string; jobId: string } }) {
  let employer;
  try { employer = await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  if (employer.role === 'member') return NextResponse.json({ error: 'Only company owners and admins can submit vacancies.' }, { status: 403 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const company = must(await db.from('companies').select('verification_status').eq('id', params.id).maybeSingle(), 'companies').data;
    if (!company) return NextResponse.json({ error: 'Company not found.' }, { status: 404 });
    if (company.verification_status !== 'verified') return NextResponse.json({ error: 'Company verification must be complete before a vacancy can be submitted for review. Your draft is saved.' }, { status: 409 });
    const job = must(await db.from('employer_job_submissions').update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('company_id', params.id).eq('id', params.jobId).eq('status', 'draft').select(COLUMNS).maybeSingle(), 'employer_job_submissions').data;
    return job ? NextResponse.json({ job }) : NextResponse.json({ error: 'Draft not found or already submitted.' }, { status: 409 });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Could not submit job.' }, { status: 500 }); }
}

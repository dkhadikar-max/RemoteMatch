import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedEmployer } from '@/lib/auth/get-authenticated-employer';
import { authErrorResponse } from '@/lib/auth/api-error';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { must } from '@/lib/supabase/query-helpers';
import { queryErrorResponse } from '@/lib/admin/sections';

const COLUMNS = 'id,company_id,title,description,responsibilities,employment_type,remote_type,location,eligible_countries,salary_min,salary_max,salary_currency,required_skills,preferred_skills,experience_requirement,application_url,status,review_reason,published_opportunity_id,created_at,updated_at,submitted_at';
const allowed = ['title','description','responsibilities','employmentType','remoteType','location','eligibleCountries','salaryMin','salaryMax','salaryCurrency','requiredSkills','preferredSkills','experienceRequirement','applicationUrl'];
function valid(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some(k => !allowed.includes(k))) return false;
  const str = (k: string, max: number, required = false) => b[k] === undefined ? !required : (typeof b[k] === 'string' && (b[k] as string).length <= max && (!required || Boolean((b[k] as string).trim())));
  const arr = (k: string) => b[k] === undefined || (Array.isArray(b[k]) && (b[k] as unknown[]).length <= 50 && (b[k] as unknown[]).every(x => typeof x === 'string' && x.length <= 80));
  const num = (k: string) => b[k] === undefined || b[k] === null || (typeof b[k] === 'number' && Number.isFinite(b[k]) && (b[k] as number) >= 0);
  return str('title',180,true) && str('description',20000,true) && (String(b.description ?? '').trim().length >= 30) && str('responsibilities',10000) &&
    str('employmentType',30,true) && ['Full-time','Part-time','Contract','Temporary','Internship'].includes(String(b.employmentType)) &&
    str('remoteType',20,true) && ['Remote','Hybrid','On-site'].includes(String(b.remoteType)) &&
    str('location',180,true) && arr('eligibleCountries') && num('salaryMin') && num('salaryMax') &&
    str('salaryCurrency',3) && (b.salaryCurrency === undefined || /^[A-Z]{3}$/.test(String(b.salaryCurrency).toUpperCase())) && arr('requiredSkills') && arr('preferredSkills') &&
    str('experienceRequirement',180) && str('applicationUrl',1000,true);
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
    experience_requirement: b.experienceRequirement ?? null,
    application_url: (b.applicationUrl as string).trim(),
  };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  try { await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const jobs = must(await db.from('employer_job_submissions').select(COLUMNS)
      .eq('company_id', params.id).order('updated_at', { ascending: false }), 'employer_job_submissions').data ?? [];
    return NextResponse.json({ jobs });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  let employer;
  try { employer = await getAuthenticatedEmployer(req, params.id); }
  catch (err) { return authErrorResponse(err) ?? NextResponse.json({ error: 'Internal error' }, { status: 500 }); }
  if (employer.role === 'member') return NextResponse.json({ error: 'Only company owners and admins can create vacancies.' }, { status: 403 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 }); }
  if (!valid(body)) return NextResponse.json({ error: 'Complete all required job fields with valid values.' }, { status: 400 });
  if (body.salaryMin != null && body.salaryMax != null && Number(body.salaryMax) < Number(body.salaryMin)) {
    return NextResponse.json({ error: 'Maximum salary must be greater than or equal to minimum salary.' }, { status: 400 });
  }
  let url: URL;
  try { url = new URL(String(body.applicationUrl)); } catch { return NextResponse.json({ error: 'Application URL must be a valid HTTPS URL.' }, { status: 400 }); }
  if (url.protocol !== 'https:') return NextResponse.json({ error: 'Application URL must use HTTPS.' }, { status: 400 });
  const db = getSupabaseAdminClient();
  if (!db) return NextResponse.json({ error: 'Service temporarily unavailable.' }, { status: 503 });
  try {
    const row = must(await db.from('employer_job_submissions').insert({
      company_id: params.id, created_by: employer.user.id, ...toRow(body),
    }).select(COLUMNS).single(), 'employer_job_submissions').data;
    return NextResponse.json({ job: row }, { status: 201 });
  } catch (err) { return queryErrorResponse(err) ?? NextResponse.json({ error: 'Could not save job draft.' }, { status: 500 }); }
}

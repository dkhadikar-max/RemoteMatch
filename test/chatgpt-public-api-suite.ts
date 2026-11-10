import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ws from 'ws';
import { createClient } from '@supabase/supabase-js';

(globalThis as typeof globalThis & { WebSocket?: typeof WebSocket }).WebSocket = ws as unknown as typeof WebSocket;

const baseUrl = process.env.TEST_BASE_URL ?? 'http://localhost:3100';
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(supabaseUrl && serviceRoleKey, 'isolated Supabase test credentials are required');

const admin = createClient(supabaseUrl!, serviceRoleKey!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const sourceId = `chatgpt-api/${randomUUID()}`;
const exclusionSourceId = `chatgpt-country-exclusion/${randomUUID()}`;
const postedAt = new Date(Date.now() - 60_000).toISOString();

async function get(path: string) {
  return fetch(new URL(path, baseUrl), { headers: { Accept: 'application/json' } });
}

async function main() {
  const invalidLimit = await get('/api/integrations/chatgpt/jobs?limit=26');
  assert.equal(invalidLimit.status, 400, 'search API must reject an oversized page');

  const invalidSalary = await get('/api/integrations/chatgpt/jobs?minSalary=-1');
  assert.equal(invalidSalary.status, 400, 'search API must reject a negative salary');

  const invalidId = await get('/api/integrations/chatgpt/jobs/not-a-canonical-id');
  assert.equal(invalidId.status, 400, 'job details API must reject malformed canonical IDs');

  const { error: seedError } = await admin.from('opportunities').insert({
    source: 'remotive',
    source_id: sourceId,
    type: 'job',
    title: 'ChatGPT API Test — Senior TypeScript Engineer',
    company: 'RemoteMatch Integration Test',
    company_logo: null,
    description: 'Synthetic isolated integration fixture for ChatGPT job discovery and details.',
    source_url: 'https://example.com/source',
    official_url: 'https://example.com/apply',
    canonical_url_hash: `chatgpt-api-${sourceId}`,
    content_hash: `chatgpt-content-${sourceId}`,
    employment_type: 'Full-time',
    remote_type: 'Specific countries',
    eligible_countries: ['IN'],
    excluded_countries: [],
    timezone_requirements: [],
    salary_min: 100000,
    salary_max: 120000,
    salary_currency: 'USD',
    salary_period: 'yearly',
    required_skills: ['TypeScript'],
    preferred_skills: ['Node.js'],
    experience_requirement: '2-3',
    quality_score: 80,
    source_quality: 80,
    description_completeness: 'high',
    salary_quality: 'verified',
    remote_policy_confidence: 'high',
    explicit_remote_scope: 'explicit_worldwide',
    status: 'active',
    posted_at: postedAt,
    first_seen_at: postedAt,
    last_seen_in_feed_at: postedAt,
    consecutive_absences: 0,
    is_permanently_removed: false,
    link_checked_at: postedAt,
  });
  assert.equal(seedError, null, `isolated job fixture must seed successfully: ${seedError?.message ?? ''}`);

  const { error: exclusionSeedError } = await admin.from('opportunities').insert({
    source: 'remotive',
    source_id: exclusionSourceId,
    type: 'job',
    title: 'Country Exclusion Test — Remote Platform Engineer',
    company: 'RemoteMatch Country Fixture',
    company_logo: null,
    description: 'Synthetic fixture verifies country exclusions for public ChatGPT discovery.',
    source_url: 'https://example.com/country-source',
    official_url: 'https://example.com/country-apply',
    canonical_url_hash: `chatgpt-country-${exclusionSourceId}`,
    content_hash: `chatgpt-country-content-${exclusionSourceId}`,
    employment_type: 'Full-time',
    remote_type: 'worldwide',
    eligible_countries: [],
    excluded_countries: ['IN', 'India', 'EU'],
    timezone_requirements: [],
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_period: null,
    required_skills: ['TypeScript'],
    preferred_skills: [],
    experience_requirement: '2-3',
    quality_score: 80,
    source_quality: 80,
    description_completeness: 'high',
    salary_quality: 'unknown',
    remote_policy_confidence: 'high',
    explicit_remote_scope: 'explicit_worldwide',
    status: 'active',
    posted_at: postedAt,
    first_seen_at: postedAt,
    last_seen_in_feed_at: postedAt,
    consecutive_absences: 0,
    is_permanently_removed: false,
    link_checked_at: postedAt,
  });
  assert.equal(exclusionSeedError, null, `country exclusion fixture must seed successfully: ${exclusionSeedError?.message ?? ''}`);

  try {
    const filterCases = [
      ['text', 'q=ChatGPT%20API%20Test'],
      ['skills', 'q=ChatGPT%20API%20Test&skills=TypeScript'],
      ['country', 'q=ChatGPT%20API%20Test&country=India'],
      ['remoteType', 'q=ChatGPT%20API%20Test&remoteType=Specific%20countries'],
      ['employmentType', 'q=ChatGPT%20API%20Test&employmentType=Full-time'],
      ['experience', 'q=ChatGPT%20API%20Test&experience=2-3'],
      ['salaryCurrency', 'q=ChatGPT%20API%20Test&salaryCurrency=USD'],
      ['minSalary', 'q=ChatGPT%20API%20Test&minSalary=90000'],
    ] as const;
    for (const [name, filters] of filterCases) {
      const filterResponse = await get(`/api/integrations/chatgpt/jobs?${filters}&limit=5`);
      assert.equal(filterResponse.status, 200, `${name} filter request should succeed`);
      const filterResult = await filterResponse.json() as { total: number };
      assert.ok(filterResult.total >= 1, `${name} filter must retain the seeded fixture`);
    }

    const indiaExclusionResponse = await get('/api/integrations/chatgpt/jobs?q=Country%20Exclusion%20Test&country=India&limit=5');
    assert.equal(indiaExclusionResponse.status, 200, 'India country-filtered search should succeed');
    const indiaExclusionResult = await indiaExclusionResponse.json() as { opportunities: Array<{ id: string }> };
    assert.equal(indiaExclusionResult.opportunities.some((item) => item.id === `opp-remotive-${exclusionSourceId}`), false,
      'a worldwide job explicitly excluding India must not appear in India results');

    const euExclusionResponse = await get('/api/integrations/chatgpt/jobs?q=Country%20Exclusion%20Test&country=Germany&limit=5');
    assert.equal(euExclusionResponse.status, 200, 'Germany country-filtered search should succeed');
    const euExclusionResult = await euExclusionResponse.json() as { opportunities: Array<{ id: string }> };
    assert.equal(euExclusionResult.opportunities.some((item) => item.id === `opp-remotive-${exclusionSourceId}`), false,
      'a worldwide job excluding the EU must not appear for an EU member country');

    const usExclusionResponse = await get('/api/integrations/chatgpt/jobs?q=Country%20Exclusion%20Test&country=US&limit=5');
    assert.equal(usExclusionResponse.status, 200, 'US country-filtered search should succeed');
    const usExclusionResult = await usExclusionResponse.json() as { opportunities: Array<{ id: string }> };
    assert.ok(usExclusionResult.opportunities.some((item) => item.id === `opp-remotive-${exclusionSourceId}`),
      'the same worldwide job must remain visible in the US');

    const response = await get('/api/integrations/chatgpt/jobs?q=ChatGPT%20API%20Test&skills=TypeScript&country=India&remoteType=Specific%20countries&employmentType=Full-time&experience=2-3&minSalary=90000&salaryCurrency=USD&limit=5');
    assert.equal(response.status, 200, 'public job search should be available');
    const result = await response.json() as {
      success: boolean;
      total: number;
      totalIsEstimate: boolean;
      limit: number;
      offset: number;
      hasMore: boolean;
      opportunities: Array<Record<string, unknown> & { id: string; title: string; company: string; jobUrl: string; applicationUrl: string; applicationMethod: string }>;
    };

    assert.equal(result.success, true);
    assert.equal(result.totalIsEstimate, true, 'public search reports that its planned count is approximate');
    assert.equal(result.limit, 5);
    assert.equal(result.offset, 0);
    assert.ok(Number.isInteger(result.total) && result.total >= 1, 'combined filters must retain the seeded fixture');
    assert.ok(Array.isArray(result.opportunities));
    assert.ok(result.opportunities.length <= 5);

    const job = result.opportunities.find((item) => item.id === `opp-remotive-${sourceId}`);
    if (!job) throw new Error(`ChatGPT search did not return seeded fixture ${sourceId}; response=${JSON.stringify({ total: result.total, opportunities: result.opportunities.map(({ id, title, company }) => ({ id, title, company })) })}`);
    assert.ok(job.title.toLowerCase().includes('chatgpt api test'), `unexpected fixture title returned: ${JSON.stringify(job.title)}`);
    assert.equal(job.company, 'RemoteMatch Integration Test');
    // Pin every field supplied by the endpoint-specific database projection; compare timestamps by instant because PostgREST may normalize timezone formatting.
    assert.equal(job.description, 'Synthetic isolated integration fixture for ChatGPT job discovery and details.');
    assert.equal(job.companyLogo, null);
    assert.equal(job.employmentType, 'Full-time');
    assert.equal(job.remoteType, 'Specific countries');
    assert.deepEqual(job.eligibleCountries, ['IN']);
    assert.deepEqual(job.excludedCountries, []);
    assert.deepEqual(job.timezoneRequirements, []);
    assert.equal(job.salaryMin, 100000);
    assert.equal(job.salaryMax, 120000);
    assert.equal(job.salaryCurrency, 'USD');
    assert.equal(job.salaryPeriod, 'yearly');
    assert.deepEqual(job.requiredSkills, ['TypeScript']);
    assert.deepEqual(job.preferredSkills, ['Node.js']);
    assert.equal(job.experienceRequirement, '2-3');
    assert.equal(Date.parse(String(job.postedAt)), Date.parse(postedAt), 'postedAt must preserve the seeded instant');
    assert.equal(Date.parse(String(job.linkCheckedAt)), Date.parse(postedAt), 'linkCheckedAt must preserve the seeded instant');
    assert.ok(job.jobUrl.startsWith('https://'));
    assert.ok(job.applicationUrl.startsWith('https://'));
    assert.equal(job.applicationMethod, 'Employer website');
    assert.equal('rawResumeText' in job, false, 'public job payload must not contain candidate resume data');
    assert.equal('candidateProfileId' in job, false, 'public job payload must not contain candidate identity');

    const detailResponse = await get(`/api/integrations/chatgpt/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(detailResponse.status, 200, 'every returned job ID must resolve through the details API');
    const detail = await detailResponse.json() as { success: boolean; opportunity?: { id: string; title: string; salaryCurrency: string } };
    assert.equal(detail.success, true);
    assert.equal(detail.opportunity?.id, job.id);
    assert.equal(detail.opportunity?.title, job.title);
    assert.equal(detail.opportunity?.salaryCurrency, 'USD');

    console.log('ChatGPT public API suite passed: filter validation, combined text/country/skill/salary filters, public-field allowlist, and job details.');
  } finally {
    const { error: cleanupError } = await admin.from('opportunities').delete().eq('source', 'remotive')
      .in('source_id', [sourceId, exclusionSourceId]);
    assert.equal(cleanupError, null, `isolated job fixtures must be cleaned up: ${cleanupError?.message ?? ''}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

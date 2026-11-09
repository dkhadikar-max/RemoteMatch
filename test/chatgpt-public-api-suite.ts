import assert from 'node:assert/strict';

const baseUrl = process.env.TEST_BASE_URL ?? 'http://localhost:3100';

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

  const response = await get('/api/integrations/chatgpt/jobs?limit=5');
  assert.equal(response.status, 200, 'public job search should be available');
  const result = await response.json() as {
    success: boolean;
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
    opportunities: Array<Record<string, unknown> & { id: string; title: string; company: string; jobUrl: string; applicationUrl: string; applicationMethod: string }>;
  };

  assert.equal(result.success, true);
  assert.equal(result.limit, 5);
  assert.equal(result.offset, 0);
  assert.ok(Number.isInteger(result.total) && result.total >= 0);
  assert.ok(Array.isArray(result.opportunities));
  assert.ok(result.opportunities.length <= 5);

  for (const job of result.opportunities) {
    assert.ok(job.id.startsWith('opp-'));
    assert.ok(job.title.length > 0);
    assert.ok(job.company.length > 0);
    assert.ok(job.jobUrl.startsWith('https://'));
    assert.ok(job.applicationUrl.startsWith('https://'));
    assert.ok(['RemoteMatch in-platform application', 'Employer website'].includes(job.applicationMethod));
    assert.equal('rawResumeText' in job, false, 'public job payload must not contain candidate resume data');
    assert.equal('candidateProfileId' in job, false, 'public job payload must not contain candidate identity');

    const detailResponse = await get(`/api/integrations/chatgpt/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(detailResponse.status, 200, 'every returned job ID must resolve through the details API');
    const detail = await detailResponse.json() as { success: boolean; opportunity?: { id: string } };
    assert.equal(detail.success, true);
    assert.equal(detail.opportunity?.id, job.id);
  }

  console.log(`ChatGPT public API suite passed: pagination validation, salary validation, ID validation, ${result.opportunities.length} job details verified.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

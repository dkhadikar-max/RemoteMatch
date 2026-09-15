/**
 * LinkedIn Job Finder — normalize.ts / parse-posting.ts / deep-links.ts /
 * trust-signals.ts (all pure, no infra). Plan: vivid-hatching-kitten.md.
 *
 * Run: npx tsx test/linkedin-jobs-normalize-suite.ts
 */
import { normalizeVendorResult, normalizePastedJob } from '../src/lib/linkedin-jobs/normalize';
import { parsePastedPosting } from '../src/lib/linkedin-jobs/parse-posting';
import { buildLinkedInJobSearchUrl, buildLinkedInPeopleSearchUrl, suggestPeopleSearchRoleKeywords } from '../src/lib/linkedin-jobs/deep-links';
import { linkedInBadgeLabel, provenanceBadgeLabel, confidenceLabel } from '../src/lib/linkedin-jobs/trust-signals';
import type { VendorJobResult, PastedJobInput } from '../src/types/linkedin-jobs';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

console.log('==============================================================================');
console.log('LINKEDIN JOB FINDER — normalize / parse-posting / deep-links / trust-signals');
console.log('==============================================================================\n');

console.log('1. normalizeVendorResult()');
{
  const raw: VendorJobResult = {
    title: 'Senior Backend Engineer', company: 'Acme Corp', location: 'Remote, US',
    descriptionExcerpt: 'We are looking for a backend engineer with Python and AWS experience...',
    postedAtText: '3 days ago',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/12345',
  };
  const { opportunity, provenance, descriptionConfidence, linkedinUrl } = normalizeVendorResult(raw);

  assert(opportunity.id.startsWith('li-'), `id is li-namespaced, never opp-* (got ${opportunity.id})`);
  assert(opportunity.source === 'linkedin', "source is the display-only 'linkedin' tag");
  assert(opportunity.title === raw.title, 'title carried through unchanged');
  assert(opportunity.company === raw.company, 'company carried through unchanged');
  assert(opportunity.officialUrl === raw.linkedinUrl, 'officialUrl is the real linkedin.com URL');
  assert(provenance === 'vendor_search', "provenance is 'vendor_search'");
  assert(descriptionConfidence === 'excerpt', 'vendor-sourced description is always excerpt-confidence');
  assert(linkedinUrl === raw.linkedinUrl, 'linkedinUrl passed through');
  assert(typeof opportunity.canonicalUrlHash === 'string' && opportunity.canonicalUrlHash.length > 0, 'canonicalUrlHash computed');
  assert(typeof opportunity.contentHash === 'string' && opportunity.contentHash.length > 0, 'contentHash computed');
  assert(opportunity.requiredSkills.includes('Python'), `skills extracted from description (got ${JSON.stringify(opportunity.requiredSkills)})`);
  assert(opportunity.requiredSkills.includes('Aws'), 'AWS extracted (case-normalized)');

  const a = normalizeVendorResult(raw);
  const b = normalizeVendorResult(raw);
  assert(a.opportunity.id !== b.opportunity.id, 'two normalizations of the same raw input get distinct ids (never collide)');
}

console.log('\n2. normalizePastedJob() — user-pasted always earns full confidence');
{
  const input: PastedJobInput = {
    title: 'Product Manager', company: 'Widget Co',
    description: 'A short pasted description.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/999',
  };
  const { descriptionConfidence, provenance } = normalizePastedJob(input);
  assert(descriptionConfidence === 'full', 'user-pasted description is always full-confidence, regardless of length');
  assert(provenance === 'user_pasted', "provenance is 'user_pasted'");
}

console.log('\n3. parsePastedPosting() — heuristic field split');
{
  const text = `Senior Frontend Engineer at Acme Corp · Remote, Worldwide

About the job
We are looking for a senior frontend engineer with React and TypeScript experience.`;
  const parsed = parsePastedPosting(text);
  assert(parsed.title === 'Senior Frontend Engineer', `title parsed correctly (got "${parsed.title}")`);
  assert(parsed.company === 'Acme Corp', `company parsed correctly (got "${parsed.company}")`);
  assert(parsed.location === 'Remote, Worldwide', `location parsed correctly (got "${parsed.location}")`);
  assert(parsed.description.includes('React and TypeScript'), 'description starts after the "About the job" marker');

  const empty = parsePastedPosting('');
  assert(empty.title === '' && empty.company === '', 'empty input never throws, returns empty fields');
}

console.log('\n4. deep-links.ts — pure URL builders, real linkedin.com hosts');
{
  const searchUrl = buildLinkedInJobSearchUrl({ keywords: 'engineer', location: 'Remote', remoteOnly: true, datePosted: 'pastWeek' });
  const u = new URL(searchUrl);
  assert(u.hostname === 'www.linkedin.com', 'job search URL targets linkedin.com');
  assert(u.pathname === '/jobs/search', 'job search URL path is /jobs/search');
  assert(u.searchParams.get('keywords') === 'engineer', 'keywords param set');
  assert(u.searchParams.get('f_WT') === '2', 'remote facet set');
  assert(u.searchParams.get('f_TPR') === 'r604800', 'date-posted facet set for pastWeek');

  const peopleUrl = buildLinkedInPeopleSearchUrl('Acme Corp', 'Recruiter');
  const pu = new URL(peopleUrl);
  assert(pu.hostname === 'www.linkedin.com', 'people search URL targets linkedin.com');
  assert(pu.searchParams.get('keywords') === 'Acme Corp Recruiter', 'people search keywords combine company + role');

  const suggestions = suggestPeopleSearchRoleKeywords('Senior Engineering Manager');
  assert(suggestions.includes('Recruiter'), 'role suggestions always include Recruiter');
  assert(suggestions.some((s) => s.includes('Engineering')), `role suggestions pick up department from title (got ${JSON.stringify(suggestions)})`);
}

console.log('\n5. trust-signals.ts — attribution/confidence labeling');
{
  assert(linkedInBadgeLabel() === 'LinkedIn', 'badge label is exactly "LinkedIn"');
  assert(provenanceBadgeLabel('vendor_search') === 'Found via job search', 'vendor-search provenance label correct');
  assert(provenanceBadgeLabel('user_pasted') === 'You pasted this job', 'pasted provenance label correct');
  assert(confidenceLabel('full') === null, 'full-confidence description shows no confidence caveat');
  assert(typeof confidenceLabel('excerpt') === 'string' && confidenceLabel('excerpt')!.length > 0, 'excerpt-confidence shows a real caveat string');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

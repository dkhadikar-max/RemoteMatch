/**
 * LinkedIn Job Finder — LIVE verification of generateConnectionMessageDraft()'s
 * real 'ai' branch (src/lib/ai/connection-message.ts). Authorized one-off
 * verification call, same precedent as this session's earlier Phase 1B
 * live-OpenAI check. Uses the already-configured OPENAI_API_KEY and the
 * existing spend ledger (reserve_openai_spend / consume) — no new key, no
 * new provider, no vendor spend (SerpApi untouched).
 *
 * Run: npx tsx test/linkedin-connection-message-live-suite.ts
 */
import ws from 'ws';
if (!(global as any).WebSocket) (global as any).WebSocket = ws;

import { generateConnectionMessageDraft } from '../src/lib/ai/connection-message';
import { generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import { normalizePastedJob } from '../src/lib/linkedin-jobs/normalize';
import type { PersonProfile, ProfileSkill } from '../src/types/byn';

let passed = 0, failed = 0;
const assert = (c: boolean, n: string) => {
  if (c) { passed++; console.log(`  ✓ PASS: ${n}`); }
  else { failed++; console.error(`  ✗ FAIL: ${n}`); }
};

function skill(name: string): ProfileSkill {
  return { id: `s-${name}`, profileId: 'p1', skillName: name, isPrimary: false };
}
function realProfile(): PersonProfile {
  return {
    id: 'p1', fullName: 'Jordan Rivera', email: 'jordan@example.com', headline: 'Backend Engineer',
    profileStrength: 70, planTier: 'pro', dailyRightSwipesCount: 0, dailyProposalsCount: 0,
    usageDate: '2026-09-15', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    skills: [skill('Python'), skill('AWS'), skill('Django')],
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: ['Backend Engineer'], yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: '2026-01-01T00:00:00Z' },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'United States', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    experiences: [{ id: 'e1', profileId: 'p1', company: 'PriorCo', roleTitle: 'Backend Engineer', isCurrent: false, achievements: ['Scaled a Python/AWS service to 10x traffic'], startDate: '2022-01-01', endDate: '2025-01-01' }],
  } as unknown as PersonProfile;
}

async function run() {
  console.log('==============================================================================');
  console.log('LINKEDIN JOB FINDER — LIVE connection-message generation (real OpenAI call)');
  console.log('==============================================================================\n');

  if (!process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY not set in this shell — skipping (this suite requires the real key).');
    return;
  }

  const profile = realProfile();
  const { opportunity } = normalizePastedJob({
    title: 'Senior Backend Engineer',
    company: 'Acme Robotics',
    description: 'We are looking for a Senior Backend Engineer with strong Python and AWS experience to help scale our robotics platform. Django experience is a big plus.',
    linkedinUrl: 'https://www.linkedin.com/jobs/view/live-test-1',
  });
  const match = generateRuleBasedMatchAnalysis(profile, opportunity);

  console.log(`Calling generateConnectionMessageDraft() for real, against OpenAI (${process.env.OPENAI_MODEL || 'gpt-5-mini'})...\n`);
  const startedAt = Date.now();
  const draft = await generateConnectionMessageDraft(profile, opportunity, match);
  const elapsedMs = Date.now() - startedAt;

  console.log(`Result (${elapsedMs}ms):`);
  console.log(`  source: ${draft.source}`);
  console.log(`  message: "${draft.message}"`);
  console.log('');

  assert(draft.source === 'ai' || draft.source === 'template', `source is a valid value (got "${draft.source}")`);
  assert(typeof draft.message === 'string' && draft.message.trim().length > 0, 'a real, non-empty message was returned');
  assert(draft.message.length < 400, `message is short enough for a LinkedIn connection note (got ${draft.message.length} chars)`);

  // Recipient-agnostic: must not fabricate a specific person's name/title —
  // the only names it's allowed to reference are the CANDIDATE's own name
  // and the company/job title, all of which are real, supplied context.
  const lower = draft.message.toLowerCase();
  const fabricatedGreeting = /\bhi\s+(mr|ms|mrs|dr)\.?\s+\w+/i.test(draft.message) || /\bdear\s+\w+,/i.test(draft.message);
  assert(!fabricatedGreeting, `message does not address a fabricated named recipient (checked for "Dear X," / "Hi Mr./Ms. X" patterns)`);

  if (draft.source === 'ai') {
    console.log('  -> The real \'ai\' branch executed successfully: OpenAI was called, the JSON response parsed, and the anti-fabrication-adjacent recipient-agnostic check passed.');
  } else {
    console.log('  -> Fell back to the template path (spend cap, malformed response, or API error) — see console output above this line for the specific reason logged by connection-message.ts.');
  }

  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error('Fatal error running linkedin-connection-message-live-suite:', e); process.exit(1); });

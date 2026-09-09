/**
 * RemoteMatch — Onboarding persistence contract suite (AFC / P-INT)
 * ==============================================================================
 * Pure. Covers src/lib/onboarding/contract.ts:
 *   - validateOnboardingPayload: each required section, salary bounds
 *   - toCompleteOnboardingArgs: exact positional mapping to the RPC, dedupe,
 *     trimming, defaults, skill shaping
 *
 * Run: npx tsx test/onboarding-contract-suite.ts
 */
import {
  validateOnboardingPayload,
  toCompleteOnboardingArgs,
  OnboardingPayload,
} from '../src/lib/onboarding/contract';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function good(): OnboardingPayload {
  return {
    fullName: '  Ada Lovelace ',
    headline: ' Engineer ',
    employmentTypes: ['Full-time', 'Full-time', 'Contract'],
    targetRoles: ['Backend Engineer', ' Backend Engineer ', 'Platform Engineer'],
    yearsOfExperience: '4-6',
    minSalary: 120000,
    preferredCurrency: '',
    skills: [{ name: ' Rust ', isPrimary: true }, { name: 'Postgres' }, { name: '  ' }],
    workPreference: 'worldwide',
    currentCountry: ' Portugal ',
    currentTimezone: '',
    allowedCountries: ['Worldwide', 'Worldwide'],
    willingTimezones: ['UTC', 'WET'],
    rawResumeText: ' cv text ',
  };
}

console.log('='.repeat(78));
console.log('ONBOARDING CONTRACT SUITE (AFC)');
console.log('='.repeat(78) + '\n');

// --- validation ---
console.log('validateOnboardingPayload:');
assert(validateOnboardingPayload(good()).length === 0, 'a complete payload validates');

for (const [label, mut] of [
  ['missing fullName', (p: OnboardingPayload) => { p.fullName = '   '; }],
  ['empty employmentTypes', (p: OnboardingPayload) => { p.employmentTypes = []; }],
  ['empty targetRoles', (p: OnboardingPayload) => { p.targetRoles = ['', '  ']; }],
  ['bad yearsOfExperience', (p: OnboardingPayload) => { (p as { yearsOfExperience: string }).yearsOfExperience = 'senior'; }],
  ['bad workPreference', (p: OnboardingPayload) => { (p as { workPreference: string }).workPreference = 'remote'; }],
  ['missing currentCountry', (p: OnboardingPayload) => { p.currentCountry = ''; }],
  ['no real skills', (p: OnboardingPayload) => { p.skills = [{ name: '  ' }]; }],
  ['negative minSalary', (p: OnboardingPayload) => { p.minSalary = -5; }],
] as const) {
  const p = good();
  mut(p);
  const errs = validateOnboardingPayload(p);
  assert(errs.length > 0, `${label} -> rejected`);
}
assert(validateOnboardingPayload(null).length > 0, 'null payload -> rejected (not a crash)');
assert(validateOnboardingPayload({}).length >= 6, 'empty object -> every required section flagged');
{
  const p = good();
  p.minSalary = null;
  assert(validateOnboardingPayload(p).length === 0, 'minSalary null is allowed (optional)');
}

// --- mapping to RPC args ---
console.log('\ntoCompleteOnboardingArgs:');
const a = toCompleteOnboardingArgs(good());
assert(a.p_full_name === 'Ada Lovelace', 'full_name trimmed');
assert(a.p_headline === 'Engineer', 'headline trimmed');
assert(JSON.stringify(a.p_employment_types) === JSON.stringify(['Full-time', 'Contract']), 'employment_types deduped, order preserved');
assert(JSON.stringify(a.p_target_roles) === JSON.stringify(['Backend Engineer', 'Platform Engineer']), 'target_roles trimmed + deduped');
assert(a.p_years_of_experience === '4-6', 'years_of_experience passthrough');
assert(a.p_min_salary === 120000, 'min_salary passthrough');
assert(a.p_preferred_currency === 'USD', 'empty preferredCurrency -> USD default');
assert(JSON.stringify(a.p_skills) === JSON.stringify([{ name: 'Rust', isPrimary: true }, { name: 'Postgres', isPrimary: false }]),
  'skills: trimmed, blank dropped, isPrimary coerced to boolean');
assert(a.p_work_preference === 'worldwide', 'work_preference passthrough');
assert(a.p_current_country === 'Portugal', 'current_country trimmed');
assert(a.p_current_timezone === 'UTC', 'empty currentTimezone -> UTC default');
assert(JSON.stringify(a.p_allowed_countries) === JSON.stringify(['Worldwide']), 'allowed_countries deduped');
assert(JSON.stringify(a.p_willing_timezones) === JSON.stringify(['UTC', 'WET']), 'willing_timezones passthrough');
assert(a.p_raw_resume_text === 'cv text', 'raw_resume_text trimmed');
{
  const p = good();
  p.headline = '   ';
  p.rawResumeText = '';
  p.minSalary = undefined;
  const b = toCompleteOnboardingArgs(p);
  assert(b.p_headline === null && b.p_raw_resume_text === null && b.p_min_salary === null,
    'blank headline / resume / absent salary -> null (not empty string)');
}

// The positional order of the returned object's keys must match migration 014's
// function signature. This asserts the key set + order explicitly.
const EXPECTED_KEYS = [
  'p_full_name', 'p_headline', 'p_employment_types', 'p_target_roles', 'p_years_of_experience',
  'p_min_salary', 'p_preferred_currency', 'p_skills', 'p_work_preference', 'p_current_country',
  'p_current_timezone', 'p_allowed_countries', 'p_willing_timezones', 'p_raw_resume_text',
];
assert(JSON.stringify(Object.keys(a)) === JSON.stringify(EXPECTED_KEYS),
  'arg keys match the complete_onboarding() signature order (014)');

console.log('\n' + '='.repeat(78));
console.log(`${passed} passed, ${failed} failed.`);
console.log('='.repeat(78));
if (failed > 0) process.exitCode = 1;

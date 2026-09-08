/**
 * RemoteMatch — Demand pattern normalizer suite (Additional Supply Discovery, C2)
 * ==============================================================================
 * Deterministic, no I/O. Covers every lexicon branch, the region_scope map, the
 * comp buckets, key stability + round-trip, and a regression guard that
 * pipeline.ts's createNormalizedJobKey is unchanged (the seniority token set is
 * duplicated between the two — a drift here must be caught).
 *
 * Run: npx tsx test/demand-pattern-suite.ts
 */
import {
  normalizeDemandPattern, demandPatternKey, parseDemandPatternKey, isValidDemandPatternKey,
} from '../src/lib/demand/pattern';
import { createNormalizedJobKey } from '../src/lib/ingestion/pipeline';
import type { RemoteType } from '../src/types/byn';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function base(over: Partial<Parameters<typeof normalizeDemandPattern>[0]>) {
  return normalizeDemandPattern({ title: 'Engineer', remoteType: 'Worldwide' as RemoteType, ...over });
}

console.log('='.repeat(78));
console.log('DEMAND PATTERN NORMALIZER SUITE (C2)');
console.log('='.repeat(78) + '\n');

// --- role_family ---
console.log('role_family:');
assert(base({ title: 'Senior Backend Engineer' }).role_family === 'software_engineering', 'Backend Engineer -> software_engineering');
assert(base({ title: 'Staff Product Designer' }).role_family === 'design', 'Product Designer -> design');
assert(base({ title: 'Group Product Manager' }).role_family === 'product_management', 'Product Manager -> product_management');
assert(base({ title: 'Senior Data Engineer' }).role_family === 'data', 'Data Engineer -> data');
assert(base({ title: 'Machine Learning Engineer' }).role_family === 'data', 'ML Engineer -> data');
assert(base({ title: 'Growth Marketer' }).role_family === 'marketing', 'Growth Marketer -> marketing');
assert(base({ title: 'Enterprise Account Executive' }).role_family === 'sales', 'Account Executive -> sales');
assert(base({ title: 'Business Operations Manager' }).role_family === 'operations', 'Operations Manager -> operations');
assert(base({ title: 'Veterinary Technician' }).role_family === 'other', 'unmatched title -> other');
assert(base({ title: 'Contributor', requiredSkills: ['Figma', 'User Research'] }).role_family === 'design', 'skills tiebreak -> design');
assert(base({ title: 'Contributor', requiredSkills: ['dbt', 'Snowflake'] }).role_family === 'data', 'skills tiebreak -> data');

// --- seniority ---
console.log('\nseniority:');
assert(base({ title: 'Principal Engineer' }).seniority === 'staff_plus', 'Principal -> staff_plus');
assert(base({ title: 'Head of Design' }).seniority === 'staff_plus', 'Head of -> staff_plus');
assert(base({ title: 'Senior Engineer' }).seniority === 'senior', 'Senior -> senior');
assert(base({ title: 'Engineering Lead' }).seniority === 'senior', 'Lead -> senior');
assert(base({ title: 'Junior Developer' }).seniority === 'junior', 'Junior -> junior');
assert(base({ title: 'Software Engineer Intern' }).seniority === 'junior', 'Intern -> junior');
assert(base({ title: 'Software Engineer' }).seniority === 'mid', 'no token -> mid');
assert(base({ title: 'Engineer', experienceRequirement: '7-10' }).seniority === 'senior', 'exp 7-10 fallback -> senior');
assert(base({ title: 'Engineer', experienceRequirement: '0-1' }).seniority === 'junior', 'exp 0-1 fallback -> junior');

// --- region_scope (1:1 off remoteType) ---
console.log('\nregion_scope:');
const rs = (r: RemoteType) => base({ remoteType: r }).region_scope;
assert(rs('Worldwide') === 'worldwide', 'Worldwide -> worldwide');
assert(rs('US') === 'us', 'US -> us');
assert(rs('EU/EEA') === 'eu_eea', 'EU/EEA -> eu_eea');
assert(rs('India') === 'india', 'India -> india');
assert(rs('Timezone restricted') === 'timezone_restricted', 'Timezone restricted -> timezone_restricted');
assert(rs('Specific countries') === 'specific', 'Specific countries -> specific');
assert(rs('Contractor only') === 'specific', 'Contractor only -> specific');

// --- domain ---
console.log('\ndomain:');
assert(base({ title: 'Engineer', description: 'building payments infrastructure for a fintech' }).domain === 'fintech', 'fintech');
assert(base({ title: 'Engineer', description: 'clinical trial data at a healthcare company' }).domain === 'health', 'health');
assert(base({ title: 'Engineer', description: 'our developer platform and CI/CD tooling' }).domain === 'devtools', 'devtools');
assert(base({ title: 'Engineer', description: 'LLM fine-tuning and RAG pipeline work' }).domain === 'ai_ml', 'ai_ml');
assert(base({ title: 'Engineer', description: 'a plain internal CRUD app' }).domain === null, 'no match -> null');

// --- comp_floor_bucket ---
console.log('\ncomp_floor_bucket:');
assert(base({ salaryMin: 60000, salaryCurrency: 'USD' }).comp_floor_bucket === '<80k', '60k USD -> <80k');
assert(base({ salaryMin: 100000, salaryCurrency: 'USD' }).comp_floor_bucket === '80-120k', '100k USD -> 80-120k');
assert(base({ salaryMin: 140000, salaryCurrency: 'USD' }).comp_floor_bucket === '120-160k', '140k USD -> 120-160k');
assert(base({ salaryMin: 200000, salaryCurrency: 'USD' }).comp_floor_bucket === '160k+', '200k USD -> 160k+');
assert(base({ salaryMin: 90000, salaryCurrency: 'GBP' }).comp_floor_bucket === '80-120k', '90k GBP (~114k USD) -> 80-120k (FX)');
assert(base({ salaryMin: 110000, salaryCurrency: 'GBP' }).comp_floor_bucket === '120-160k', '110k GBP (~140k USD) -> 120-160k (FX)');
assert(base({}).comp_floor_bucket === null, 'no salary -> null');
assert(base({ salaryMin: 120000, salaryCurrency: 'JPY' }).comp_floor_bucket === null, 'unsupported currency -> null');
assert(base({ salaryMin: 70, salaryCurrency: 'USD' }).comp_floor_bucket === null, 'hourly-ish figure (<1000) -> null (never guessed)');

// --- key stability + round-trip ---
console.log('\nkey:');
const p1 = base({ title: 'Senior Data Engineer', remoteType: 'US', description: 'fintech payments', salaryMin: 150000, salaryCurrency: 'USD' });
const p2 = base({ title: 'Senior Data Engineer', remoteType: 'US', description: 'fintech payments', salaryMin: 150000, salaryCurrency: 'USD' });
assert(demandPatternKey(p1) === demandPatternKey(p2), 'same input -> same key');
assert(demandPatternKey(p1) === 'data|senior|us|fintech|120-160k', `key shape (got ${demandPatternKey(p1)})`);
assert(JSON.stringify(parseDemandPatternKey(demandPatternKey(p1))) === JSON.stringify(p1), 'parse(key(p)) === p');
assert(demandPatternKey(base({ title: 'Engineer' })) === 'software_engineering|mid|worldwide|-|-', 'null domain/comp -> "-" in key');

// --- key validation: wrong-length AND semantically-invalid five-part keys ---
console.log('\nkey validation (runtime enum check, not just shape):');
assert(parseDemandPatternKey('a|b|c') === null, 'wrong-length key -> null');
assert(parseDemandPatternKey('software_engineering|senior|worldwide|-|-|-') === null, '6-part key -> null');
assert(parseDemandPatternKey('garbage|garbage|garbage|garbage|garbage') === null,
  '5-part but every component invalid -> null');
assert(parseDemandPatternKey('data|senior|us|fintech|120-160k') !== null, 'fully-valid 5-part key -> parses');
assert(parseDemandPatternKey('bogus_family|senior|us|fintech|120-160k') === null, 'bad role_family slot -> null');
assert(parseDemandPatternKey('data|overlord|us|fintech|120-160k') === null, 'bad seniority slot -> null');
assert(parseDemandPatternKey('data|senior|mars|fintech|120-160k') === null, 'bad region_scope slot -> null');
assert(parseDemandPatternKey('data|senior|us|not_a_domain|120-160k') === null, 'bad domain slot (non-"-" invalid) -> null');
assert(parseDemandPatternKey('data|senior|us|-|9000k+') === null, 'bad comp_floor_bucket slot (non-"-" invalid) -> null');
assert(parseDemandPatternKey('data|senior|us|-|-') !== null, 'nullable slots as "-" -> valid');
// @ts-expect-error — runtime guard must survive a non-string input
assert(parseDemandPatternKey(null) === null, 'non-string input -> null');
assert(isValidDemandPatternKey('data|senior|us|fintech|120-160k') === true, 'isValidDemandPatternKey: true for a good key');
assert(isValidDemandPatternKey('garbage|garbage|garbage|garbage|garbage') === false, 'isValidDemandPatternKey: false for a bad key');

// --- regression guard: createNormalizedJobKey unchanged ---
console.log('\nregression guard (pipeline.createNormalizedJobKey):');
assert(createNormalizedJobKey('Automattic', 'Senior Full Stack Engineer') === 'automattic:fullstackengineer',
  'createNormalizedJobKey byte-identical for a known input');
assert(createNormalizedJobKey('GitLab', 'Staff Product Designer') === 'gitlab:productdesigner',
  'createNormalizedJobKey byte-identical (staff stripped)');

console.log('\n' + '='.repeat(78));
console.log(`${passed} passed, ${failed} failed.`);
console.log('='.repeat(78));
if (failed > 0) process.exitCode = 1;

/**
 * RemoteMatch — P1b: job-specific resume suggestions must be derived from data, never invented
 * ==============================================================================
 * Audit R-P2-2 (docs/audit-2026-10-13-resume-analysis.md). `generateJobSpecificResumeAnalysis` — the source of the
 * match page's "Before you apply" steps and the downloadable summary — emitted template text as if it described the
 * user's resume: `Typical current bullet: "Built features and maintained web services."`, a rewrite example with a
 * `[insert your metric…]` placeholder and an invented "Architected core services handling high concurrency",
 * "Employer emphasizes autonomous remote execution", "The employer specifically requests Technical Stack" (when the
 * job lists no skills), "Move your X experience higher" (whether or not the user has X) — and the view fell back to
 * three static claims ("Add production-scale impact metrics to your recent role", …) when it had nothing.
 *
 * Deep's decision (2026-10-13): remove unsupported job-specific resume claims; NO matching or scoring changes.
 *
 * This suite proves (1) the new suggestions are derived only from {job's required skills, the user's declared skills,
 * the user's resume text}; (2) no invented content survives anywhere in src/; (3) matching/scoring output is
 * byte-identical to the unchanged base (golden recorded with --record before the change).
 *
 * Pure (no network, no DB). Run: npx tsx test/resume-p1b-suite.ts    |    record: … --record (base commit only)
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PersonProfile, CanonicalOpportunity } from '../src/types/byn';
import { generateJobSpecificResumeAnalysis } from '../src/lib/ai/resume-intelligence';
import { generateRuleBasedMatchAnalysis, scoreOpportunitiesForFeed } from '../src/lib/matching/engine';
import { CURATED_JOBS } from '../src/lib/providers/curated';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';

const root = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'resume-p1b-matching-golden.json');
const RECORD = process.argv.includes('--record');
let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const NOW = '2026-01-01T00:00:00.000Z';
const profile = (skills: string[], rawResumeText = '', roles: string[] = ['Frontend Engineer']): PersonProfile => ({
  id: 'p', email: '', fullName: 'T', planTier: 'free', dailyEvaluationsCount: 0, lastEvaluationResetAt: NOW, createdAt: NOW, updatedAt: NOW, rawResumeText,
  skills: skills.map((s, i) => ({ id: `s-${i}`, profileId: 'p', skillName: s, isPrimary: i < 4 })), experiences: [],
  intent: { id: 'i', profileId: 'p', employmentTypes: ['Full-time'], targetRoles: roles, yearsOfExperience: '4-6', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: NOW },
  location: { id: 'l', profileId: 'p', currentCountry: 'Worldwide', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: ['Worldwide'], willingTimezones: ['UTC'] },
});
const job = (requiredSkills: string[], title = 'Senior Frontend Engineer', remoteType = 'Worldwide'): CanonicalOpportunity => ({
  ...(normalizeOpportunity(CURATED_JOBS[0]) as CanonicalOpportunity), id: 'opp-test', title, requiredSkills, remoteType: remoteType as CanonicalOpportunity['remoteType'],
});
const RESUME = 'Jane Doe — Senior Frontend Engineer. I built design systems and checkout flows in React and TypeScript at two companies, led migrations to Next.js, and mentored four engineers across timezones for six years.';

// ── golden: matching & scoring on a fixed corpus ──
const MATCH_PROFILES = [profile(['React', 'TypeScript', 'Next.js'], RESUME), profile(['Go', 'Python', 'PostgreSQL']), profile(['C++', 'C#', '.NET'], 'Systems engineer with C++ and C# experience building low-latency services for ten years.'), profile([], ''), profile(['React'], '', [])];
const MATCH_OPPS = CURATED_JOBS.slice(0, 6).map(normalizeOpportunity);
function computeMatchingGolden() {
  return {
    analysis: MATCH_PROFILES.map((p, pi) => MATCH_OPPS.map((o, oi) => { const m = generateRuleBasedMatchAnalysis(p, o) as unknown as Record<string, unknown>; const { jobSpecificResumeImprovements, ...rest } = m; void jobSpecificResumeImprovements; return [`${pi}/${oi}`, rest]; })),
    feed: MATCH_PROFILES.map((p, pi) => [pi, scoreOpportunitiesForFeed(p, MATCH_OPPS).map((o: any) => [o.id, o.fitScore, o.fitBadge])]),
  };
}

// Phrases that existed ONLY in this feature: forbidden anywhere in src/.
const FORBIDDEN_EVERYWHERE = [
  /typical current bullet/i, /built features and maintained/i, /architected core services/i, /handling high concurrency/i,
  /autonomous remote execution/i, /production-scale impact metrics/i, /clarify architectural ownership/i,
  /distributed systems scope/i, /make remote async workflow/i, /cross-timezone documentation/i,
];
// Generic phrases that other, unrelated modules legitimately contain (e.g. the application-kit template in materials.ts —
// a SEPARATE finding, see the PR description): forbidden only in the two files that carried THIS feature.
const FORBIDDEN_IN_FEATURE_FILES = [/\[insert/i, /technical stack/i, /async communication/i];
const FEATURE_FILES = ['src/lib/ai/resume-intelligence.ts', 'src/components/match/match-analysis-view.tsx'];

async function main() {
  console.log('='.repeat(78));
  console.log(RECORD ? 'RECORDING MATCHING GOLDEN (base commit)' : 'P1b — JOB-SPECIFIC RESUME SUGGESTIONS');
  console.log('='.repeat(78));
  const golden = computeMatchingGolden();
  if (RECORD) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
    console.log(`recorded ${GOLDEN}`);
    return;
  }

  console.log('\n1. Matching and scoring are byte-identical to the unchanged base');
  const recorded = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const now = JSON.parse(JSON.stringify(golden));
  assert(JSON.stringify(now.analysis) === JSON.stringify(recorded.analysis), `generateRuleBasedMatchAnalysis: fit score, badge, strengths, gaps, checklist identical (${MATCH_PROFILES.length} profiles × ${MATCH_OPPS.length} jobs)`);
  assert(JSON.stringify(now.feed) === JSON.stringify(recorded.feed), `scoreOpportunitiesForFeed: ids, fit scores and badges identical (${MATCH_PROFILES.length} profiles)`);

  console.log('\n2. Suggestions are derived from data only');
  const j = job(['React', 'TypeScript', 'GraphQL', 'Kubernetes']);
  const out = generateJobSpecificResumeAnalysis(profile(['React', 'TypeScript', 'GraphQL'], RESUME), j);
  const text = JSON.stringify(out);
  assert(out.length >= 1 && out.length <= 3, `1–3 suggestions (got ${out.length})`);
  assert(out.some((s) => s.actionType === 'evidence' && /GraphQL/.test(s.title) && /Listed on your profile/.test(s.currentContext ?? '')), 'declared-but-absent-from-resume skill (GraphQL) → "make it visible on your resume"', text.slice(0, 300));
  assert(out.some((s) => /Kubernetes/.test(s.title + s.recommendation) && /isn't on your profile|not on your profile/.test(s.currentContext + s.recommendation)), 'required skill missing from the profile (Kubernetes) → "add it if you have used it"');
  assert(out.some((s) => s.actionType === 'reorder' && /React|TypeScript/.test(s.title) && /Found in your resume text/.test(s.currentContext ?? '')), 'skill the resume text really mentions (React/TypeScript) → "keep it near the top"');
  assert(!out.some((s) => /Kubernetes/.test(s.title) && s.actionType === 'reorder'), 'a skill the resume does NOT mention is never described as being "in your resume"');
  assert(out.every((s) => s.title && s.recommendation && ['reorder', 'rewrite', 'evidence'].includes(s.actionType)), 'every suggestion keeps the JobSpecificResumeImprovement contract');
  assert(!out.some((s) => s.actionType === 'rewrite'), 'no generic "rewrite your bullets" template is produced (it was invented text)');
  const strings = out.map((x) => [x.title, x.currentContext ?? '', x.recommendation].join(' | ')).join(' || ');
  assert(!/\d+\s*%|\$\s*\d/.test(strings) && !/[\[\]]/.test(strings), 'no metrics, no bracketed placeholders (checked on the suggestion strings)');

  const namedSkills = (s: string) => ['React', 'TypeScript', 'GraphQL', 'Kubernetes', 'Go', 'Python', 'Rust', 'AWS'].filter((k) => new RegExp(`\\b${k}\\b`).test(s));
  assert(namedSkills(text).every((k) => j.requiredSkills.includes(k)), 'every skill named in a suggestion is one of the job\'s required skills');

  console.log('\n3. No data → no claims');
  assert(generateJobSpecificResumeAnalysis(profile(['React']), job([])).length === 0, 'a job with no listed skills → no suggestions (previously: "requests Technical Stack")');
  assert(generateJobSpecificResumeAnalysis(profile(['React', 'TypeScript']), job(['React', 'TypeScript'])).length === 0, 'everything the job asks for is on the profile and there is no resume text → nothing to suggest');
  const noResume = generateJobSpecificResumeAnalysis(profile(['React', 'GraphQL']), job(['React', 'GraphQL', 'Rust']));
  assert(noResume.every((s) => !/resume text/i.test((s.currentContext ?? '') + s.recommendation) || /isn't|not on your profile/.test((s.currentContext ?? '') + s.recommendation)), 'without resume text no claim about the resume is made');
  const shortResume = generateJobSpecificResumeAnalysis(profile(['React', 'GraphQL'], 'React dev.'), job(['React', 'GraphQL']));
  assert(shortResume.length === 0, 'a resume too short to judge produces no "not in your resume" claim');
  assert(generateJobSpecificResumeAnalysis(profile([], ''), job(['Go'])).every((s) => /Go/.test(s.title)), 'empty profile: only the factual "required, not on your profile" suggestion');

  console.log('\n4. Problematic skill input never throws');
  let threw = '';
  for (const sk of ['C++', 'C#', '.NET', '(', '[', '*', '\\', 'a.b', '', ' ']) { try { generateJobSpecificResumeAnalysis(profile([sk, 'React'], RESUME), job([sk, 'React', 'Go'])); } catch (e) { threw = `${JSON.stringify(sk)}: ${(e as Error).message}`; } }
  assert(threw === '', 'metacharacter / empty skill names in the profile or in the job are handled', threw);
  const cpp = generateJobSpecificResumeAnalysis(profile(['C++'], 'Wrote C++ trading systems for years and led a team of six engineers.'), job(['C++', 'Go']));
  assert(cpp.some((s) => s.actionType === 'reorder' && /C\+\+/.test(s.title)) && cpp.some((s) => /Go/.test(s.title)), 'C++ is recognised in the resume text and Go is reported as not on the profile');
  assert(!generateJobSpecificResumeAnalysis(profile(['Go'], 'I enjoy going to work and google searches every day of the week.'), job(['Go'])).some((s) => s.actionType === 'reorder'), '"Go" is not "found" in going/google');

  console.log('\n5. Determinism and purity');
  const a = JSON.stringify(generateJobSpecificResumeAnalysis(profile(['React', 'GraphQL'], RESUME), j));
  assert(a === JSON.stringify(generateJobSpecificResumeAnalysis(profile(['React', 'GraphQL'], RESUME), j)), 'same input → same output');
  const p0 = profile(['React'], RESUME); const snap = JSON.stringify(p0); generateJobSpecificResumeAnalysis(p0, j);
  assert(JSON.stringify(p0) === snap, 'the profile is not mutated');

  console.log('\n6. Invented content is gone from the whole codebase');
  const walk = (dir: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(e.name)) walk(p, out); } else if (/\.(ts|tsx)$/.test(e.name)) out.push(p); } return out; };
  const srcFiles = walk(path.join(root, 'src'));
  for (const re of FORBIDDEN_EVERYWHERE) {
    const hits = srcFiles.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).split(path.sep).join('/'));
    assert(hits.length === 0, `src/ contains no "${re.source}"`, hits.join(', '));
  }
  for (const re of FORBIDDEN_IN_FEATURE_FILES) {
    const hits = FEATURE_FILES.filter((f) => re.test(read(f)));
    assert(hits.length === 0, `the suggestion generator and the match view contain no "${re.source}"`, hits.join(', '));
  }
  const view = read('src/components/match/match-analysis-view.tsx');
  assert(!/'Add concrete metrics demonstrating scale'|'Clarify architectural ownership on your most recent project'|'Make your remote async collaboration explicit'/.test(view), 'the download no longer falls back to three static "BEFORE YOU APPLY" claims');
  assert(view.includes('No resume-specific suggestions for this job.') && view.includes('beforeYouApplySteps.length === 0'), 'the view shows an honest empty state instead of static advice');
  assert(!/const beforeYouApplySteps = [\s\S]{0,300}\|\| \[\s*'/.test(view), 'beforeYouApplySteps no longer has a static-claims fallback array');

  console.log('\n7. Scope');
  const lines = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  // Pinned to THIS change's own commit range (PR #12: c9e9eaf..e3e62bd), not a moving branch diff, so the guard keeps
  // holding after the PR merges and when later branches add other files. Skipped, with a note, if those commits are not
  // in this clone (shallow clone, or the branch was deleted after merge).
  const PINNED_BASE = 'c9e9eaf';
  const PINNED_TIP = 'e3e62bd';
  const pinnedAvailable = (() => { try { execSync('git cat-file -e ' + PINNED_BASE, { cwd: root, stdio: 'ignore' }); execSync('git cat-file -e ' + PINNED_TIP, { cwd: root, stdio: 'ignore' }); return true; } catch { return false; } })();
  const changed = pinnedAvailable ? lines(`git diff --name-only ${PINNED_BASE} ${PINNED_TIP}`) : [];
  if (!pinnedAvailable) console.log('  (scope guard skipped: pinned commits ' + PINNED_BASE + '..' + PINNED_TIP + ' are not in this clone)');
  const allowed = new Set(['src/lib/ai/resume-intelligence.ts', 'src/components/match/match-analysis-view.tsx', 'test/resume-p1b-suite.ts', 'test/fixtures/resume-p1b-matching-golden.json', 'test/resume-p1-equivalence-suite.ts', 'test/resume-honesty-suite.ts', 'test/verification-suite.ts', 'test/ai-eval-set.ts']);
  assert(changed.every((f) => allowed.has(f)), `only the suggestion generator, the match view's empty state and the tests that pinned the old text changed (PR #12 range)`, changed.filter((f) => !allowed.has(f)).join(', '));
  assert(changed.every((f) => !['src/lib/matching/', 'src/app/api/', 'supabase/', 'src/lib/db/', 'src/lib/onboarding/', 'src/middleware.ts', 'src/lib/ingestion/'].some((x) => f.startsWith(x))), 'matcher, API routes (incl. swipe/snapshots), migrations, stores, onboarding contract, ingestion and middleware untouched');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });

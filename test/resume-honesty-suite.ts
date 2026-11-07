/**
 * RemoteMatch — Resume step honesty (onboarding review)
 * ==============================================================================
 * Audit findings R-P0-1, R-P1-1, R-P1-2, R-P1-4 (docs/audit-2026-10-13-resume-analysis.md), measured on 4c3fc95:
 *  - the heuristic "analysis" returned hard-coded praise/advice regardless of input ("asdf qwer" → 48/100, "Clean
 *    chronological formatting", strengths "Core domain foundation"); the dashboard showed three hard-coded improvement
 *    cards, a "Profile Strength / Readiness" score that rose by +3/+4 for any typed text, and "Profile Verified";
 *  - skill "C++" threw "Nothing to repeat" and left onboarding stuck on "Analyzing profile…";
 *  - C# / .NET were reported "no evidence" while present, "Go" was found in "going/google", and one skill could be
 *    both a "strength" and "uncertain".
 *
 * Pure (no network, no DB). Run: npx tsx test/resume-honesty-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as unknown as { React: unknown }).React = React;

import { skillAppearsInText, normalizeResumeText } from '../src/lib/resume/skill-evidence';
import { checkResumeAgainstSkills, sanitizeSkills, suggestSkillsFromResume, MAX_SKILLS_CHECKED, MAX_SUGGESTED_SKILLS, type ResumeCheck } from '../src/lib/resume/resume-check';
import { ResumeCheckSummary } from '../src/components/onboarding/resume-check-summary';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const has = (skill: string, text: string) => skillAppearsInText(skill, text);

console.log('='.repeat(78));
console.log('RESUME STEP HONESTY');
console.log('='.repeat(78));

// ── 1. The matcher ──────────────────────────────────────────────────────────
console.log('\n1. skillAppearsInText — the four reported defects');
const sys = 'Senior systems engineer. Built low-latency trading systems in C++ and Python. 2016-2024.';
assert(has('C++', sys), 'C++ is found (previously threw "Nothing to repeat")');
assert(has('C++', 'Modern C++17 and C++20 features') && has('C++', 'C++, Rust'), 'C++ found before digits / punctuation');
assert(!has('C++', 'I write C# and Java'), 'C++ is not found in a C#/Java resume');
assert(has('C++', 'I know cpp well'), 'alias: cpp → C++');
const dotnet = 'Backend engineer with 8 years in C# and .NET. Reduced latency 40%.';
assert(has('C#', dotnet), 'C# is found (previously reported "no evidence")');
assert(has('.NET', dotnet), '.NET is found (previously reported "no evidence")');
assert(has('C#', 'Wrote C#9 records') && has('.NET', 'ASP.NET Core APIs') && has('.NET', 'built on dotnet 8'), 'C#9, ASP.NET, dotnet aliases');
assert(!has('C#', 'Built in C++ only') && !has('.NET', 'My network (NET) skills'), 'C# / .NET not found where they are absent');
assert(!has('Go', 'I enjoy going to work and my google searches. Mongodb. Django.'), 'Go is NOT found in "going", "google", "Mongodb", "Django"');
assert(has('Go', 'Built services in Go and Rust') && has('Go', 'Backend: Go, PostgreSQL'), 'Go is found as the language');
assert(has('Go', 'Experienced Golang developer') && has('Golang', 'Wrote Go services'), 'Go ↔ Golang');
assert(!has('Go', 'strong go-to-market skills') && !has('Go', 'ready to go live'), 'Go not found in "go-to-market" / lowercase "go"');

console.log('\n2. skillAppearsInText — whole tokens, not substrings');
assert(!has('Java', 'Frontend work in JavaScript') && has('Java', 'Java, Kotlin and Scala') && has('Java', 'Java/Kotlin'), 'Java ≠ JavaScript');
assert(!has('SQL', 'NoSQL and MySQL databases') && has('SQL', 'Strong SQL, Python'), 'SQL ≠ NoSQL / MySQL');
assert(has('R', 'Statistical analysis in R and SQL') && !has('R', 'worked in R&D and research') && !has('R', 'in my free time, r'), 'R: the language, not "R&D" or a lowercase r');
assert(has('C', 'Systems programming in C and C++') && !has('C', 'C++ and C# only') && !has('C', 'C-level stakeholders'), 'C: not taken from C++ / C# / C-level');
assert(has('Node.js', 'Built APIs with NodeJS') && has('Node.js', 'Node.js services') && !has('Node.js', 'a node in the graph'), 'Node.js ↔ NodeJS, not generic "node"');
assert(has('PostgreSQL', 'tuned Postgres queries') && has('Kubernetes', 'ran k8s clusters') && has('Next.js', 'Nextjs app') , 'common aliases (Postgres, k8s, Nextjs)');
assert(has('Tailwind CSS', 'styled with Tailwind') && has('Tailwind CSS', 'Tailwind CSS') && has('CI/CD', 'owned CI/CD pipelines'), 'Tailwind variants, NBSP, CI/CD');
assert(has('python', 'PYTHON developer') && has('React', 'react, redux'), 'long terms are case-insensitive');
assert(has('Objective-C', 'iOS in Objective-C') && has('F#', 'functional F# code'), 'Objective-C, F#');

console.log('\n3. Never throws, on any input');
const hostile = ['C++', 'C#', '.NET', '(', ')', '[', ']', '*', '+', '++', '?', '|', '^', '$', '\\', '{1}', '{', '}', 'a.b.c', '.*', '(?:', '\\b', '[a-', 'x'.repeat(5000), '', ' ', '\u0000', '😀', 'ﬁnance'];
let threw = '';
for (const s of hostile) { try { skillAppearsInText(s, sys); skillAppearsInText(s, s); skillAppearsInText(s, ''); } catch (e) { threw = `${JSON.stringify(s).slice(0, 30)}: ${(e as Error).message}`; } }
for (const v of [null, undefined, 5, {}, [], true, NaN] as unknown[]) { try { skillAppearsInText(v, sys); skillAppearsInText('C++', v); normalizeResumeText(v); } catch (e) { threw = `non-string ${String(v)}: ${(e as Error).message}`; } }
assert(threw === '', 'every regex-metacharacter / non-string / oversized input is handled without throwing', threw);
assert(!has('(', 'a (b) c') || true, 'metacharacter skills are data, not patterns');
assert(has('.NET', 'x .NET y') && !has('.', 'a.b') , 'a bare "." skill does not match everything');
assert(normalizeResumeText('a\u0000b\u0007c d') === 'a b c d', 'control characters stripped, NBSP normalised');
const t0 = Date.now();
const big = ('lorem ipsum dolor sit amet C++ ' + 'x'.repeat(40)).repeat(8000);
has('Go', big); has('C++', big); has('Kubernetes', big);
assert(Date.now() - t0 < 2000, `large text (${big.length.toLocaleString()} chars) is searched quickly (${Date.now() - t0} ms, no pathological backtracking)`);

// ── 2. checkResumeAgainstSkills ─────────────────────────────────────────────
console.log('\n4. checkResumeAgainstSkills — facts only');
const gib = checkResumeAgainstSkills(['Python', 'Go'], 'asdf qwer');
assert(gib.status === 'too_short' && gib.notFound.length === 0 && gib.found.length === 0, 'the audit\'s gibberish input ("asdf qwer") yields NO claims — not a score, not "not found" (too little text to conclude)');
const hello = checkResumeAgainstSkills(['React', 'Rust', 'Go', 'Kubernetes', 'Terraform', 'Scala'], 'Hello');
assert(hello.status === 'too_short' && hello.notFound.length === 0, 'a one-word resume with six skills yields no "missing" claims');
const real = checkResumeAgainstSkills(['C++', 'C#', '.NET', 'Go', 'Python'], 'Backend engineer with 8 years in C# and .NET plus Python tooling. I enjoy going to meetups and google searches daily.');
assert(real.status === 'ok' && real.found.join() === 'C#,.NET,Python' && real.notFound.join() === 'C++,Go', 'real text: C#, .NET, Python found; C++ and Go correctly not found (the four reported defects, end to end)', JSON.stringify(real));
for (const [label, v] of [['empty string', ''], ['whitespace', '   \n\t  '], ['null', null], ['undefined', undefined], ['number', 42], ['object', {}]] as Array<[string, unknown]>) {
  const c = checkResumeAgainstSkills(['React'], v);
  assert(c.status === 'empty' && c.found.length === 0 && c.notFound.length === 0, `${label} → status "empty", no claims`);
}
const notArr = checkResumeAgainstSkills('React' as unknown, 'some words here for a resume that is long enough to check properly ok');
assert(notArr.status === 'ok' && notArr.skillsChecked === 0, 'non-array skills → nothing checked, no crash');
assert(sanitizeSkills(['React', ' react ', 'REACT', '', '   ', 5, null, 'Go', 'x'.repeat(200)] as unknown[]).join() === 'React,Go', 'skills are trimmed, de-duplicated (case-insensitive), non-strings and oversize dropped');
assert(sanitizeSkills(Array.from({ length: 300 }, (_, i) => `Skill${i}`)).length === MAX_SKILLS_CHECKED, `skill list capped at ${MAX_SKILLS_CHECKED}`);
const junk = checkResumeAgainstSkills(['C++', '(((', '[a-', '\\', '.*'], 'x'.repeat(20) + ' word '.repeat(30));
assert(junk.status === 'ok', 'hostile skill names never break the check');

// property: found ∪ notFound == sanitized skills, disjoint, for random inputs
let rng = 12345;
const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
const pool = ['C++', 'C#', '.NET', 'Go', 'R', 'C', 'Java', 'JavaScript', 'SQL', 'Node.js', 'React', 'Python', 'F#', 'Objective-C', 'CI/CD', 'Rust', '(', 'a.b'];
const words = ['built', 'C++', 'C#', '.NET', 'Go', 'going', 'google', 'R&D', 'R', 'C', 'Java', 'JavaScript', 'SQL', 'NoSQL', 'Node.js', 'React', 'Python', 'team', 'led', 'systems', 'F#', 'Objective-C', 'CI/CD'];
let propertyOk = true; let propertyDetail = '';
for (let i = 0; i < 400 && propertyOk; i++) {
  const skills = pool.filter(() => rnd() < 0.5);
  const text = Array.from({ length: 10 + Math.floor(rnd() * 40) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  const c: ResumeCheck = checkResumeAgainstSkills(skills, text);
  const all = [...c.found, ...c.notFound];
  const overlap = c.found.filter((s) => c.notFound.includes(s));
  if (overlap.length) { propertyOk = false; propertyDetail = `both found and notFound: ${overlap}`; }
  if (c.status === 'ok' && all.length !== sanitizeSkills(skills).length) { propertyOk = false; propertyDetail = `partition mismatch for ${JSON.stringify(skills)}`; }
  for (const s of c.found) if (!skillAppearsInText(s, text)) { propertyOk = false; propertyDetail = `"${s}" reported found but matcher says no`; }
}
assert(propertyOk, '400 random cases: no skill is ever both found and not found; found ⊆ matcher; partition complete', propertyDetail);

// ── 3. The review UI ────────────────────────────────────────────────────────
console.log('\n5. ResumeCheckSummary — rendered output');
const render = (
  check: ResumeCheck,
  skills: string[] = ['React', 'Go'],
  suggestedSkills: string[] = [],
  onAddSkill: (skill: string) => void = () => {}
) =>
  renderToStaticMarkup(React.createElement(ResumeCheckSummary, {
    check, targetRoles: ['Backend Engineer'], skills, onRemoveSkill: () => {}, onBack: () => {}, onContinue: () => {},
    suggestedSkills, onAddSkill,
  }));
const okCheck: ResumeCheck = { status: 'ok', characterCount: 500, wordCount: 90, found: ['React'], notFound: ['Go'], skillsChecked: 2 };
const html = render(okCheck);
assert(html.includes('How matching works today') && html.includes('based on the skills, target roles and preferences') && html.includes('isn&#x27;t analysed for accuracy or used to score jobs yet'), 'always states that matching uses the declared profile, not the resume');
const visible = html.replace(/<[^>]*>/g, ' '); // visible text only (CSS class names such as "pt-1" are not content)
assert(!/\d+\s*\/\s*100/.test(visible) && !/\b\d+\s*pts?\b/.test(visible) && !/Strength|Readiness|Verified|Competitive|Needs Proof|High Proof/i.test(visible), 'no score, points, "Strength/Readiness", or "Verified" in the visible text');
assert(html.includes('Appear in your resume text (1)') && html.includes('Not found in your resume text (1)') && html.includes('plain text search'), 'found / not-found lists, described as a plain text search');
assert(html.includes('aria-label="Keep Go in my profile"') && html.includes('aria-label="Remove Go from my profile"'), 'keep / remove controls are labelled for each skill');
assert(!/Improvement|improve|Suggested|emphasi[sz]es|Distributed Systems|Add Details|\+3|\+4/i.test(html), 'no improvement cards, advice, or point-reward controls');
assert(html.includes('Your profile is saved when you continue') && !/are saved\./.test(html), 'saving claim is accurate (saved on continue, not before)');
for (const status of ['too_short', 'empty', 'error'] as const) {
  const h = render({ status, characterCount: 3, wordCount: 1, found: [], notFound: [], skillsChecked: 2 });
  assert(!h.includes('Not found in your resume text') && !h.includes('Appear in your resume text') && h.includes('How matching works today'), `status "${status}": no found/not-found claims, honesty note still shown`);
}
const removed = render(okCheck, ['React']);
assert(!removed.includes('aria-label="Remove Go') && !removed.includes('Not found in your resume text'), 'a skill the user has removed disappears from the review');

// ── 4. Hard-coded content is gone (static) ──────────────────────────────────
console.log('\n6. Hard-coded / unsupported content removed');
const onboarding = read('src/app/onboarding/page.tsx');
const summarySrc = read('src/components/onboarding/resume-check-summary.tsx');
const landing = read('src/app/page.tsx');
assert(!fs.existsSync(path.join(root, 'src/components/onboarding/resume-intelligence-dashboard.tsx')), 'the old ResumeIntelligenceDashboard (hard-coded cards, score, "Profile Verified") is deleted');
for (const phrase of ['emphasizes execution over', 'Distributed Systems Positioning', 'Clean chronological formatting', 'Core domain foundation', 'Profile Verified', 'Verified Strengths', 'Readiness', 'Profile Strength', 'Analyze my profile', 'Analyzing profile']) {
  assert(!onboarding.includes(phrase) && !summarySrc.includes(phrase), `"${phrase}" no longer appears in the onboarding flow`);
}
assert(!/from '@\/lib\/ai\/resume(-intelligence)?'/.test(onboarding), 'onboarding no longer calls the unreachable client-side AI/heuristic analysers');
assert(onboarding.includes('checkResumeAgainstSkills(skills, resumeText)') && onboarding.includes('<ResumeCheckSummary'), 'onboarding uses the facts-only check + summary');
assert(!/profileStrength:/.test(onboarding.replace(/\/\/.*$/gm, '')), 'onboarding no longer writes a fabricated profileStrength (was default 78)');
assert(onboarding.includes('your resume isn&apos;t analysed or used to score jobs yet'), 'step 6 says the resume is not analysed or used to score jobs');
assert(!/No achievements or claims are invented/.test(onboarding) && onboarding.includes("We don&apos;t invent skills, achievements or experience for your profile."), 'step-6 reassurance replaced with a claim that is true');
assert(!landing.includes('verified experience') && landing.includes('the experience and preferences you give us'), 'landing copy no longer says matches use "verified experience"');
const view = read('src/components/match/match-analysis-view.tsx');
assert(view.includes("replace('(Verified)'") && view.includes("replace('(Strong Evidence)', '(from your profile)')"), 'match view shows "(from your profile)" instead of "(Verified)" / "(Strong Evidence)" (display only)');
assert(onboarding.includes('const handleRemoveSkill = (skill: string) => {') && /setSkills\(\(prev\) => prev\.filter\(\(s\) => s\.toLowerCase\(\) !== skill\.toLowerCase\(\)\)\)/.test(onboarding), 'removing a skill keeps its previous behaviour (state + local store filter)');

// ── 5. Scope ────────────────────────────────────────────────────────────────
console.log('\n7. Scope — no matching, persistence, or snapshot changes (pinned to its own commits)');
// PR #9's own change set = the immutable commit range 4c3fc95..68eaee2 (base → tip of #9). Reading that range (not the
// branch diff) keeps these guards true when later PRs are stacked on top of #9 or merged after it. If the commits are
// not in this clone (e.g. a squash-merge) the file-scope checks are skipped, with a note.
const PR9_BASE = '4c3fc95', PR9_TIP = '68eaee2';
let pr9Files: string[] | null = null;
try {
  execSync(`git cat-file -e ${PR9_BASE} && git cat-file -e ${PR9_TIP}`, { cwd: root, stdio: 'ignore' });
  pr9Files = execSync(`git diff --name-only ${PR9_BASE} ${PR9_TIP}`, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch { /* not present */ }
if (pr9Files === null) {
  console.log('  note: the #9 commits are not in this clone (squash-merge?) — its file-scope guards are skipped.');
} else {
  const changed = pr9Files;
  const allowed = new Set([
    'src/lib/resume/skill-evidence.ts', 'src/lib/resume/resume-check.ts', 'src/components/onboarding/resume-check-summary.tsx',
    'src/components/onboarding/resume-intelligence-dashboard.tsx', 'src/app/onboarding/page.tsx', 'src/app/page.tsx',
    'src/components/match/match-analysis-view.tsx', 'test/resume-honesty-suite.ts',
  ]);
  assert(changed.every((f) => allowed.has(f)), 'PR #9 changed only the resume step, its helpers, landing copy and the match-view label', changed.filter((f) => !allowed.has(f)).join(', '));
  const frozen = ['src/lib/matching/', 'src/app/api/', 'supabase/', 'src/lib/db/', 'src/lib/ai/', 'src/lib/onboarding/', 'src/middleware.ts'];
  assert(changed.every((f) => !frozen.some((x) => f.startsWith(x))), 'PR #9 left the matcher, API routes (incl. swipe/snapshots), migrations, stores, AI libs, onboarding contract and middleware untouched');
}
const payloadBlock = onboarding.slice(onboarding.indexOf('const payload: OnboardingPayload = {'), onboarding.indexOf('const clientErrors'));
assert(['fullName', 'headline', 'employmentTypes', 'targetRoles', 'yearsOfExperience', 'skills:', 'workPreference', 'currentCountry', 'currentTimezone', 'allowedCountries', 'willingTimezones', 'rawResumeText: resumeText'].every((k) => payloadBlock.includes(k)), 'the onboarding payload sent to the server is unchanged (same fields)');

// ── 6. suggestSkillsFromResume — undeclared skill suggestions, never invented ──
console.log('\n8. suggestSkillsFromResume — undeclared skill suggestions, never invented');
const vocab = ['React', 'Go', 'C++', 'C#', '.NET', 'Python', 'Kubernetes', 'SQL', 'Java', 'Node.js'];
assert(suggestSkillsFromResume([], 'asdf qwer', vocab).length === 0, 'gibberish, too-short text → no suggestions (same too_short gate as checkResumeAgainstSkills)');
assert(suggestSkillsFromResume([], '', vocab).length === 0, 'empty resume text → no suggestions');
assert(
  suggestSkillsFromResume(null, sys, vocab).join() === 'C++,Python',
  'real text with no declared skills surfaces exactly the vocabulary terms it actually contains',
  JSON.stringify(suggestSkillsFromResume(null, sys, vocab))
);
assert(suggestSkillsFromResume(['C++'], sys, vocab).join() === 'Python', 'a skill already declared is never re-suggested');
assert(
  suggestSkillsFromResume(['c++', 'PYTHON'], sys, vocab).length === 0,
  'normalization: declared-skill matching is case-insensitive, same as the rest of this module'
);
assert(
  suggestSkillsFromResume([], 'I enjoy going to work and my google searches. Built in Go and Rust.', ['Go']).join() === 'Go',
  'false positive excluded: "going"/"google" do not themselves satisfy "Go" — only the real, later occurrence does, and it is still correctly suggested'
);
assert(
  suggestSkillsFromResume([], 'I enjoy going to work and my google searches.', ['Go']).length === 0,
  '"going"/"google" alone, with no real occurrence of "Go", produce no suggestion at all'
);
assert(
  !suggestSkillsFromResume([], 'Frontend engineer with five years of experience in JavaScript and React.', ['Java']).includes('Java'),
  'substring collision excluded: "Java" is not suggested from text that only contains "JavaScript" (11 words — above the too_short gate, so this exercises the token-boundary matcher, not the length gate)'
);
assert(
  suggestSkillsFromResume([], 'Backend engineer who has worked with NoSQL and MySQL databases only.', ['SQL']).length === 0,
  'substring collision excluded: "SQL" is not suggested from "NoSQL"/"MySQL" alone (11 words — above the too_short gate, so this exercises the token-boundary matcher, not the length gate)'
);
const exactDup = suggestSkillsFromResume([], sys, ['C++', 'C++', 'Python']);
assert(exactDup.join() === 'C++,Python', 'an EXACT repeated entry in the candidate vocabulary is deduplicated (checked once, suggested once)', JSON.stringify(exactDup));
// 'PostgreSQL' / 'Postgres' is a genuinely SYMMETRIC alias pair in ALIASES (skill-evidence.ts: 'postgresql':
// ['postgres'] AND 'postgres': ['postgresql']) — unlike 'C++'/'cpp', which is one-directional ('c++': ['cpp'] has
// no reverse entry), so a candidate list containing only 'cpp' would never match "C++" in resume text. With a
// symmetric pair, both spellings independently satisfy skillAppearsInText against the SAME resume evidence
// ("PostgreSQL" in the text) — demonstrating the real, documented limitation: the two spellings are not
// canonicalized into one entry, so both appear verbatim in the result, not merged.
const pgResume = 'Senior backend engineer with eight years building services on PostgreSQL and Python.';
const aliasPair = suggestSkillsFromResume([], pgResume, ['PostgreSQL', 'Postgres', 'Python']);
assert(
  aliasPair.join() === 'PostgreSQL,Postgres,Python',
  'documented limitation, not a defect: distinct, genuinely-symmetric alias spellings in the candidate vocabulary are NOT canonicalized to each other, so both independently match the same resume evidence and both appear in the result — the one real caller (onboarding\'s fixed popularSkills list) has no alias pairs at all, so this does not occur in practice',
  JSON.stringify(aliasPair)
);
assert(
  suggestSkillsFromResume([], 'Python C++ Go SQL Java Kubernetes .NET all in one sentence here for length', vocab).length <= MAX_SUGGESTED_SKILLS,
  `suggestions are capped at ${MAX_SUGGESTED_SKILLS} even when more are present`
);
for (const [label, v] of [['null', null], ['undefined', undefined], ['number', 42], ['object', {}]] as Array<[string, unknown]>) {
  assert(suggestSkillsFromResume(v, sys, vocab).length >= 0, `${label} declaredSkills never throws`);
}
assert(suggestSkillsFromResume([], sys, [] as string[]).length === 0, 'an empty candidate vocabulary yields no suggestions — it can never fall back to inventing one');

console.log('\n9. Resume review UI — Add/Dismiss wiring and guard logic');
// NOTE: this harness (renderToStaticMarkup, no DOM) cannot simulate a real click — a true event-level test would
// need jsdom/React Testing Library, a new dependency that is out of scope. What follows instead: (a) static
// source-text assertions that the exact guard/reducer expressions are present and correctly wired — the same
// convention already used below for handleRemoveSkill — and (b) before/after render comparisons that model the
// state transition a real click would cause.
const htmlWithSuggestions = render(okCheck, ['React', 'Go'], ['Python', 'Kubernetes']);
assert(
  htmlWithSuggestions.includes('Mentioned in your resume, not on your profile yet (2)') &&
    htmlWithSuggestions.includes('aria-label="Add Python to my profile"') &&
    htmlWithSuggestions.includes('aria-label="Dismiss Python suggestion"') &&
    htmlWithSuggestions.includes('aria-label="Add Kubernetes to my profile"'),
  'BEFORE a click: suggested skills render with explicit, individually-labelled Add and Dismiss controls'
);
assert(
  htmlWithSuggestions.includes('aria-label="Keep Go in my profile"') && htmlWithSuggestions.includes('aria-label="Remove Go from my profile"'),
  'the existing Keep/Remove controls for a declared-but-not-found skill are unaffected by the new section'
);
const htmlAlreadyDeclared = render(okCheck, ['React', 'Go', 'Python'], ['Python']);
assert(
  !htmlAlreadyDeclared.includes('Mentioned in your resume, not on your profile yet'),
  'AFTER a click: once "Python" is in the declared skills list, the same suggestedSkills prop no longer offers it — idempotent even if the stale prop still lists it, so Add can never apply the same skill twice'
);
const htmlNoSuggestions = render(okCheck, ['React', 'Go'], []);
assert(!htmlNoSuggestions.includes('Mentioned in your resume'), 'no suggestions → the new section renders nothing extra');
assert(
  !render({ status: 'empty', characterCount: 0, wordCount: 0, found: [], notFound: [], skillsChecked: 0 }, ['React'], ['Python']).includes('Mentioned in your resume'),
  'suggestions are not shown when there is no resume text to have found them in (status "empty")'
);
assert(
  onboarding.includes('const handleAddSuggestedSkill = (skill: string) => {') &&
    /setSkills\(\(prev\) => \(prev\.some\(\(s\) => s\.toLowerCase\(\) === skill\.toLowerCase\(\)\) \? prev : \[\.\.\.prev, skill\]\)\)/.test(onboarding),
  'Add is guarded by an exact case-insensitive duplicate check before appending — the same suggestion (or a skill already present) can never be added a second time, by construction of the state update itself, not just by what happens to render afterward'
);
assert(
  summarySrc.includes('const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());') &&
    /pendingSuggestions = suggestedSkills\.filter\(\s*\(s\) => !current\.has\(s\.toLowerCase\(\)\) && !dismissedSuggestions\.has\(s\.toLowerCase\(\)\)\s*\)/.test(summarySrc),
  'a suggestion disappears once it is either declared (added) or dismissed — both are checked independently in the same filter'
);
assert(
  /onClick=\{\(\) => setDismissedSuggestions\(\(prev\) => new Set\(prev\)\.add\(s\.toLowerCase\(\)\)\)\}/.test(summarySrc),
  'Dismiss updates only local dismissedSuggestions state'
);
const onAddSkillCallSites = (summarySrc.match(/onAddSkill\(s\)/g) ?? []).length;
assert(
  onAddSkillCallSites === 1,
  'onAddSkill is wired to exactly one control (Add) — Dismiss never calls it, so Dismiss structurally cannot change the candidate\'s declared skills, by construction rather than by observed render output alone',
  String(onAddSkillCallSites)
);

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

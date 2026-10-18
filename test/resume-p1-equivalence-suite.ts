/**
 * RemoteMatch — Resume P1 clean-up: behaviour-preservation (equivalence) suite
 * ==============================================================================
 * P1 is a CLEAN-UP with no behaviour change (Deep, 2026-10-13: no matching, scoring, persistence, API or snapshot
 * changes). It (a) deletes src/lib/ai/resume.ts — dead code with zero importers whose fallback fabricated a profile
 * (audit R-P1-5), (b) marks the unreachable client-side resume analysers @deprecated (comment only), and
 * (c) extracts the PDF text-joining expressions into pure functions.
 *
 * This suite PROVES equivalence rather than asserting it:
 *  1. GOLDEN: outputs of every production-reachable resume function on a fixed corpus were recorded from the
 *     UNCHANGED base commit (test/fixtures/resume-p1-golden.json, via `--record`) and must be byte-identical now.
 *  2. REFERENCE: the extracted PDF functions are compared with a verbatim copy of the ORIGINAL inline expressions over
 *     thousands of generated inputs, and over text items produced by the real pdfjs on a hand-built PDF.
 *  3. REACHABILITY: nothing under src/app, src/components or middleware can reach the deleted module or the
 *     deprecated analysers; nothing in the repo references the deleted symbols.
 *  4. SCOPE: the diff touches only the allowed files (merge-base diff).
 *
 * Pure (no network, no DB). Run: npx tsx test/resume-p1-equivalence-suite.ts   |   record: … --record (base commit only)
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { PersonProfile } from '../src/types/byn';
import { generateJobSpecificResumeAnalysis } from '../src/lib/ai/resume-intelligence';
import { checkResumeAgainstSkills } from '../src/lib/resume/resume-check';
import { skillAppearsInText } from '../src/lib/resume/skill-evidence';
import { CURATED_JOBS } from '../src/lib/providers/curated';
import { normalizeOpportunity } from '../src/lib/ingestion/pipeline';

const root = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'resume-p1-golden.json');
const RECORD = process.argv.includes('--record');

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── the corpus (deterministic; no dates, no randomness beyond a seeded PRNG) ──
const NOW = '2026-01-01T00:00:00.000Z';
const profile = (skills: string[], roles: string[], rawResumeText = '', yoe: '0-1' | '2-3' | '4-6' | '7-10' | '10+' = '4-6'): PersonProfile => ({
  id: 'p', email: '', fullName: 'T', planTier: 'free', dailyEvaluationsCount: 0, lastEvaluationResetAt: NOW, createdAt: NOW, updatedAt: NOW,
  rawResumeText,
  skills: skills.map((s, i) => ({ id: `s-${i}`, profileId: 'p', skillName: s, isPrimary: i < 4 })), experiences: [],
  intent: { id: 'i', profileId: 'p', employmentTypes: ['Full-time'], targetRoles: roles, yearsOfExperience: yoe, preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: NOW },
});
const REAL_RESUME = `Jane Doe — Senior Backend Engineer
Experience
2019–Present  Staff Engineer, Acme Corp. Led a team of 6 to migrate a monolith to Go services handling 40k requests/sec, cutting p99 latency by 35%.
2015–2019  Software Engineer, Initech. Built PostgreSQL-backed APIs in Python and Django; owned CI/CD on AWS and Kubernetes.
Skills  Go, Python, PostgreSQL, Kubernetes, Terraform, React, TypeScript
Education  BSc Computer Science`;
const ANALYZER_CASES: Array<[string, PersonProfile, string]> = [
  ['garbage', profile(['Python', 'Go'], ['Backend Engineer']), 'asdf qwer'],
  ['one word, six skills', profile(['React', 'Rust', 'Go', 'Kubernetes', 'Terraform', 'Scala'], ['Staff Engineer']), 'Hello'],
  ['empty text', profile(['Python'], ['Backend Engineer']), ''],
  ['C++ skill (throws today)', profile(['C++', 'Python'], ['Systems Engineer']), 'Senior systems engineer. Built low-latency trading systems in C++ and Python. 2016-2024.'],
  ['C# and .NET', profile(['C#', '.NET'], ['Backend Engineer']), 'Backend engineer with 8 years in C# and .NET. Reduced latency 40%.'],
  ['Go vs going', profile(['Go'], ['Backend Engineer']), 'I enjoy going to work and my google searches. 2020-2024 experience section.'],
  ['realistic resume', profile(['Go', 'Python', 'PostgreSQL', 'Kubernetes', 'Rust'], ['Backend Engineer', 'Platform Engineer'], REAL_RESUME, '10+'), REAL_RESUME],
  ['no roles', { ...profile(['React'], []), intent: undefined }, 'React developer. 2018-2024. Experience, Skills, Education.'],
];
const OPPS = CURATED_JOBS.slice(0, 4).map(normalizeOpportunity);
const CHECK_CASES: Array<[string, unknown, unknown]> = [
  ['gibberish', ['Python', 'Go'], 'asdf qwer'], ['empty', ['React'], ''], ['null text', ['React'], null], ['not array', 'React', REAL_RESUME],
  ['real', ['Go', 'Python', 'C++', 'Rust', 'Kubernetes'], REAL_RESUME], ['hostile skills', ['C++', '(((', '[a-', '\\', '.*', 'C#', '.NET'], REAL_RESUME],
  ['dupes', ['Go', 'go', ' GO ', 'Go'], REAL_RESUME], ['many', Array.from({ length: 150 }, (_, i) => `Skill${i}`), REAL_RESUME],
];
const MATCH_SKILLS = ['C++', 'C#', '.NET', 'Go', 'R', 'C', 'Java', 'JavaScript', 'SQL', 'Node.js', 'React', 'Python', 'F#', 'Objective-C', 'CI/CD', 'Rust', 'Kubernetes', 'Tailwind CSS', 'Golang', 'Postgres'];
const MATCH_TEXTS = ['Built services in C++ and Go.', 'C#, .NET and ASP.NET Core', 'going to google; Mongodb; Django', 'R&D in R and SQL; NoSQL', 'JavaScript, Node.js, Next.js, React Native', 'Kubernetes (k8s), Terraform, CI/CD pipelines', 'Tailwind\u00A0CSS and Postgres; C-level exec; Objective-C', ''];

function safe<T>(fn: () => T): { ok: T } | { threw: string } {
  try { return { ok: fn() }; } catch (e) { return { threw: (e as Error).message }; }
}
function computeGolden() {
  // `analyzer` is no longer computed: analyzeResumeHeuristically was removed in resume PR A. ANALYZER_CASES stays as
  // documentation of the recorded corpus (the golden file still holds the outputs that justified the removal).
  void ANALYZER_CASES;
  return {
    jobSpecific: [profile(['React', 'TypeScript'], ['Frontend Engineer'], REAL_RESUME), profile(['Go'], ['Backend Engineer'], ''), profile([], [])]
      .map((p, pi) => OPPS.map((o, oi) => [`${pi}/${oi}`, safe(() => generateJobSpecificResumeAnalysis(p, o))])),
    check: CHECK_CASES.map(([name, s, t]) => [name, checkResumeAgainstSkills(s, t)]),
    matcher: MATCH_SKILLS.map((s) => [s, MATCH_TEXTS.map((t) => skillAppearsInText(s, t))]),
  };
}

// ── verbatim copies of the ORIGINAL inline PDF expressions (src/lib/resume/extract-pdf-text.ts @ 4c3fc95) ──
const ORIGINAL_join = (items: ReadonlyArray<any>) => items.map((item) => ('str' in item ? item.str : '')).join(' ');
const ORIGINAL_assemble = (pageTexts: string[]) => pageTexts.join('\n\n').replace(/[ \t]+/g, ' ').trim();

async function main() {
  console.log('='.repeat(78));
  console.log(RECORD ? 'RECORDING GOLDEN OUTPUTS (base commit)' : 'RESUME P1 — BEHAVIOUR PRESERVATION');
  console.log('='.repeat(78));

  const golden = computeGolden();
  if (RECORD) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n');
    console.log(`recorded ${GOLDEN} (${JSON.stringify(golden).length} bytes)`);
    return;
  }

  console.log('\n1. Golden outputs (recorded from the unchanged base) are byte-identical');
  const recorded = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const now = JSON.parse(JSON.stringify(golden));
  // P1b INTENTIONALLY replaced generateJobSpecificResumeAnalysis (invented template text → data-derived suggestions);
  // that function is therefore no longer pinned to the P1 golden and is covered by test/resume-p1b-suite.ts instead.
  // `analyzer`: the function was REMOVED in resume PR A (docs/resume-intelligence-design.md §1), so it is no longer pinned.
  for (const key of ['check', 'matcher'] as const) {
    assert(JSON.stringify(now[key]) === JSON.stringify(recorded[key]), `${key}: output identical to the recorded base output (${(recorded[key] as unknown[]).length} cases)`);
  }
  assert(JSON.stringify(now.jobSpecific) !== JSON.stringify(recorded.jobSpecific), 'jobSpecific: deliberately CHANGED by P1b (the old golden documents the invented text that was removed)');
  assert((recorded.analyzer as any[]).some(([n, r]) => n.startsWith('C++') && 'threw' in r), 'the golden corpus really includes the known C++ analyser crash (so "identical" includes unfixed legacy quirks — they are P-later, not P1)');

  console.log('\n2. PDF extraction — DELIBERATELY changed by resume PR A (layout-aware; was equivalence-pinned in P1)');
  // P1 proved the extracted functions equal the original one-line join. Resume PR A (Deep-approved, decision 2 of
  // docs/resume-intelligence-design.md §10) replaces that join with a layout-aware one, so equivalence is NO LONGER the
  // contract: test/pdf-extraction-fidelity-suite.ts is. Here we only record that the change is real and intended.
  const mod = await import('../src/lib/resume/extract-pdf-text');
  assert(typeof mod.joinPageItems === 'function' && typeof mod.assemblePdfText === 'function', 'joinPageItems / assemblePdfText exist and are exported');
  assert(mod.assemblePdfText([]) === '' && mod.assemblePdfText(['  ', '\t']) === '', 'empty / whitespace-only pages assemble to "" (the caller still raises its "no text" error)');
  assert(mod.assemblePdfText(['a', 'b']) === 'a\n\nb', 'pages are still separated by a blank line');

  // The real pdfjs on a hand-built two-line PDF: P1 characterised "line breaks are lost"; PR A flips that.
  const pdf = buildPdf(['Hello World', 'Second line C++ and Go']);
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const std = path.join(root, 'node_modules', 'pdfjs-dist', 'standard_fonts').split(path.sep).join('/') + '/'; // pdfjs wants forward slashes + a trailing slash
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), standardFontDataUrl: std, useSystemFonts: false, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const real = mod.assemblePdfText([mod.joinPageItems(content.items)]);
    const old = ORIGINAL_assemble([ORIGINAL_join(content.items)]);
    assert(real === 'Hello World\nSecond line C++ and Go', 'CHARACTERISATION (changed by PR A): the two PDF lines now come out as two lines', JSON.stringify(real));
    assert(!old.includes('\n') && old.replace(/\s+/g, ' ') === real.replace(/\s+/g, ' '), 'the only difference from the original join is whitespace layout — the same words in the same order', JSON.stringify({ old, real }));
  } catch (e) {
    assert(false, 'pdfjs (legacy build, Node) could read the hand-built PDF', (e as Error).message);
  }

  console.log('\n3. Reachability — the deleted / deprecated code cannot be reached from production');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.next', '.git'].includes(e.name)) walk(p, out); }
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');
  assert(!fs.existsSync(path.join(root, 'src/lib/ai/resume.ts')), 'src/lib/ai/resume.ts (parseResumeWithAI / parseResumeHeuristically — fabricating fallback) is deleted');
  const all = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'test')), ...walk(path.join(root, 'scripts'))].filter((p) => !p.endsWith('resume-p1-equivalence-suite.ts'));
  const refsDeleted = all.filter((p) => /parseResumeWithAI|parseResumeHeuristically|ExtractedResumeData|from ['"][^'"]*\/ai\/resume['"]/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert(refsDeleted.length === 0, 'nothing in src/, test/ or scripts/ references the deleted module or its symbols', refsDeleted.join(', '));
  const prod = [...walk(path.join(root, 'src/app')), ...walk(path.join(root, 'src/components'))].concat(fs.existsSync(path.join(root, 'src/middleware.ts')) ? [path.join(root, 'src/middleware.ts')] : []);
  const reach = prod.filter((p) => /analyzeResumeWithAI|analyzeResumeHeuristically/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert(reach.length === 0, 'no page, component, API route or middleware references the deprecated client-side resume analysers', reach.join(', '));
  const importers = prod.filter((p) => /lib\/ai\/resume-intelligence/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert(importers.length === 1 && importers[0] === 'src/app/match/[jobId]/page.tsx', 'the only production importer of resume-intelligence.ts is the match page (generateJobSpecificResumeAnalysis, unchanged)', importers.join(', '));
  const ri = fs.readFileSync(path.join(root, 'src/lib/ai/resume-intelligence.ts'), 'utf8');
  assert(!/export\s+(async\s+)?function\s+(analyzeResumeHeuristically|analyzeResumeWithAI)\b/.test(ri), 'analyzeResumeHeuristically and analyzeResumeWithAI are REMOVED (resume PR A), not just deprecated');
  const anyRef = all.filter((p) => /\b(analyzeResumeHeuristically|analyzeResumeWithAI)\s*\(/.test(fs.readFileSync(p, 'utf8'))).map(rel);
  assert(anyRef.length === 0, 'nothing in src/, test/ or scripts/ calls the removed analysers', anyRef.join(', '));

  console.log('\n4. Scope — no matching, scoring, persistence, API or snapshot change (pinned to the P1 commit itself)');
  // These guards describe what the P1 commit changed. They read that immutable commit (not the branch diff), so they
  // stay true when later PRs (e.g. P1b) are stacked on top of P1 or merged after it.
  const P1_COMMIT = 'c9e9eaf';
  const lines = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  let p1Files: string[] | null = null;
  let p1RiDiff = '';
  try {
    execSync(`git cat-file -e ${P1_COMMIT}`, { cwd: root, stdio: 'ignore' });
    p1Files = lines(`git show --name-only --pretty=format: ${P1_COMMIT}`);
    p1RiDiff = execSync(`git show ${P1_COMMIT} -- src/lib/ai/resume-intelligence.ts`, { cwd: root, encoding: 'utf8' });
  } catch { /* commit not present (e.g. squash-merged): the checks below are skipped, with a note */ }
  if (p1Files === null) {
    console.log('  note: the P1 commit is not in this clone (squash-merge?) — its scope / comments-only guards are skipped.');
  } else {
    const allowedP1 = new Set(['src/lib/ai/resume.ts', 'src/lib/ai/resume-intelligence.ts', 'src/lib/resume/extract-pdf-text.ts', 'test/resume-p1-equivalence-suite.ts', 'test/fixtures/resume-p1-golden.json', 'test/openai-reasoning-effort-suite.ts', 'test/resume-honesty-suite.ts']);
    assert(p1Files.every((f) => allowedP1.has(f)), 'the P1 commit changed only the retired module, the deprecation notice, the PDF-join extraction, this suite and the two guard literals it forced', p1Files.filter((f) => !allowedP1.has(f)).join(', '));
    const frozenP1 = ['src/lib/matching/', 'src/app/', 'src/components/', 'supabase/', 'src/lib/db/', 'src/lib/onboarding/', 'src/middleware.ts'];
    assert(p1Files.every((f) => !frozenP1.some((x) => f.startsWith(x))), 'the P1 commit left matcher, pages/components, API routes (incl. swipe/snapshots), migrations, stores, onboarding contract and middleware untouched');
    const p1Code = p1RiDiff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).filter((l) => !/^[+-]\s*(\/\/|\/\*|\*|$)/.test(l));
    assert(p1Code.length === 0, "the P1 commit's change to resume-intelligence.ts is COMMENTS ONLY (no code line added or removed)", p1Code.slice(0, 3).join(' | '));
  }

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

/** A minimal, valid one-page PDF with one text line per entry (Helvetica) — no libraries, no network. */
function buildPdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 12 Tf 14 TL 72 720 Td ${lines.map((l, i) => `${i ? 'T* ' : ''}(${esc(l)}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

main().catch((e) => { console.error(e); process.exit(2); });

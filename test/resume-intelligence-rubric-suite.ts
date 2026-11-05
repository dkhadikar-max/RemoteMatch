/**
 * Resume Intelligence (PR B) — deterministic-layer suite.
 * docs/resume-intelligence-design.md §4. Pure, no network, no AI.
 * Run: npx tsx test/resume-intelligence-rubric-suite.ts
 */
import {
  buildSectionMap,
  extractBullets,
  extractionSignals,
  extractDateRanges,
  findChronologyIssues,
  findDuplicateBullets,
  evaluateSkillEvidence,
  runDeterministicAnalysis,
} from '../src/lib/resume/rubric';
import { redactForModel, mapRedactedOffsetToOriginal, containsPlaceholder } from '../src/lib/resume/redaction';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const REAL_RESUME = `Jane Doe
Senior Backend Engineer | jane.doe@example.invalid | +1 415-555-0134 | linkedin.com/in/janedoe

Summary
Backend engineer with 8 years building distributed systems.

Experience
Staff Engineer, Acme Corp
Jan 2019 - Present
• Led a team of 6 to migrate a monolith to Go services handling 40k requests/sec.
• Cut p99 latency by 35% through caching and query optimization.
• Led a team of 6 to migrate a monolith to Go services handling 40k requests/sec.

Software Engineer, Initech
Mar 2015 - Dec 2018
• Built PostgreSQL-backed APIs in Python and Django.
• Owned CI/CD on AWS and Kubernetes.

Education
BSc Computer Science, State University
2015

Skills
Go, Python, PostgreSQL, Kubernetes, Terraform, React, TypeScript, Docker
`;

async function main() {
  console.log('='.repeat(78));
  console.log('RESUME INTELLIGENCE (PR B) — DETERMINISTIC LAYER');
  console.log('='.repeat(78));

  console.log('\n1. Section map');
  const sections = buildSectionMap(REAL_RESUME);
  const ids = sections.map((s) => s.id);
  assert(ids.includes('summary') && ids.includes('experience') && ids.includes('education') && ids.includes('skills'), 'recognises Summary/Experience/Education/Skills headings', JSON.stringify(ids));
  assert(ids[0] === 'header' || ids[0] === 'summary', 'the header block (name/contact) precedes the first recognised heading', JSON.stringify(ids));
  const noHeadings = buildSectionMap('Just some plain text with no headings at all, paragraph only.');
  assert(noHeadings.length === 1 && noHeadings[0].id === 'body', 'a resume with no recognisable headings becomes one "body" section, never throws');

  // G6 (docs/resume-pr-b-inventory-2026-10-30.md): the fallback itself was already covered above —
  // this makes explicit the R1 (header & contact) consequence G6 actually flags. A one-paragraph,
  // headerless resume (the realistic case this fallback exists for, not just an edge case) has no
  // section specifically scoped to header/contact info — R1's rating has only the single 'body'
  // section to anchor evidence to, same as every other criterion. Not a defect by itself (R1 can
  // still rate against 'body'), but it means this case has no labelled expected R1 outcome anywhere
  // yet — flagged for docs/resume-intelligence-design.md §9's evaluation set, not fixed here.
  const oneParagraphResume = 'Jane Doe, backend engineer with 6 years building Go services at two startups, currently leading a 4-person team shipping payments infrastructure. jane@example.com';
  const headerlessSections = buildSectionMap(oneParagraphResume);
  assert(headerlessSections.length === 1 && headerlessSections[0].id === 'body', 'G6: a realistic one-paragraph resume with no recognised heading also collapses to a single "body" section');
  assert(!headerlessSections.some((s) => s.id === 'header'), 'G6: no section is specifically scoped to header/contact info in this case — R1 has only "body" to anchor evidence to, same as every other criterion');

  console.log('\n2. Bullets');
  const bullets = extractBullets(REAL_RESUME, sections);
  // 5, not 4: the fixture deliberately repeats one bullet verbatim (for the duplicate-detection
  // test in §5) — extractBullets must still find every bulleted line, including the duplicate.
  assert(bullets.length === 5, `extracts all 5 bulleted lines, including the deliberately-repeated one (got ${bullets.length})`, JSON.stringify(bullets.map((b) => b.text)));
  assert(bullets.every((b) => b.sectionId === 'experience' || b.sectionId?.startsWith('experience')), 'every bullet is attributed to the Experience section', JSON.stringify(bullets.map((b) => b.sectionId)));
  assert(bullets[0].leadingVerb === 'Led', 'captures the leading verb of a bullet');
  const noBullets = extractBullets('No bullets here, just prose.', []);
  assert(noBullets.length === 0, 'text with no bullet glyphs yields an empty array, never throws');

  console.log('\n3. Extraction-quality signals');
  const oneLine = extractionSignals('A'.repeat(500));
  assert(oneLine.some((s) => s.code === 'no_line_breaks'), 'a single very long line with no breaks is flagged');
  const clean = extractionSignals(REAL_RESUME);
  assert(!clean.some((s) => s.code === 'no_line_breaks'), 'a normal multi-line resume is NOT flagged for missing line breaks');
  const repeatedHeader = extractionSignals(Array(4).fill('CONFIDENTIAL - DO NOT DISTRIBUTE').join('\n'));
  assert(repeatedHeader.some((s) => s.code === 'repeated_line'), 'a line repeated 3+ times (a header/footer artifact) is flagged');

  console.log('\n4. Chronology');
  const ranges = extractDateRanges(REAL_RESUME);
  assert(ranges.length === 2, `finds both date ranges (got ${ranges.length})`, JSON.stringify(ranges.map((r) => r.raw)));
  const normalFindings = findChronologyIssues(ranges);
  // The fixture lists the current role FIRST (Jan 2019 - Present) and the earlier one SECOND
  // (Mar 2015 - Dec 2018) — the standard newest-first resume convention. That must never be
  // flagged as a problem; only a genuine overlap or >6-month gap should be.
  assert(normalFindings.length === 0, 'a normal newest-first resume (two consecutive, non-overlapping roles) produces no chronology findings', JSON.stringify(normalFindings));
  const overlapping = extractDateRanges('Role A, Jan 2020 - Dec 2022. Role B, Jan 2021 - Mar 2023.');
  const overlapFindings = findChronologyIssues(overlapping);
  assert(overlapFindings.some((f) => f.code === 'overlap'), 'two genuinely overlapping ranges are flagged as an overlap (a neutral observation, not a judgment)');
  const gapped = extractDateRanges('Role A, Jan 2018 - Jun 2018. Role B, Jan 2020 - Dec 2021.');
  const gapFindings = findChronologyIssues(gapped);
  assert(gapFindings.some((f) => f.code === 'gap'), 'a gap of more than 6 months between two ranges is flagged');
  assert(findChronologyIssues([]).length === 0 && findChronologyIssues(extractDateRanges('no dates here')).length === 0, 'zero or one date range never throws and produces no findings');
  const threeRolesNewestFirst = extractDateRanges('Lead, Jan 2023 - Present. Senior, Jan 2020 - Dec 2022. Junior, Jan 2017 - Dec 2019.');
  assert(threeRolesNewestFirst.length === 3 && findChronologyIssues(threeRolesNewestFirst).length === 0, 'three consecutive roles listed newest-first (the common case) produce zero findings', JSON.stringify(findChronologyIssues(threeRolesNewestFirst)));

  console.log('\n5. Duplicate bullets');
  const dupBullets = extractBullets(REAL_RESUME, sections);
  const dups = findDuplicateBullets(dupBullets);
  assert(dups.length === 1, `finds the exact duplicate bullet planted in the fixture (got ${dups.length})`, JSON.stringify(dups));
  const distinctBullets = extractBullets('• Wrote the onboarding docs.\n• Reviewed pull requests for the platform team.', []);
  assert(findDuplicateBullets(distinctBullets).length === 0, 'two genuinely different bullets are not flagged as duplicates');

  console.log('\n6. Skill evidence');
  const skillEv = evaluateSkillEvidence(['Go', 'Python', 'Rust', 'Kubernetes'], REAL_RESUME, sections);
  const byName = Object.fromEntries(skillEv.map((s) => [s.skill, s]));
  assert(byName['Go'].inExperienceOrProjects, 'Go is found in the Experience section (not just the Skills list)');
  assert(byName['Rust'].notFound, 'Rust (not mentioned anywhere) is reported not found');
  assert(!skillEv.some((s) => s.inExperienceOrProjects && s.notFound), 'no skill is ever both found-in-experience and not-found at once');

  console.log('\n7. Full deterministic pass (entry point)');
  const full = runDeterministicAnalysis(REAL_RESUME, ['Go', 'Python']);
  assert(full.wordCount > 20 && full.charCount > 100, 'computes a sane word/char count');
  assert(full.sections.length > 0 && full.bullets.length === 5 && full.duplicates.length === 1, 'the entry point wires sections/bullets/duplicates together correctly');
  const empty = runDeterministicAnalysis('', []);
  assert(empty.charCount === 0 && empty.sections.length === 1, 'empty input never throws and returns a minimal, honest result');
  const hostile = runDeterministicAnalysis(null, ['C++', '(((', '*']);
  assert(hostile.charCount === 0, 'non-string input and hostile skill names never throw');

  console.log('\n8. PII redaction and offset mapping');
  const { redactedText, spans } = redactForModel(REAL_RESUME, 'Jane Doe');
  assert(!redactedText.includes('jane.doe@example.invalid'), 'email is redacted');
  assert(!redactedText.includes('415-555-0134'), 'phone number is redacted');
  assert(!redactedText.includes('linkedin.com/in/janedoe'), 'the LinkedIn link is redacted');
  assert(!/\bJane Doe\b/.test(redactedText.replace(/\[NAME\]/g, '')), 'the candidate\'s declared name is redacted everywhere it appears');
  assert(redactedText.includes('Staff Engineer, Acme Corp'), 'non-PII content (employer, role, bullets) is left untouched');
  assert(spans.length >= 4, `at least 4 spans redacted (email, phone, link, name) (got ${spans.length})`);

  // offset round-trip: a known substring AFTER several redactions maps back to the right place.
  const marker = 'handling 40k requests/sec';
  const redactedIdx = redactedText.indexOf(marker);
  assert(redactedIdx !== -1, 'the marker text survives redaction (sanity check for the test itself)');
  const mappedStart = mapRedactedOffsetToOriginal(spans, redactedIdx);
  assert(REAL_RESUME.slice(mappedStart, mappedStart + marker.length) === marker, 'an offset into the redacted text maps back to the correct offset in the ORIGINAL text', `mapped=${mappedStart}`);

  assert(containsPlaceholder('contact them at [EMAIL] for details'), 'containsPlaceholder detects a placeholder token');
  assert(!containsPlaceholder('contact them by email for details'), 'containsPlaceholder does not false-positive on the word "email"');

  const shortName = redactForModel('Hi there, I am a candidate.', 'Al');
  assert(shortName.spans.every((s) => s.kind !== 'NAME'), 'a very short declared name (≤2 chars) is never used to redact, to avoid over-matching common words');

  console.log('\n' + '='.repeat(78));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });

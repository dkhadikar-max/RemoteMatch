import { buildAuthenticityReview } from '../src/lib/resume/authenticity';
import { rewriteIsSupported } from '../src/lib/resume/evidence-validation';
import type { ResumeBullet } from '../src/lib/resume/rubric';

let passed = 0;
let failed = 0;
function assert(condition: boolean, name: string) {
  if (condition) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`); }
}

const resume = [
  'Summary',
  'Results-driven professional and team player.',
  'Experience',
  '• Responsible for customer acquisition.',
  '• Worked on sales campaigns with the marketing team.',
  '• Increased monthly enquiries by 18%.',
].join('\n');

const bullets: ResumeBullet[] = [
  { id: 'b1', sectionId: 'experience', text: 'Responsible for customer acquisition.', start: resume.indexOf('Responsible'), end: resume.indexOf('Responsible') + 'Responsible for customer acquisition.'.length, leadingVerb: 'Responsible' },
  { id: 'b2', sectionId: 'experience', text: 'Worked on sales campaigns with the marketing team.', start: resume.indexOf('Worked'), end: resume.indexOf('Worked') + 'Worked on sales campaigns with the marketing team.'.length, leadingVerb: 'Worked' },
  { id: 'b3', sectionId: 'experience', text: 'Increased monthly enquiries by 18%.', start: resume.indexOf('Increased'), end: resume.indexOf('Increased') + 'Increased monthly enquiries by 18%.'.length, leadingVerb: 'Increased' },
];

const review = buildAuthenticityReview(resume, bullets);
assert(review.findings.length === 3, 'flags two vague bullets and one generic profile phrase');
assert(review.findings.every((finding) => finding.evidence.length === 1), 'every deterministic finding carries source evidence');
assert(review.findings.every((finding) => resume.slice(finding.evidence[0].start, finding.evidence[0].end) === finding.evidence[0].quote), 'evidence offsets resolve to the exact original text');
assert(review.questions.length <= 3, 'limits clarification questions to avoid overwhelming candidates');
assert(review.questions.some((question) => question.question.includes('personally do')), 'asks for personal contribution instead of inventing impact');
assert(!review.findings.some((finding) => finding.evidence[0]?.quote.includes('Increased monthly enquiries')), 'does not flag a specific achievement as vague');

assert(!rewriteIsSupported('Led a team to deliver the project.', 'Worked with a team to deliver the project.', resume, []), 'rejects an unsupported upgrade from collaboration to leadership');
assert(rewriteIsSupported('Led a team to deliver the project.', 'Led a team to deliver the project.', resume, []), 'allows leadership wording already present in the original bullet');
assert(!rewriteIsSupported('Managed a team of 12.', 'Supported a team.', resume, []), 'rejects invented management ownership and headcount');
assert(rewriteIsSupported('Supported a team during sales campaigns.', 'Supported a team during sales campaigns.', resume, []), 'preserves accurate support-level language');
assert(!rewriteIsSupported('Managed a team to deliver the project.', 'Led a team to deliver the project.', resume, []), 'does not silently swap one leadership claim for another');
assert(!rewriteIsSupported('Led a team of 12 to deliver the project.', 'Led a team to deliver the project.', resume, []), 'rejects a new standalone headcount number');
assert(rewriteIsSupported('Led a team of 6 to deliver the project.', 'Led a team to deliver the project.', resume + '\nLed a team of 6.', []), 'allows a number that is present in the resume evidence');

console.log(`\nAuthenticity suite: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

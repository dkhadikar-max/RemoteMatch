/**
 * RemoteMatch — Public Typography & Hierarchy Regression Test Suite
 * ==============================================================================
 * Regression guard for T1 + T5 typography implementation.
 *
 * Invariants tested:
 *   1. No text below 12px (zero occurrences of text-[8px], text-[9px], text-[10px], text-[11px] or sub-12px)
 *      across public unauthenticated pages and components.
 *   2. Semantic typography tokens present in :root (--text-display, --text-h1, --text-h2, --text-h3,
 *      --text-body, --text-small, --text-label).
 *   3. Global typography classes (.eyebrow, .section-label, .tag) conform to minimum 12px font size.
 *   4. Responsive body copy and job description targets meet editorial hierarchy standards.
 *
 * Pure; no network. Run: npx tsx test/public-typography-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

console.log('='.repeat(78));
console.log('PUBLIC TYPOGRAPHY & HIERARCHY REGRESSION SUITE (T1 + T5)');
console.log('='.repeat(78));

// ── 1. Semantic typography tokens in globals.css ─────────────────────────────
console.log('\n1. Semantic typography scale tokens in globals.css');
const css = read('src/app/globals.css');
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));

const requiredTokens = [
  '--text-display',
  '--text-h1',
  '--text-h2',
  '--text-h3',
  '--text-body',
  '--text-small',
  '--text-label',
];

for (const t of requiredTokens) {
  const present = rootBlock.includes(`${t}:`);
  assert(present, `Token ${t} declared in :root`);
}

// ── 2. Global utility class minimum sizes ────────────────────────────────────
console.log('\n2. Utility classes .eyebrow, .section-label, and .tag font sizes');
const eyebrowMatch = css.match(/\.eyebrow\s*\{[^}]*font-size:\s*(\d+)px/);
assert(
  eyebrowMatch !== null && parseInt(eyebrowMatch[1], 10) >= 12,
  `.eyebrow font-size is at least 12px (found ${eyebrowMatch ? eyebrowMatch[1] : 'none'}px)`
);

const sectionLabelMatch = css.match(/\.section-label\s*\{[^}]*font-size:\s*(\d+)px/);
assert(
  sectionLabelMatch !== null && parseInt(sectionLabelMatch[1], 10) >= 12,
  `.section-label font-size is at least 12px (found ${sectionLabelMatch ? sectionLabelMatch[1] : 'none'}px)`
);

const tagMatch = css.match(/\.tag\s*\{[^}]*font-size:\s*(\d+)px/);
assert(
  tagMatch !== null && parseInt(tagMatch[1], 10) >= 12,
  `.tag font-size is at least 12px (found ${tagMatch ? tagMatch[1] : 'none'}px)`
);

// ── 3. Public unauthenticated pages scan for sub-12px arbitrary classes ─────
console.log('\n3. Guard against sub-12px arbitrary classes (text-[8px], text-[10px], text-[11px])');

const publicFiles = [
  'src/app/page.tsx',
  'src/app/remote-jobs/page.tsx',
  'src/app/remote-jobs/[slug]/page.tsx',
  'src/app/remote-jobs/view/[id]/page.tsx',
  'src/app/guide/page.tsx',
  'src/app/guide/[slug]/page.tsx',
  'src/app/login/page.tsx',
  'src/app/signup/page.tsx',
  'src/app/forgot-password/page.tsx',
  'src/app/reset-password/page.tsx',
  'src/components/auth/VerifyCode.tsx',
];

const sub12Regex = /text-\[(?:[0-9]|1[01])px\]/g;

for (const relPath of publicFiles) {
  const content = read(relPath);
  const matches = content.match(sub12Regex);
  assert(
    !matches || matches.length === 0,
    `No sub-12px arbitrary font sizes in ${relPath}`,
    matches ? `Found matches: ${matches.join(', ')}` : undefined
  );
}

// ── 4. Responsive typography targets on body copy ────────────────────────────
console.log('\n4. Responsive body copy and job description targets');

const jobViewContent = read('src/app/remote-jobs/view/[id]/page.tsx');
assert(
  jobViewContent.includes('text-base text-[var(--ink)]/90 leading-relaxed'),
  'Job view description upgraded to text-base text-[var(--ink)]/90'
);

const directoryContent = read('src/app/remote-jobs/page.tsx');
assert(
  directoryContent.includes('text-sm text-[var(--muted)] line-clamp-2 leading-relaxed'),
  'Directory job card descriptions use text-sm'
);

const guideContent = read('src/app/guide/[slug]/page.tsx');
assert(
  guideContent.includes('text-base sm:text-lg leading-relaxed text-[var(--muted)]'),
  'Guide article paragraphs upgraded to text-base sm:text-lg'
);

// ── 5. Form typography scaling ──────────────────────────────────────────────
console.log('\n5. Authentication input and button sizes');

const loginContent = read('src/app/login/page.tsx');
assert(
  loginContent.includes('soft-input py-2.5 px-3.5 text-sm'),
  'Login inputs use text-sm with py-2.5 px-3.5'
);
assert(
  loginContent.includes('text-sm font-semibold px-3.5 py-2.5 transition-colors min-h-[44px]'),
  'Login submit button uses text-sm font-semibold'
);

console.log('\n' + '='.repeat(78));
console.log(`TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
console.log('='.repeat(78));

if (failed > 0) {
  process.exit(1);
}

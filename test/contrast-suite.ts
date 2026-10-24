/**
 * RemoteMatch — WCAG 2.x contrast for the design tokens (secondary text, primary buttons, green pills)
 * ==============================================================================
 * Audit finding U-P1-4 (docs/audit-2026-10-13-ui-ux.md). Measured on 4c3fc95:
 *   muted on bg/surface/surface-soft 3.61 / 3.21 / 3.91 · light-on-red primary button 3.03 (bg) / 3.61 (white)
 *   red text on bg/red-soft 3.03 / 3.29 · green #059669 text on its #ecfdf5 pill 3.58   — all below AA 4.5:1.
 *
 * The suite reads the tokens straight out of src/app/globals.css (so a future token edit is re-measured, not
 * re-assumed), derives the primary-button pair from the CSS rule itself, and scans components for the green text
 * colour. Pure; no network. Run: npx tsx test/contrast-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

// ── WCAG 2.x relative luminance / contrast ──────────────────────────────────
const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
const lum = (hex: string) => { const [r, g, b] = rgb(hex); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// ── tokens from the stylesheet ──────────────────────────────────────────────
const css = read('src/app/globals.css');
const rootBlock = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
const token = (name: string): string => {
  const m = rootBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  if (!m) throw new Error(`token --${name} not found as a hex value in :root`);
  return m[1];
};
const T = {
  bg: token('bg'), surface: token('surface'), soft: token('surface-soft'), ink: token('ink'), muted: token('muted'),
  red: token('red'), redDark: token('red-dark'), redSoft: token('red-soft'), primary: token('primary'),
  danger: token('danger'), greenDark: token('green-dark'), greenSoft: token('green-soft'),
};
const WHITE = '#ffffff';
const GREEN_PILL_BG = '#ecfdf5';
const AA = 4.5;

function check(label: string, fg: string, bg: string, min = AA) {
  const r = ratio(fg, bg);
  assert(r >= min, `${label}: ${fg} on ${bg} = ${r.toFixed(2)}:1 (need ≥ ${min})`);
}

console.log('='.repeat(78));
console.log('CONTRAST (WCAG 2.x AA) — secondary text, primary buttons, green pills');
console.log('='.repeat(78));

console.log('\n1. Secondary text (--muted) on every surface it sits on');
for (const [name, bg] of [['bg', T.bg], ['surface (cards)', T.surface], ['surface-soft', T.soft], ['white', WHITE]] as const) check(`muted on ${name}`, T.muted, bg);

console.log('\n2. Primary button + red accent');
const rule = (css.match(/\.soft-button\.primary\s*\{([^}]*)\}/) ?? [])[1] ?? '';
const ruleBg = (rule.match(/background:\s*var\(--(\w[\w-]*)\)/) ?? [])[1];
const ruleFg = (rule.match(/(?<![-\w])color:\s*var\(--(\w[\w-]*)\)/) ?? [])[1];
assert(ruleBg === 'red' && ruleFg === 'bg', `.soft-button.primary is background:var(--${ruleBg}) / color:var(--${ruleFg}) (pair derived from the stylesheet)`);
check('primary button text (--bg) on --red', T.bg, T.red);
check('white button text on --red (bg-[var(--red)] text-white CTAs)', WHITE, T.red);
check('hover: --bg on --red-dark', T.bg, T.redDark);
check('hover: white on --red-dark', WHITE, T.redDark);
assert(lum(T.redDark) < lum(T.red), '--red-dark is darker than --red (hover still darkens)');
assert(T.primary.toLowerCase() === T.red.toLowerCase(), '--primary tracks --red');
for (const [name, bg] of [['bg', T.bg], ['surface (cards)', T.surface], ['red-soft (score box, badges)', T.redSoft], ['white', WHITE]] as const) check(`--red text on ${name}`, T.red, bg);

console.log('\n3. Green pills ("Why it matches", INTERESTED stamp, checkmarks)');
// Files that the separate "resume step honesty" PR rewrites wholesale; its green is fixed there (this avoids a guaranteed
// merge conflict between the two PRs). Exempt ONLY from the failing-green check, and only while they still contain it.
const REWRITTEN_ELSEWHERE = ['src/app/onboarding/page.tsx', 'src/components/onboarding/resume-intelligence-dashboard.tsx'];
const greens = new Set<string>();
const legacyGreenFiles = new Set<string>();
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) {
      const rel = path.relative(root, p).split(path.sep).join('/');
      for (const m of Array.from(fs.readFileSync(p, 'utf8').matchAll(/text-\[(#[0-9a-fA-F]{6})\]/g))) {
        const [r, g, b] = rgb(m[1]);
        if (!(g > r + 40 && g > b)) continue; // green-dominant text colours only
        const hex = m[1].toLowerCase();
        if (hex === '#059669' && REWRITTEN_ELSEWHERE.includes(rel)) { legacyGreenFiles.add(rel); continue; }
        greens.add(hex);
        if (hex === '#059669') assert(false, `failing green #059669 used as a text colour in ${rel}`);
      }
    }
  }
};
walk(path.join(root, 'src'));
assert(greens.size >= 1, `found green text colours in components: ${Array.from(greens).join(', ')}`);
assert(!greens.has('#059669'), 'the failing green #059669 is no longer used as a text/icon colour (outside the files rewritten by the resume-honesty PR)');
for (const f of REWRITTEN_ELSEWHERE) {
  if (!legacyGreenFiles.has(f)) console.log(`  note: ${f} no longer uses #059669 text — its exemption above is unnecessary and can be deleted.`);
}
for (const g of Array.from(greens)) {
  check(`green text ${g} on pill`, g, GREEN_PILL_BG);
  check(`green text ${g} on bg`, g, T.bg);
  check(`green text ${g} on surface`, g, T.surface);
  check(`green text ${g} on white`, g, WHITE);
}
check('--green-dark on --green-soft (existing .tag-green)', T.greenDark, T.greenSoft);

console.log('\n4. Pairs that already passed must keep passing');
check('ink on bg', T.ink, T.bg);
check('ink on surface', T.ink, T.surface);
check('danger on bg', T.danger, T.bg);
check('amber text #b45309 on #fffbeb', '#b45309', '#fffbeb');

console.log('\n5. Scope — design-system preserved');
const hueOf = (hex: string) => { const [r, g, b] = rgb(hex).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const d = mx - mn; if (!d) return 0; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
assert(Math.abs(hueOf(T.red) - hueOf('#c67139')) < 6, `--red keeps the terracotta hue (${hueOf(T.red).toFixed(0)}° vs ${hueOf('#c67139').toFixed(0)}°)`);
assert(Math.abs(hueOf(T.muted) - hueOf('#82796a')) < 8, '--muted keeps its warm-grey hue');
for (const untouched of ['bg', 'surface', 'surface-soft', 'ink', 'red-soft']) {
  const orig: Record<string, string> = { bg: '#f5ead8', surface: '#ebddc5', 'surface-soft': '#fff2eb', ink: '#201e1d', 'red-soft': '#fff2eb' };
  assert(token(untouched).toLowerCase() === orig[untouched], `--${untouched} unchanged (${orig[untouched]})`);
}

console.log('\n6. Placeholder text (::placeholder) on input surfaces');
const phMatch = css.match(/::placeholder\s*\{([^}]*)\}/);
assert(Boolean(phMatch), '::placeholder rule found in src/app/globals.css');
assert(/input::placeholder/.test(css) && /textarea::placeholder/.test(css), 'placeholder rule covers input and textarea to override Tailwind preflight specificity');
const phBlock = phMatch ? phMatch[1] : '';
const phColorToken = (phBlock.match(/color:\s*var\(--(\w[\w-]*)\)/) ?? [])[1];
const phColorMix = phBlock.match(/color:\s*color-mix\(in\s+srgb,\s*var\(--(\w[\w-]*)\)\s*(\d+)%,\s*transparent\)/);
const phOpacityMatch = phBlock.match(/opacity:\s*([0-9.]+)/);
const phOpacity = phOpacityMatch ? parseFloat(phOpacityMatch[1]) : 1.0;

let baseHex = '';
let alpha = phOpacity;

if (phColorToken && (T as any)[phColorToken]) {
  baseHex = (T as any)[phColorToken];
} else if (phColorMix && (T as any)[phColorMix[1]]) {
  baseHex = (T as any)[phColorMix[1]];
  alpha *= parseFloat(phColorMix[2]) / 100;
} else {
  const hexMatch = phBlock.match(/color:\s*(#[0-9a-fA-F]{3,6})/);
  if (hexMatch) baseHex = hexMatch[1];
}

assert(Boolean(baseHex), `::placeholder color resolves to a valid token/hex (resolved ${baseHex}, alpha ${alpha})`);

const inputSurfaces = [
  ['.soft-input background (var(--surface))', T.surface],
  ['onboarding textarea background (var(--surface-soft))', T.soft],
  ['input on page background (var(--bg))', T.bg],
  ['input on white background', WHITE],
] as const;

for (const [desc, bgHex] of inputSurfaces) {
  let effectiveHex = baseHex;
  if (alpha < 1) {
    const [fr, fg, fb] = rgb(baseHex);
    const [br, bg_, bb] = rgb(bgHex);
    const effR = Math.round(alpha * fr + (1 - alpha) * br);
    const effG = Math.round(alpha * fg + (1 - alpha) * bg_);
    const effB = Math.round(alpha * fb + (1 - alpha) * bb);
    effectiveHex = '#' + [effR, effG, effB].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  check(`placeholder on ${desc}`, effectiveHex, bgHex, AA);
}

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

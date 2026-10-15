/**
 * Mobile navigation — LinkedIn Job Finder entry point.
 * ==============================================================================
 * The page was deliberately left out of the mobile bottom bar (Jobs /
 * Applications / Profile), so on a phone the only way to reach /linkedin-jobs
 * was to type the URL. This suite renders the REAL Navbar (usePathname mocked)
 * and pins: the new tab, its order/target/active state, that the three
 * existing tabs are untouched, that the bar is still suppressed everywhere it
 * was already suppressed, and that the desktop entry is intact.
 *
 * Pure (no network, no DB). Run: npx tsx test/mobile-nav-linkedin-suite.ts
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as unknown as { React: unknown }).React = React;

// The navbar calls usePathname(); outside the Next app router there is no
// context, so serve the path we choose. Must be installed BEFORE the navbar
// module is loaded (hence require(), not a hoisted import).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require('module') as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = NodeModule._load;
NodeModule._load = function (this: unknown, request: string, ...rest: unknown[]) {
  if (request === 'next/navigation') {
    return { usePathname: () => (globalThis as unknown as { __PATH__: string }).__PATH__ };
  }
  return originalLoad.call(this, request, ...rest);
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Navbar } = require('../src/components/navigation/navbar') as { Navbar: React.ComponentType };

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

function render(pathname: string): string {
  (globalThis as unknown as { __PATH__: string }).__PATH__ = pathname;
  return renderToStaticMarkup(React.createElement(Navbar));
}

interface Tab { href: string; label: string; active: boolean; classes: string; icon: string }
/** The fixed bottom bar is the <nav> carrying `md:hidden`; returns null if it isn't rendered. */
function mobileTabs(html: string): Tab[] | null {
  const nav = html.match(/<nav[^>]*md:hidden[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) return null;
  const tabs: Tab[] = [];
  // Next's <Link> renders `class` before `href`.
  const re = /<a class="([^"]*)" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(nav[1]))) {
    const label = (m[3].match(/<span class="mt-0\.5">([^<]*)<\/span>/) || [])[1] ?? '';
    const icon = (m[3].match(/class="lucide ([^"]*)"/) || [])[1] ?? '';
    tabs.push({ href: m[2], label, active: m[1].includes('bg-[var(--red-soft)]'), classes: m[1], icon });
  }
  return tabs;
}

console.log('='.repeat(78));
console.log('MOBILE NAV — LinkedIn Job Finder entry point');
console.log('='.repeat(78));

console.log('\n1. The bar has a LinkedIn tab, in the right place, pointing at the right page');
{
  const tabs = mobileTabs(render('/feed'));
  assert(tabs !== null, 'the mobile bottom bar renders on /feed');
  const t = tabs ?? [];
  assert(t.length === 4, `four tabs (was three) — got ${t.length}`);
  assert(JSON.stringify(t.map((x) => x.label)) === JSON.stringify(['Jobs', 'Applications', 'LinkedIn', 'Profile']), `order is Jobs, Applications, LinkedIn, Profile — got ${JSON.stringify(t.map((x) => x.label))}`);
  assert(JSON.stringify(t.map((x) => x.href)) === JSON.stringify(['/feed', '/tracker', '/linkedin-jobs', '/settings']), 'targets are /feed, /tracker, /linkedin-jobs, /settings');
  assert(t[t.length - 1]?.label === 'Profile', 'Profile is still the last tab (account stays at the end)');
  assert(t.every((x) => x.classes.includes('min-h-[48px]')), 'every tab keeps the 48px touch target, including the new one');
  assert(t.every((x) => x.classes.includes('flex-1')), 'tabs share the width equally (flex-1), so four fit without overflow');
  assert(t.every((x) => x.icon.startsWith('lucide-')), 'every tab renders an icon');
  assert(t.find((x) => x.label === 'LinkedIn')?.icon === 'lucide-linkedin', "the LinkedIn tab uses the LinkedIn glyph, and the others keep theirs");
  assert(JSON.stringify(t.filter((x) => x.label !== 'LinkedIn').map((x) => x.icon)) === JSON.stringify(['lucide-compass', 'lucide-briefcase-business', 'lucide-user-round']), 'Jobs / Applications / Profile keep their original icons');
}

console.log('\n2. The existing three tabs are untouched');
{
  const on = (p: string) => mobileTabs(render(p)) ?? [];
  const only = (p: string) => on(p).filter((x) => x.active).map((x) => x.label);
  assert(JSON.stringify(only('/feed')) === '["Jobs"]', '/feed -> only Jobs is active');
  assert(JSON.stringify(only('/match/opp-curated-1')) === '["Jobs"]', '/match/... -> Jobs is still active (unchanged rule)');
  assert(JSON.stringify(only('/tracker')) === '["Applications"]', '/tracker -> only Applications is active');
  assert(JSON.stringify(only('/settings')) === '["Profile"]', '/settings -> only Profile is active');
}

console.log('\n3. The LinkedIn tab is active exactly on its own page');
{
  const only = (p: string) => (mobileTabs(render(p)) ?? []).filter((x) => x.active).map((x) => x.label);
  assert(JSON.stringify(only('/linkedin-jobs')) === '["LinkedIn"]', '/linkedin-jobs -> only LinkedIn is active');
  assert(JSON.stringify(only('/linkedin-jobs/anything')) === '["LinkedIn"]', '/linkedin-jobs/... -> LinkedIn stays active');
  assert(!only('/feed').includes('LinkedIn') && !only('/tracker').includes('LinkedIn') && !only('/settings').includes('LinkedIn'), 'LinkedIn is NOT active on the other product pages');
  assert(JSON.stringify(only('/linkedin-jobsX')) === '[]', 'a look-alike path (/linkedin-jobsX) does not light it up');
}

console.log('\n4. The bar is still suppressed where it was already suppressed (no new overlap)');
{
  for (const p of ['/', '/login', '/remote-jobs', '/remote-jobs/design', '/guide', '/guide/how-remote-matching-works']) {
    assert(mobileTabs(render(p)) === null, `${p}: no mobile bar, so the new tab never appears there`);
  }
}

console.log('\n5. The desktop entry is intact and the bar is still mobile-only');
{
  const html = render('/feed');
  const header = html.split('md:hidden')[0];
  assert(/<a [^>]*href="\/linkedin-jobs"[^>]*>LinkedIn<\/a>/.test(header), 'the desktop nav still has its "LinkedIn" link');
  assert(/<nav[^>]*md:hidden/.test(html), 'the bottom bar is still `md:hidden` (mobile only)');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

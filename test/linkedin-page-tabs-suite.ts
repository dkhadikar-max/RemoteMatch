/**
 * LinkedIn Job Finder page — the three mode tabs must not wrap on a phone.
 * ==============================================================================
 * At 375px the tabs ("Find LinkedIn Jobs", "Paste a job", "Search on
 * LinkedIn") shrank to share ~340px and each label wrapped onto 2-3 lines
 * (82px-tall tabs). Fix: a short label below the `sm` breakpoint, the full
 * label from `sm` up, no wrapping/shrinking at any width, and a sideways-scroll
 * fallback for extremely narrow screens.
 *
 * This suite renders the REAL page and pins the tab row's structure. Whether
 * the text actually fits on one line is a layout fact that markup cannot
 * prove — that is measured in a real browser (see the PR description).
 *
 * Pure (no network, no DB). Run: npx tsx test/linkedin-page-tabs-suite.ts
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as unknown as { React: unknown }).React = React;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Page = (require('../src/app/linkedin-jobs/page') as { default: React.ComponentType }).default;

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const html = renderToStaticMarkup(React.createElement(Page));

// The tab row is the <div> that holds the three mode buttons.
const rowMatch = html.match(/<div class="([^"]*border-b border-\[var\(--line\)\][^"]*)">((?:<button[\s\S]*?<\/button>){3})<\/div>/);
const rowClasses = rowMatch?.[1] ?? '';
const rowInner = rowMatch?.[2] ?? '';

interface TabEl { classes: string; short: string; full: string; shortClasses: string; fullClasses: string }
const tabs: TabEl[] = [];
// Like tabs.every, but FALSE when the three tabs were not found, so a missing tab row cannot pass vacuously.
const all = (fn: (t: TabEl) => boolean) => tabs.length === 3 && tabs.every(fn);
{
  const re = /<button type="button" class="([^"]*)">[\s\S]*?<span class="([^"]*sm:hidden[^"]*)">([^<]*)<\/span><span class="([^"]*hidden sm:inline[^"]*)">([^<]*)<\/span><\/button>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowInner))) tabs.push({ classes: m[1], shortClasses: m[2], short: m[3], fullClasses: m[4], full: m[5] });
}

console.log('='.repeat(78));
console.log('LINKEDIN PAGE — mode tabs do not wrap on mobile');
console.log('='.repeat(78));

console.log('\n1. The tab row renders three tabs, each with a short and a full label');
{
  assert(!!rowMatch, 'the tab row (three mode buttons) is found in the rendered page');
  assert(tabs.length === 3, `three tabs, each with BOTH a short and a full label span — got ${tabs.length}`);
  assert(JSON.stringify(tabs.map((t) => t.full)) === JSON.stringify(['Find LinkedIn Jobs', 'Paste a job', 'Search on LinkedIn']), `full labels are unchanged (desktop copy untouched) — got ${JSON.stringify(tabs.map((t) => t.full))}`);
  assert(JSON.stringify(tabs.map((t) => t.short)) === JSON.stringify(['Search', 'Paste a job', 'On LinkedIn']), `short labels are Search / Paste a job / On LinkedIn — got ${JSON.stringify(tabs.map((t) => t.short))}`);
  assert(all((t) => t.short.length <= 12), `every short label is at most 12 characters (so three fit a phone) — longest is ${Math.max(0, ...tabs.map((t) => t.short.length))}`);
  assert(all((t) => t.short.length <= t.full.length), 'a short label is never longer than its full label');
}

console.log('\n2. Responsive switch: short below `sm`, full from `sm` up, never both visible');
{
  assert(all((t) => /(^|\s)sm:hidden(\s|$)/.test(t.shortClasses) && !/(^|\s)hidden(\s|$)/.test(t.shortClasses)), 'the short label is visible by default and hidden from `sm` up');
  assert(all((t) => /(^|\s)hidden(\s|$)/.test(t.fullClasses) && /(^|\s)sm:inline(\s|$)/.test(t.fullClasses)), 'the full label is hidden by default and shown inline from `sm` up');
}

console.log('\n3. Nothing can wrap or shrink, at any width');
{
  assert(all((t) => /(^|\s)whitespace-nowrap(\s|$)/.test(t.classes)), 'every tab is `whitespace-nowrap` (a label cannot wrap onto a second line)');
  assert(all((t) => /(^|\s)shrink-0(\s|$)/.test(t.classes)), 'every tab is `shrink-0` (it cannot be squeezed narrower than its label)');
  assert(/(^|\s)overflow-x-auto(\s|$)/.test(rowClasses), 'the row scrolls sideways if an extremely narrow screen still cannot fit them (instead of wrapping)');
  assert(/(^|\s)flex(\s|$)/.test(rowClasses), 'the row is still a flex row');
}

console.log('\n4. Existing behavior is preserved');
{
  const active = tabs.map((t) => t.classes.includes('border-[var(--red)]'));
  assert(JSON.stringify(active) === '[true,false,false]', "the default tab ('search') is the active one — the others are not");
  assert(all((t) => t.classes.includes('py-2.5') && t.classes.includes('border-b-2')), 'tabs keep their vertical padding and active underline');
  assert(/<h1[^>]*>Find LinkedIn Jobs<\/h1>/.test(html), 'the page heading is unchanged');
  assert((rowInner.match(/<svg/g) || []).length === 3, 'each of the three tabs still has its icon');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

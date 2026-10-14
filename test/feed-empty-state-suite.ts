/**
 * RemoteMatch — the feed's empty states must be truthful
 * ==============================================================================
 * Audit U-P0-1 / U-P1-1 (docs/audit-2026-10-13-ui-ux.md). The deck's only empty message was "Queue Cleared — All
 * opportunities matching your criteria have been evaluated", shown (a) when supply simply ran out (the feed only shows
 * jobs posted within 48 h, so with ingestion paused it runs dry), and (b) when the load FAILED (errors were swallowed).
 * Deep's rule: an empty-feed message must not imply the user has evaluated every opportunity unless that is true.
 *
 * Pure (no network, no DB). Run: npx tsx test/feed-empty-state-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as unknown as { React: unknown }).React = React;
import { feedEmptyKind, interpretFeedResponse, FEED_EMPTY_COPY, type FeedEmptyKind, type FeedEmptyInput } from '../src/lib/feed/empty-state';
import { FeedEmptyState } from '../src/components/feed/feed-empty-state';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const base: FeedEmptyInput = { loadFailed: false, serverCount: 100, unswipedCount: 10, filteredCount: 10, hasActiveFilters: false };

console.log('='.repeat(78));
console.log('FEED EMPTY STATES');
console.log('='.repeat(78));

console.log('\n1. feedEmptyKind — which situation is it?');
assert(feedEmptyKind(base) === null, 'jobs available → no empty state (the deck is shown)');
assert(feedEmptyKind({ ...base, loadFailed: true }) === 'load_failed', 'a failed load → load_failed');
assert(feedEmptyKind({ ...base, loadFailed: true, serverCount: 0, unswipedCount: 0, filteredCount: 0 }) === 'load_failed', 'a failed load wins over "0 jobs" (failure must never read as "nothing new" or "all done")');
assert(feedEmptyKind({ ...base, serverCount: 0, unswipedCount: 0, filteredCount: 0 }) === 'no_supply', 'the server returned no jobs → no_supply (NOT "you reviewed everything")');
assert(feedEmptyKind({ ...base, unswipedCount: 0, filteredCount: 0 }) === 'all_reviewed', 'jobs exist but the user already swiped every one → all_reviewed');
assert(feedEmptyKind({ ...base, filteredCount: 0, hasActiveFilters: true }) === 'filters_exclude_all', 'jobs remain but the filters exclude them all → filters_exclude_all');
assert(feedEmptyKind({ ...base, filteredCount: 0, hasActiveFilters: false }) === null, 'no filters and still nothing is not a reachable state — no empty message invented');
assert(feedEmptyKind({ ...base, serverCount: 0, unswipedCount: 0, filteredCount: 0, hasActiveFilters: true }) === 'no_supply', 'no supply stays no_supply even with a filter set (clearing filters would not help)');

console.log('\n2. Exhaustive truth check — "reviewed everything" is only ever said when it is true');
let violations = 0; let cases = 0; let allReviewed = 0;
for (const loadFailed of [false, true]) for (const serverCount of [0, 1, 5, 1500]) for (const unswipedCount of [0, 1, 5]) for (const filteredCount of [0, 1, 5]) for (const hasActiveFilters of [false, true]) {
  if (unswipedCount > serverCount || filteredCount > unswipedCount) continue; // impossible combinations
  cases++;
  const k = feedEmptyKind({ loadFailed, serverCount, unswipedCount, filteredCount, hasActiveFilters });
  if (k === 'all_reviewed') { allReviewed++; if (loadFailed || serverCount === 0 || unswipedCount !== 0) violations++; }
  if (k === 'no_supply' && (loadFailed || serverCount !== 0)) violations++;
  if (k === 'load_failed' && !loadFailed) violations++;
  if (k === 'filters_exclude_all' && (loadFailed || serverCount === 0 || unswipedCount === 0 || filteredCount !== 0 || !hasActiveFilters)) violations++;
  if (k === null && (loadFailed || serverCount === 0 || unswipedCount === 0)) violations++;
}
assert(violations === 0 && allReviewed > 0, `${cases} input combinations: every classification is consistent with its definition (${allReviewed} all_reviewed cases, 0 violations)`, String(violations));

console.log('\n3. interpretFeedResponse — only a real, successful body is "supply"');
assert(JSON.stringify(interpretFeedResponse(true, { success: true, opportunities: [1, 2, 3] })) === '{"failed":false,"returned":3}', '200 + success + array → 3 jobs, not failed');
assert(JSON.stringify(interpretFeedResponse(true, { success: true, opportunities: [] })) === '{"failed":false,"returned":0}', '200 + success + empty array → genuinely 0 jobs (no_supply), not failed');
for (const [label, ok, body] of [['503 service unavailable', false, { success: false, error: 'Service temporarily unavailable.' }], ['200 but success:false', true, { success: false, error: 'x' }], ['500 with an array present', false, { success: true, opportunities: [1] }], ['200 without an opportunities array', true, { success: true }], ['null body', true, null], ['undefined body', true, undefined], ['opportunities is not an array', true, { success: true, opportunities: 'x' }]] as Array<[string, boolean, unknown]>) {
  const r = interpretFeedResponse(ok, body);
  assert(r.failed && r.returned === 0, `${label} → failed (never mistaken for an empty catalog)`);
}

console.log('\n4. Copy — nothing but all_reviewed may claim the user finished');
const kinds: FeedEmptyKind[] = ['load_failed', 'no_supply', 'all_reviewed', 'filters_exclude_all'];
const claimsDone = /every|evaluated|reviewed|cleared|all (the )?(jobs|opportunities)|finished|that's all|gone through/i;
for (const k of kinds) {
  const text = `${FEED_EMPTY_COPY[k].title} ${FEED_EMPTY_COPY[k].body}`;
  if (k === 'all_reviewed') assert(claimsDone.test(text), 'all_reviewed does say the user has gone through the jobs (and only when feedEmptyKind proves it)');
  else assert(!claimsDone.test(text), `${k}: makes no "you've finished / evaluated / cleared" claim`, text);
}
assert(!JSON.stringify(FEED_EMPTY_COPY).includes('Queue Cleared'), 'the old "Queue Cleared — all opportunities … evaluated" wording is not used by any new state');
assert(/try again/i.test(FEED_EMPTY_COPY.load_failed.body) && /connection/i.test(FEED_EMPTY_COPY.load_failed.body), 'load_failed tells the user it is a loading problem and to retry');
assert(/check back/i.test(FEED_EMPTY_COPY.no_supply.body) && !/\b\d+\s*(hours?|days?|minutes?)\b/i.test(FEED_EMPTY_COPY.no_supply.body), 'no_supply invites a later visit and makes no timing promise');

console.log('\n5. Rendered output');
const render = (kind: FeedEmptyKind) => renderToStaticMarkup(React.createElement(FeedEmptyState, { kind, onRetry: () => {}, onClearFilters: () => {} }));
const visible = (h: string) => h.replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
for (const k of kinds) assert(visible(render(k)).includes(FEED_EMPTY_COPY[k].title), `${k}: renders its own title`);
assert(render('load_failed').includes('role="alert"') && render('no_supply').includes('role="status"'), 'a failure is announced as an alert; the others as status');
assert(visible(render('load_failed')).includes('Try again') && !render('load_failed').includes('/tracker'), 'load_failed offers "Try again" only');
assert(visible(render('filters_exclude_all')).includes('Clear filters'), 'filters_exclude_all offers "Clear filters"');
assert(visible(render('no_supply')).includes('Check again') && render('no_supply').includes('href="/tracker"'), 'no_supply offers "Check again" and a link to the user\'s applications');
assert(visible(render('all_reviewed')).includes('Check again') && render('all_reviewed').includes('href="/tracker"'), 'all_reviewed offers "Check again" and the tracker link');
assert(kinds.every((k) => render(k).includes('min-h-[44px]')), 'every action (button or link) in every state uses the 44 px minimum target');

console.log('\n6. Wiring (static) — the page uses the helper and fails loudly');
const page = read('src/app/feed/page.tsx');
const deck = read('src/components/feed/swipe-deck.tsx');
assert(page.includes('interpretFeedResponse(res.ok, data)') && page.includes('failed = outcome.failed'), 'the page classifies the response with interpretFeedResponse');
assert(/catch \{[\s\S]{0,300}failed = true;/.test(page), 'a network exception marks the load as failed (no longer swallowed into an empty deck)');
assert(page.includes('setLoadFailed(failed)') && page.includes('setServerCount(returned)'), 'failure and the server count are stored in state');
assert(page.includes('unswipedCount: opportunities.length') && page.includes('filteredCount: filteredOpportunities.length'), 'the helper is fed the real counts');
assert(/\{emptyKind \? \(\s*<FeedEmptyState kind=\{emptyKind\} onRetry=\{handleRetryLoad\} onClearFilters=\{\(\) => setActiveFilters\(\{\}\)\} \/>\s*\) : \(\s*<SwipeDeck/.test(page), 'the deck is rendered ONLY when there is no empty state; otherwise the matching FeedEmptyState is');
assert(page.includes('setIsLoading(true);') && /handleRetryLoad = \(\) => \{\s*setIsLoading\(true\);\s*refreshOpportunities\(\);/.test(page), 'retry re-runs the load and shows the loading state');
assert(deck.includes('Queue Cleared'), 'the deck\'s own end-of-queue message is untouched (it is only reached after the user really swipes the last card in a session)');

console.log('\n7. Scope — UI only; no ingestion, API, scoring or data change');
const lines = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const committed = (() => { try { return lines('git diff --name-only origin/main...HEAD'); } catch { return lines('git diff --name-only 4c3fc95 HEAD'); } })();
const changed = Array.from(new Set([...committed, ...lines('git diff --name-only HEAD'), ...lines('git ls-files --others --exclude-standard')]));
const allowed = new Set(['src/lib/feed/empty-state.ts', 'src/components/feed/feed-empty-state.tsx', 'src/app/feed/page.tsx', 'test/feed-empty-state-suite.ts']);
assert(changed.every((f) => allowed.has(f)), 'only the helper, the component, the feed page and this suite changed', changed.filter((f) => !allowed.has(f)).join(', '));
assert(changed.every((f) => !['src/lib/ingestion/', 'src/lib/matching/', 'src/app/api/', 'supabase/', 'src/lib/providers/', 'scripts/'].some((x) => f.startsWith(x))), 'no ingestion, matcher, API, migration, provider or script file changed');

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

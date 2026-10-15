/**
 * LinkedIn Job Finder — the search tab must tell the truth about what happened.
 * ==============================================================================
 * Before this change a failed vendor call (status 'vendor_failed') rendered as
 * an empty list with no explanation, which reads as "no jobs match". This
 * suite pins the state decision (search-view-state.ts), the rendered notice
 * (search-state-notice.tsx), the retry wiring, and the page's use of both.
 *
 * Pure (no network, no DB), following test/feed-empty-state-suite.ts.
 * Run: npx tsx test/linkedin-jobs-search-view-state-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as unknown as { React: unknown }).React = React;
import {
  interpretSearchResponse, networkFailureState, SEARCH_NOTICE_COPY, QUOTA_REFUNDED_NOTE,
  type SearchViewKind, type SearchViewState,
} from '../src/lib/linkedin-jobs/search-view-state';
import { SearchStateNotice } from '../src/components/linkedin-jobs/search-state-notice';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/[^\r\n]*/, '')).join('\n');
// renderToStaticMarkup HTML-escapes ' and &; compare against the escaped form.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

const NOTICE_KINDS = ['empty', 'not_configured', 'vendor_failed', 'request_failed'] as const;
const results = [{ id: 'li-1' }];

console.log('='.repeat(78));
console.log('LINKEDIN JOB FINDER — search tab states (vendor failure message)');
console.log('='.repeat(78));

console.log('\n1. interpretSearchResponse(): every response maps to the right state');
{
  assert(interpretSearchResponse(true, 200, { status: 'ok', results }).kind === 'results', "status ok + jobs -> 'results'");
  assert(interpretSearchResponse(true, 200, { status: 'ok', results: [] }).kind === 'empty', "status ok + ZERO jobs -> 'empty' (a legitimate empty result, not a failure)");
  assert(interpretSearchResponse(true, 200, { status: 'vendor_not_configured', results: [] }).kind === 'not_configured', "vendor_not_configured -> 'not_configured'");
  assert(interpretSearchResponse(true, 200, { status: 'vendor_failed', results: [] }).kind === 'vendor_failed', "vendor_failed -> 'vendor_failed' (no longer shown as an empty list)");
  assert(interpretSearchResponse(true, 200, { status: 'vendor_failed' }).kind !== 'empty', 'a vendor failure is never classified as empty');

  const refunded = interpretSearchResponse(true, 200, { status: 'vendor_failed', results: [], quotaRefunded: true });
  assert(refunded.quotaNote === QUOTA_REFUNDED_NOTE, "quotaRefunded true -> the 'didn't use a daily search' note");
  const refundFailed = interpretSearchResponse(true, 200, { status: 'vendor_failed', results: [], quotaRefunded: false, quotaRefundError: 'rpc failed' });
  assert(refundFailed.quotaNote === null, 'refund FAILED -> no claim about the allowance (we never say it was not used when it may have been)');
  assert(interpretSearchResponse(true, 200, { status: 'vendor_failed', results: [] }).quotaNote === null, 'no quotaRefunded field -> no claim');

  const http500 = interpretSearchResponse(false, 500, { error: 'Search failed', quotaRefunded: true });
  assert(http500.kind === 'request_failed' && http500.quotaNote === QUOTA_REFUNDED_NOTE, "HTTP 500 -> 'request_failed', with the refund note when the route refunded");
  assert(interpretSearchResponse(false, 500, null).kind === 'request_failed', 'HTTP 500 with an unparseable body -> request_failed');
  assert(interpretSearchResponse(false, 401, { error: 'Unauthorized' }).kind === 'request_failed', 'HTTP 401 -> request_failed (not an empty list)');

  assert(interpretSearchResponse(false, 403, { error: 'limit_reached', upgradeRequired: true }).kind === 'limit_reached', "403 upgradeRequired -> 'limit_reached' (page opens the upgrade modal)");
  assert(interpretSearchResponse(false, 403, { error: 'pro_required' }).kind === 'request_failed', '403 without upgradeRequired is NOT treated as the daily limit');

  assert(interpretSearchResponse(true, 200, { something: 'else' }).kind === 'request_failed', 'unrecognised 200 body -> request_failed, never "no jobs"');
  assert(interpretSearchResponse(true, 200, { status: 'ok' }).kind === 'request_failed', "status ok but no results array -> request_failed");
  assert(interpretSearchResponse(true, 200, null).kind === 'request_failed', '200 with a null body -> request_failed');
  assert(networkFailureState().kind === 'request_failed', 'a fetch that threw (offline etc.) -> request_failed');
}

console.log('\n2. Copy honesty and retry rules');
{
  for (const k of ['vendor_failed', 'request_failed'] as const) {
    const c = SEARCH_NOTICE_COPY[k];
    assert(/doesn.t mean there are no matching jobs/.test(c.body), `${k}: explicitly says a failure does NOT mean there are no matching jobs`);
    assert(!/^no /i.test(c.title), `${k}: title does not open with "No ..." (which reads as an empty result)`);
    assert(c.canRetry === true && c.isError === true, `${k}: offers a retry and is announced as an error`);
  }
  assert(SEARCH_NOTICE_COPY.vendor_failed.title !== SEARCH_NOTICE_COPY.not_configured.title, 'a temporary vendor failure is distinguishable from "not connected yet"');
  assert(SEARCH_NOTICE_COPY.vendor_failed.body !== SEARCH_NOTICE_COPY.not_configured.body, '...and its explanation differs too');
  assert(SEARCH_NOTICE_COPY.not_configured.canRetry === false, "not_configured offers NO retry (retrying cannot help)");
  assert(SEARCH_NOTICE_COPY.not_configured.isError === false, 'not_configured is informational, not an error');
  assert(SEARCH_NOTICE_COPY.empty.canRetry === false && SEARCH_NOTICE_COPY.empty.isError === false, 'a legitimate empty result is not an error and does not push a retry');
  assert(/no postings|no LinkedIn jobs/i.test(SEARCH_NOTICE_COPY.empty.title + SEARCH_NOTICE_COPY.empty.body), "the empty state IS allowed to say nothing matched (it's true)");
  assert(/search ran/i.test(SEARCH_NOTICE_COPY.empty.body), 'and says the search actually ran');
}

console.log('\n3. Rendered markup for every state');
{
  const render = (state: SearchViewState, isRetrying = false) =>
    renderToStaticMarkup(React.createElement(SearchStateNotice, { state, onRetry: () => {}, isRetrying }));
  const st = (kind: SearchViewKind, quotaNote: string | null = null): SearchViewState => ({ kind, quotaNote });

  for (const k of NOTICE_KINDS) {
    const html = render(st(k));
    const c = SEARCH_NOTICE_COPY[k];
    assert(html.includes(esc(c.title)) && html.includes(esc(c.body)), `${k}: title and body are rendered`);
    assert(html.includes(c.isError ? 'role="alert"' : 'role="status"'), `${k}: announced as ${c.isError ? 'an alert' : 'a status'}`);
    assert(c.canRetry ? html.includes('Try again') : !html.includes('Try again'), `${k}: "Try again" ${c.canRetry ? 'is' : 'is NOT'} shown`);
  }
  assert(render(st('results')) === '' && render(st('limit_reached')) === '', "'results' and 'limit_reached' render no notice");
  assert(render(st('vendor_failed', QUOTA_REFUNDED_NOTE)).includes(esc(QUOTA_REFUNDED_NOTE)), 'the quota note is rendered when present');
  assert(!render(st('vendor_failed', null)).includes(esc(QUOTA_REFUNDED_NOTE)), 'and absent when null');
  // Match the real `disabled` ATTRIBUTE, not the Tailwind class `disabled:opacity-60`
  // that is always present in the class string.
  const hasDisabledAttr = (html: string) => /<button\b[^>]*\sdisabled(?:=""|(?=[\s>]))/.test(html);
  assert(hasDisabledAttr(render(st('vendor_failed'), true)), 'the retry button has the disabled attribute while a retry is in flight (no double-fire)');
  assert(!hasDisabledAttr(render(st('vendor_failed'), false)), 'and does not otherwise');
}

console.log('\n4. Retry behavior: the button really calls onRetry');
{
  type El = { type?: unknown; props?: { onClick?: () => void; children?: unknown } };
  const findButton = (node: unknown): El | null => {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const n of node) { const f = findButton(n); if (f) return f; } return null; }
    const el = node as El;
    if (el.type === 'button') return el;
    return findButton(el.props?.children);
  };
  const tree = (kind: SearchViewKind, onRetry: () => void) =>
    (SearchStateNotice as unknown as (p: unknown) => unknown)({ state: { kind, quotaNote: null }, onRetry, isRetrying: false });

  for (const k of ['vendor_failed', 'request_failed'] as const) {
    let calls = 0;
    const btn = findButton(tree(k, () => { calls++; }));
    assert(!!btn && typeof btn.props?.onClick === 'function', `${k}: a button with an onClick exists`);
    btn?.props?.onClick?.();
    assert(calls === 1, `${k}: clicking it calls onRetry exactly once (got ${calls})`);
  }
  for (const k of ['empty', 'not_configured'] as const) {
    assert(findButton(tree(k, () => {})) === null, `${k}: no retry button exists`);
  }
}

console.log('\n5. The page uses all of this (source guard — the page itself cannot render without a browser)');
{
  const page = stripComments(read('src/app/linkedin-jobs/page.tsx'));
  assert(/interpretSearchResponse\(/.test(page), 'page decides its state through interpretSearchResponse()');
  assert(/<SearchStateNotice[^>]*onRetry=\{runSearch\}/.test(page), 'page wires the notice\'s onRetry to runSearch (a retry re-runs the same search)');
  assert(/networkFailureState\(\)/.test(page), 'a thrown fetch is handled via networkFailureState()');
  assert(/view\.kind === 'results' \? data\.results : \[\]/.test(page), 'results are cleared unless the latest search succeeded');
  assert(!/vendorConfigured/.test(page), 'page no longer relies on the old `vendorConfigured` flag alone');
  assert(!/setSearchError|Search failed/.test(page), 'the old generic "Search failed" string state is gone');
  assert(/limit_reached/.test(page) && /setUpgradeReason\('linkedinSearch'\)/.test(page), 'the Free daily limit still opens the upgrade modal');
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

/**
 * RemoteMatch — Feed keyboard shortcuts must not swipe/save a job behind a modal
 * ==============================================================================
 * Audit finding U-P1-2 (docs/audit-2026-10-13-ui-ux.md): SwipeDeck listened on `window` for ← / → / Space and only
 * ignored its OWN details modal. With the Filter or Upgrade modal open, → recorded a swipe (a persisted, server-side
 * decision) on the card behind the modal. It also hijacked Space from focused controls, ignored modifiers (Alt+←
 * is browser Back) and auto-repeat (holding → swiped through the whole deck).
 *
 * Pure (no network, no DB). Run: npx tsx test/feed-keyboard-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { deckKeyAction, type DeckKeyEvent, type DeckKeyState } from '../src/lib/feed/deck-keys';

let passed = 0;
let failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}
const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/** A DOM-shaped test double: `closest(selector)` is true when the element "is" / sits inside a matching element. */
const el = (tagName: string, opts: { roles?: string[]; contentEditable?: boolean; insideDialog?: boolean; href?: boolean } = {}) => ({
  tagName,
  isContentEditable: opts.contentEditable ?? false,
  closest: (selector: string) => {
    const parts = selector.split(',').map((s) => s.trim());
    for (const p of parts) {
      const lower = tagName.toLowerCase();
      if (p === lower) return {};
      if (p === 'a[href]' && lower === 'a' && opts.href) return {};
      for (const r of opts.roles ?? []) if (p === `[role="${r}"]`) return {};
      if (opts.contentEditable && p === '[contenteditable="true"]') return {};
      if (opts.insideDialog && (p === '[role="dialog"]' || p === '[aria-modal="true"]')) return {};
    }
    return null;
  },
});
const key = (k: string, extra: Partial<DeckKeyEvent> = {}): DeckKeyEvent => ({ key: k, target: el('BODY'), ...extra });
const open: DeckKeyState = { paused: false, detailsOpen: false, hasCard: true };

console.log('='.repeat(78));
console.log('FEED KEYBOARD SHORTCUTS vs MODALS');
console.log('='.repeat(78));

console.log('\n1. deckKeyAction — baseline');
assert(deckKeyAction(key('ArrowLeft'), open) === 'passed', '← → passed');
assert(deckKeyAction(key('ArrowRight'), open) === 'interested', '→ → interested');
assert(deckKeyAction(key(' '), open) === 'details', 'Space → details');
assert(deckKeyAction(key('Enter'), open) === null && deckKeyAction(key('a'), open) === null, 'other keys ignored');
assert(deckKeyAction({ key: 'ArrowRight' }, open) === 'interested', 'no target (synthetic event) still works');

console.log('\n2. Each modal over the feed blocks every shortcut');
const modals: Array<[string, DeckKeyState]> = [
  ['Filter modal open (paused)', { ...open, paused: true }],
  ['Upgrade modal open (paused)', { ...open, paused: true }],
  ['Job-details modal open', { ...open, detailsOpen: true }],
];
for (const [name, st] of modals) {
  for (const k of ['ArrowLeft', 'ArrowRight', ' ']) {
    assert(deckKeyAction(key(k), st) === null, `${name}: ${k === ' ' ? 'Space' : k} does nothing`);
  }
}
assert(deckKeyAction(key('ArrowRight'), { ...open, hasCard: false }) === null && deckKeyAction(key(' '), { ...open, hasCard: false }) === null, 'empty deck: shortcuts do nothing (arrows left for scrolling)');

console.log('\n3. Events the deck must not take');
for (const m of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
  assert(deckKeyAction(key('ArrowLeft', { [m]: true }), open) === null, `${m}+← ignored (e.g. Alt+← is browser Back)`);
}
assert(deckKeyAction(key('ArrowRight', { repeat: true }), open) === null, 'auto-repeat (held key) ignored — one swipe per press');
assert(deckKeyAction(key('ArrowRight', { defaultPrevented: true }), open) === null, 'already-handled events ignored');
assert(deckKeyAction(key('ArrowRight', { target: el('INPUT') }), open) === null, 'arrows inside <input> ignored');
assert(deckKeyAction(key('ArrowLeft', { target: el('TEXTAREA') }), open) === null, 'arrows inside <textarea> ignored');
assert(deckKeyAction(key('ArrowRight', { target: el('SELECT') }), open) === null, 'arrows inside <select> ignored');
assert(deckKeyAction(key('ArrowRight', { target: el('DIV', { contentEditable: true }) }), open) === null, 'arrows inside contenteditable ignored');
assert(deckKeyAction(key('ArrowLeft', { target: el('DIV', { roles: ['slider'] }) }), open) === null, 'arrows on a slider widget ignored');
assert(deckKeyAction(key('ArrowRight', { target: el('DIV', { roles: ['tab'] }) }), open) === null, 'arrows on a tab widget ignored');
assert(deckKeyAction(key(' ', { target: el('BUTTON') }), open) === null, 'Space on a focused <button> is left to the button');
assert(deckKeyAction(key(' ', { target: el('A', { href: true }) }), open) === null, 'Space on a focused link is left alone');
assert(deckKeyAction(key(' ', { target: el('DIV', { roles: ['button'] }) }), open) === null, 'Space on role=button left alone');
assert(deckKeyAction(key(' ', { target: el('INPUT') }), open) === null, 'Space in an input types a space');
assert(deckKeyAction(key('ArrowRight', { target: el('DIV', { insideDialog: true }) }), open) === null, 'events from inside a dialog ignored (defence in depth)');
assert(deckKeyAction(key('ArrowRight', { target: el('BUTTON') }), open) === 'interested', 'arrows still work with a button focused (intended keyboard use)');

console.log('\n4. Wiring (static) — every modal rendered by the feed pauses the deck');
const deck = read('src/components/feed/swipe-deck.tsx');
const page = read('src/app/feed/page.tsx');
assert(/paused\??:\s*boolean/.test(deck) && /paused\s*=\s*false/.test(deck), 'SwipeDeck has a `paused` prop (default false)');
assert(deck.includes('deckKeyAction(e, { paused, detailsOpen: isDetailsOpen, hasCard: Boolean(currentOpp) })'), 'SwipeDeck key handler delegates to deckKeyAction with paused + detailsOpen + hasCard');
assert(!/e\.key\s*===\s*'Arrow(Left|Right)'/.test(deck) && !/e\.key\s*===\s*' '/.test(deck), 'no raw key checks left in SwipeDeck (no bypass of the guard)');
assert(/\[handleSwipe, currentOpp, isDetailsOpen, paused\]/.test(deck), 'effect re-subscribes when `paused` changes');
const pausedExpr = (page.match(/<SwipeDeck[\s\S]*?paused=\{([^}]+)\}[\s\S]*?\/>/) ?? [])[1] ?? '';
assert(pausedExpr.length > 0, 'feed page passes `paused` to SwipeDeck', pausedExpr);
const modalFlags = Array.from(page.matchAll(/<(\w+Modal)\b[^>]*?isOpen=\{(\w+)\}/g)).map((m) => ({ component: m[1], flag: m[2] }));
assert(modalFlags.length >= 2, `feed page renders its modals (${modalFlags.map((m) => m.component).join(', ')})`);
for (const m of modalFlags) {
  assert(pausedExpr.includes(m.flag), `${m.component} (${m.flag}) is part of the deck's paused condition`, `paused={${pausedExpr}}`);
}

console.log('\n5. Scope');
// This branch's OWN changes: committed since the merge-base with origin/main (three-dot, so sibling PRs merged into
// main later don't count), plus uncommitted and untracked files. Falls back to the original base commit offline.
const lines = (c: string) => execSync(c, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const committed = (() => { try { return lines('git diff --name-only origin/main...HEAD'); } catch { return lines('git diff --name-only 4c3fc95 HEAD'); } })();
const changed = Array.from(new Set([...committed, ...lines('git diff --name-only HEAD'), ...lines('git ls-files --others --exclude-standard')]));
const allowed = new Set(['src/lib/feed/deck-keys.ts', 'src/components/feed/swipe-deck.tsx', 'src/app/feed/page.tsx', 'test/feed-keyboard-suite.ts', 'test/funnel-emission-wiring-suite.ts']);
assert(changed.every((f) => allowed.has(f)), 'branch touches only the deck, the feed page, the pure helper, this suite and the funnel wiring guard literal', changed.filter((f) => !allowed.has(f)).join(', '));

console.log('\n' + '='.repeat(78));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);

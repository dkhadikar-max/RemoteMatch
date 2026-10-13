/**
 * Keyboard shortcuts for the feed's swipe deck — pure decision logic (unit-tested).
 *
 *   ←  pass        →  save / interested        Space  open details
 *
 * A swipe is a PERSISTED, server-side decision (it feeds outcome data), so the shortcuts must never fire by accident.
 * The deck listens on `window`, so this function decides, per key event, whether the deck owns it. It returns null (the
 * deck ignores the event and does NOT preventDefault) when:
 *  - the deck is paused (a modal — filter, upgrade — is open over the feed) or its own details modal is open;
 *  - there is no card to act on;
 *  - a modifier is held (Alt+← is browser Back, Ctrl/⌘+→ is word/tab navigation) or the key is auto-repeating
 *    (holding → would otherwise swipe through the whole deck);
 *  - the event came from inside a dialog;
 *  - the focus is in a text-entry / widget control (the arrows belong to it), or — for Space — on any interactive
 *    control (Space activates a focused button/link; it must not be stolen to open details).
 */
export type DeckKeyAction = 'passed' | 'interested' | 'details';

export interface DeckKeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

export interface DeckKeyEvent {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
  /** A DOM EventTarget (or a test double shaped like DeckKeyTarget). */
  target?: unknown;
}

export interface DeckKeyState {
  /** A modal rendered over the feed is open (filter, upgrade, …). */
  paused: boolean;
  /** The deck's own job-details modal is open. */
  detailsOpen: boolean;
  /** There is a front card to act on. */
  hasCard: boolean;
}

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const ARROW_WIDGET_SELECTOR =
  '[role="textbox"],[role="combobox"],[role="listbox"],[role="slider"],[role="spinbutton"],[role="tab"],[role="radio"],[role="menuitem"],[role="option"],[role="tree"],[role="grid"]';
const INTERACTIVE_SELECTOR =
  'button,a[href],summary,select,input,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"]';
const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]';

const matches = (t: DeckKeyTarget, selector: string): boolean => {
  try {
    return Boolean(t.closest?.(selector));
  } catch {
    return false;
  }
};

export function deckKeyAction(e: DeckKeyEvent, state: DeckKeyState): DeckKeyAction | null {
  if (state.paused || state.detailsOpen || !state.hasCard) return null;
  if (e.defaultPrevented || e.repeat) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;

  const action: DeckKeyAction | null =
    e.key === 'ArrowLeft' ? 'passed' : e.key === 'ArrowRight' ? 'interested' : e.key === ' ' ? 'details' : null;
  if (!action) return null;

  const t = (e.target ?? null) as DeckKeyTarget | null;
  if (t) {
    if (matches(t, DIALOG_SELECTOR)) return null;
    const tag = (t.tagName ?? '').toUpperCase();
    if (TEXT_ENTRY_TAGS.has(tag) || t.isContentEditable || matches(t, ARROW_WIDGET_SELECTOR)) return null;
    if (action === 'details' && matches(t, INTERACTIVE_SELECTOR)) return null;
  }
  return action;
}

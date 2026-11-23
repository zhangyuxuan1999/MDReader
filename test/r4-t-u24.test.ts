// @vitest-environment jsdom
// test/r4-t-u24.test.ts — fix-trust (stage 2e, round 4): U24 (CONTRACT §11, J13). A task line is rewritten only by a
// click that hit its checkbox itself: the last press in the document went down on that checkbox and the click's point
// lies inside its box, or a key went down on the focused checkbox (detail 0). A click a <label> forwards (wrapping the
// checkbox, for= naming it, nested labels, a label inside the same item) changes no source, leaves the box as the
// source says and reaches no later listener. Also: a block that is not current toggles nothing (item 2a), and the
// focus line / Alt+click take the OUTER block wrapper (item 2b).
// The browser's label forwarding is simulated as Chromium does it (bench/verify/r4-t-probe.mjs): a press and a click
// on the label, then a trusted-looking click on the control with the label's coordinates and the same detail.
// R4T_OLD=1 ran the same cases against interactions.ts as it was before round 4 (a snapshot, deleted at the release of
// 0.2.0): the U24, 2a and 2b cases failed there. Since round 7 (CONTRACT §11 Checkpoint I) it runs them against the
// released 0.2.0 (test/fixtures/src-0.2.0), which has the repair: they pass there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvents, EventBus } from '../src/shared/types';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import * as current from '../src/preview/interactions';

const mod: typeof current = process.env.R4T_OLD
  ? await import('./fixtures/src-0.2.0/preview/interactions') as unknown as typeof current
  : current;

let root: HTMLElement;
let detach: () => void;
let edits: Array<BusEvents['source:edit']>;
let gotos: number[];
let lines: string[];
let current_: (id: number) => boolean;

function attach(): void {
  edits = [];
  gotos = [];
  const bus = {
    emit(name: string, payload: unknown) {
      if (name === 'source:edit') edits.push(payload as BusEvents['source:edit']);
      if (name === 'nav:gotoLine') gotos.push((payload as { line: number }).line);
    },
    on() { return () => {}; },
  } as unknown as EventBus;
  detach = mod.attachInteractions(root, {
    bus, setFocusLine() {}, currentFocusLine: () => null, outline: () => [], isEditing: () => false,
    startLineOf: (id) => (id === 1 ? 1 : undefined),
    lineCountOf: (id) => (id === 1 ? lines.length : undefined),
    sourceLine: (line) => lines[line - 1] ?? '',
    isCurrent: (id) => current_(id),
  });
}

/** Renders `md` as block 1 (lines 1..n) the way the worker and the preview do. */
function mount(md: string): HTMLElement {
  lines = md.replace(/\n$/, '').split('\n');
  const r = createMarkdown(DEFAULT_RENDER_OPTIONS).renderBlock(md, { references: {} });
  const s = document.createElement('section');
  s.className = 'md-block';
  s.dataset.id = '1';
  s.replaceChildren(sanitizeToFragment(r.html));
  root.firstElementChild!.appendChild(s);
  return s;
}

const mouse = (type: string, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: type === 'click' ? 1 : 0, ...init });
/** A box laid out at (100,100)-(116,116). */
function placeBox(b: HTMLInputElement): void {
  b.getBoundingClientRect = () => ({ left: 100, top: 100, right: 116, bottom: 116, width: 16, height: 16, x: 100, y: 100, toJSON() { return {}; } });
}
/** A real click on the box itself: press and click at its centre. Returns true when the click was cancelled. */
function clickBox(b: HTMLInputElement): boolean {
  placeBox(b);
  b.dispatchEvent(mouse('pointerdown', { clientX: 108, clientY: 108 }));
  b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
  b.dispatchEvent(mouse('mouseup', { clientX: 108, clientY: 108 }));
  return !b.dispatchEvent(mouse('click', { clientX: 108, clientY: 108 }));
}
/** What Chromium does for a click on `label` (at 400,300) whose control is `b`: the press and the click go to the
 *  label, the label focuses its control and forwards the click with its own coordinates. Returns true when the
 *  forwarded click was cancelled. */
function forward(label: Element, b: HTMLInputElement, detail = 1): boolean {
  placeBox(b);
  const at = { clientX: 400, clientY: 300, detail };
  label.dispatchEvent(mouse('pointerdown', at));
  label.dispatchEvent(mouse('mousedown', at));
  label.dispatchEvent(mouse('mouseup', at));
  // the label's own click, its activation behaviour stopped here so that the forwarded click below is the only one
  const own = mouse('click', at);
  label.addEventListener('click', (e) => e.preventDefault(), { once: true });
  label.dispatchEvent(own);
  b.focus();
  return !b.dispatchEvent(mouse('click', at));
}
const box = (s: HTMLElement, text: string): HTMLInputElement => {
  for (const i of Array.from(s.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]) {
    const li = i.closest('li');
    if (li && Array.from(li.childNodes).some((n) => n.nodeType === 3 && (n as Text).data.includes(text))) return i;
  }
  throw new Error('no box ' + text);
};

beforeEach(() => {
  root = document.createElement('div');
  const chunk = document.createElement('div');
  chunk.className = 'md-chunk';
  root.appendChild(chunk);
  document.body.appendChild(root);
  current_ = () => true;
  attach();
});
afterEach(() => {
  detach();
  root.remove();
});

describe('U24: only a click on the checkbox itself ticks a task', () => {
  it('a direct click toggles its own task line (the normal case is unchanged)', () => {
    const s = mount('- [ ] a\n- [ ] b\n');
    const b = box(s, 'b');
    expect(clickBox(b)).toBe(false);
    expect(b.checked).toBe(true);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }]);
  });

  it('a label wrapping a hidden task: a click on the label text changes nothing and the box stays unchecked', () => {
    const s = mount('- <label>click me to read\n  - [ ] hidden task\n  </label>\n');
    const label = s.querySelector('label')!;
    const b = box(s, 'hidden task');
    expect(label.contains(b)).toBe(true);
    expect(forward(label, b)).toBe(true);
    expect(b.checked).toBe(false);
    expect(edits).toEqual([]);
  });

  // U24 as amended (CONTRACT §11, Checkpoint-C decisions, RVT-3): a raw checkbox inside a task item is not the item's own
  // box: a direct click on it ticks nothing either; the item's own box does.
  it('label for= naming a raw checkbox on a task line: the sanitizer keeps id and for; the forward ticks nothing, a direct click on the raw box neither, the own box does', () => {
    const s = mount('<label for="tk">press here to read</label>\n\n- [ ] <input type="checkbox" id="tk"> task\n');
    const label = s.querySelector('label')!;
    const raw = s.querySelector<HTMLInputElement>('#tk')!;
    expect(label.getAttribute('for')).toBe('tk');               // DOMPurify keeps both: the label does name the box
    expect(raw.getAttribute('id')).toBe('tk');
    expect(forward(label, raw)).toBe(true);
    expect(raw.checked).toBe(false);
    expect(edits).toEqual([]);
    expect(clickBox(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(clickBox(s.querySelector<HTMLInputElement>('li input:not(#tk)')!)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 3 }]);
  });

  it('a label inside the same list item naming the item\'s box: no tick', () => {
    const s = mount('- [ ] <input type="checkbox" id="k"> <label for="k">same item words</label>\n- [ ] two\n');
    const label = s.querySelector('label')!;
    const raw = s.querySelector<HTMLInputElement>('#k')!;
    expect(forward(label, raw)).toBe(true);
    expect(edits).toEqual([]);
  });

  it('nested labels: a click on the outer or the inner label forwards nothing that ticks', () => {
    const s = mount('- <label>outer words <label>inner words</label> more\n  - [ ] nested task\n  </label>\n');
    const [outer, inner] = Array.from(s.querySelectorAll('label'));
    const b = box(s, 'nested task');
    expect(forward(outer, b)).toBe(true);
    expect(forward(inner, b, 2)).toBe(true);
    expect(b.checked).toBe(false);
    expect(edits).toEqual([]);
  });

  // U24 as amended (CONTRACT §11, Switch-off audit decisions, OFFC-1): the coordinate test is gone — a click on the box
  // after a press on it counts whatever its point (Chromium's hit region of the box is larger than its rectangle); a
  // press on the box released on a label reaches the box only as the label's forward, after the label's own click,
  // which clears the press (test/r4-ie-u24.test.ts).
  it('a press on the box, then a click on the box: counts whatever the click\'s point (U24 as amended)', () => {
    const s = mount('- [ ] a\n');
    const b = box(s, 'a');
    placeBox(b);
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
    expect(!b.dispatchEvent(mouse('click', { clientX: 300, clientY: 108 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
    // the edge of the box counts as before
    b.dispatchEvent(mouse('mousedown', { clientX: 116, clientY: 100 }));
    expect(!b.dispatchEvent(mouse('click', { clientX: 116, clientY: 100 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }, { kind: 'toggleTask', line: 1 }]);
  });

  it('a click on a box with no press before it (a forward from machinery other than the mouse) ticks nothing', () => {
    const s = mount('- [ ] a\n');
    const b = box(s, 'a');
    placeBox(b);
    expect(!b.dispatchEvent(mouse('click', { clientX: 108, clientY: 108 }))).toBe(true);
    expect(edits).toEqual([]);
  });

  it('the keyboard: Space on the focused box toggles; a detail-0 click after a key elsewhere does not', () => {
    const s = mount('- [ ] a\n- [ ] b\n');
    const a = box(s, 'a'), b = box(s, 'b');
    a.focus();
    a.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    a.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(!a.dispatchEvent(mouse('click', { detail: 0 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
    const other = s.querySelector('li')!;
    other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(true);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });

  it('Space on a box that a refused forwarded click focused ticks nothing until the box lost the focus', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const label = s.querySelector('label')!;
    const b = box(s, 't1');
    expect(forward(label, b)).toBe(true);
    expect(document.activeElement).toBe(b);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(true);
    expect(edits).toEqual([]);
    b.blur();
    b.focus();                                                    // Tab back to it: the user's own focus now
    b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }]);
  });

  it('a refused click reaches no later listener (the edit session would replay or apply it)', () => {
    const s = mount('- <label>words here\n  - [ ] t\n  </label>\n');
    const seen: string[] = [];
    const spy = (e: Event): void => { if ((e.target as Element).localName === 'input') seen.push(e.type); };
    root.addEventListener('click', spy, true);
    try {
      expect(forward(s.querySelector('label')!, box(s, 't'))).toBe(true);
      expect(seen).toEqual([]);
      expect(clickBox(box(s, 't'))).toBe(false);
      expect(seen).toEqual(['click']);
    } finally { root.removeEventListener('click', spy, true); }
  });

  it('the session\'s replay (input.click()) of a click that hit the box counts once; of a refused click never', () => {
    const s = mount('- [ ] a\n');
    const b = box(s, 'a');
    // the edit session holds a direct click back (a write of its own on the way) and replays it later
    const hold = (e: Event): void => { e.preventDefault(); };
    root.addEventListener('click', hold, true);
    expect(clickBox(b)).toBe(true);
    root.removeEventListener('click', hold, true);
    expect(edits).toEqual([]);
    b.click();                                                    // the replay
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
    b.click();                                                    // a second one is no replay of anything
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
});

describe('item 2a: a block whose structure or HTML is not current toggles nothing', () => {
  it('isCurrent false: the click is cancelled and no line is written; once current, the same click toggles', () => {
    const s = mount('- [ ] a\n- [ ] b\n');
    const b = box(s, 'b');
    current_ = () => false;
    expect(clickBox(b)).toBe(true);
    expect(b.checked).toBe(false);
    expect(edits).toEqual([]);
    current_ = () => true;
    expect(clickBox(b)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }]);
  });
});

describe('item 2b: the focus line and Alt+click take the outer block wrapper', () => {
  it('an element inside a forged inner .md-block names a line of the outer block', () => {
    const s = mount('para one\n\n<section class="md-block" data-id="7"><p data-l="0">forged</p></section>\n');
    const p = s.querySelector('[data-id="7"] p')!;
    expect(p.textContent).toBe('forged');
    // the inner wrapper claims block 7; startLineOf(7) is unknown: the old code navigated nowhere or elsewhere
    p.dispatchEvent(mouse('click', { altKey: true }));
    expect(gotos.length).toBe(1);
    expect(gotos[0]).toBeGreaterThanOrEqual(1);
    expect(gotos[0]).toBeLessThanOrEqual(lines.length);
  });
});

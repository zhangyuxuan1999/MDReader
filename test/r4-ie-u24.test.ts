// @vitest-environment jsdom
// test/r4-ie-u24.test.ts — fix-session-e (stage 2e, round 4): U24 as amended (CONTRACT §11, "Switch-off audit
// decisions" OFFC-1 and "Checkpoint-C decisions" RVT-4 / RVT-3).
// B1: a click on a task checkbox counts when the last press in the document went down on that checkbox and no click
// came between, whatever the click's coordinates (Chromium hit-tests the box over a region larger than its fractional
// rectangle; mouse and pen coordinates are truncated, touch ones rounded); a key between the press and the click
// (Shift, Escape) does not clear the press. A click a <label> forwards still ticks nothing in every one of its births,
// because the label's own click clears the press first.
// B4: a task is ticked only through the checkbox the task-list renderer made for its item (ownTaskBox): any other
// checkbox inside a task item (raw HTML, whatever its class, its attributes or its place) is cancelled like a raw
// checkbox outside a task line.
// R4IE_OLD=1 ran the same cases against interactions.ts as it was before fix-session-e (a snapshot of round 4, deleted at
// the release of 0.2.0): the cases marked [new rule] failed there. Since round 7 (CONTRACT §11 Checkpoint I) it runs them
// against the released 0.2.0 (test/fixtures/src-0.2.0), which has the repair: they pass there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvents, EventBus } from '../src/shared/types';
import { DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import * as current from '../src/preview/interactions';

const mod: typeof current = process.env.R4IE_OLD
  ? await import('./fixtures/src-0.2.0/preview/interactions') as unknown as typeof current
  : current;

let root: HTMLElement;
let detach: () => void;
let edits: Array<BusEvents['source:edit']>;
let lines: string[];

function attach(): void {
  edits = [];
  const bus = {
    emit(name: string, payload: unknown) { if (name === 'source:edit') edits.push(payload as BusEvents['source:edit']); },
    on() { return () => {}; },
  } as unknown as EventBus;
  detach = mod.attachInteractions(root, {
    bus, setFocusLine() {}, currentFocusLine: () => null, outline: () => [], isEditing: () => false,
    startLineOf: (id) => (id === 1 ? 1 : undefined),
    lineCountOf: (id) => (id === 1 ? lines.length : undefined),
    sourceLine: (line) => lines[line - 1] ?? '',
    isCurrent: () => true,
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
/** A box laid out at a FRACTIONAL rectangle (100.4,100.4)-(116.4,116.4), as at a page zoom or a device scale factor. */
function placeBox(b: HTMLInputElement): void {
  b.getBoundingClientRect = () => ({ left: 100.4, top: 100.4, right: 116.4, bottom: 116.4, width: 16, height: 16, x: 100.4, y: 100.4, toJSON() { return {}; } });
}
/** A press and a click on the box at (x, y); true when the click was cancelled. */
function pressClick(b: HTMLInputElement, x: number, y: number, between?: () => void): boolean {
  placeBox(b);
  b.dispatchEvent(mouse('pointerdown', { clientX: x, clientY: y }));
  b.dispatchEvent(mouse('mousedown', { clientX: x, clientY: y }));
  between?.();
  b.dispatchEvent(mouse('mouseup', { clientX: x, clientY: y }));
  return !b.dispatchEvent(mouse('click', { clientX: x, clientY: y }));
}
/** The label's own click (its activation stopped here), then the click Chromium forwards to its control `b`, with the
 *  label's coordinates and the same detail. `press` false: the press went down elsewhere before (the caller did it).
 *  True when the forwarded click was cancelled. */
function forward(label: Element, b: HTMLInputElement, press = true): boolean {
  placeBox(b);
  const at = { clientX: 400, clientY: 300 };
  if (press) {
    label.dispatchEvent(mouse('pointerdown', at));
    label.dispatchEvent(mouse('mousedown', at));
  }
  label.dispatchEvent(mouse('mouseup', at));
  label.addEventListener('click', (e) => e.preventDefault(), { once: true });
  label.dispatchEvent(mouse('click', at));
  b.focus();
  return !b.dispatchEvent(mouse('click', at));
}
const key = (t: EventTarget, k: string): void => {
  t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  t.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
};
const boxes = (s: HTMLElement): HTMLInputElement[] => Array.from(s.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

beforeEach(() => {
  root = document.createElement('div');
  const chunk = document.createElement('div');
  chunk.className = 'md-chunk';
  root.appendChild(chunk);
  document.body.appendChild(root);
  attach();
});
afterEach(() => {
  detach();
  root.remove();
});

describe('B1, U24 as amended: the press decides, not the click\'s coordinates', () => {
  it('[new rule] a click on the left edge strip (integer x just left of the fractional rectangle) ticks', () => {
    const s = mount('- [ ] a\n');
    expect(pressClick(boxes(s)[0], 100, 108)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a click on the top edge strip ticks', () => {
    const s = mount('- [ ] a\n');
    expect(pressClick(boxes(s)[0], 108, 100)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a click at 0 / 0 after a mousedown on the box ticks', () => {
    const s = mount('- [ ] a\n');
    const b = boxes(s)[0];
    placeBox(b);
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
    expect(!b.dispatchEvent(mouse('click', { clientX: 0, clientY: 0 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('the accessibility press as measured (pointerdown and mousedown with detail 0 on the box, a click with detail 1 at its centre) ticks', () => {
    const s = mount('- [ ] a\n- [ ] b\n');
    const b = boxes(s)[1];
    placeBox(b);
    b.dispatchEvent(mouse('pointerdown', { clientX: 108.4, clientY: 108.4, detail: 0 }));
    b.dispatchEvent(mouse('mousedown', { clientX: 108.4, clientY: 108.4, detail: 0 }));
    b.dispatchEvent(mouse('mouseup', { clientX: 108.4, clientY: 108.4, detail: 0 }));
    expect(!b.dispatchEvent(mouse('click', { clientX: 108.4, clientY: 108.4, detail: 1 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }]);
  });
  it('a click with no press before it (input.click()) is still refused', () => {
    const s = mount('- [ ] a\n');
    const b = boxes(s)[0];
    b.click();
    expect(b.checked).toBe(false);
    expect(edits).toEqual([]);
  });
  it('[new rule] RVT-4: press on the box, Shift down while holding, release on the box: ticks', () => {
    const s = mount('- [ ] a\n');
    expect(pressClick(boxes(s)[0], 108, 108, () => key(document.body, 'Shift'))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] RVT-4: the same with Escape', () => {
    const s = mount('- [ ] a\n');
    expect(pressClick(boxes(s)[0], 108, 108, () => key(document.body, 'Escape'))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('a press on the box released on its label\'s text (the click goes to the label, which forwards it): nothing', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const label = s.querySelector('label')!;
    const b = boxes(s)[0];
    expect(label.contains(b)).toBe(true);
    b.dispatchEvent(mouse('pointerdown', { clientX: 108, clientY: 108 }));
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
    expect(forward(label, b, false)).toBe(true);
    expect(b.checked).toBe(false);
    expect(edits).toEqual([]);
  });
  it('a press on the label\'s text released on the box (the click goes to the label): nothing', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const label = s.querySelector('label')!;
    const b = boxes(s)[0];
    label.dispatchEvent(mouse('mousedown', { clientX: 400, clientY: 300 }));
    b.dispatchEvent(mouse('mouseup', { clientX: 108, clientY: 108 }));
    expect(forward(label, b, false)).toBe(true);
    expect(edits).toEqual([]);
  });
  it('a plain click on a label that wraps the box: nothing', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    expect(forward(s.querySelector('label')!, boxes(s)[0])).toBe(true);
    expect(edits).toEqual([]);
  });
  it('a click on a label elsewhere in the document that names the box with for=: nothing', () => {
    const s = mount('<label for="tk">press here to read</label>\n\n- [ ] <input type="checkbox" id="tk"> task\n');
    const raw = s.querySelector<HTMLInputElement>('#tk')!;
    expect(forward(s.querySelector('label')!, raw)).toBe(true);
    expect(edits).toEqual([]);
  });
  it('a right-button press on the box followed by a click on its label: nothing', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const b = boxes(s)[0];
    b.dispatchEvent(mouse('pointerdown', { clientX: 108, clientY: 108, button: 2 }));
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108, button: 2 }));
    b.dispatchEvent(mouse('mouseup', { clientX: 108, clientY: 108, button: 2 }));
    expect(forward(s.querySelector('label')!, b)).toBe(true);
    expect(edits).toEqual([]);
  });
  it('a press on the box with no click (released outside the window), then a click on its label: nothing; then Space on the box the user focused: one tick', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const b = boxes(s)[0];
    b.dispatchEvent(mouse('pointerdown', { clientX: 108, clientY: 108 }));
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
    key(document.body, 'Tab');                                    // keys meanwhile keep the press (RVT-4)
    expect(forward(s.querySelector('label')!, b, true)).toBe(true);
    expect(edits).toEqual([]);
    b.blur();
    b.focus();                                                    // Tab back to it: the user's own focus
    b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }]);
  });
  it('a key on a box that got its focus from a refused click ticks nothing (focusGiven)', () => {
    const s = mount('- <label>read the words\n  - [ ] t1\n  </label>\n');
    const b = boxes(s)[0];
    expect(forward(s.querySelector('label')!, b)).toBe(true);
    expect(document.activeElement).toBe(b);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(true);
    expect(edits).toEqual([]);
  });
  it('a press on the box with no click, then Space on it: one tick', () => {
    const s = mount('- [ ] a\n');
    const b = boxes(s)[0];
    b.dispatchEvent(mouse('mousedown', { clientX: 108, clientY: 108 }));
    b.focus();
    b.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(!b.dispatchEvent(mouse('click', { detail: 0 }))).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
});

describe('B4, RVT-3: a task is ticked only through the checkbox the task-list renderer made for its item', () => {
  /** A real hit on `b`: true when it was cancelled. */
  const hit = (b: HTMLInputElement): boolean => pressClick(b, 108, 108);
  /** The own boxes of a mounted block, as ownTaskBox sees them. */
  const own = (s: HTMLElement): HTMLInputElement[] => boxes(s).filter((b) => mod.ownTaskBox?.(b));

  it('[new rule] a raw checkbox after the item\'s text ticks nothing; the own boxes tick their lines', () => {
    const s = mount('- [ ] victim <input type="checkbox">\n- [ ] other\n');
    const [v, raw, o] = boxes(s);
    expect(hit(raw)).toBe(true);
    expect(raw.checked).toBe(false);
    expect(edits).toEqual([]);
    expect(hit(v)).toBe(false);
    expect(hit(o)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }, { kind: 'toggleTask', line: 2 }]);
  });
  it('[new rule] the overlay of the review (a raw box with style over the other tasks\' boxes) ticks nothing', () => {
    const s = mount('- [ ] victim <input type="checkbox" style="position:absolute;left:-60px;top:-80px;width:900px;height:120px;opacity:0;margin:0;z-index:9">\n- [ ] other\n');
    const raw = boxes(s)[1];
    expect(raw.getAttribute('style')).toContain('opacity:0');           // the sanitizer keeps it
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
  });
  it('[new rule] a raw checkbox with the renderer\'s class ticks nothing', () => {
    const s = mount('- [ ] a <input type="checkbox" class="task-list-item-checkbox">\n');
    const [a, raw] = boxes(s);
    expect(raw.className).toBe('task-list-item-checkbox');
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(a)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a raw checkbox inside a nested raw label ticks nothing', () => {
    const s = mount('- [ ] a <label>outer <label><input type="checkbox"> inner</label></label>\n');
    const [a, raw] = boxes(s);
    expect(raw.closest('label')).not.toBeNull();
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(a)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a raw checkbox before the text of a later paragraph of the same item ticks nothing', () => {
    const s = mount('- [ ] a\n\n  <input type="checkbox"> para\n');
    const [a, raw] = boxes(s);
    expect(raw.parentElement?.localName).toBe('p');
    expect(raw.previousSibling).toBeNull();                          // the first node of its paragraph
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(a)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a nested task list: each own box ticks its own line, a raw box in the inner item nothing', () => {
    const s = mount('- [ ] outer\n  - [ ] inner <input type="checkbox">\n');
    const [outer, inner, raw] = boxes(s);
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(inner)).toBe(false);
    expect(hit(outer)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }, { kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] a task item in a quote', () => {
    const s = mount('> - [ ] q <input type="checkbox">\n> - [ ] r\n');
    const [q, raw, r] = boxes(s);
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(r)).toBe(false);
    expect(hit(q)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }, { kind: 'toggleTask', line: 1 }]);
  });
  it('[new rule] an ordered task list', () => {
    const s = mount('1. [ ] a <input type="checkbox">\n2. [x] b\n');
    const [a, raw, b] = boxes(s);
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(b)).toBe(false);
    expect(hit(a)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 2 }, { kind: 'toggleTask', line: 1 }]);
  });
  it('a raw-HTML list item with a raw checkbox outside any task line: still nothing; a task beside it ticks', () => {
    const s = mount('<ul><li><input type="checkbox"> raw item</li></ul>\n\n- [ ] t\n');
    const [raw, t] = boxes(s);
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(t)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 3 }]);
  });
  it('[new rule] an item that starts with a reference definition (no task, but a task-shaped line): its raw box ticks nothing', () => {
    const s = mount('- [x]: http://a\n  <input type="checkbox"> y\n');
    const [raw] = boxes(s);
    expect(raw.closest('li')?.classList.contains('task-list-item')).toBe(false);
    expect(hit(raw)).toBe(true);
    expect(edits).toEqual([]);
  });
  it('an HTML block that forges a task item (class and the worker\'s injected data-l): its line is no task line, nothing', () => {
    const s = mount('- [ ] x\n  <li class="task-list-item"><input type="checkbox"> y</li>\n');
    const [x, forged] = boxes(s);
    expect(forged.closest('li')?.getAttribute('data-l')).toBe('1');
    expect(hit(forged)).toBe(true);
    expect(edits).toEqual([]);
    expect(hit(x)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 1 }]);
  });
  it('an earlier item that leaves a formatting element open: the later items\' own boxes still tick', () => {
    const s = mount('- [ ] a <b>bold\n- [ ] b\n- [ ] c\n');
    const [, b, c] = boxes(s);
    expect(hit(c)).toBe(false);
    expect(hit(b)).toBe(false);
    expect(edits).toEqual([{ kind: 'toggleTask', line: 3 }, { kind: 'toggleTask', line: 2 }]);
  });
  it('ownTaskBox: the own boxes are exactly the renderer\'s, one per task item, in every document above', () => {
    if (!mod.ownTaskBox) return;                                   // (not in the old module)
    for (const md of ['- [ ] victim <input type="checkbox">\n- [ ] other\n', '- [ ] a\n\n  <input type="checkbox"> para\n',
      '- [ ] outer\n  - [ ] inner <input type="checkbox">\n', '> - [ ] q <input type="checkbox">\n> - [ ] r\n',
      '1. [ ] a <input type="checkbox">\n2. [x] b\n', '- [ ] a <b>bold\n- [ ] b\n- [ ] c\n', '<ul><li><input type="checkbox"> raw</li></ul>\n']) {
      root.firstElementChild!.replaceChildren();
      const s = mount(md);
      const want = Array.from(s.querySelectorAll('li.task-list-item')).length;
      const got = own(s);
      expect(got.length, md).toBe(md.startsWith('<ul>') ? 0 : want);
      for (const b of got) expect(b.closest('li')!.querySelector('input'), md).toBe(b);
    }
  });
});

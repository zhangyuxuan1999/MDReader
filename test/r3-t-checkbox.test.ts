// @vitest-environment jsdom
// test/r3-t-checkbox.test.ts — fix-trust (stage 2d, round 3): U16 (CONTRACT §11). A preview checkbox toggles only a
// task line of its OWN block: the line its nearest data-l names must lie inside the line range of the block wrapper
// that holds the checkbox (the outermost .md-block under the preview root, not a forged one inside raw HTML) and must
// be a task-item line of the source; otherwise the click changes nothing and the box keeps the state the source has.
// Independently of the U10 flag (the blocks below are NOT flagged, as a block would be whose forgery the scan missed).
// R3T_OLD=1 ran the same cases against the round-2 interactions.ts (a snapshot taken before round 3): they failed there.
// Since round 7 (CONTRACT §11 Checkpoint I) it runs them against the released 0.2.0 (test/fixtures/src-0.2.0), which has
// the repair: they pass there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvents, EventBus } from '../src/shared/types';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import { createMarkdown } from '../src/worker/md';
import { sanitizeToFragment } from '../src/preview/sanitize';
import * as current from '../src/preview/interactions';

const mod: typeof current = process.env.R3T_OLD
  ? await import('./fixtures/src-0.2.0/preview/interactions') as unknown as typeof current
  : current;

/** Source lines 1-based: block 1 = lines 10..12, block 2 = lines 20..22. */
const SOURCE: Record<number, string> = {
  9: '- [ ] pay the rent (another block)',
  10: '- [ ] first',
  11: 'just a paragraph line',
  12: '> - [x] quoted task',
  13: '- [ ] after the block',
  20: '1. [X] numbered',
  21: '   - [ ] nested',
  22: 'text',
};

let root: HTMLElement;
let detach: () => void;
let edits: Array<BusEvents['source:edit']>;

function attach(withRange: boolean): void {
  edits = [];
  const bus = {
    emit(name: string, payload: unknown) { if (name === 'source:edit') edits.push(payload as BusEvents['source:edit']); },
    on() { return () => {}; },
  } as unknown as EventBus;
  detach = mod.attachInteractions(root, {
    bus, setFocusLine() {}, currentFocusLine: () => null, outline: () => [], isEditing: () => false,
    startLineOf: (id) => (id === 1 ? 10 : id === 2 ? 20 : undefined),
    ...(withRange ? {
      lineCountOf: (id: number) => (id === 1 || id === 2 ? 3 : undefined),
      sourceLine: (line: number) => SOURCE[line] ?? '',
    } : {}),
  });
}

beforeEach(() => {
  root = document.createElement('div');
  const chunk = document.createElement('div');
  chunk.className = 'md-chunk';
  root.appendChild(chunk);
  document.body.appendChild(root);
});
afterEach(() => {
  detach();
  root.remove();
});

function block(id: number, html: string): HTMLElement {
  const s = document.createElement('section');
  s.className = 'md-block';
  s.dataset.id = String(id);
  s.innerHTML = html;
  root.firstElementChild!.appendChild(s);
  return s;
}
/** A real click: the browser toggles the box, fires change unless the click was cancelled (then the box reverts). */
function clickBox(input: HTMLInputElement): { cancelled: boolean; checked: boolean } {
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));   // U24: its press
  const cancelled = !input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return { cancelled, checked: input.checked };
}
const box = (html: string, id = 1): HTMLInputElement => block(id, html).querySelector('input')!;

describe('U16: a checkbox toggles only a task line of its own block', () => {
  it('a forged data-l pointing before the block changes nothing and the box stays as it was', () => {
    attach(true);
    const b = box('<ul><li class="task-list-item" data-l="-1"><input type="checkbox"> forged</li></ul>');
    expect(clickBox(b)).toEqual({ cancelled: true, checked: false });
    expect(edits).toEqual([]);
  });

  it('a forged data-l pointing after the block (a task line there) changes nothing', () => {
    attach(true);
    const b = box('<ul><li class="task-list-item" data-l="3"><input type="checkbox"> forged</li></ul>');   // line 13 is a task line
    expect(clickBox(b)).toEqual({ cancelled: true, checked: false });
    expect(edits).toEqual([]);
  });

  it('a data-l inside the block naming a line that is not a task item changes nothing', () => {
    attach(true);
    const b = box('<ul><li class="task-list-item" data-l="1"><input type="checkbox" checked> forged</li></ul>');  // line 11: a paragraph line
    expect(clickBox(b)).toEqual({ cancelled: true, checked: true });
    expect(edits).toEqual([]);
  });

  it('data-l values the worker never writes are refused (sign, exponent, hex, spaces, empty)', () => {
    attach(true);
    for (const l of ['-0', '+1', '1e0', '0x1', ' 1', '1 ', '', '1.0', 'NaN']) {
      const b = box(`<ul><li class="task-list-item" data-l="${l}"><input type="checkbox"> x</li></ul>`);
      expect(clickBox(b).cancelled, JSON.stringify(l)).toBe(true);
      b.closest('section')!.remove();
    }
    expect(edits).toEqual([]);
  });

  it('a task line of the block itself toggles, also in a blockquote, numbered and nested', () => {
    attach(true);
    const a = box('<ul><li class="task-list-item" data-l="0"><input type="checkbox"> first</li></ul>');
    expect(clickBox(a)).toEqual({ cancelled: false, checked: true });
    const q = box('<blockquote data-l="2"><ul><li class="task-list-item" data-l="2"><input type="checkbox" checked> quoted</li></ul></blockquote>');
    expect(clickBox(q)).toEqual({ cancelled: false, checked: false });
    const n = box('<ol><li class="task-list-item" data-l="0"><input type="checkbox" checked> numbered<ul><li class="task-list-item" data-l="1"><input type="checkbox"> nested</li></ul></li></ol>', 2);
    expect(clickBox(n).cancelled).toBe(false);
    const nested = n.closest('section')!.querySelectorAll('input')[1] as HTMLInputElement;
    expect(clickBox(nested).cancelled).toBe(false);
    expect(edits).toEqual([
      { kind: 'toggleTask', line: 10 }, { kind: 'toggleTask', line: 12 }, { kind: 'toggleTask', line: 20 }, { kind: 'toggleTask', line: 21 },
    ]);
  });

  it('a forged .md-block[data-id] inside the block: the range is the OUTER wrapper\'s (REV-2 without the flag)', () => {
    attach(true);
    // the forged inner wrapper claims block 2 (lines 20..22): its line 0 would be "1. [X] numbered"
    const b = box('<section class="md-block" data-id="2"><ul><li class="task-list-item" data-l="0"><input type="checkbox"> x</li></ul></section>', 1);
    expect(clickBox(b)).toEqual({ cancelled: false, checked: true });
    expect(edits).toEqual([{ kind: 'toggleTask', line: 10 }]);   // block 1's own line 0
  });

  it('through the worker: a raw-HTML checkbox whose html_block data-l names a non-task line does not toggle', () => {
    attach(true);
    const r = createMarkdown(DEFAULT_RENDER_OPTIONS).renderBlock('<ul><li><input type="checkbox"> raw</li></ul>\n', { references: {} });
    expect(r.flags & HTML_FLAG_RESERVED).toBe(0);                // nothing reserved in it
    const s = document.createElement('section');
    s.className = 'md-block';
    s.dataset.id = '2';
    s.replaceChildren(sanitizeToFragment(r.html));                // the worker put data-l="0" on the <ul>
    root.firstElementChild!.appendChild(s);
    const b = s.querySelector('input')!;
    expect(b.closest('[data-l]')!.getAttribute('data-l')).toBe('0');
    SOURCE[20] = '<ul><li><input type="checkbox"> raw</li></ul>';
    try {
      expect(clickBox(b)).toEqual({ cancelled: true, checked: false });
      expect(edits).toEqual([]);
    } finally { SOURCE[20] = '1. [X] numbered'; }
  });

  it('without the range and source deps (older wiring) a data-l before the block is still refused; the own line toggles', () => {
    attach(false);
    const f = box('<ul><li class="task-list-item" data-l="-4"><input type="checkbox"> forged</li></ul>');
    expect(clickBox(f)).toEqual({ cancelled: true, checked: false });
    const ok = box('<ul><li class="task-list-item" data-l="1"><input type="checkbox"> ok</li></ul>', 2);
    expect(clickBox(ok)).toEqual({ cancelled: false, checked: true });
    expect(edits).toEqual([{ kind: 'toggleTask', line: 21 }]);
  });
});

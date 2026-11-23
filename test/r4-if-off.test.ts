// @vitest-environment jsdom
// test/r4-if-off.test.ts — fix-session-f, the switch-off proof at unit level (CONTRACT §11, "Release decision for 0.2.0":
// with 预览可编辑 off no code of the editing session may change what the user sees, types, copies or scrolls). Every
// event type the listeners of inlineEdit.ts, createPreview.ts and interactions.ts listen for is fired at the preview
// root, at text inside a block, at the document and at the window, with the switch off — never turned on, and after a
// session was used and the switch then turned off — and nothing may happen: no preventDefault, no stopPropagation, no
// DOM change in the preview, no selection or focus change, no write to the source, no timer left running. And a click
// on a task checkbox with the switch off never reaches the wait (no capture element, no timer, no replay), whatever the
// answer of THE function (createPreview taskLine) is.
// The one guard every handler relies on: inlineEdit's `editable` (false whenever the switch is off). Every session
// state — the session `s`, a `resume`, a `pendingToggle`, `press`, `dragFrom`, `toggle`, `helpersOut` — is only ever
// created while it is true, and setEditable(false) ends the session and the resume (end(), cancelResume()); a task
// click waits only when editable (onClick). interactions' U24 listeners (onPress, onKey, onFocusOut) only remember
// targets; onCheckClick cancels a checkbox click only when it did not hit its box (U24, decided with the switch off too).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, DEFAULT_RENDER_OPTIONS, type HtmlItem, type PreviewApi, type PreviewSourceAccess,
} from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { blockSource, identify, segmentAll, type Block } from '../src/worker/segmenter';
import { TASK_NOT_TICKED_TEXT, type TaskAnswer } from '../src/preview/interactions';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (n = 1): void => { for (let k = 0; k < n; k++) vi.advanceTimersByTime(17); };
class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }

let mdk: Markdown;
beforeAll(() => { mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
const live: Sim[] = [];
afterEach(() => { for (const s of live.splice(0)) s.pv.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

type Pv = PreviewApi & { taskLine(box: HTMLInputElement): TaskAnswer };

/** Source with a version (one per changing write) and a lineNow that knows the current version only; worker stand-in. */
class Sim {
  lines: string[];
  version = 1;
  writes = 0;
  blocks: Block[] = [];
  nextId = 1;
  dirty = new Set<number>();
  requested = new Set<number>();
  bus = createBus();
  toasts: string[] = [];
  edits: number[] = [];
  pv: Pv;
  source: PreviewSourceAccess;
  constructor(text: string) {
    this.lines = text.split('\n');
    this.source = {
      read: (start, count) => this.lines.slice(start - 1, start - 1 + count).join('\n'),
      replace: (start, count, t) => {
        if (this.lines.slice(start - 1, start - 1 + count).join('\n') === t) return;
        this.writes++;
        this.version++;
        this.lines.splice(start - 1, count, ...t.split('\n'));
        this.structure();
      },
      history: () => null,
      version: () => this.version,
      lineNow: (line, v) => (v === this.version ? line : undefined),
    };
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    this.pv = createPreview({
      parent, bus: this.bus,
      request: (ids) => { for (const id of ids) this.requested.add(id); },
      viewport: () => {},
      resync: () => {},
      source: this.source,
    }) as Pv;
    Object.defineProperty(this.pv.el, 'clientHeight', { value: 4000, configurable: true });
    this.bus.on('toast', (t) => { this.toasts.push(t.text); });
    this.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') this.edits.push(e.line); });
    live.push(this);
    this.structure();
    this.pump();
  }
  structure(): void {
    const segs = segmentAll(this.lines);
    const { N, dirty } = identify(this.lines, this.blocks, segs, () => this.nextId++);
    this.blocks = N;
    for (const id of dirty) this.dirty.add(id);
    const arr = new Int32Array(N.length * BLOCK_STRIDE);
    N.forEach((b, i) => {
      arr[i * BLOCK_STRIDE + B_ID] = b.id; arr[i * BLOCK_STRIDE + B_START] = b.startLine;
      arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount; arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    });
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: this.lines.length, readingMinutes: 0 };
    this.pv.applyStructure({ type: 'structure', version: this.version, blocks: arr, changed: Int32Array.from(dirty), lineCount: this.lines.length, stats, outlineVersion: 1 });
  }
  pump(): void {
    for (let f = 0; f < 3; f++) {
      const ids = new Set([...this.requested, ...this.dirty]);
      this.requested.clear(); this.dirty.clear();
      const items: HtmlItem[] = [];
      for (const b of this.blocks) {
        if (!ids.has(b.id)) continue;
        const r = mdk.renderBlock(blockSource(this.lines, b), { references: {} });
        items.push({ id: b.id, flags: r.flags, payload: r.html });
      }
      if (items.length) this.pv.applyHtml({ type: 'html', version: this.version, batch: packHtml(items).batch });
      frame();
    }
  }
  block(i: number): HTMLElement { return this.pv.el.querySelectorAll<HTMLElement>('section.md-block')[i]; }
}

const DOC = 'First paragraph with words.\n\nSecond paragraph here.\n\n- [ ] one\n- [ ] two\n- [ ] three\n';

/** The event types the three modules listen for (and the ones a gesture brings with it), with a constructor each. */
const EVENTS: Array<[string, () => Event]> = [
  ...['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'mousemove'].map((t) => [t, () => new MouseEvent(t, { bubbles: true, cancelable: true, button: 0, buttons: t === 'mousemove' ? 1 : 0 })] as [string, () => Event]),
  ...['pointerdown', 'pointerup', 'touchstart', 'wheel', 'scroll', 'selectionchange', 'dragend', 'dragover', 'blur'].map((t) => [t, () => new Event(t, { bubbles: true, cancelable: true })] as [string, () => Event]),
  ...['a', 'Escape', 'Enter', 'Backspace', ' ', 'Home', 'End', 'Tab'].map((k) => [`keydown:${k}`, () => new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })] as [string, () => Event]),
  ['keydown:Meta+z', () => new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })],
  ['keydown:Meta+e', () => new KeyboardEvent('keydown', { key: 'e', metaKey: true, bubbles: true, cancelable: true })],
  ['keyup', () => new KeyboardEvent('keyup', { key: 'a', bubbles: true, cancelable: true })],
  ['beforeinput', () => new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true })],
  ['beforeinput:historyUndo', () => new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })],
  ['input', () => new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true })],
  ['compositionstart', () => new CompositionEvent('compositionstart', { bubbles: true, cancelable: true })],
  ['compositionend', () => new CompositionEvent('compositionend', { data: 'x', bubbles: true, cancelable: true })],
  ...['paste', 'copy', 'cut', 'drop', 'dragstart'].map((t) => [t, () => {
    const e = new Event(t, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: () => 'pasted', setData: () => {}, types: ['text/plain'] } });
    Object.defineProperty(e, 'dataTransfer', { value: { getData: () => '', setData: () => {}, types: [] } });
    return e;
  }] as [string, () => Event]),
  ...['focusin', 'focusout'].map((t) => [t, () => new FocusEvent(t, { bubbles: true })] as [string, () => Event]),
];

/** Fires every event at every target; returns what happened. */
function fireAll(sim: Sim): { prevented: string[]; stopped: string[]; mutations: number; selection: string; focus: Element | null; writes: number; timers: number } {
  const prevented: string[] = [];
  const stopped: string[] = [];
  const pd = vi.spyOn(Event.prototype, 'preventDefault');
  const sp = vi.spyOn(Event.prototype, 'stopPropagation');
  const sip = vi.spyOn(Event.prototype, 'stopImmediatePropagation');
  const mo = new MutationObserver(() => {});
  mo.observe(sim.pv.el, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
  // a selection in the first paragraph, and the focus on the body
  // (jsdom keeps the focus on a wrapper whose contenteditable was removed, where a browser drops it: move it off)
  const tmp = document.body.appendChild(document.createElement('input'));
  tmp.focus(); tmp.blur(); tmp.remove();
  const p = sim.block(0).querySelector('p')!;
  const r = document.createRange();
  r.setStart(p.firstChild!, 2); r.setEnd(p.firstChild!, 9);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
  const selBefore = () => { const s = document.getSelection()!; return `${s.anchorOffset}:${s.focusOffset}:${s.toString()}`; };
  const sel0 = selBefore();
  const writes0 = sim.writes;
  const targets: Array<[string, EventTarget]> = [['root', sim.pv.el], ['text', p], ['document', document], ['window', window]];
  if (process.env.R4IF_DEBUG) {
    const f = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, o?: FocusOptions) { console.log('FOCUS', this.tagName, this.className, new Error().stack?.split('\n').slice(2, 7).join(' | ')); return f.call(this, o); });
  }
  for (const [tn, t] of targets) {
    for (const [en, mk] of EVENTS) {
      if (process.env.R4IF_DEBUG && document.activeElement !== document.body) console.log('ACTIVE before', en, tn, document.activeElement?.tagName);
      pd.mockClear(); sp.mockClear(); sip.mockClear();
      const e = mk();
      t.dispatchEvent(e);
      if (pd.mock.calls.length || e.defaultPrevented) prevented.push(`${en}@${tn}`);
      if (sp.mock.calls.length || sip.mock.calls.length) stopped.push(`${en}@${tn}`);
      frame();
    }
  }
  vi.advanceTimersByTime(5000);
  const recs = mo.takeRecords();
  if (process.env.R4IF_DEBUG) for (const m of recs) console.log('MUT', m.type, m.attributeName, (m.target as Element).className ?? m.target.nodeName, m.oldValue);
  // the focus line (CONTRACT §9: a click tints its line, in 0.1.1 too) is interactions' own, not the editing code's
  const mutations = recs.filter((m) => !(m.type === 'attributes' && m.attributeName === 'class'
    && ((m.oldValue ?? '').includes('is-focus') !== (m.target as Element).classList.contains('is-focus')))).length;
  mo.disconnect();
  pd.mockRestore(); sp.mockRestore(); sip.mockRestore();
  return { prevented, stopped, mutations, selection: selBefore() === sel0 ? 'same' : `${sel0} -> ${selBefore()}`, focus: document.activeElement, writes: sim.writes - writes0, timers: vi.getTimerCount() };
}

function expectNothing(sim: Sim): void {
  const out = fireAll(sim);
  expect(out.prevented).toEqual([]);
  expect(out.stopped).toEqual([]);
  expect(out.mutations).toBe(0);
  expect(out.selection).toBe('same');
  expect(out.focus).toBe(document.body);
  expect(out.writes).toBe(0);
  expect(out.timers).toBe(0);
  expect(sim.pv.el.querySelector('textarea, [contenteditable], .is-editing')).toBeNull();
  expect(sim.toasts).toEqual([]);
}

/** A primary click on `target`: press, release, click. */
function clickOn(target: Element): MouseEvent {
  const o = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(new MouseEvent('pointerdown', o));
  target.dispatchEvent(new MouseEvent('mousedown', o));
  target.dispatchEvent(new MouseEvent('mouseup', o));
  const c = new MouseEvent('click', o);
  target.dispatchEvent(c);
  return c;
}

describe('the switch off: every listener does nothing (Release decision for 0.2.0)', () => {
  it('never turned on: every event at the root, in a block, at the document and the window — nothing happens', () => {
    const sim = new Sim(DOC);
    expect(sim.pv.isPreviewEditable()).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
    expectNothing(sim);
  });

  it('after a session was used (text written) and the switch turned off: the same', () => {
    const sim = new Sim(DOC);
    sim.pv.setPreviewEditable(true);
    frame();
    const p = sim.block(0).querySelector('p')!;
    clickOn(p);
    expect(sim.pv.el.querySelector('.is-editing')).not.toBeNull();
    p.firstChild!.textContent = 'First paragraph with more words.';
    sim.block(0).dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'more ' }));
    frame(3);
    expect(sim.writes).toBe(1);
    sim.pv.setPreviewEditable(false);
    sim.pump();
    vi.advanceTimersByTime(5000);
    sim.pump();
    sim.toasts.length = 0;
    expect(vi.getTimerCount()).toBe(0);
    expectNothing(sim);
  });

  it('after a session was ended by Esc and the switch turned off while its re-render was on its way: the same', () => {
    const sim = new Sim(DOC);
    sim.pv.setPreviewEditable(true);
    frame();
    const li = sim.block(2).querySelector('li')!;
    clickOn(li);
    expect(sim.pv.el.querySelector('.is-editing')).not.toBeNull();
    sim.block(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    sim.pv.setPreviewEditable(false);
    sim.pump();
    vi.advanceTimersByTime(5000);
    expect(vi.getTimerCount()).toBe(0);
    expectNothing(sim);
  });
});

describe('the switch off: a task click never reaches the wait, whatever the answer', () => {
  function noWait(sim: Sim, box: HTMLInputElement, want: TaskAnswer, prevented: boolean, toasts: string[]): void {
    expect(sim.pv.taskLine(box)).toBe(want);
    const timers0 = vi.getTimerCount();
    const c = clickOn(box);
    expect(c.defaultPrevented).toBe(prevented);
    expect(vi.getTimerCount()).toBe(timers0);                                  // no toggle timer
    expect(sim.pv.el.querySelector('textarea')).toBeNull();                    // no capture element
    expect(sim.toasts).toEqual(toasts);
    const edits0 = sim.edits.length;
    sim.structure(); sim.pump(); vi.advanceTimersByTime(12000); sim.pump();
    expect(sim.edits.length).toBe(edits0);                                     // nothing replays it
  }

  it('a line: ticked at once', () => {
    const sim = new Sim(DOC);
    noWait(sim, sim.block(2).querySelectorAll('input')[1] as HTMLInputElement, 6, false, []);
    expect(sim.edits).toEqual([6]);
  });
  it('none (a raw checkbox): cancelled silently', () => {
    const sim = new Sim('- [ ] one <input type="checkbox">\n- [ ] two\n');
    noWait(sim, sim.block(0).querySelectorAll('input')[1] as HTMLInputElement, 'none', true, []);
  });
  it('gone (the line, mapped through a change, is no longer a task line): the toast', () => {
    const sim = new Sim(DOC);
    // a change the structure has not seen (fix-session-g, Checkpoint-E decisions CHC-3: 'gone' is for a MAPPED line;
    // the source changed under a current structure without a version, as this case did before, answers 'none' now)
    sim.lines[5] = 'not a task';
    const now = ++sim.version;
    sim.source.lineNow = (line, v) => (v === now || v === now - 1 ? line : undefined);
    noWait(sim, sim.block(2).querySelectorAll('input')[1] as HTMLInputElement, 'gone', true, [TASK_NOT_TICKED_TEXT]);
  });
  it('none (the box shows the source as it is and its line is not a task line, CHC-3): cancelled silently', () => {
    const sim = new Sim('- - [ ] q3 nested\n\n- [ ] q5 plain\n');
    noWait(sim, sim.block(0).querySelector('input') as HTMLInputElement, 'none', true, []);
  });
  it('unknown (the source moved on and its lineNow cannot map the stamp): the toast', () => {
    const sim = new Sim(DOC);
    sim.version++;                                // a change the structure has not seen; this lineNow knows none
    noWait(sim, sim.block(2).querySelectorAll('input')[0] as HTMLInputElement, 'unknown', true, [TASK_NOT_TICKED_TEXT]);
  });
  it('a block a session released just before the switch went off: unknown, the toast, no wait', () => {
    const sim = new Sim(DOC);
    sim.pv.setPreviewEditable(true);
    frame();
    clickOn(sim.block(2).querySelector('li')!);
    expect(sim.pv.el.querySelector('.is-editing')).not.toBeNull();
    sim.pv.setPreviewEditable(false);             // ends the session: the block is released, its re-render on its way
    noWait(sim, sim.block(2).querySelectorAll('input')[2] as HTMLInputElement, 'unknown', true, [TASK_NOT_TICKED_TEXT]);
  });
});

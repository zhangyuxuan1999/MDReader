// @vitest-environment jsdom
// test/r4-if-ticks.test.ts — fix-session-f, "the tick that does not wait" (CONTRACT §11, Checkpoint-C and Checkpoint-D
// decisions: U16 as amended a second time). Harness: a real CodeMirror editor (createEditor: its version, its ring of
// steps and lineNow; App's wiring of 'source:edit' to applySourceEdit), createSourceAccess, a real createPreview, and a
// worker stand-in that keeps its OWN copy of the document at the version of its last structure (it renders HTML from
// that copy, as the real worker does) and posts full structures or deltas when the test says so.
// Checked: (1) the stamp invariant after every path of createPreview a unit test can drive — for every wrapper with a
// stamp (V, S, N), each task item's data-l r is line S + r of the document of version V (every task line holds a unique
// token); (2) every answer of THE function (createPreview taskLine) that is a line names the clicked task's own line now;
// (3) the five answers, each with what the click does (cancelled or not, toast or not, wait or not), the same answer in
// onClick and onChange, and the replay of Fix B's wait ending in a line.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createEditor, STEP_RING, type DisposableEditorApi } from '../src/editor/createEditor';
import { createSourceAccess } from '../src/app/previewEdit';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, DEFAULT_RENDER_OPTIONS, type HtmlItem, type PreviewApi,
} from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { blockSource, identify, segmentAll, type Block } from '../src/worker/segmenter';
import { TASK_NOT_TICKED_TEXT, type TaskAnswer, type TaskStamp } from '../src/preview/interactions';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

installLayoutStubs();
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
const live: H[] = [];
afterEach(() => {
  for (const h of live.splice(0)) { h.pv.dispose(); h.editor.dispose(); }
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

type Pv = PreviewApi & { taskStampOf(w: HTMLElement): TaskStamp | undefined; taskLine(box: HTMLInputElement): TaskAnswer };

/** Editor + preview + worker stand-in. */
class H {
  bus = createBus();
  editor: DisposableEditorApi;
  pv: Pv;
  toasts: string[] = [];
  edits: number[] = [];
  resyncs = 0;
  /** The document of every version the editor produced (version -> lines). */
  docs = new Map<number, string[]>();
  // ---- worker stand-in
  wBlocks: Block[] = [];
  wLines: string[] = [];
  wVersion = 0;
  nextId = 1;
  dirty = new Set<number>();
  requested = new Set<number>();

  constructor(text: string, height = 4000) {
    const ep = document.createElement('div');
    document.body.appendChild(ep);
    this.editor = createEditor({ parent: ep, bus: this.bus, registry: createFakeRegistry(), theme: 'light' }) as DisposableEditorApi;
    this.editor.onChanges((v) => { this.docs.set(v, this.editor.getText().split('\n')); });
    this.editor.setDoc(text);
    this.docs.set(this.editor.version, text.split('\n'));
    const pp = document.createElement('div');
    document.body.appendChild(pp);
    this.pv = createPreview({
      parent: pp, bus: this.bus,
      request: (ids) => { for (const id of ids) this.requested.add(id); },
      viewport: () => {},
      resync: () => { this.resyncs++; },
      source: createSourceAccess(this.editor),
    }) as Pv;
    this.setHeight(height);
    this.bus.on('toast', (t) => { this.toasts.push(t.text); });
    this.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') { this.edits.push(e.line); this.editor.applySourceEdit(e); } });
    live.push(this);
    this.structure('full');
    this.html();
    frame(3);
  }
  setHeight(px: number): void { Object.defineProperty(this.pv.el, 'clientHeight', { value: px, configurable: true }); }
  text(): string { return this.editor.getText(); }
  lines(): string[] { return this.text().split('\n'); }
  /** An edit in the editor pane (one transaction). */
  type(line: number, col: number, insert: string, delChars = 0): void {
    const v = this.editor.view;
    const from = v.state.doc.line(line).from + col;
    v.dispatch({ changes: { from, to: from + delChars, insert }, userEvent: 'input' });
  }
  /** Worker: re-segment its copy of the document (the editor's text now), keep ids, post a structure. */
  structure(kind: 'full' | 'delta' = 'delta'): void {
    const lines = this.lines();
    const segs = segmentAll(lines);
    const old = this.wBlocks;
    const { N, dirty } = identify(lines, old, segs, () => this.nextId++);
    this.wBlocks = N;
    this.wLines = lines;
    this.wVersion = this.editor.version;
    for (const id of dirty) this.dirty.add(id);
    const ch = new Set(dirty);
    const pack = (bs: Block[]): Int32Array => {
      const arr = new Int32Array(bs.length * BLOCK_STRIDE);
      bs.forEach((b, i) => {
        arr[i * BLOCK_STRIDE + B_ID] = b.id; arr[i * BLOCK_STRIDE + B_START] = b.startLine;
        arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount; arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
      });
      return arr;
    };
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: lines.length, readingMinutes: 0 };
    if (kind === 'full' || old.length === 0) {
      this.pv.applyStructure({ type: 'structure', version: this.wVersion, blocks: pack(N), changed: Int32Array.from(dirty), lineCount: lines.length, stats, outlineVersion: 1 });
      return;
    }
    const min = Math.min(old.length, N.length);
    let p = 0;
    while (p < min && old[p].id === N[p].id && old[p].startLine === N[p].startLine && old[p].lineCount === N[p].lineCount && !ch.has(N[p].id)) p++;
    let s = 0;
    while (s < min - p && old[old.length - 1 - s].id === N[N.length - 1 - s].id && old[old.length - 1 - s].lineCount === N[N.length - 1 - s].lineCount && !ch.has(N[N.length - 1 - s].id)) s++;
    const ins = N.slice(p, N.length - s);
    const rem = old.slice(p, old.length - s);
    const lineDelta = ins.reduce((n, b) => n + b.lineCount, 0) - rem.reduce((n, b) => n + b.lineCount, 0);
    this.pv.applyStructureDelta({
      type: 'structureDelta', version: this.wVersion, index: p, removed: rem.length, inserted: pack(ins), lineDelta,
      changed: Int32Array.from(dirty), lineCount: lines.length, stats, outlineVersion: 1,
    });
  }
  /** Worker: push HTML (from its own copy, at its version) for the requested and dirty blocks, or for `only`. */
  html(only?: number[], version = this.wVersion): void {
    const ids = only ? new Set(only) : new Set([...this.requested, ...this.dirty]);
    if (!only) { this.requested.clear(); this.dirty.clear(); }
    const items: HtmlItem[] = [];
    for (const b of this.wBlocks) {
      if (!ids.has(b.id)) continue;
      const r = mdk.renderBlock(blockSource(this.wLines, b), { references: {} });
      items.push({ id: b.id, flags: r.flags, payload: r.html });
    }
    if (items.length > 0) this.pv.applyHtml({ type: 'html', version, batch: packHtml(items).batch });
  }
  wrappers(): HTMLElement[] { return Array.from(this.pv.el.querySelectorAll<HTMLElement>('section.md-block')); }
  boxes(): HTMLInputElement[] { return Array.from(this.pv.el.querySelectorAll<HTMLInputElement>('li.task-list-item > input[type="checkbox"], li.task-list-item > p > input[type="checkbox"]')); }
  box(token: string): HTMLInputElement {
    const b = this.boxes().find((x) => tokenOf(x.closest('li')!) === token);
    if (!b) throw new Error(`no box for ${token}`);
    return b;
  }
}

const tokenOf = (li: Element): string => /\bt\d+\b/.exec(li.textContent ?? '')?.[0] ?? '';

/** (1) The stamp invariant; returns how many task items it checked. */
function checkStamps(h: H): number {
  let n = 0;
  for (const w of h.wrappers()) {
    const st = h.pv.taskStampOf(w);
    if (!st) continue;
    const doc = h.docs.get(st.v);
    expect(doc, `the document of version ${st.v}`).toBeDefined();
    for (const li of Array.from(w.querySelectorAll<HTMLElement>('li.task-list-item[data-l]'))) {
      const r = Number(li.dataset.l);
      expect(r).toBeLessThan(st.n);
      const tok = tokenOf(li);
      expect(doc![st.s + r - 1], `stamp (${st.v}, ${st.s}, ${st.n}) item ${r} (${tok})`).toMatch(new RegExp(`\\b${tok}\\b`));
      n++;
    }
  }
  return n;
}
/** (2) Every line answer names the clicked task's own line now; returns the answers. */
function checkAnswers(h: H): TaskAnswer[] {
  const out: TaskAnswer[] = [];
  const lines = h.lines();
  for (const b of h.boxes()) {
    const a = h.pv.taskLine(b);
    out.push(a);
    if (typeof a === 'number') expect(lines[a - 1], `answer ${a} for ${tokenOf(b.closest('li')!)}`).toMatch(new RegExp(`\\b${tokenOf(b.closest('li')!)}\\b`));
  }
  return out;
}
const check = (h: H): void => { checkStamps(h); checkAnswers(h); };

/** A real hit on a checkbox (U24: the press on it), then the click; returns the click event. */
function hit(box: HTMLInputElement): MouseEvent {
  const o = { bubbles: true, cancelable: true, button: 0 };
  box.dispatchEvent(new MouseEvent('pointerdown', o));
  box.dispatchEvent(new MouseEvent('mousedown', o));
  box.dispatchEvent(new MouseEvent('mouseup', o));
  const c = new MouseEvent('click', o);
  box.dispatchEvent(c);
  return c;
}

const TASKS = (from: number, to: number): string => Array.from({ length: to - from + 1 }, (_, k) => `- [ ] t${from + k} item`).join('\n');
const DOC = `# Title\n\nintro text\n\n${TASKS(1, 5)}\n\nmiddle text\n\n${TASKS(6, 8)}\n`;

describe('stamps: the invariant on every path (Checkpoint-D decisions)', () => {
  it('a payload mounted in order: every wrapper with tasks has a stamp; answers are the lines', () => {
    const h = new H(DOC);
    expect(checkStamps(h)).toBe(8);
    expect(checkAnswers(h)).toEqual([5, 6, 7, 8, 9, 13, 14, 15]);
  });

  it('an edit above, before and after the structure: every tick lands on its own line (mapped by lineNow)', () => {
    const h = new H(DOC);
    h.type(1, 0, 'new line\n\n');                 // two lines above everything
    check(h);
    expect(checkAnswers(h)).toEqual([7, 8, 9, 10, 11, 15, 16, 17]);
    h.structure();
    check(h);
    h.html(); frame(3);
    check(h);
  });

  it('an edit inside a list: stale with its stamp until the new HTML mounts', () => {
    const h = new H(DOC);
    h.type(6, 0, '- [ ] t20 inserted\n');        // above t2, inside the first list
    expect(checkAnswers(h)).toEqual([5, 7, 8, 9, 10, 14, 15, 16]);
    h.structure();
    check(h);
    expect(checkAnswers(h)).toEqual([5, 7, 8, 9, 10, 14, 15, 16]);   // the old DOM: t20 has no box yet
    h.html(); frame(3);
    check(h);
    expect(checkAnswers(h)).toEqual([5, 6, 7, 8, 9, 10, 14, 15, 16]);
  });

  it('a late payload (older than staleSince) mounts stale and keeps ITS stamp', () => {
    const h = new H(DOC);
    h.type(9, h.editor.view.state.doc.line(9).length, '\n\n' + TASKS(30, 32));   // a new list after t5: pending
    h.structure();
    const newList = h.wBlocks.find((b) => blockSource(h.wLines, b).includes('t30'))!;
    h.html([newList.id]);                         // queued, not mounted yet
    h.type(h.lines().findIndex((l) => l.includes('t31')) + 1, 0, '- [ ] t33 above t31\n');
    h.structure();                                // changes the pending block: staleSince > the queued payload's version
    frame(3);                                     // the older payload mounts and stays stale
    const w = h.pv.elementOfBlock(newList.id)!;
    expect(w.classList.contains('is-stale')).toBe(true);
    expect(h.pv.taskStampOf(w)!.v).toBeLessThan(h.editor.version);
    check(h);
    const a = h.pv.taskLine(h.box('t32'));
    expect(h.lines()[(a as number) - 1]).toContain('t32');
    h.html(); frame(3);
    check(h);
  });

  it('superseded payloads: an older one after a newer one is dropped; the stamp stays the newer one', () => {
    const h = new H(DOC);
    const list = h.wBlocks.find((b) => blockSource(h.wLines, b).includes('t1'))!;
    const oldLines = h.wLines, oldBlocks = h.wBlocks, oldV = h.wVersion;
    h.type(5, h.editor.view.state.doc.line(5).length, ' more');
    h.structure();
    h.html(); frame(3);
    // a payload of the older version arrives late (rendered from the older copy)
    const r = mdk.renderBlock(blockSource(oldLines, oldBlocks.find((b) => b.id === list.id)!), { references: {} });
    h.pv.applyHtml({ type: 'html', version: oldV, batch: packHtml([{ id: list.id, flags: r.flags, payload: r.html }]).batch });
    frame(3);
    expect(h.box('t1').closest('li')!.textContent).toContain('more');
    check(h);
  });

  it('a block changed twice before any HTML: mapped through both changes', () => {
    const h = new H(DOC);
    h.type(5, 0, '- [ ] t40 one\n');
    h.structure();
    h.type(5, 0, '- [ ] t41 two\n');
    h.structure();
    check(h);
    expect(checkAnswers(h)).toEqual([7, 8, 9, 10, 11, 15, 16, 17]);
    h.html(); frame(3);
    check(h);
  });

  it('a block whose stamp came from the structure (restamped before an update) maps from that version', () => {
    const h = new H(DOC);
    for (let k = 0; k < 5; k++) { h.type(3, 0, 'x'); h.structure(); h.html(); frame(2); }
    h.type(6, h.editor.view.state.doc.line(6).length, ' changed');   // t2's text: the list changes
    h.structure();
    const w = h.box('t2').closest<HTMLElement>('section.md-block')!;
    expect(h.pv.taskStampOf(w)!.v).toBe(h.editor.version - 1);       // the structure's own version before the update
    check(h);
  });

  it('the giant path: a deferred payload carries its stamp until it mounts', () => {
    const big = TASKS(100, 5200);
    const h = new H(`intro\n\n${big}\n`);
    frame(40);                                     // GIANT_SETTLE_MS
    check(h);
    h.type(1, 0, 'x');                             // above: the list only shifts
    h.type(3, 0, '- [ ] t99 first\n');             // inside: the giant list changes
    h.structure();
    h.html();
    frame(5);                                      // deferred, not mounted yet
    expect(checkAnswers(h).slice(0, 3)).toEqual([4, 5, 6]);
    frame(40);
    check(h);
  });

  it('eviction and re-request: a recreated wrapper has no stamp until its payload mounts', () => {
    const paras = Array.from({ length: 120 }, (_, k) => `para ${k}`).join('\n\n');
    const h = new H(`${TASKS(1, 3)}\n\n${paras}\n\n${TASKS(4, 6)}\n`);
    check(h);
    h.setHeight(200);
    h.pv.el.dispatchEvent(new Event('scroll'));
    frame(3);
    const last = h.box('t5').closest<HTMLElement>('section.md-block')!;
    h.type(h.lines().findIndex((l) => l.includes('t5')) + 1, 0, '- [ ] t7 new\n');
    h.structure();                                 // far outside the window: evicted at once
    expect(last.isConnected).toBe(false);
    check(h);
    h.setHeight(4000);
    h.pv.el.dispatchEvent(new Event('scroll'));
    frame(3);
    h.html(); frame(3);
    check(h);
    expect(checkAnswers(h).filter((a) => typeof a === 'number').length).toBe(7);
  });

  it('a hidden pane: refreshes are dropped (lost, not released); the stale block is still known by its stamp', () => {
    const h = new H(DOC);
    h.pv.setVisible(false);
    for (let k = 0; k < 5; k++) { h.type(5, h.editor.view.state.doc.line(5).length, 'z'); h.structure(); h.html(); frame(); }
    h.pv.setVisible(true);
    check(h);
    const b = h.box('t3');
    expect(hit(b).defaultPrevented).toBe(false);   // ticked at once (PTK-1)
    expect(h.edits).toEqual([7]);
    expect(h.lines()[6]).toBe('- [x] t3 item');
    frame(3); h.html(); frame(3);
    check(h);
  });

  /** Makes the preview reject a delta (it does not tile): desynced, one resync asked. */
  function reject(h: H): void {
    h.pv.applyStructureDelta({ type: 'structureDelta', version: h.editor.version, index: 0, removed: 1, inserted: new Int32Array(0), lineDelta: 5,
      changed: new Int32Array(0), lineCount: 999, stats: { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: 0, readingMinutes: 0 }, outlineVersion: 1 });
  }

  it('a rejected delta: a payload mounted during the desync gets no stamp (unknown: the toast, nothing ticked)', () => {
    const h = new H(DOC);
    const list2 = h.box('t7').closest<HTMLElement>('section.md-block')!;
    h.type(1, 0, 'x');
    reject(h);
    expect(h.resyncs).toBe(1);
    h.type(h.lines().findIndex((l) => l.includes('t7')) + 1, 0, '- [ ] t9 new\n');
    h.structure();                                 // the worker's delta: ignored while desynced
    h.html(); frame(3);                            // its HTML mounts (no stamp: the structure is behind it)
    expect(h.pv.taskStampOf(list2)).toBeUndefined();
    expect(h.pv.taskLine(h.box('t9'))).toBe('unknown');
    hit(h.box('t9'));
    expect(h.edits).toEqual([]);
    expect(h.toasts.filter((t) => t === TASK_NOT_TICKED_TEXT).length).toBe(1);
    h.structure('full');                           // the resync ends the desync
    h.html(); frame(3);
    check(h);
  });

  it('the resync after a rejected delta does not list a block whose refresh the preview dropped: the floor keeps it mapped (RRC-4)', () => {
    const h = new H(DOC);
    reject(h);
    h.type(6, 0, '- [ ] t9 new\n');              // inserted above t2 in the first list
    h.structure();                                 // ignored (desynced)
    h.pv.setVisible(false);
    h.html(); frame(3);                            // pushed while hidden: dropped; the worker thinks it delivered it
    h.pv.setVisible(true);
    h.structure('full');                           // the resync: changed lists nothing (no block is still dirty)
    const w = h.box('t2').closest<HTMLElement>('section.md-block')!;
    expect(w.classList.contains('is-stale')).toBe(false);   // fresh by the bookkeeping, showing the old lines
    check(h);
    expect(h.pv.taskLine(h.box('t2'))).toBe(7);    // the stamp (below the floor), mapped: never t9's line 6
    expect(hit(h.box('t2')).defaultPrevented).toBe(false);
    expect(h.edits).toEqual([7]);
    expect(h.lines()[6]).toBe('- [x] t2 item');
  });

  it('hold and release: a session removes the stamp; the released block answers wait (editing on) or unknown (off)', () => {
    const h = new H(DOC);
    h.pv.setPreviewEditable(true);
    frame();
    const w = h.box('t2').closest<HTMLElement>('section.md-block')!;
    const li = h.box('t2').closest('li')!;
    const o = { bubbles: true, cancelable: true, button: 0 };
    li.dispatchEvent(new MouseEvent('mousedown', o));
    li.dispatchEvent(new MouseEvent('mouseup', o));
    li.dispatchEvent(new MouseEvent('click', o));
    expect(w.classList.contains('is-editing')).toBe(true);
    expect(h.pv.taskStampOf(w)).toBeUndefined();
    w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(w.classList.contains('is-editing')).toBe(false);
    expect(h.pv.taskLine(h.box('t2'))).toBe('wait');
    h.pv.setPreviewEditable(false);
    expect(h.pv.taskLine(h.box('t2'))).toBe('unknown');
    h.pv.setPreviewEditable(true);
    h.html(); frame(3);
    expect(h.pv.taskLine(h.box('t2'))).toBe(6);
    check(h);
  });
});

describe('the five answers and what the click does (Checkpoint-D decisions)', () => {
  it('a LINE: the click goes through, onChange toggles the same line (the answer onClick saw)', () => {
    const h = new H(DOC);
    h.type(1, 0, 'zz\n');                          // the structure is behind the source
    const b = h.box('t4');
    const a = h.pv.taskLine(b);
    expect(a).toBe(9);
    const c = hit(b);
    expect(c.defaultPrevented).toBe(false);
    expect(b.checked).toBe(true);
    expect(h.edits).toEqual([a]);
    expect(h.lines()[8]).toBe('- [x] t4 item');
    expect(h.toasts).toEqual([]);
  });

  it('NONE: a raw checkbox in a task item and a flagged block are cancelled silently', () => {
    const h = new H('intro\n\n- [ ] t1 a <input type="checkbox"> b\n- [ ] t2 c\n');
    const raw = Array.from(h.pv.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((x) => !x.closest('li')!.querySelector('input')!.isSameNode(x))!;
    expect(h.pv.taskLine(raw)).toBe('none');
    expect(hit(raw).defaultPrevented).toBe(true);
    const own = h.box('t2');
    own.closest('section.md-block')!.setAttribute('data-mdr-x', '');
    expect(h.pv.taskLine(own)).toBe('none');
    expect(hit(own).defaultPrevented).toBe(true);
    expect(h.edits).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it('NONE also in a block that is behind or released: no wait, no toast (fix-session-e\'s request)', () => {
    const h = new H('intro\n\n- [ ] t1 a <input type="checkbox"> b\n- [ ] t2 c\n');
    h.pv.setPreviewEditable(true);
    h.type(1, 0, 'x');                              // behind
    const raw = Array.from(h.pv.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[1];
    expect(h.pv.taskLine(raw)).toBe('none');
    expect(hit(raw).defaultPrevented).toBe(true);
    frame(200);
    expect(h.toasts).toEqual([]);
    expect(h.pv.el.querySelector('textarea')).toBeNull();
  });

  it('GONE: the task line was deleted in the editor before the click — cancelled, one toast, nothing written', () => {
    const h = new H(DOC);
    const v = h.editor.view;
    const l = v.state.doc.line(7);
    v.dispatch({ changes: { from: l.from, to: l.to + 1 } });   // delete "- [ ] t3 item"
    const b = h.box('t3');
    expect(h.pv.taskLine(b)).toBe('gone');
    expect(hit(b).defaultPrevented).toBe(true);
    expect(b.checked).toBe(false);
    expect(h.edits).toEqual([]);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);
    frame(200);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);             // no wait gives it up later
  });

  it('GONE: the line is no longer a task line (its marker text changed after the box)', () => {
    const h = new H(DOC);
    h.type(7, 2, '', 3);                                          // "- [ ] t3" -> "-  t3": not a task line
    expect(h.pv.taskLine(h.box('t3'))).toBe('gone');
  });

  it(`UNKNOWN: a version older than the ring (${STEP_RING} edits after the block's HTML) — cancelled, one toast, no wait`, () => {
    const h = new H(DOC);
    h.type(5, h.editor.view.state.doc.line(5).length, 'q');      // the first list goes stale
    h.structure();
    const v = h.editor.view;
    for (let k = 0; k < STEP_RING + 2; k++) v.dispatch({ changes: { from: 0, insert: 'y' } });
    const b = h.box('t2');
    expect(h.pv.taskLine(b)).toBe('unknown');
    expect(hit(b).defaultPrevented).toBe(true);
    expect(h.edits).toEqual([]);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);
    frame(200);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);
    expect(h.pv.el.querySelector('textarea')).toBeNull();
  });

  it('WAIT: a block a session just released — the click waits (no toast), and the replay after the re-render ends in a line', () => {
    const h = new H(DOC);
    h.pv.setPreviewEditable(true);
    frame();
    const li = h.box('t2').closest('li')!;
    const w = li.closest<HTMLElement>('section.md-block')!;
    const o = { bubbles: true, cancelable: true, button: 0 };
    li.dispatchEvent(new MouseEvent('mousedown', o));
    li.dispatchEvent(new MouseEvent('mouseup', o));
    li.dispatchEvent(new MouseEvent('click', o));
    expect(w.classList.contains('is-editing')).toBe(true);
    w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const b = h.box('t4');
    expect(h.pv.taskLine(b)).toBe('wait');
    expect(hit(b).defaultPrevented).toBe(true);
    expect(h.edits).toEqual([]);
    expect(h.toasts).toEqual([]);
    h.html(); frame(3);                                           // the re-render mounts: the replay
    expect(h.edits).toEqual([8]);
    expect(h.lines()[7]).toBe('- [x] t4 item');
    expect(h.toasts).toEqual([]);
  });

  it('with the switch off a released block never waits: unknown, the toast, nothing pending', () => {
    const h = new H(DOC);
    h.pv.setPreviewEditable(true);
    frame();
    const li = h.box('t2').closest('li')!;
    const w = li.closest<HTMLElement>('section.md-block')!;
    const o = { bubbles: true, cancelable: true, button: 0 };
    li.dispatchEvent(new MouseEvent('mousedown', o));
    li.dispatchEvent(new MouseEvent('mouseup', o));
    li.dispatchEvent(new MouseEvent('click', o));
    expect(w.classList.contains('is-editing')).toBe(true);
    h.pv.setPreviewEditable(false);                               // the session ends, the block is released
    const b = h.box('t4');
    expect(hit(b).defaultPrevented).toBe(true);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);
    h.html(); frame(3);
    expect(h.edits).toEqual([]);                                  // nothing replays it
    expect(h.pv.el.querySelector('textarea')).toBeNull();
  });

  it('rapid ticks with the switch off: every one at once, each on its own task, none waits (CHB-1)', () => {
    const h = new H(`intro\n\n${TASKS(1, 30)}\n`);
    const order = ['t3', 't9', 't15', 't21', 't27'];
    for (const t of order) {
      const b = h.box(t);
      expect(hit(b).defaultPrevented).toBe(false);
      frame();
      if (t === 't15') { h.structure(); }                        // a structure arrives between two ticks
    }
    expect(h.edits).toEqual([5, 11, 17, 23, 29]);
    for (const t of order) expect(h.lines().find((l) => l.includes(t + ' '))).toMatch(/^- \[x\]/);
    expect(h.toasts).toEqual([]);
  });

  it('switch on: a session\'s write above (its block gains a line), then a box below clicked while the structure is behind: the clicked task at once', () => {
    const h = new H(DOC);
    h.pv.setPreviewEditable(true);
    frame();
    const p = h.pv.el.querySelectorAll('section.md-block')[1].querySelector('p')!;   // "intro text"
    const o = { bubbles: true, cancelable: true, button: 0 };
    p.dispatchEvent(new MouseEvent('mousedown', o)); p.dispatchEvent(new MouseEvent('mouseup', o)); p.dispatchEvent(new MouseEvent('click', o));
    expect(p.closest('section')!.classList.contains('is-editing')).toBe(true);
    p.innerHTML = 'intro<br>text';
    p.closest('section')!.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak' }));
    const b = h.box('t4');
    expect(hit(b).defaultPrevented).toBe(false);   // the press ended the session (its write is in the source now)
    expect(h.lines()[2]).toMatch(/^intro/);
    expect(h.lines()[3]).toBe('text');
    expect(h.edits).toEqual([9]);
    expect(h.lines()[8]).toBe('- [x] t4 item');
    expect(h.toasts).toEqual([]);
  });

  it('a change typed in the task\'s own line, then a click within the same frame (CHB-3): the clicked task', () => {
    const h = new H(DOC);
    h.type(7, h.editor.view.state.doc.line(7).length, ' edited');   // t3's own line
    expect(hit(h.box('t3')).defaultPrevented).toBe(false);
    expect(h.edits).toEqual([7]);
    expect(h.lines()[6]).toBe('- [x] t3 item edited');
  });
});

describe('CHC-3 (Checkpoint-E decisions, fix-session-g): a box that never named a task line is cancelled silently', () => {
  // the shapes of bench/verify/v5-chc-shapes.mjs: task items whose source line TASK_LINE does not recognise (it is not
  // widened in this round), and a plain task
  const SHAPES = 'Intro\n\n- > - [ ] t1 quote in item\n\n1. - [ ] t2 bullet in ordered\n\n- - [ ] t3 bullet in bullet\n\n-\n  [ ] t4 box on next line\n\n- [ ] t5 plain\n';
  const boxOf = (h: H, tok: string): HTMLInputElement => {
    const b = Array.from(h.pv.el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((x) => tokenOf(x.closest('li')!) === tok);
    if (!b) throw new Error(`no box for ${tok}`);
    return b;
  };
  it('at rest (the box shows the source as it is, nothing mapped): NONE — cancelled, no toast, nothing written; the plain task ticks', () => {
    const h = new H(SHAPES);
    for (const tok of ['t1', 't2', 't3', 't4']) {
      const b = boxOf(h, tok);
      expect([tok, h.pv.taskLine(b)]).toEqual([tok, 'none']);
      expect([tok, hit(b).defaultPrevented, b.checked]).toEqual([tok, true, false]);
      expect([tok, hit(b).defaultPrevented]).toEqual([tok, true]);   // a second click: the same, silently
    }
    expect(h.toasts).toEqual([]);
    expect(h.edits).toEqual([]);
    const plain = boxOf(h, 't5');
    expect(hit(plain).defaultPrevented).toBe(false);
    expect(h.lines()[h.edits[0] - 1]).toBe('- [x] t5 plain');
    expect(h.toasts).toEqual([]);
  });
  it('mapped through a change and no longer a task line: GONE — cancelled, one toast', () => {
    const h = new H(DOC);
    h.type(7, 2, '', 3);                                          // "- [ ] t3" -> "-  t3": the structure is behind
    const b = h.box('t3');
    expect(h.pv.taskLine(b)).toBe('gone');
    expect(hit(b).defaultPrevented).toBe(true);
    expect(h.edits).toEqual([]);
    expect(h.toasts).toEqual([TASK_NOT_TICKED_TEXT]);
  });
});

// @vitest-environment jsdom
// test/r4-id-session.test.ts — fix-session-d (round 4, Fix B): regression tests for P-B amended (CHA-5: "current" is
// decided by document versions), P-F amended / P-G (CHA-2: a wait never takes the focus back; nothing typed disappears
// silently), U16 amended (CHA-1: a waiting checkbox click ticks the task the user clicked), P-A (J2, J1: no helper
// character leaves the session; a paste over a whole inline element goes inside it) and P-E (J5).
// The harness (Sim, the Chrome editing stand-in, press / mousedown helpers, emptyPara, useWindowedWorker,
// useEditorHistory) is copied from test/r4-ic-session.test.ts lines 10-505; the r4-id additions follow it
// (useVersionedSource: a source with a document version, as App's createSourceAccess gives the editor's).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutKeyEvent } from '../src/app/previewEdit';
import { createPreview } from '../src/preview/createPreview';
import { EDIT_HINT_TEXT, INPUT_DROPPED_TEXT, MAX_EDIT_CHARS, NOT_EDITABLE_TEXT, PASTE_TOO_LONG_TEXT, TASK_NOT_TICKED_TEXT, editCmdOf, setCaretAtOffset, textOffsetOf } from '../src/preview/inlineEdit';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, DEFAULT_RENDER_OPTIONS,
  type AppEvents, type HtmlItem, type PreviewApi, type PreviewSourceAccess, type StructureMsg, type ToastSpec,
} from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { blockSource, identify, resegmentWindow, segmentAll, type Block } from '../src/worker/segmenter';
import type { ChangeEffect } from '../src/worker/doc';
import { commonEnds } from '../src/app/previewEdit';
import { IS_MAC } from '../src/shared/keys';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };

class FakeResizeObserver {
  constructor(public cb: unknown) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});

interface ReplaceCall { startLine: number; lineCount: number; text: string }

/** CodeMirror + worker stand-in. */
class Sim {
  lines: string[];
  blocks: Block[] = [];
  version = 0;
  nextId = 1;
  requested = new Set<number>();
  dirty = new Set<number>();
  replaces: ReplaceCall[] = [];
  bus = createBus();
  toasts: ToastSpec[] = [];
  sessions: Array<AppEvents['previewEdit:session']> = [];
  pv: PreviewApi;
  source: PreviewSourceAccess;

  /** Undo / redo snapshots of `lines` (one step per write) — see enableHistory(). */
  undoStack: string[][] = [];
  redoStack: string[][] = [];
  historyCalls: boolean[] = [];
  /** r3-ia: the worker's structure for a write arrives only when the test calls resegment() itself. */
  deferStructure = false;
  /** Harness repair (fix-session-c, round 4): changing writes made while the structure is deferred. The worker's
   *  structure carries the document version of the LAST transaction it applied (core.ts flushEdits), one version per
   *  transaction, so a structure that answers two deferred writes is two versions further, not one. */
  unsent = 0;

  constructor(text: string, withSource = true) {
    this.lines = text.split('\n');
    this.source = {
      read: (start, count) => this.lines.slice(start - 1, start - 1 + count).join('\n'),
      replace: (start, count, t) => {
        this.replaces.push({ startLine: start, lineCount: count, text: t });
        if (this.lines.slice(start - 1, start - 1 + count).join('\n') !== t) {
          this.undoStack.push(this.lines.slice());
          this.redoStack = [];
        }
        if (this.deferStructure && this.lines.slice(start - 1, start - 1 + count).join('\n') !== t) this.unsent++;
        this.lines.splice(start - 1, count, ...t.split('\n'));
        if (!this.deferStructure) this.resegment();
      },
    };
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    this.bus.on('toast', (t) => { this.toasts.push(t); });
    this.bus.on('previewEdit:session', (e) => { this.sessions.push(e); });
    this.pv = createPreview({
      parent, bus: this.bus,
      request: (ids) => { for (const id of ids) this.requested.add(id); },
      viewport: () => {},
      resync: () => {},
      source: withSource ? this.source : undefined,
    });
    Object.defineProperty(this.pv.el, 'clientHeight', { value: 4000, configurable: true });
    this.resegment();
  }

  /** Worker: re-segment the whole text, keep ids by the identity rule, send a full structure. */
  resegment(): void {
    const segs = segmentAll(this.lines);
    const { N, dirty } = identify(this.lines, this.blocks, segs, () => this.nextId++);
    this.blocks = N;
    for (const id of dirty) this.dirty.add(id);
    this.version += Math.max(1, this.unsent);
    this.unsent = 0;
    const arr = new Int32Array(N.length * BLOCK_STRIDE);
    N.forEach((b, i) => {
      arr[i * BLOCK_STRIDE + B_ID] = b.id;
      arr[i * BLOCK_STRIDE + B_START] = b.startLine;
      arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount;
      arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    });
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: this.lines.length, readingMinutes: 0 };
    const m: StructureMsg = { type: 'structure', version: this.version, blocks: arr, changed: Int32Array.from(dirty), lineCount: this.lines.length, stats, outlineVersion: 1 };
    this.pv.applyStructure(m);
  }

  /** Worker: push HTML for requested and dirty blocks, then let the mount queue run. */
  pump(frames = 3): void {
    for (let f = 0; f < frames; f++) {
      const ids = new Set([...this.requested, ...this.dirty]);
      this.requested.clear();
      this.dirty.clear();
      const items: HtmlItem[] = [];
      for (const b of this.blocks) {
        if (!ids.has(b.id)) continue;
        const r = mdk.renderBlock(blockSource(this.lines, b), { references: {} });
        items.push({ id: b.id, flags: r.flags, payload: r.html });
      }
      if (items.length > 0) this.pv.applyHtml({ type: 'html', version: this.version, batch: packHtml(items).batch });
      frame();
    }
  }

  text(): string { return this.lines.join('\n'); }
  block(i: number): HTMLElement { return this.pv.el.querySelectorAll<HTMLElement>('section.md-block')[i]; }
  editing(): HTMLElement | null { return this.pv.el.querySelector<HTMLElement>('.is-editing'); }

  /** CodeMirror's history stand-in (PreviewSourceAccess.history, decision U1): one step per write; the caret
   *  lands where the step's change begins. `sync: false` = the worker's structure for the step arrives
   *  only when the test calls resegment() itself. */
  enableHistory(sync = true): void {
    this.source.history = (redo) => {
      this.historyCalls.push(redo);
      const from = redo ? this.redoStack : this.undoStack;
      const to = redo ? this.undoStack : this.redoStack;
      const next = from.pop();
      if (!next) return null;
      to.push(this.lines.slice());
      const before = this.text();
      this.lines = next;
      const after = this.text();
      let k = 0;
      while (k < before.length && k < after.length && before[k] === after[k]) k++;
      const head = after.slice(0, k).split('\n');
      if (sync) this.resegment();
      return { line: head.length, col: head[head.length - 1].length };
    };
  }
}

// ---------------------------------------------------------------- Chrome editing stand-in
/**
 * jsdom has no `document.execCommand`. This stand-in models the parts of Chrome's editing commands the
 * session uses, including two Chrome behaviours behind findings: `insertText` with '\n' inside a code block
 * loses the newlines (finding high 2), and `insertHTML` copies the surrounding computed style onto the
 * inserted element (finding high 3). Every mutating command fires `input` on the editing host, as Chrome does.
 */
const NBSP_CHAR = String.fromCharCode(0xa0);
/** Collapsible whitespace at the start of a text (what Chrome turns into one NBSP at a new line start). */
const LEADING_WS = /^[ \t\n]+/;
function installFakeExec(): { calls: string[] } {
  const calls: string[] = [];
  const doc = document;
  const editHost = (n: Node): Element | null => (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('[contenteditable="true"]') ?? null;
  const caretAt = (node: Node, offset: number): void => {
    const r = doc.createRange(); r.setStart(node, offset); r.collapse(true);
    const sel = doc.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
  };
  const caretAfter = (n: Node): void => {
    if (n.nodeType === 3) caretAt(n, (n as Text).data.length);
    else { const r = doc.createRange(); r.setStartAfter(n); r.collapse(true); const sel = doc.getSelection()!; sel.removeAllRanges(); sel.addRange(r); }
  };
  const blockOf = (n: Node, ed: Element): Element | null => {
    const b = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('p, li, h1, h2, h3, h4, h5, h6') ?? null;
    return b && ed.contains(b) ? b : null;
  };
  /** Chrome types next to a link, never inside it, when the caret sits on the link's edge. */
  const outOfLinkEdge = (range: Range): void => {
    const n = range.startContainer;
    const a = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('a');
    if (!a) return;
    const before = doc.createRange(); before.setStart(a, 0); before.setEnd(n, range.startOffset);
    const after = doc.createRange(); after.setStart(n, range.startOffset); after.setEnd(a, a.childNodes.length);
    if (after.toString() === '') { range.setStartAfter(a); range.collapse(true); }
    else if (before.toString() === '') { range.setStartBefore(a); range.collapse(true); }
  };
  const insertText = (range: Range, text: string): void => {
    if (!range.collapsed) range.deleteContents();
    outOfLinkEdge(range);
    const n = range.startContainer;
    if (n.nodeType === 3) {
      (n as Text).insertData(range.startOffset, text);
      caretAt(n, range.startOffset + text.length);
      return;
    }
    const at = n.childNodes[range.startOffset] ?? null;
    if (at && at.nodeType === 1 && (at as Element).tagName === 'BR' && n.childNodes.length === 1) at.remove();
    const t = doc.createTextNode(text);
    n.insertBefore(t, n.childNodes[range.startOffset] ?? null);
    caretAt(t, text.length);
  };
  const exec = (cmd: string, _ui?: boolean, value?: string): boolean => {
    calls.push(value === undefined ? cmd : `${cmd}:${value}`);
    if (cmd === 'defaultParagraphSeparator') return true;
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0).cloneRange();
    const ed = editHost(range.startContainer);
    if (!ed) return false;
    const inPre = !!(range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement)?.closest('pre');
    switch (cmd) {
      case 'insertText': insertText(range, inPre ? (value ?? '').replace(/\n/g, '') : value ?? ''); break;
      case 'insertLineBreak': {
        if (!range.collapsed) range.deleteContents();
        if (inPre) insertText(range, '\n');
        else {
          const br = doc.createElement('br'); range.insertNode(br);
          // Chrome: collapsible whitespace that would start the new line shows as ONE non-breaking space
          const next = br.nextSibling;
          if (next && next.nodeType === 3) (next as Text).data = (next as Text).data.replace(LEADING_WS, NBSP_CHAR);
          caretAfter(br);
        }
        break;
      }
      case 'insertParagraph': {
        if (!range.collapsed) range.deleteContents();
        const b = blockOf(range.startContainer, ed);
        if (!b) return false;
        const tail = doc.createRange(); tail.setStart(range.startContainer, range.startOffset); tail.setEnd(b, b.childNodes.length);
        const frag = tail.extractContents();
        const nb = doc.createElement(b.tagName.toLowerCase());
        nb.appendChild(frag);
        // Chrome (InsertParagraphSeparatorCommand): the collapsible whitespace a split puts at the start of the new
        // paragraph is deleted and ONE non-breaking space inserted for it, when text follows (U13)
        const lead = doc.createTreeWalker(nb, 4).nextNode() as Text | null;
        if (lead && LEADING_WS.test(lead.data) && /\S/.test(nb.textContent ?? '')) lead.data = lead.data.replace(LEADING_WS, NBSP_CHAR);
        for (const e of [b, nb]) if ((e.textContent ?? '') === '' && !e.querySelector('br')) e.appendChild(doc.createElement('br'));
        b.after(nb);
        const first = doc.createTreeWalker(nb, 4).nextNode();
        caretAt(first ?? nb, 0);
        break;
      }
      case 'delete': {
        if (!range.collapsed) { range.deleteContents(); caretAt(range.startContainer, range.startOffset); break; }
        const n = range.startContainer;
        const off = range.startOffset;           // (a live range moves with the deletion)
        if (n.nodeType === 3 && off > 0) { (n as Text).deleteData(off - 1, 1); caretAt(n, off - 1); break; }
        const b = blockOf(n, ed);
        const prev = b?.previousElementSibling;
        if (!b || !prev || !/^(P|LI|H[1-6])$/.test(prev.tagName)) return false;
        const join = prev.childNodes.length;
        for (const br of Array.from(prev.querySelectorAll(':scope > br'))) br.remove();
        while (b.firstChild) prev.appendChild(b.firstChild);
        b.remove();
        caretAt(prev, Math.min(join, prev.childNodes.length));
        break;
      }
      case 'forwardDelete': {
        const n = range.startContainer;
        if (!range.collapsed) range.deleteContents();
        else if (n.nodeType === 3 && range.startOffset < (n as Text).data.length) (n as Text).deleteData(range.startOffset, 1);
        else return false;
        caretAt(range.startContainer, range.startOffset);
        break;
      }
      case 'insertHTML': {
        const t = doc.createElement('template');
        t.innerHTML = value ?? '';
        // Chrome keeps the inserted markup looking like its context: the computed background is baked in.
        for (const e of Array.from(t.content.children)) e.setAttribute('style', 'background-color: rgb(250, 248, 244);');
        const last = t.content.lastChild;
        if (!range.collapsed) range.deleteContents();
        range.insertNode(t.content);
        if (last) caretAfter(last);
        break;
      }
      case 'createLink': {
        if (range.collapsed) return false;
        const a = doc.createElement('a');
        a.setAttribute('href', value ?? '');
        a.appendChild(range.extractContents());
        range.insertNode(a);
        const r = doc.createRange(); r.selectNodeContents(a);
        sel.removeAllRanges(); sel.addRange(r);
        break;
      }
      case 'bold': case 'italic': {
        if (range.collapsed) return false;
        const e = doc.createElement(cmd === 'bold' ? 'b' : 'i');
        e.appendChild(range.extractContents());
        range.insertNode(e);
        caretAfter(e);
        break;
      }
      default: return false;
    }
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: cmd, data: value ?? null }));
    return true;
  };
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true });
  return { calls };
}
afterEach(() => { delete (document as { execCommand?: unknown }).execCommand; });

/** Where the browser would deliver a key now: the resume capture element while it holds the focus, else
 *  the block being edited (jsdom does not focus contenteditable hosts). */
function keyTarget(sim: Sim): Element {
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement && sim.pv.el.contains(a)) return a;
  return sim.editing() ?? document.body;
}
/** A key as the browser delivers it: keydown to the focused element, then — unless prevented — its default
 *  editing action through the editing stand-in (typing, Backspace, Delete). */
function press(sim: Sim, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const target = keyTarget(sim);
  const e = key(target, k, init);
  if (!e.defaultPrevented && !init.ctrlKey && !init.metaKey) {
    const editing = target.closest('[contenteditable="true"]');
    if (editing && k.length === 1) document.execCommand('insertText', false, k);
    else if (editing && k === 'Backspace') document.execCommand('delete');
    else if (editing && k === 'Delete') document.execCommand('forwardDelete');
    else if (target instanceof HTMLTextAreaElement && k.length === 1) target.value += k;
  }
  return e;
}
/** Text committed by an IME (or any input method) without a keydown: what CDP Input.insertText does. */
function commitText(sim: Sim, text: string): void {
  const target = keyTarget(sim);
  const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text });
  target.dispatchEvent(e);
  if (e.defaultPrevented) return;
  if (target.closest('[contenteditable="true"]')) document.execCommand('insertText', false, text);
  else if (target instanceof HTMLTextAreaElement) target.value += text;
}
function pasteInto(target: Element, text: string): ClipboardEvent {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
  target.dispatchEvent(e);
  return e;
}
/** Caret right after the first occurrence of `needle` in a text node of `el`. */
function caretAfterText(el: Element, needle: string, before = false): void {
  const w = document.createTreeWalker(el, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = (n as Text).data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, before ? i : i + needle.length);
    r.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    return;
  }
  throw new Error(`"${needle}" not in block`);
}
const caretOffset = (el: Element): number => { const s = document.getSelection()!; return textOffsetOf(el, s.focusNode!, s.focusOffset); };

/** A primary click on `target`: press, release, click (U7: a session starts when the button is released). */
function mousedown(target: Element, init: MouseEventInit = {}): void {
  const o = { bubbles: true, cancelable: true, button: 0, ...init };
  target.dispatchEvent(new MouseEvent('mousedown', o));
  target.dispatchEvent(new MouseEvent('mouseup', o));
  target.dispatchEvent(new MouseEvent('click', o));
}
function input(target: Element, init: InputEventInit = {}): void {
  target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', ...init }));
}
function key(target: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}
/** Simulates typing at the end of `el`'s last text node. */
function typeAtEnd(el: Element, s: string): void {
  const walker = document.createTreeWalker(el, 4);
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.trim() !== '') last = n as Text;
  last!.data += s;
  setCaretAtOffset(el, Number.MAX_SAFE_INTEGER);
  input(el);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => { for (const x of live.splice(0)) x.pv.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

/** Every preview made by a test, disposed afterwards (their window listeners must not see later tests' keys). */
const live: Sim[] = [];
function setup(text: string, withSource = true): Sim {
  const sim = new Sim(text, withSource);
  live.push(sim);
  sim.pv.setPreviewEditable(true);
  frame();
  sim.pump();
  return sim;
}


/** Empties the paragraph of block `i` (its deletion is written in the next frame: the session's element is gone). */
function emptyPara(sim: Sim, i: number): HTMLElement {
  const w = sim.block(i);
  mousedown(w.querySelector('p, h1, h2, li')!);
  for (const e of Array.from(w.querySelectorAll('p, h1, h2'))) e.textContent = '';
  input(w, { inputType: 'deleteContentBackward' });
  frame();
  const p = w.querySelector('p, h1, h2') ?? w;
  const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
  return w;
}

// ---------------------------------------------------------------- r4-ic additions to the harness
const ctrlKey = (k: string, shift = false): KeyboardEventInit => ({ ctrlKey: true, shiftKey: shift, code: `Key${k.toUpperCase()}` });

/** The worker's WINDOWED re-segmentation (core.ts flushEdits → resegmentWindow): blocks after the first boundary that
 *  matches a shifted old one keep their ids, as the real worker keeps them (the Sim's resegment() re-identifies the
 *  whole document). `sync`: the structure goes out inside replace; else the test calls flushWindowed(). */
function useWindowedWorker(sim: Sim, sync = true): { flush(): void } {
  let pending: ChangeEffect | null = null;
  const send = (): void => {
    const e = pending;
    pending = null;
    if (!e) return;
    const r = resegmentWindow(sim.blocks, sim.lines, e, () => sim.nextId++);
    sim.blocks = r.blocks;
    for (const id of r.dirty) sim.dirty.add(id);
    sim.version++;
    const N = sim.blocks;
    const arr = new Int32Array(N.length * BLOCK_STRIDE);
    N.forEach((b, i) => {
      arr[i * BLOCK_STRIDE + B_ID] = b.id;
      arr[i * BLOCK_STRIDE + B_START] = b.startLine;
      arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount;
      arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    });
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: sim.lines.length, readingMinutes: 0 };
    sim.pv.applyStructure({ type: 'structure', version: sim.version, blocks: arr, changed: Int32Array.from(r.dirty), lineCount: sim.lines.length, stats, outlineVersion: 1 });
  };
  sim.source.replace = (start, count, t) => {
    sim.replaces.push({ startLine: start, lineCount: count, text: t });
    const newCount = t.split('\n').length;
    sim.lines.splice(start - 1, count, ...t.split('\n'));
    pending = { fromLine: start, toLineOld: start + count - 1, toLineNew: start + newCount - 1, lineDelta: newCount - count };
    if (sync) send();
  };
  return { flush: send };
}

/** CodeMirror's history as previewEdit.ts drives it: one step per write; the write changes only what differs
 *  (commonEnds over the replaced lines), and a step's caret is the END of the range it changed (for an undone
 *  deletion: after the restored text; for a redone one: where the text was). `sync: false`: the step's structure
 *  arrives only when the test calls sim.resegment(). */
function useEditorHistory(sim: Sim, sync = true): void {
  interface Step { before: string; after: string; from: number; toOld: number; toNew: number }
  const undo: Step[] = [];
  const redo: Step[] = [];
  const replace = sim.source.replace.bind(sim.source);
  sim.source.replace = (start, count, t) => {
    const before = sim.text();
    const lines = sim.lines;
    const from = lines.slice(0, start - 1).reduce((n, l) => n + l.length + 1, 0);
    const old = lines.slice(start - 1, start - 1 + count).join('\n');
    if (old !== t) {
      const [pre, suf] = commonEnds(old, t);
      undo.push({ before, after: '', from: from + pre, toOld: from + old.length - suf, toNew: from + t.length - suf });
      redo.length = 0;
    }
    replace(start, count, t);
    if (old !== t) undo[undo.length - 1].after = sim.text();
  };
  const caretOf = (text: string, at: number): { line: number; col: number } => {
    const head = text.slice(0, at).split('\n');
    return { line: head.length, col: head[head.length - 1].length };
  };
  sim.source.history = (isRedo) => {
    sim.historyCalls.push(isRedo);
    const st = (isRedo ? redo : undo).pop();
    if (!st) return null;
    (isRedo ? undo : redo).push(st);
    const text = isRedo ? st.after : st.before;
    sim.lines = text.split('\n');
    if (sync) sim.resegment();
    return caretOf(text, isRedo ? st.toNew : st.toOld);
  };
}


// ---------------------------------------------------------------- r4-id additions to the harness
/** P-B amended: the source carries a document version, as App's createSourceAccess gives the editor's: +1 per changing
 *  write, history step and editor-pane change; every structure carries the version of the source it describes.
 *  `sim.deferStructure = true` is the slow worker: the structure (and HTML) for the changes so far arrives only at
 *  deliver(). `refuseNext()`: the next write is refused as createSourceAccess refuses a stale range (no change, no
 *  version). */
function useVersionedSource(sim: Sim): { version(): number; deliver(): void; editorChange(fn: (lines: string[]) => void): void; refuseNext(): void } {
  let dv = sim.version;
  let refuse = false;
  // Harness extension (fix-session-f, CONTRACT §11 Checkpoint-D decisions: PreviewSourceAccess.lineNow): the document
  // of every version is kept, and a line is mapped between consecutive versions by their common first and last lines
  // (a line inside the run that changed is gone) — coarser than the editor's ring, never another line.
  const docs = new Map<number, string[]>([[dv, sim.lines.slice()]]);
  const snap = (): void => { docs.set(dv, sim.lines.slice()); };
  const reseg = sim.resegment.bind(sim);
  sim.resegment = () => { sim.unsent = 0; sim.version = dv - 1; reseg(); };
  const replace = sim.source.replace.bind(sim.source);
  sim.source.replace = (start, count, t) => {
    if (refuse) { refuse = false; return; }
    const changes = sim.lines.slice(start - 1, start - 1 + count).join('\n') !== t;
    if (changes) dv++;
    replace(start, count, t);
    if (changes) snap();
  };
  const wrapHistory = (): void => {
    const h = sim.source.history;
    if (!h || (h as { r4id?: boolean }).r4id) return;
    const wrapped = (redo: boolean): { line: number; col: number } | null => {
      const before = sim.text();
      dv++;
      const at = h(redo);
      if (!at || sim.text() === before) dv--;
      else snap();
      return at;
    };
    (wrapped as { r4id?: boolean }).r4id = true;
    sim.source.history = wrapped;
  };
  wrapHistory();
  sim.source.version = () => dv;
  sim.source.lineNow = (line, v) => {
    if (v > dv || !docs.has(v)) return undefined;
    let n = line;
    for (let k = v; k < dv; k++) {
      const a = docs.get(k), b = docs.get(k + 1);
      if (!a || !b) return undefined;
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      let q = 0;
      while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
      if (n <= p) continue;
      if (n > a.length - q) { n += b.length - a.length; continue; }
      return null;
    }
    return n;
  };
  return {
    version: () => dv,
    deliver() { sim.deferStructure = false; sim.resegment(); sim.pump(); frame(); },
    editorChange(fn) { dv++; fn(sim.lines); snap(); if (!sim.deferStructure) sim.resegment(); },
    refuseNext() { refuse = true; },
  };
}
/** A click right after `needle` in block `i` as the (possibly old) preview shows it: the press, the browser's caret
 *  there (as Chrome puts it at the press), the release, the click. */
function clickAt(sim: Sim, i: number, needle: string): HTMLElement {
  const w = sim.block(i);
  caretAfterText(w, needle);
  const t = document.getSelection()!.focusNode!.parentElement!;
  const o = { bubbles: true, cancelable: true, button: 0 };
  t.dispatchEvent(new MouseEvent('mousedown', o));
  caretAfterText(w, needle);
  t.dispatchEvent(new MouseEvent('mouseup', o));
  t.dispatchEvent(new MouseEvent('click', o));
  return w;
}

describe('r4-id P-B amended (CHA-5): current = the structure\'s version is at least the source\'s', () => {
  it('Enter, Esc, a click 1.2 s later on the block below while the structure is 1.8 s late: Z at the click, no other line changes', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const a = sim.block(0);
    mousedown(a.querySelector('p')!);
    expect(sim.editing()).toBe(a);
    caretAfterText(a, 'Alpha');
    sim.deferStructure = true;
    press(sim, 'Enter');
    frame();
    expect(sim.text()).toBe('Alpha\n\nbeta\n\nGamma delta\n\nOmega words\n');
    press(sim, 'Escape');
    vi.advanceTimersByTime(1200);
    clickAt(sim, 2, 'O');                        // "Omega" as the old preview shows it
    press(sim, 'Z');
    expect(sim.text()).toBe('Alpha\n\nbeta\n\nGamma delta\n\nOmega words\n');
    vi.advanceTimersByTime(600);
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.editing()?.textContent).toContain('OZmega');
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha\n\nbeta\n\nGamma delta\n\nOZmega words\n');
  });

  it('a change in the editor pane just before the click (structure 1.8 s late): the click waits, Z at the click', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    expect(sim.editing()).toBe(null);            // the structure does not describe the source yet
    press(sim, 'Z');
    vi.advanceTimersByTime(1800);
    expect(sim.text()).toBe('New line\n\nAlpha beta\n\nGamma delta\n\nOmega words\n');
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('New line\n\nAlpha beta\n\nGamma delta\n\nOZmega words\n');
  });

  it('a line removed in the editor pane above the clicked block, structure 1.8 s late', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(2, 2));
    clickAt(sim, 2, 'O');
    press(sim, 'Z');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha beta\n\nOZmega words\n');
  });

  it('a merge (Backspace at a paragraph start) whose structure is 1.8 s late: the keys go to the join', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const g = sim.block(1);
    mousedown(g.querySelector('p')!);
    const p = g.querySelector('p')!;
    const r = document.createRange(); r.setStart(p.firstChild!, 0); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    sim.deferStructure = true;
    press(sim, 'Backspace');
    expect(sim.text()).toBe('Alpha betaGamma delta\n\nOmega words\n');
    press(sim, 'Q');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha betaQGamma delta\n\nOmega words\n');
  });

  it('⌘Z whose structure is 1.8 s late: the history resume waits, the key goes to the step\'s position', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    useEditorHistory(sim, false);
    const vs = useVersionedSource(sim);
    const g = sim.block(1);
    mousedown(g.querySelector('p')!);
    caretAfterText(g, 'Gamma');
    press(sim, 'X'); press(sim, 'Y');
    frame();
    expect(sim.text()).toBe('Alpha beta\n\nGammaXY delta\n\nOmega words\n');
    sim.deferStructure = true;
    press(sim, 'z', ctrlKey('z'));
    expect(sim.text()).toBe('Alpha beta\n\nGamma delta\n\nOmega words\n');
    press(sim, 'Q');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha beta\n\nGammaQ delta\n\nOmega words\n');
  });

  it('a split (Enter) whose structure is 1.8 s late: the keys typed meanwhile go into the new paragraph', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const a = sim.block(0);
    mousedown(a.querySelector('p')!);
    caretAfterText(a, 'Alpha');
    sim.deferStructure = true;
    press(sim, 'Enter');
    frame();
    expect(sim.text()).toBe('Alpha\n\nbeta\n\nOmega words\n');
    press(sim, 'Q');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha\n\nQbeta\n\nOmega words\n');
  });

  it('text typed into an emptied element, its structure 1.8 s late: written at the place, the session continues there', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\n乙段落文字。\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    emptyPara(sim, 1);
    expect(sim.text()).toBe('Alpha beta\n\nOmega words\n');
    press(sim, 'Q');
    frame();
    press(sim, 'R');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha beta\n\nQR\n\nOmega words\n');
  });

  it('Backspace in an emptied element whose deletion\'s structure is 1.8 s late: the session on the block before waits, keys kept', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\n乙段落文字。\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    emptyPara(sim, 1);
    press(sim, 'Backspace');
    press(sim, 'Z');
    vi.advanceTimersByTime(1800);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha betaZ\n\nOmega words\n');
  });

  it('a write the source refused changes no version: a click right after it starts its session at once', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const a = sim.block(0);
    mousedown(a.querySelector('p')!);
    caretAfterText(a, 'Alpha');
    vs.refuseNext();
    press(sim, 'X');
    frame();
    expect(sim.text()).toBe('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const o = clickAt(sim, 2, 'O');
    expect(sim.editing()).toBe(o);               // nothing waits for the refused write
  });

  it('a structure later than every bound: no session starts and nothing is written', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    press(sim, 'Z');
    vi.advanceTimersByTime(2500 * 4 + 200);
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.editing()).toBe(null);
    expect(sim.text()).toBe('New line\n\nAlpha beta\n\nGamma delta\n\nOmega words\n');
  });
});

describe('r4-id P-F amended / P-G (CHA-2): a wait never takes the focus back; nothing typed disappears silently', () => {
  const dropped = (sim: Sim): number => sim.toasts.filter((t) => t.text === INPUT_DROPPED_TEXT).length;

  it('the focus arriving in another control abandons a waiting click: no session starts later, the focus stays, one toast', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const other = document.createElement('input');
    document.body.appendChild(other);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    press(sim, 'Z');                             // queued for the waiting click
    other.focus();                               // the user turns to another control
    expect(dropped(sim)).toBe(1);
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.editing()).toBe(null);
    expect(document.activeElement).toBe(other);
    expect(sim.text()).toBe('New line\n\nAlpha beta\n\nGamma delta\n\nOmega words\n');
  });

  it('a press outside the preview abandons a waiting click (nothing queued: no toast)', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.editing()).toBe(null);
    expect(dropped(sim)).toBe(0);
  });

  it('a wait that expires with typed text tells the user once', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    press(sim, 'Z'); press(sim, 'W');
    vi.advanceTimersByTime(2500 * 4 + 200);
    expect(dropped(sim)).toBe(1);
    expect(sim.editing()).toBe(null);
  });

  it('a wait that expires with only caret keys queued says nothing', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    press(sim, 'ArrowRight'); press(sim, 'End');
    vi.advanceTimersByTime(2500 * 4 + 200);
    expect(dropped(sim)).toBe(0);
    expect(sim.editing()).toBe(null);
  });

  it('a second click while the first waits: the first click\'s keys are discarded with one toast, the second\'s are written', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 1, 'G');
    press(sim, 'Z');
    clickAt(sim, 2, 'O');
    press(sim, 'W');
    expect(dropped(sim)).toBe(1);
    vs.deliver();
    sim.pump();
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('New line\n\nAlpha beta\n\nGamma delta\n\nOWmega words\n');
    expect(dropped(sim)).toBe(1);
  });
});

describe('r4-id U16 amended (CHA-1): a waiting checkbox click ticks the task the user clicked, or nothing with a toast', () => {
  /** A real hit on a checkbox (U24: the press on it, the click inside its box). */
  function hit(box: HTMLInputElement): MouseEvent {
    const o = { bubbles: true, cancelable: true, button: 0 };
    box.dispatchEvent(new MouseEvent('mousedown', o));
    box.dispatchEvent(new MouseEvent('mouseup', o));
    const c = new MouseEvent('click', o);
    box.dispatchEvent(c);
    return c;
  }
  const lineOf = (sim: Sim, text: string, k = 0): number => {
    let n = -1;
    for (let i = 0; i < sim.lines.length; i++) if (sim.lines[i] === text && n++ === k - 1) return i + 1;
    return -1;
  };

  it('three tasks with the same text, a re-render between the click and the replay: the clicked one is ticked', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] a\n- [ ] a\n- [ ] a\n\nend\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    const list = sim.block(1);
    mousedown(list.querySelector('li')!);
    caretAfterText(list, 'a');
    sim.deferStructure = true;
    press(sim, 'X');
    frame();
    expect(sim.text()).toBe('intro\n\n- [ ] aX\n- [ ] a\n- [ ] a\n\nend\n');
    press(sim, 'Escape');
    const box = sim.block(1).querySelectorAll('input')[2] as HTMLInputElement;
    expect(hit(box).defaultPrevented).toBe(true);   // the block does not show its current source: the click waits
    expect(toggles).toEqual([]);
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.block(1).querySelectorAll('input')[2]).not.toBe(box);   // re-rendered
    expect(toggles).toEqual([5]);
  });

  it('a task line inserted above the clicked one by the session\'s own write: the clicked task is ticked', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] one\n- [ ] two\n- [ ] three\n\nend\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    const list = sim.block(1);
    mousedown(list.querySelector('li')!);
    caretAfterText(list, 'one');
    sim.deferStructure = true;
    press(sim, 'Enter');
    press(sim, 'N');
    frame();
    expect(sim.text()).toBe('intro\n\n- [ ] one\n- [ ] N\n- [ ] two\n- [ ] three\n\nend\n');
    press(sim, 'Escape');
    const boxes = Array.from(sim.block(1).querySelectorAll('input')) as HTMLInputElement[];
    const two = boxes.find((b) => (b.closest('li')?.textContent ?? '').trim() === 'two')!;
    hit(two);
    vs.deliver();
    sim.pump();
    frame();
    expect(toggles).toEqual([lineOf(sim, '- [ ] two')]);
    expect(toggles).toEqual([5]);
  });

  it('the clicked task\'s text changed meanwhile (editor pane): nothing is ticked and a toast says so', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] one\n- [ ] two\n- [ ] three\n\nend\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    sim.deferStructure = true;
    vs.editorChange((lines) => { lines[3] = '- [ ] deux'; });
    const box = sim.block(1).querySelectorAll('input')[1] as HTMLInputElement;
    hit(box);
    vs.deliver();
    sim.pump();
    frame();
    expect(toggles).toEqual([]);
    expect(sim.toasts.filter((t) => t.text === TASK_NOT_TICKED_TEXT).length).toBe(1);
  });

  it('a line inserted above the list in the editor pane just before the click: the clicked task, not its neighbour', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] a\n- [ ] b\n- [ ] c\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(1, 0, ''));
    // U16 as amended a second time (Checkpoint-D decisions): the tick does not wait — the line its box stands for is
    // mapped through the change (lineNow) and toggled at once (was: waited for the structure, then ticked 5)
    expect(hit(sim.block(1).querySelectorAll('input')[1] as HTMLInputElement).defaultPrevented).toBe(false);
    expect(toggles).toEqual([5]);
    vs.deliver();
    sim.pump();
    frame();
    expect(toggles).toEqual([5]);
  });

  // fix-session-e B4 (CONTRACT §11, Checkpoint-C decisions, RVT-3): a block's task boxes are only each task item's own
  // checkbox (interactions ownTaskBox), so a document's checkbox in an item neither shifts the ordinal of the clicked
  // task nor is ever replayed onto one.
  it('B4: a raw checkbox added to another task item meanwhile does not shift the clicked task', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] x\n- [ ] x\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    sim.deferStructure = true;
    vs.editorChange((lines) => { lines[2] = '- [ ] x <input type="checkbox">'; });
    // U16 as amended a second time (Checkpoint-D decisions): applied at once, on the line mapped through the change
    // (was: waited for the structure, then ticked 4)
    hit(sim.block(1).querySelectorAll('input')[1] as HTMLInputElement);
    expect(toggles).toEqual([4]);
    vs.deliver();
    sim.pump();
    frame();
    expect(toggles).toEqual([4]);
    expect(sim.toasts.filter((t) => t.text === TASK_NOT_TICKED_TEXT).length).toBe(0);
  });

  it('B4: a raw checkbox inside a task item, clicked while its block waits: no task is ticked', () => {
    installFakeExec();
    const sim = setup('intro\n\n- [ ] victim <input type="checkbox">\n- [ ] b\n');
    const vs = useVersionedSource(sim);
    const toggles: number[] = [];
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    sim.deferStructure = true;
    vs.editorChange((lines) => { lines[0] = 'intro2'; });
    const raw = sim.block(1).querySelectorAll('input')[1] as HTMLInputElement;
    expect(raw.closest('li')?.textContent).toContain('victim');
    hit(raw);
    vs.deliver();
    sim.pump();
    frame();
    expect(toggles).toEqual([]);
    expect(sim.text()).toBe('intro2\n\n- [ ] victim <input type="checkbox">\n- [ ] b\n');
  });
});

describe('r4-id P-A (J2): no helper character leaves the session', () => {
  const ZW = String.fromCharCode(0x200b);
  const zws = (el: Element): number => (el.textContent ?? '').split('').filter((c) => c === ZW || c.charCodeAt(0) === 0xfeff).length;
  /** A session on the paragraph that starts with a formula (U21 puts a spacer before it) with an inline code opened by
   *  ⌘E (a placeholder inside it, a caret place after it). */
  function sessionWithHelpers(sim: Sim): { w: HTMLElement; own: number } {
    const w = sim.block(0);
    const own = zws(w);
    mousedown(w.querySelector('p')!);
    expect(sim.editing()).toBe(w);
    caretAfterText(w, 'starts');
    press(sim, 'e', ctrlKey('e'));               // ⌘E at a collapsed caret: an empty inline code
    expect(zws(w)).toBeGreaterThan(own + 1);    // the spacer, the code's placeholder, the place after it
    return { w, own };
  }
  const DOC = '$x^2$ starts here\n\nnext para\n';
  const paths: Array<[string, (sim: Sim, w: HTMLElement) => void]> = [
    ['Esc', (sim) => { press(sim, 'Escape'); }],
    ['a press in another block', (sim) => { mousedown(sim.block(1).querySelector('p')!); }],
    ['a drag out of the block', (sim, w) => {
      w.querySelector('p')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      sim.block(1).querySelector('p')!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, buttons: 1 }));
    }],
    ['endEditSession (App: save-as, mode switch, open)', (sim) => { sim.pv.endEditSession(); }],
    ['editing switched off', (sim) => { sim.pv.setPreviewEditable(false); }],
    ['a document replaced', (sim) => { sim.bus.emit('doc:loaded', { docId: 'x', name: 'x.md', path: null } as never); }],
    ['a split (Enter) that resumes on the new block', (sim, w) => { caretAfterText(w, 'here', true); press(sim, 'Enter'); frame(); sim.pump(); frame(); }],
  ];
  for (const [name, end] of paths) {
    it(`ends by ${name}: no helper character stays in the wrapper`, () => {
      installFakeExec();
      const sim = setup(DOC);
      const { w, own } = sessionWithHelpers(sim);
      const helpers: Text[] = [];
      const tw = document.createTreeWalker(w, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(ZW)) helpers.push(n as Text);
      end(sim, w);
      // the ended session's helpers are gone (a session the split resumed on has its own, made at its start)
      for (const t of helpers) expect(t.isConnected && t.data.includes(ZW)).toBe(false);
      if (sim.editing() !== w) expect(zws(w)).toBe(own);
      expect(sim.text().includes(ZW)).toBe(false);
    });
  }

  it('the serialization never holds one: typing next to the spacer and inside the opened code writes none', () => {
    installFakeExec();
    const sim = setup(DOC);
    sessionWithHelpers(sim);
    press(sim, 'Q');
    frame();
    sim.pv.endEditSession();
    expect(sim.text().includes(ZW)).toBe(false);
    expect(sim.text()).toBe('$x^2$ starts`Q` here\n\nnext para\n');
  });

  function copyEvent(type: 'copy' | 'cut'): ClipboardEvent {
    const e = new Event(type, { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(e, 'clipboardData', { value: { setData: () => {}, getData: () => '' } });
    return e;
  }
  const selText = (): string => document.getSelection()!.toString();
  it('a copy whose selection holds a helper: the browser serializes it without the helpers, which come back right after', () => {
    installFakeExec();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const own = zws(w);
    expect(own).toBeGreaterThan(0);              // the spacer before the formula
    const p = w.querySelector('p')!;
    const r = document.createRange(); r.selectNodeContents(p);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    const before = selText();
    expect(before.includes(ZW)).toBe(true);
    const e = copyEvent('copy');
    w.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);      // the browser's own copy …
    expect(selText().includes(ZW)).toBe(false);  // … of the selection without its helpers
    expect(selText()).toBe(before.split(ZW).join(''));
    vi.advanceTimersByTime(1);
    expect(zws(w)).toBe(own);                    // back right after
    expect(selText()).toBe(before);              // the same selection
    press(sim, 'Escape');
    expect(sim.text()).toBe(DOC);
  });

  it('the helpers come back before the next key even when no timer ran yet', () => {
    installFakeExec();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const own = zws(w);
    const r = document.createRange(); r.selectNodeContents(w.querySelector('p')!);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    w.dispatchEvent(copyEvent('copy'));
    expect(zws(w)).toBe(0);
    key(w, 'ArrowRight');
    expect(zws(w)).toBe(own);
  });

  it('a copy without a helper in its selection is left to the browser (nothing taken out)', () => {
    installFakeExec();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const own = zws(w);
    caretAfterText(w, 'here');
    const s0 = document.getSelection()!;
    const r2 = document.createRange(); r2.setStart(s0.focusNode!, s0.focusOffset - 4); r2.setEnd(s0.focusNode!, s0.focusOffset);
    s0.removeAllRanges(); s0.addRange(r2);
    const e = copyEvent('copy');
    w.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(zws(w)).toBe(own);
  });

  it('a drag of a selection that holds a helper: the browser\'s drag data without it', () => {
    installFakeExec();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const r = document.createRange(); r.selectNodeContents(w.querySelector('p')!);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    const data = new Map<string, string>([['text/plain', ZW + 'x2 starts here'], ['text/html', '<span>' + ZW + 'x</span> starts']]);
    const e = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', { value: { getData: (t: string) => data.get(t) ?? '', setData: (t: string, v: string) => { data.set(t, v); } } });
    w.dispatchEvent(e);
    expect(data.get('text/plain')).toBe('x2 starts here');
    expect(data.get('text/html')).toBe('<span>x</span> starts');
  });

  it('a cut over a helper: the browser cuts the selection without it; no helper reaches the source', () => {
    installFakeExec();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    const r = document.createRange(); r.selectNodeContents(p);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    w.dispatchEvent(copyEvent('cut'));
    expect(selText().includes(ZW)).toBe(false);
    document.execCommand('delete');              // the browser's cut deletes the selection
    vi.advanceTimersByTime(1);
    frame();
    sim.pv.endEditSession();
    expect(sim.text().includes(ZW)).toBe(false);
    expect(sim.text().includes('starts')).toBe(false);
  });
});

describe('r4-id P-A / J1: a paste over a selection leaves no placeholder; over a whole inline element it goes inside it', () => {
  const ZW = String.fromCharCode(0x200b);
  const DOC = 'Lead **bold words** tail and [link](https://e.x/y) end.\n\nnext para\n';
  /** Chrome: TYPING over a selection puts the text where the selection was — inside a link or bold whose whole text was
   *  selected (the measured typing of v4-sesb-pastesel: '[X](https://e.x/y)'); only a collapsed caret on a link's
   *  edge types next to the link. The stand-in's insertText is adjusted to that for these tests. */
  function chromeTypingOverSelection(): void {
    const exec = document.execCommand.bind(document);
    Object.defineProperty(document, 'execCommand', {
      configurable: true, writable: true,
      value: (cmd: string, ui?: boolean, value?: string): boolean => {
        const sel = document.getSelection();
        if (cmd === 'insertText' && sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
          const r = sel.getRangeAt(0);
          const n = r.startContainer;
          if (n.nodeType === 3) {
            r.deleteContents();
            const off = r.startOffset;
            (n as Text).insertData(off, value ?? '');
            const c = document.createRange(); c.setStart(n, off + (value ?? '').length); c.collapse(true);
            sel.removeAllRanges(); sel.addRange(c);
            const ed = (n.parentElement as Element).closest('[contenteditable="true"]')!;
            ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value ?? null }));
            return true;
          }
        }
        return exec(cmd, ui, value);
      },
    });
  }
  function selectText(el: Element, needle: string): void {
    const tw = document.createTreeWalker(el, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const i = (n as Text).data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
      return;
    }
    throw new Error(`"${needle}" not shown`);
  }
  function pasteOver(text: string, needle: string, sel0: (w: Element) => void = (w) => selectText(w, needle)): Sim {
    installFakeExec();
    chromeTypingOverSelection();
    const sim = setup(DOC);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    sel0(w);
    pasteInto(w, text);
    frame();
    expect(w.textContent!.includes(ZW)).toBe(false);   // no placeholder stays
    for (const e of Array.from(w.querySelectorAll('a, strong, em, code, del, s, b, i'))) expect((e.textContent ?? '').trim()).not.toBe('');
    sim.pv.endEditSession();
    return sim;
  }

  it('over a link\'s whole text: the text goes inside the link (as typing puts it), never [](url)', () => {
    const sim = pasteOver('X', 'link');
    expect(sim.text()).toBe('Lead **bold words** tail and [X](https://e.x/y) end.\n\nnext para\n');
  });
  it('two words over a link\'s whole text', () => {
    const sim = pasteOver('X Y', 'link');
    expect(sim.text()).toBe('Lead **bold words** tail and [X Y](https://e.x/y) end.\n\nnext para\n');
  });
  it('over a bold element\'s whole text: inside the bold', () => {
    const sim = pasteOver('X', 'bold words');
    expect(sim.text()).toBe('Lead **X** tail and [link](https://e.x/y) end.\n\nnext para\n');
  });
  it('two paragraphs over a link\'s whole text: no empty link is left in either paragraph', () => {
    const sim = pasteOver('X\n\nY', 'link');
    expect(sim.text().includes('[](')).toBe(false);
    expect(sim.text().includes(ZW)).toBe(false);
    expect(sim.text()).toContain('[X](https://e.x/y)');
  });
  it('over part of a word: unchanged (the text replaces the selection, nothing else moves)', () => {
    const sim = pasteOver('X', 'tai');
    expect(sim.text()).toBe('Lead **bold words** Xl and [link](https://e.x/y) end.\n\nnext para\n');
  });
});

describe('r4-id P-E (J5): a released block\'s selection end points come back on the same side of a line boundary', () => {
  /** The text from the selection's anchor to the end of its block's text, as a copy would start. */
  const fromAnchor = (): string => {
    const s = document.getSelection()!;
    const w = (s.anchorNode!.nodeType === 1 ? s.anchorNode as Element : s.anchorNode!.parentElement)!.closest('section.md-block')!;
    const r = document.createRange(); r.setStart(s.anchorNode!, s.anchorOffset); r.setEnd(w, w.childNodes.length);
    const f = r.cloneContents();
    for (const u of Array.from(f.querySelectorAll('.katex-mathml, [data-mdr-ui]'))) u.remove();
    return (f.textContent ?? '').replace(/\s+/g, ' ').trim();
  };
  function endSessionKeepingSelection(sim: Sim, anchor: [Node, number], focus: [Node, number]): void {
    document.getSelection()!.setBaseAndExtent(anchor[0], anchor[1], focus[0], focus[1]);
    sim.pv.endEditSession();
    sim.pump();
    frame();
  }
  const textNode = (el: Element, needle: string): Text => {
    const tw = document.createTreeWalker(el, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes(needle)) return n as Text;
    throw new Error(`"${needle}" not shown`);
  };

  it('an anchor at the start of the second item stays there (not at the end of the first item)', () => {
    installFakeExec();
    const sim = setup('- item one text\n- item two text\n\nafter para\n');
    const list = sim.block(0);
    mousedown(list.querySelectorAll('li')[1]);
    expect(sim.editing()).toBe(list);
    endSessionKeepingSelection(sim, [textNode(list, 'item two'), 0], [textNode(sim.block(1), 'after'), 3]);
    const s = document.getSelection()!;
    expect((s.anchorNode as Text).data).toContain('item two');
    expect(s.anchorOffset).toBe(0);
    expect(fromAnchor().startsWith('item two text')).toBe(true);
  });

  it('an anchor at the start of a table cell stays in that cell', () => {
    installFakeExec();
    const sim = setup('| col a | col b |\n| --- | --- |\n| cell one | cell two |\n\nafter para\n');
    const t = sim.block(0);
    mousedown(t.querySelectorAll('td')[1]);
    endSessionKeepingSelection(sim, [textNode(t, 'cell two'), 0], [textNode(sim.block(1), 'after'), 3]);
    const s = document.getSelection()!;
    expect((s.anchorNode as Text).data).toContain('cell two');
    expect(s.anchorOffset).toBe(0);
  });

  it('a focus at the start of the second quote paragraph stays there (backward from below)', () => {
    installFakeExec();
    const sim = setup('> Quote line one\n>\n> Second quote para here.\n\nafter para\n');
    const q = sim.block(0);
    mousedown(q.querySelectorAll('p')[1]);
    endSessionKeepingSelection(sim, [textNode(sim.block(1), 'after'), 3], [textNode(q, 'Second quote'), 0]);
    const s = document.getSelection()!;
    expect((s.focusNode as Text).data).toContain('Second quote');
    expect(s.focusOffset).toBe(0);
  });

  it('after an opened formula the anchor maps to the same characters of the re-rendered block', () => {
    installFakeExec();
    const sim = setup('Inline $x^2+y^2$ formula and more words.\n\nafter para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const m = w.querySelector('.md-math')!;
    m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));   // opens its TeX source
    expect(w.querySelector('.md-math-src')).not.toBe(null);
    const t = textNode(w, 'and more');
    endSessionKeepingSelection(sim, [t, t.data.indexOf('and more') + 1], [textNode(sim.block(1), 'after'), 3]);
    const s = document.getSelection()!;
    expect((s.anchorNode as Text).data).toContain('and more');
    expect(s.anchorOffset).toBe((s.anchorNode as Text).data.indexOf('and more') + 1);
    expect(fromAnchor().startsWith('nd more words.')).toBe(true);
  });
});

// fix-session-e B3 (CONTRACT §11, Switch-off audit decisions, OFFC-3): the capture element that holds the focus during
// a resume or a waiting click is in the DOM only while it does; releaseFocus takes it out on every path that ends the
// wait. (It used to stay in the preview's scroller for the life of the window.)
describe('fix-session-e B3 (OFFC-3): the capture element is in the DOM only during a wait', () => {
  const caps = (sim: Sim): number => sim.pv.el.querySelectorAll('textarea.mdr-preview__edit-capture').length;
  /** A split (Enter after "Alpha") whose structure is late: a resume waits, holding the focus in the capture element. */
  function splitWaits(sim: Sim): void {
    const a = sim.block(0);
    mousedown(a.querySelector('p')!);
    caretAfterText(a, 'Alpha');
    sim.deferStructure = true;
    press(sim, 'Enter');
    frame();
    expect(caps(sim)).toBe(1);
    expect((document.activeElement as Element | null)?.classList.contains('mdr-preview__edit-capture')).toBe(true);
  }
  /** A click on block `i` while the structure is behind the source (an editor-pane change): a waiting click. */
  function clickWaits(sim: Sim, vs: ReturnType<typeof useVersionedSource>): void {
    sim.deferStructure = true;
    vs.editorChange((lines) => lines.splice(0, 0, 'New line', ''));
    clickAt(sim, 2, 'O');
    expect(caps(sim)).toBe(1);
  }

  it('the wait succeeds: the session resumes and the capture element is gone', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    splitWaits(sim);
    press(sim, 'Q');
    vs.deliver();
    sim.pump();
    frame();
    expect(caps(sim)).toBe(0);
    expect(sim.editing()).not.toBe(null);
    expect(document.activeElement).toBe(sim.editing());
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha\n\nQbeta\n\nOmega words\n');
  });

  it('a waiting click succeeds: gone too', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    clickWaits(sim, vs);
    vs.deliver();
    sim.pump();
    frame();
    expect(sim.editing()).not.toBe(null);
    expect(caps(sim)).toBe(0);
  });

  it('the wait times out: gone', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    clickWaits(sim, vs);
    vi.advanceTimersByTime(2500 * 4 + 200);
    expect(sim.editing()).toBe(null);
    expect(caps(sim)).toBe(0);
  });

  it('the wait is cancelled (a press outside the preview): gone, and the focus is not moved by the removal', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const other = document.createElement('input');
    document.body.appendChild(other);
    clickWaits(sim, vs);
    other.focus();
    expect(caps(sim)).toBe(0);
    expect(document.activeElement).toBe(other);
  });

  it('the switch is turned off during the wait: gone', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nOmega words\n');
    useVersionedSource(sim);
    splitWaits(sim);
    sim.pv.setPreviewEditable(false);
    expect(caps(sim)).toBe(0);
  });

  it('the document is replaced during the wait: gone', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nGamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    clickWaits(sim, vs);
    sim.bus.emit('doc:loaded', { docId: 'x', name: 'x.md', path: null } as never);
    expect(caps(sim)).toBe(0);
  });

  it('the preview is disposed during the wait: gone', () => {
    installFakeExec();
    const sim = setup('Alpha beta\n\nOmega words\n');
    useVersionedSource(sim);
    splitWaits(sim);
    const el = sim.pv.el;
    sim.pv.dispose();
    live.splice(live.indexOf(sim), 1);
    expect(el.querySelectorAll('textarea').length).toBe(0);
  });

  it('three resumes in a row: the element comes back for each wait, holds the focus, and is gone after each', () => {
    installFakeExec();
    const sim = setup('Alpha beta gamma delta\n\nOmega words\n');
    const vs = useVersionedSource(sim);
    const a = sim.block(0);
    mousedown(a.querySelector('p')!);
    caretAfterText(a, 'Alpha');
    for (const k of ['1', '2', '3']) {
      sim.deferStructure = true;
      press(sim, 'Enter');
      frame();
      expect(caps(sim)).toBe(1);
      expect((document.activeElement as Element | null)?.classList.contains('mdr-preview__edit-capture')).toBe(true);
      press(sim, k);
      vs.deliver();
      sim.pump();
      frame();
      expect(caps(sim)).toBe(0);
      expect(sim.editing()).not.toBe(null);
    }
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Alpha\n\n1\n\n2\n\n3beta gamma delta\n\nOmega words\n');
  });
});

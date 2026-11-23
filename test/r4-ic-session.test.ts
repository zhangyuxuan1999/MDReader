// @vitest-environment jsdom
// test/r4-ic-session.test.ts — fix-session-c (round 4): regression tests for P-B (J3, J9), P-F (J8), P-C (J12, J30) and
// P-D (J6). The harness (Sim, the Chrome editing stand-in, press / mousedown helpers, emptyPara) is copied from
// test/r3-ia-session.test.ts lines 1-421 (itself from test/v3-ses-repro.test.ts / test/inlineEdit.test.ts); added below it:
// useWindowedWorker (the worker's windowed identity rule) and useEditorHistory (previewEdit.ts's history caret).
// In-preview editing sessions (CONTRACT §11) against the real preview, the real segmenter / identity rule
// and the real markdown-it renderer. A small simulator stands in for CodeMirror (`source`) and the worker:
// every `source.replace` is re-segmented with `identify` (same ids as the worker would keep) and pushed to
// the preview as a full `structure`; requested / changed blocks get their HTML on `pump()`.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { shortcutKeyEvent } from '../src/app/previewEdit';
import { createPreview } from '../src/preview/createPreview';
import { EDIT_HINT_TEXT, MAX_EDIT_CHARS, NOT_EDITABLE_TEXT, PASTE_TOO_LONG_TEXT, editCmdOf, setCaretAtOffset, textOffsetOf } from '../src/preview/inlineEdit';
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

const inMath = (): boolean => {
  const s = document.getSelection()!;
  const n = s.focusNode;
  return !!(n && (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('.md-math'));
};

describe('r4-ic P-B (J3): a resume starts only on a wrapper that shows the block\'s current source', () => {
  it('⌘Z ⇧⌘Z of an emptied block between two lists waits for the merged list; Q keeps the list below', () => {
    installFakeExec();
    const sim = setup('- aaa\n\n乙段落文字。\n\n- zzz\n');
    useEditorHistory(sim);
    emptyPara(sim, 1);
    sim.pump();
    expect(sim.text()).toBe('- aaa\n\n- zzz\n');
    press(sim, 'z', ctrlKey('z'));               // the deletion undone: 乙 is back, the session on it
    sim.pump();
    expect(sim.text()).toBe('- aaa\n\n乙段落文字。\n\n- zzz\n');
    expect(sim.editing()?.textContent?.trim()).toBe('乙段落文字。');
    // the redo (as CodeMirror steps it: the caret where the deleted text was, line 2): the source is the merged
    // list again, its structure has not arrived yet
    const lines = '- aaa\n\n- zzz\n'.split('\n');
    sim.source.history = () => { sim.historyCalls.push(true); sim.lines = lines.slice(); return { line: 2, col: 0 }; };
    press(sim, 'z', ctrlKey('z', true));
    frame();
    // the block at line 2 in the preview's (old) structure still shows "- aaa" alone: no session on it
    expect(sim.editing()).toBe(null);
    press(sim, 'Q');
    sim.resegment();
    sim.pump();
    frame();
    expect(sim.text()).toBe('- aaaQ\n\n- zzz\n');
  });

  it('a split whose second part equals the block below resumes on the new block, not on that neighbour (J9, the place rule)', () => {
    installFakeExec();
    const sim = setup('a\n\nxdup\n\ndup\n\nz\n');
    const worker = useWindowedWorker(sim, false);
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'x');
    press(sim, 'Enter');
    frame();
    expect(sim.text()).toBe('a\n\nx\n\ndup\n\ndup\n\nz\n');
    // before the worker's structure for the split: the old "dup" block at line 5 has the expected text, but the
    // structure does not describe the source — no session on it
    expect(sim.editing()).toBe(null);
    worker.flush();
    sim.pump();
    frame();
    const ed = sim.editing();
    expect(ed?.textContent?.trim()).toBe('dup');
    press(sim, 'Q'); press(sim, 'R');
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('a\n\nx\n\nQRdup\n\ndup\n\nz\n');
  });
});

describe('r4-ic P-F (J8): a click on a block whose re-render is on its way waits for it, keys kept', () => {
  it('Esc, click back while the re-render is slower than CLICK_WAIT_MS: the keys typed meanwhile are written', () => {
    installFakeExec();
    const sim = setup('Top para.\n\nMARKER words here.\n\nEnd para.\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    expect(sim.editing()).toBe(w);
    press(sim, 'Escape');
    expect(sim.editing()).toBe(null);
    // the wrapper waits for its re-render (U19: lost until it mounts); click into it again and type
    const p = sim.block(1).querySelector('p')!;
    const r = document.createRange(); r.setStart(p.firstChild!, 4); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    mousedown(p);
    press(sim, 'Q'); press(sim, 'R'); press(sim, 'S');
    vi.advanceTimersByTime(900);                 // the worker is slow: well past CLICK_WAIT_MS (300 ms)
    expect(sim.text()).toBe('Top para.\n\nMARKER words here.\n\nEnd para.\n');
    sim.pump();
    frame();
    expect(sim.editing()).toBe(sim.block(1));
    sim.pv.endEditSession();
    expect(sim.text()).toBe('Top para.\n\nMARKQRSER words here.\n\nEnd para.\n');
  });

  it('the wait ends with the bound of the history resume when nothing mounts (keys then dropped, as an expired resume)', () => {
    installFakeExec();
    const sim = setup('Top para.\n\nMARKER words here.\n\nEnd para.\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    press(sim, 'Escape');
    const p = sim.block(1).querySelector('p')!;
    mousedown(p);
    press(sim, 'Q');
    vi.advanceTimersByTime(2500 * 4 + 100);      // RESUME_MS, extended MOUNT_WAIT_EXTENSIONS times while pending
    sim.pump();
    frame();
    expect(sim.editing()).toBe(null);
    expect(sim.text()).toBe('Top para.\n\nMARKER words here.\n\nEnd para.\n');
  });
});

describe('r4-ic P-C (J12, J30): the place of an emptied element is a line of the source', () => {
  for (const [nm, above, below] of [['lists', '- aaa', '- zzz'], ['ordered', '1. aaa', '2. zzz'], ['indented code', '    aaa code', '    zzz code'], ['tasks', '- [ ] aaa', '- [ ] zzz']] as const) {
    it(`text typed into an emptied paragraph between two ${nm} that merge once it is gone goes between them`, () => {
      installFakeExec();
      const sim = setup(`${above}\n\n乙段落\n\n${below}\n`);
      emptyPara(sim, 1);
      sim.pump();
      expect(sim.text()).toBe(`${above}\n\n${below}\n`);
      press(sim, 'Q');
      frame();
      sim.pump();
      frame();
      expect(sim.text()).toBe(`${above}\n\nQ\n\n${below}\n`);
    });
  }

  it('a change of the block above in the editor pane moves the place with it', () => {
    installFakeExec();
    const sim = setup('a\n\nsame\n\nz\n');
    emptyPara(sim, 1);
    sim.pump();
    expect(sim.text()).toBe('a\n\nz\n');
    // the editor inserts lines into the block above (not a write of the session)
    sim.lines = 'a\na2\n\na3\n\nz\n'.split('\n');
    sim.resegment();
    sim.pump();
    press(sim, 'N');
    frame();
    sim.pump();
    frame();
    expect(sim.text()).toBe('a\na2\n\na3\n\nN\n\nz\n');
  });

  it('a change below the place leaves it where it is', () => {
    installFakeExec();
    const sim = setup('a\n\nsame\n\nz\n');
    emptyPara(sim, 1);
    sim.pump();
    sim.lines = 'a\n\nz\nz2\n\nz3\n'.split('\n');
    sim.resegment();
    sim.pump();
    press(sim, 'N');
    frame();
    sim.pump();
    frame();
    expect(sim.text()).toBe('a\n\nN\n\nz\nz2\n\nz3\n');
  });

  for (const [nm, first] of [['paragraph', '乙段落文字。'], ['list', '- 乙段落文字。\n- 乙二'], ['heading', '## 乙段落文字。']] as const) {
    it(`J30: the FIRST block (${nm}) emptied, ⌘Z: the session continues at the end of the restored block`, () => {
      installFakeExec();
      const doc = `${first}\n\n丙段落文字。\n`;
      const sim = setup(doc);
      useEditorHistory(sim);
      const w = sim.block(0);
      mousedown(w.querySelector('p, h2, li')!);
      for (const e of Array.from(w.querySelectorAll('p, h2, li'))) e.textContent = '';
      for (const e of Array.from(w.querySelectorAll('li')).slice(1)) e.remove();
      input(w, { inputType: 'deleteContentBackward' });
      frame();
      sim.pump();
      expect(sim.text()).toBe('丙段落文字。\n');
      press(sim, 'z', ctrlKey('z'));
      sim.pump();
      frame();
      expect(sim.text()).toBe(doc);
      press(sim, 'Q');
      frame();
      expect(sim.text()).toBe(`${first}Q\n\n丙段落文字。\n`);
    });
  }
});

describe('r4-ic P-D (J6): a source position maps to a caret that counts atoms and is never inside one', () => {
  it('⌘Z at the end of a line that ends with a formula: the caret is after the formula and typing works', () => {
    installFakeExec();
    const sim = setup('a1 b1 $x^2$\n\nzz\n');
    useEditorHistory(sim);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    const r = document.createRange(); r.setStart(p, p.childNodes.length); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Q'); press(sim, 'R');
    frame();
    expect(sim.text()).toBe('a1 b1 $x^2$QR\n\nzz\n');
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    frame();
    expect(sim.text()).toBe('a1 b1 $x^2$\n\nzz\n');
    expect(sim.editing()).toBe(sim.block(0));
    expect(inMath()).toBe(false);
    press(sim, 'W');
    frame();
    expect(sim.text()).toBe('a1 b1 $x^2$W\n\nzz\n');
  });

  it('a Backspace merge after a formula puts the caret at the join, not some characters further', () => {
    installFakeExec();
    const sim = setup('a1 $x^2$\n\nb1 yy\n\nzz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'b1', true);
    press(sim, 'Backspace');
    sim.pump();
    frame();
    expect(sim.text()).toBe('a1 $x^2$b1 yy\n\nzz\n');
    expect(inMath()).toBe(false);
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('a1 $x^2$Qb1 yy\n\nzz\n');
  });

  it('⌘Z after typing in a table cell that ends with a formula: the caret goes after the formula in that cell', () => {
    installFakeExec();
    const sim = setup('| h |\n| --- |\n| c1 $x$ |\n');
    useEditorHistory(sim);
    const w = sim.block(0);
    const td = w.querySelector('td')!;
    mousedown(td);
    const r = document.createRange(); r.setStart(td, td.childNodes.length); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('| h |\n| --- |\n| c1 $x$Q |\n');
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    frame();
    expect(inMath()).toBe(false);
    press(sim, 'W');
    frame();
    expect(sim.text()).toBe('| h |\n| --- |\n| c1 $x$W |\n');
  });

  it('setCaretAtOffset never leaves the caret inside a formula\'s rendered text', () => {
    const root = document.createElement('p');
    root.innerHTML = 'ab<span class="md-math"><span class="katex-html">x2</span></span>cd';
    document.body.appendChild(root);
    setCaretAtOffset(root, 4);                   // right after the formula's text
    expect(inMath()).toBe(false);
    const s = document.getSelection()!;
    expect(s.focusNode === root ? s.focusOffset : -1).toBe(2);
    setCaretAtOffset(root, 3);                   // inside it
    expect(inMath()).toBe(false);
  });
});

describe('r4-ic P-D: links, code spans and escapes on the line before the caret', () => {
  it('⌘Z after typing at the end of a line with a link (parentheses in its destination), a code span and a formula', () => {
    installFakeExec();
    const doc = 'see [link](http://e.x/a(b)) and `co[de $1$` then $y$ end\n\nzz\n';
    const sim = setup(doc);
    useEditorHistory(sim);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'end');
    press(sim, 'Q'); press(sim, 'R');
    frame();
    expect(sim.text()).toBe(doc.replace('end', 'endQR'));
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    frame();
    expect(sim.text()).toBe(doc);
    expect(inMath()).toBe(false);
    press(sim, 'W');
    frame();
    expect(sim.text()).toBe(doc.replace('end', 'endW'));
  });

  it('a merge after a code span that holds dollars and brackets puts the caret at the join', () => {
    installFakeExec();
    const sim = setup('a `$x$ [y` b\n\nc1 yy\n\nzz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'c1', true);
    press(sim, 'Backspace');
    sim.pump();
    frame();
    expect(sim.text()).toBe('a `$x$ [y` bc1 yy\n\nzz\n');
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('a `$x$ [y` bQc1 yy\n\nzz\n');
  });
});

describe('r4-ic P-D: inline formatting at the caret', () => {
  it('⌘Z with the caret inside bold at its end keeps it inside', () => {
    installFakeExec();
    const doc = 'a1 **bb** cc\n\nzz\n';
    const sim = setup(doc);
    useEditorHistory(sim);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'bb');
    press(sim, 'X');
    frame();
    expect(sim.text()).toBe('a1 **bbX** cc\n\nzz\n');
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    frame();
    expect(sim.text()).toBe(doc);
    press(sim, 'W');
    frame();
    expect(sim.text()).toBe('a1 **bbW** cc\n\nzz\n');
  });
});

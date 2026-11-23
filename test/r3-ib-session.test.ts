// @vitest-environment jsdom
// test/r3-ib-session.test.ts — fix-session-b (round 3): regression tests for U22 (P1, H13), U21 (H10, H11), U19 (H14),
// H20, H22 and the session side of H15. The harness (Sim, the Chrome editing stand-in, press / mousedown helpers)
// is copied unchanged from test/v3-ses-repro.test.ts lines 5-403.
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
import { blockSource, identify, segmentAll, type Block } from '../src/worker/segmenter';
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
        this.lines.splice(start - 1, count, ...t.split('\n'));
        this.resegment();
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
    // (r3-ib: the worker's normaliseEmpty — one empty line is the empty document, which has no block)
    const lines = this.lines.length === 1 && this.lines[0] === '' ? [] : this.lines;
    const segs = segmentAll(lines);
    const { N, dirty } = identify(lines, this.blocks, segs, () => this.nextId++);
    this.blocks = N;
    for (const id of dirty) this.dirty.add(id);
    this.version++;
    const arr = new Int32Array(N.length * BLOCK_STRIDE);
    N.forEach((b, i) => {
      arr[i * BLOCK_STRIDE + B_ID] = b.id;
      arr[i * BLOCK_STRIDE + B_START] = b.startLine;
      arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount;
      arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    });
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: this.lines.length, readingMinutes: 0 };
    const m: StructureMsg = { type: 'structure', version: this.version, blocks: arr, changed: Int32Array.from(dirty), lineCount: Math.max(1, lines.length), stats, outlineVersion: 1 };
    // (r3-ib) a slow worker: the structures wait in `held` until deliver()
    if (this.held) { this.held.push(m); return; }
    this.pv.applyStructure(m);
  }

  /** (r3-ib) Structures of a slow worker, applied by deliver(); null: applied at once. */
  held: StructureMsg[] | null = null;
  deliver(n = Infinity): void {
    while (this.held && this.held.length > 0 && n-- > 0) this.pv.applyStructure(this.held.shift()!);
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
          // (r3-ib) Chromium: a line that starts with a non-editable element gets a placeholder <br> before it
          if (br.nextSibling && br.nextSibling.nodeType === 1 && (br.nextSibling as Element).getAttribute('contenteditable') === 'false') br.after(doc.createElement('br'));
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
        // (r3-ib) Chromium: a new paragraph that starts with a non-editable element gets a placeholder <br> before it
        if (nb.firstChild && nb.firstChild.nodeType === 1 && (nb.firstChild as Element).getAttribute('contenteditable') === 'false') nb.insertBefore(doc.createElement('br'), nb.firstChild);
        b.after(nb);
        const first = doc.createTreeWalker(nb, 4).nextNode();
        caretAt(first ?? nb, 0);
        break;
      }
      case 'delete': {
        if (!range.collapsed) {
          range.deleteContents();
          // (r3-ib) Chromium's DeleteSelection keeps two spaces it leaves side by side visible: one becomes an NBSP
          const n = range.startContainer, o = range.startOffset;
          if (n.nodeType === 3 && o > 0 && (n as Text).data[o - 1] === ' ' && (n as Text).data[o] === ' ') (n as Text).replaceData(o - 1, 1, NBSP_CHAR);
          caretAt(range.startContainer, range.startOffset);
          break;
        }
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

const capture = (sim: Sim): HTMLTextAreaElement | null => sim.pv.el.querySelector<HTMLTextAreaElement>('textarea.mdr-preview__edit-capture');
const undoKey = (sim: Sim, redo = false): KeyboardEvent => press(sim, 'z', { ctrlKey: true, shiftKey: redo, code: 'KeyZ' });

describe('U22: the history caret (H13) and the empty document (P1)', () => {
  /** A session on the needle's block, Enter + typing after the needle, then one ⌘Z through `history` (the
   *  position CodeMirror reports: the start of the removed range, in the block's trailing blank line). */
  function typedThenUndone(doc: string, needle: string, sel: string, typed: string): Sim {
    installFakeExec();
    const sim = setup(doc);
    const w = Array.from(sim.pv.el.querySelectorAll<HTMLElement>('section.md-block')).find((b) => (b.textContent ?? '').includes(needle))!;
    mousedown(w.querySelector(sel)!);
    caretAfterText(w, needle);
    press(sim, 'Enter');
    for (const ch of typed) press(sim, ch);
    frame(); sim.pump(); frame(); sim.pump();
    sim.enableHistory();
    sim.undoStack = [doc.split('\n')];
    return sim;
  }
  it('a paragraph: the caret goes to the end of its text', () => {
    const sim = typedThenUndone('abc\n\nzzz\n', 'abc', 'p', 'def');
    expect(sim.text()).toBe('abc\n\ndef\n\nzzz\n');
    // CodeMirror: the inverse of inserting "\ndef\n" at offset 4 — line 2, column 0 (abc's trailing blank line)
    sim.source.history = () => { sim.lines = 'abc\n\nzzz\n'.split('\n'); sim.resegment(); return { line: 2, col: 0 }; };
    expect(undoKey(sim).defaultPrevented).toBe(true);
    sim.pump(); frame(); sim.pump();
    expect(sim.text()).toBe('abc\n\nzzz\n');
    expect(caretOffset(sim.editing()!)).toBe(3);
  });
  it('the last block of the document (its trailing line is the final newline)', () => {
    const sim = typedThenUndone('abc\n', 'abc', 'p', 'def');
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    expect(sim.text()).toBe('abc\n');
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('abcQ\n');
  });
  it('a list: the end of its last item, not the first', () => {
    const sim = typedThenUndone('- one\n- two\n\nz\n', 'two', 'li', 'xyz');
    expect(sim.text()).toBe('- one\n- two\n- xyz\n\nz\n');
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    expect(sim.text()).toBe('- one\n- two\n\nz\n');
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('- one\n- twoQ\n\nz\n');
  });
  it('a paragraph of two source lines: the end of the second', () => {
    const sim = typedThenUndone('abc\ndef\n\nz\n', 'def', 'p', 'ghi');
    sim.source.history = () => { sim.lines = 'abc\ndef\n\nz\n'.split('\n'); sim.resegment(); return { line: 3, col: 0 }; };
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    expect(sim.text()).toBe('abc\ndef\n\nz\n');
    expect(caretOffset(sim.editing()!)).toBe(7);
  });
  it('a blank line between two blocks belongs to the block above: its end', () => {
    installFakeExec();
    const sim = setup('abc\n\n\nzzz\n');
    sim.enableHistory();
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '!');
    frame(); sim.pump();
    expect(sim.text()).toBe('abc\n\n\nzzz!\n');
    sim.source.history = () => { sim.lines = 'abc\n\n\nzzz\n'.split('\n'); sim.resegment(); return { line: 3, col: 0 }; };
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('abc');
    expect(caretOffset(sim.editing()!)).toBe(3);
  });
  it('a fenced code block: the end of its last code line, not after the fence', () => {
    installFakeExec();
    const sim = setup('```\nab\ncd\n```\n\nzzz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '!');
    frame(); sim.pump();
    sim.source.history = () => { sim.lines = '```\nab\ncd\n```\n\nzzz\n'.split('\n'); sim.resegment(); return { line: 5, col: 0 }; };
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    const ed = sim.editing()!;
    expect(ed.querySelector('pre')).not.toBeNull();
    expect(caretOffset(ed)).toBe(textOffsetOf(ed, ed.querySelector('pre')!, 0) + 'ab\ncd'.length);
  });
  it('a position in the leading blank line of a first block (U14) is the start of its content', () => {
    installFakeExec();
    const sim = setup('  \nabc def\n\nzzz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '!');
    frame(); sim.pump();
    sim.source.history = () => { sim.lines = '  \nabc def\n\nzzz\n'.split('\n'); sim.resegment(); return { line: 1, col: 2 }; };
    undoKey(sim);
    sim.pump(); frame(); sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('abc def');
    expect(caretOffset(sim.editing()!)).toBe(0);
  });

  /** The only block emptied (U9: '' written), Q typed into the emptied element (written as a new block). */
  function emptiedThenTyped(doc: string, sync: boolean): Sim {
    installFakeExec();
    const sim = setup(doc);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    p.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame(); sim.pump();
    expect(sim.text()).toBe('');
    p.textContent = 'Q';
    caretAfterText(p, 'Q');
    input(w);
    frame(); sim.pump(); frame(); sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('Q');
    sim.undoStack = [doc.split('\n'), ['']];
    sim.redoStack = [];
    sim.enableHistory(sync);
    return sim;
  }
  it('P1: ⌘Z into the empty document ends the resume at once (nothing holds the keys)', () => {
    const sim = emptiedThenTyped('abc\n', true);
    expect(undoKey(sim).defaultPrevented).toBe(true);
    expect(sim.text()).toBe('');
    expect(sim.pv.blockCount()).toBe(0);
    // no resume waits for a block of the empty document: the capture element gives the focus back now
    expect(document.activeElement).not.toBe(capture(sim));
    expect(sim.editing()).toBeNull();
  });
  it('P1: a second ⌘Z pressed before the empty document\'s structure arrived is stepped at once, not dropped', () => {
    const sim = emptiedThenTyped('abc\n', false);
    undoKey(sim);
    expect(sim.text()).toBe('');
    expect(document.activeElement).toBe(capture(sim));        // the resume waits for the step's structure
    expect(undoKey(sim).defaultPrevented).toBe(true);          // queued (U4)
    expect(sim.text()).toBe('');
    sim.resegment();                                           // the empty document's structure
    expect(sim.text()).toBe('abc\n');                          // the queued ⌘Z went through at once
    sim.resegment();
    sim.pump(); frame(); sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('abc');    // … and the session resumed on the restored block
    press(sim, 'R');
    frame();
    expect(sim.text()).toMatch(/^(Rabc|abcR)\n$/);
  });
  it('P1: ⇧⌘Z queued the same way redoes at once; the leading-blank-line variant (U14)', () => {
    const sim = emptiedThenTyped('\nabc\n', false);
    undoKey(sim);
    expect(sim.text()).toBe('');
    undoKey(sim);                                              // queued
    sim.resegment();
    expect(sim.text()).toBe('\nabc\n');
    undoKey(sim, true);                                        // queued on the new resume
    sim.resegment();
    sim.pump(1);                                               // the session resumes, the queued ⇧⌘Z runs
    expect(sim.text()).toBe('');                               // redo of the deletion: the empty document again
    expect(document.activeElement).toBe(capture(sim));
    sim.resegment();                                           // … whose structure ends the resume at once
    expect(document.activeElement).not.toBe(capture(sim));
    expect(sim.editing()).toBeNull();
  });
});

describe('U21: Enter before an inline formula or an image (H10, H11)', () => {
  const IMG = '![i](https://e.example/i.png)';
  /** Session on block 0, caret after `needle`, `keys` pressed, every write and resume settled, then Z typed. */
  function enterThenZ(doc: string, needle: string, shift: boolean): Sim {
    installFakeExec();
    const sim = setup(doc);
    const w = sim.block(0);
    mousedown(w.querySelector('p, li')!);
    caretAfterText(w, needle);
    press(sim, 'Enter', { shiftKey: shift });
    frame(); sim.pump(); frame(); sim.pump();
    press(sim, 'Z');
    frame(); sim.pump();
    return sim;
  }
  it('Enter: no line break before the formula, Z stands before it', () => {
    expect(enterThenZ('abc $x$ y\n', 'abc', false).text()).toBe('abc\n\nZ$x$ y\n');
  });
  it('Enter with no space before the formula', () => {
    expect(enterThenZ('abc$x$ y\n', 'abc', false).text()).toBe('abc\n\nZ$x$ y\n');
  });
  it('Shift+Enter: one line break (the one typed), Z before the formula', () => {
    expect(enterThenZ('abc $x$ y\n', 'abc', true).text()).toBe('abc  \nZ$x$ y\n');
  });
  it('Enter in a list item', () => {
    expect(enterThenZ('- abc $x$ y\n- b\n', 'abc', false).text()).toBe('- abc\n- Z$x$ y\n- b\n');
  });
  it('Enter before an image: after the resume the caret is still before it', () => {
    expect(enterThenZ(`abc ${IMG} y\n`, 'abc', false).text()).toBe(`abc\n\nZ${IMG} y\n`);
  });
  it('Z typed before the resume (queued) lands before the image too', () => {
    installFakeExec();
    const sim = setup(`abc ${IMG} y\n`);
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    frame();
    press(sim, 'Z');                             // the resume waits: queued
    sim.pump(); frame(); sim.pump();
    expect(sim.text()).toBe(`abc\n\nZ${IMG} y\n`);
  });
  it('a formula that starts a line gets a caret position before it; nothing of it reaches the source', () => {
    installFakeExec();
    const sim = setup('$x$ d\n\nabc\\\n$y$ e\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const first = w.querySelector('p')!.firstChild!;
    expect(first.nodeType).toBe(3);
    expect((first as Text).data).toBe(String.fromCharCode(0x200b));
    const r = document.createRange(); r.setStart(first, 0); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Q');
    frame(); sim.pump();
    expect(sim.text()).toBe('Q$x$ d\n\nabc\\\n$y$ e\n');
    expect(sim.text()).not.toContain(String.fromCharCode(0x200b));
    // after a hard break too
    const w2 = sim.block(1);
    mousedown(w2.querySelector('p')!);
    const br = w2.querySelector('br')!;
    let sp: Node | null = br.nextSibling;
    while (sp && sp.nodeType === 3 && (sp as Text).data !== String.fromCharCode(0x200b)) sp = sp.nextSibling;
    expect(sp).not.toBeNull();
    press(sim, 'Escape');
    // the session's zero-width spaces leave with it
    expect(w2.textContent).not.toContain(String.fromCharCode(0x200b));
  });
  it('a formula that does not start a line gets no zero-width space', () => {
    installFakeExec();
    const sim = setup('abc $x$ d\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    expect(w.textContent).not.toContain(String.fromCharCode(0x200b));
  });
});

describe('U19: a paste over a selection (H14)', () => {
  function selectIn(el: Element, needle: string): void {
    const w = document.createTreeWalker(el, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const i = (n as Text).data.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
      document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
      return;
    }
    throw new Error(`"${needle}" not in block`);
  }
  function pasteOver(doc: string, needle: string, text: string): { sim: Sim; calls: string[] } {
    const { calls } = installFakeExec();
    const sim = setup(doc);
    const w = sim.block(0);
    mousedown(w.querySelector('p, td, li, h1, pre')!);
    selectIn(w, needle);
    expect(pasteInto(sim.editing()!, text).defaultPrevented).toBe(true);
    frame(); sim.pump(); frame(); sim.pump();
    return { sim, calls };
  }
  it('a word between two spaces: one space on each side stays, no &nbsp;', () => {
    const { sim, calls } = pasteOver('abc def ghi\n\nz\n', 'def', 'X');
    expect(sim.text()).toBe('abc X ghi\n\nz\n');
    expect(calls).not.toContain('delete');      // no delete command (its smart delete / whitespace rebalancing)
  });
  it('several paragraphs over a word', () => {
    expect(pasteOver('abc def ghi\n\nz\n', 'def', 'X\n\nY').sim.text()).toBe('abc X\n\nY ghi\n\nz\n');
  });
  it('a selection that ends in a space, in a table cell, in code', () => {
    expect(pasteOver('abc def ghi\n\nz\n', 'def ', 'X').sim.text()).toBe('abc Xghi\n\nz\n');
    expect(pasteOver('| h |\n|---|\n| abc def ghi |\n', 'def', 'X').sim.text()).toBe('| h |\n|---|\n| abc X ghi |\n');
    expect(pasteOver('```\nabc def ghi\n```\n', 'def', 'X').sim.text()).toBe('```\nabc X ghi\n```\n');
  });
  it('nothing of the zero-width space reaches the source or stays in the text', () => {
    const { sim } = pasteOver('abc def ghi\n\nz\n', 'def', 'X');
    expect(sim.text()).not.toContain(String.fromCharCode(0x200b));
    expect(sim.editing()?.textContent).not.toContain(String.fromCharCode(0x200b));
  });
});

describe('H20: an older structure that arrives after the deletion write', () => {
  function typedThenEmptied(doc: string, needle: string): { sim: Sim; w: HTMLElement; id: number } {
    installFakeExec();
    const sim = setup(doc);
    const w = Array.from(sim.pv.el.querySelectorAll<HTMLElement>('section.md-block')).find((b) => (b.textContent ?? '').includes(needle))!;
    const id = Number(w.dataset.id);
    mousedown(w.querySelector('p')!);
    sim.held = [];                               // the worker is slow from here on
    typeAtEnd(w, 'X');
    frame();                                     // the write of X (its structure waits)
    const p = w.querySelector('p')!;
    p.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();                                     // the deletion (its structure waits too)
    expect(sim.held.length).toBe(2);
    return { sim, w, id };
  }
  const wrappersOf = (sim: Sim, id: number): HTMLElement[] => Array.from(sim.pv.el.querySelectorAll<HTMLElement>(`section.md-block[data-id="${id}"]`));
  it('the structure of the write before the deletion keeps the session\'s wrapper as the block\'s (no second wrapper for it)', () => {
    const { sim, w, id } = typedThenEmptied('aaa\n\nmid\n\nzzz\n', 'mid');
    sim.deliver(1);                              // the OLD structure (it still has "midX")
    expect(sim.pv.elementOfBlock(id)).toBe(w);
    expect(wrappersOf(sim, id)).toEqual([w]);
    expect(sim.pv.el.querySelector('.md-ghost-holder')).toBeNull();
    sim.deliver();                               // the deletion's structure
    sim.held = null;
    sim.pump();
    expect(sim.text()).toBe('aaa\n\nzzz\n');
    const shown = Array.from(sim.pv.el.querySelectorAll<HTMLElement>('section.md-block')).map((b) => (b.textContent ?? '').trim()).filter((t) => t !== '');
    expect(shown).toEqual(['aaa', 'zzz']);
  });
  it('the same for a first block with a leading blank line (U14: its id goes to the next block)', () => {
    const { sim, w, id } = typedThenEmptied('\nmid\n\nzzz\n', 'mid');
    sim.deliver(1);
    expect(sim.pv.elementOfBlock(id)).toBe(w);
    expect(wrappersOf(sim, id)).toEqual([w]);
    sim.deliver();
    sim.held = null;
    sim.pump();
    expect(sim.text()).toBe('\nzzz\n');
    // the deletion's structure handed the id on: the emptied element and the block that now has it are apart
    expect(sim.pv.elementOfBlock(id)).not.toBe(w);
    // and text typed into the emptied element goes where the deleted block stood
    w.querySelector('p')!.textContent = 'N';
    input(w);
    frame(); sim.pump();
    expect(sim.text()).toBe('\nN\n\nzzz\n');
  });
});

describe('H22: the second ⌘A in a code block', () => {
  it('with the code selected the way the browser\'s select-all leaves it (not its final line break), ⌘A selects the whole preview', () => {
    installFakeExec();
    const sim = setup('```js\nlet a = 1;\n```\n\ntail\n');
    const w = sim.block(0);
    mousedown(w.querySelector('pre')!);
    expect(sim.editing()).toBe(w);
    const tw = document.createTreeWalker(w.querySelector('pre')!, 4);
    const texts: Text[] = [];
    for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text);
    const t = texts[texts.length - 1];
    expect(t.data.endsWith('\n')).toBe(true);
    const r = document.createRange(); r.setStart(texts[0], 0); r.setEnd(t, t.data.length - 1);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    const e = press(sim, 'a', { ctrlKey: true, code: 'KeyA' });
    expect(e.defaultPrevented).toBe(true);
    expect(sim.editing()).toBeNull();
    expect(document.getSelection()!.toString()).toContain('tail');
    expect(sim.text()).toBe('```js\nlet a = 1;\n```\n\ntail\n');
  });
  it('a selection that stops before the code\'s last character is not the whole block', () => {
    installFakeExec();
    const sim = setup('```\nplain code\n```\n\ntail\n');
    const w = sim.block(0);
    mousedown(w.querySelector('pre')!);
    const t = w.querySelector('pre code')!.firstChild as Text;
    const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, t.data.length - 2);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    expect(press(sim, 'a', { ctrlKey: true, code: 'KeyA' }).defaultPrevented).toBe(false);   // the browser's own select-all
    expect(sim.editing()).toBe(w);
  });
});

describe('H15, the session side: no free marker set', () => {
  const PUA = ((): string => {
    let s = '';
    for (let c = 0xe000; c <= 0xf8ff; c++) s += String.fromCharCode(c);
    for (let c = 0xfdd0; c <= 0xfdef; c++) s += String.fromCharCode(c);
    return s;
  })();
  it('a paste of the whole private-use table: nothing written, the session ends with the refusal toast', () => {
    installFakeExec();
    const sim = setup('Glyphs: end\n\nz\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'Glyphs');
    expect(pasteInto(sim.editing()!, PUA).defaultPrevented).toBe(true);
    expect(() => { frame(); sim.pump(); frame(); }).not.toThrow();
    expect(sim.text()).toBe('Glyphs: end\n\nz\n');
    expect(sim.replaces.length).toBe(0);
    expect(sim.editing()).toBeNull();
    expect(sim.sessions[sim.sessions.length - 1]).toEqual({ id: null });
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
    // the block re-renders from its unchanged source, and a new click edits it as before
    sim.pump();
    expect(sim.block(0).textContent).not.toContain(PUA.slice(0, 10));
    mousedown(sim.block(0).querySelector('p')!);
    expect(sim.editing()).toBe(sim.block(0));
  });
  it('the same at a session end (Esc): nothing written, no error escapes', () => {
    installFakeExec();
    const sim = setup('Glyphs: end\n\nz\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'Glyphs');
    pasteInto(sim.editing()!, PUA);
    expect(() => press(sim, 'Escape')).not.toThrow();
    expect(sim.text()).toBe('Glyphs: end\n\nz\n');
    expect(sim.editing()).toBeNull();
  });
  it('Backspace at the start (a merge) after such a paste: nothing written, the session ends', () => {
    installFakeExec();
    const sim = setup('one\n\nGlyphs: end\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    p.firstChild!.textContent = PUA + 'Glyphs: end';             // typed, not written yet
    caretAfterText(w, PUA.slice(0, 1), true);
    expect(() => press(sim, 'Backspace')).not.toThrow();
    expect(sim.text()).toBe('one\n\nGlyphs: end\n');
    expect(sim.editing()).toBeNull();
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
  });
  it('a history step into a block that leaves no free marker set: the resume ends with the refusal, nothing thrown', () => {
    installFakeExec();
    const sim = setup('abc\n\n' + PUA + '\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, 'X');
    frame(); sim.pump();
    expect(sim.text()).toBe('abcX\n\n' + PUA + '\n');
    sim.source.history = () => { sim.lines = ('abc\n\n' + PUA + '\n').split('\n'); sim.resegment(); return { line: 3, col: 2 }; };
    expect(() => { undoKey(sim); sim.pump(); frame(); sim.pump(); }).not.toThrow();
    expect(sim.editing()).toBeNull();
    expect(document.activeElement).not.toBe(capture(sim));
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
  });
});

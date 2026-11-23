// @vitest-environment jsdom
// test/v3-ses-repro.test.ts — verify-session stage 2c: repro tests for SES-1 / SES-2 / SES-3 / SES-8 (FAIL today; they define
// "fixed"). The harness (Sim, the Chrome editing stand-in, press / mousedown helpers) is copied unchanged from
// test/inlineEdit.test.ts lines 1-400.
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
    const segs = segmentAll(this.lines);
    const { N, dirty } = identify(this.lines, this.blocks, segs, () => this.nextId++);
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

describe('v3-ses repro (stage 2c)', () => {
  it('SES-2: Backspace in an emptied paragraph (deletion written) leaves the next block\'s source alone', () => {
    installFakeExec();
    const sim = setup('one\n\nmid\n\n## Next\n\nz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    p.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    expect(sim.text()).toBe('one\n\n## Next\n\nz\n');
    const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Backspace');
    frame();
    sim.pump();
    // the heading below must still be a heading (today: "one## Next\n\nz\n")
    expect(sim.text()).toContain('\n\n## Next\n');
    expect(sim.text()).not.toContain('one## Next');
  });

  it('SES-2: the same with a fenced code block after the emptied paragraph', () => {
    installFakeExec();
    const sim = setup('one\n\nmid\n\n```\ncode\n```\n\nz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    const p = w.querySelector('p')!;
    p.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Backspace');
    frame();
    sim.pump();
    expect(sim.text()).toContain('\n```\ncode\n```\n');
  });

  it('SES-1: deleting an emptied block that sits right under a paragraph (no blank line) keeps the neighbours apart', () => {
    installFakeExec();
    const sim = setup('para one\n# Head\n\nz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('h1')!);
    w.replaceChildren(document.createElement('p'));
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    sim.pump();
    // two paragraphs stay two paragraphs (today: "para one\nz\n" — one paragraph)
    expect(sim.text()).toMatch(/^para one\n\n+z\n$/);
  });

  it('SES-1: text typed into that emptied element lands between the two paragraphs', () => {
    installFakeExec();
    const sim = setup('para one\n# Head\n\nz\n');
    const w = sim.block(1);
    mousedown(w.querySelector('h1')!);
    const p = document.createElement('p');
    w.replaceChildren(p);
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    sim.pump();
    p.textContent = 'N';
    input(w);
    frame();
    sim.pump();
    // today: "para one\nz\n\nN\n" (N after z)
    expect(sim.text()).toMatch(/^para one\n\n+N\n\n+z\n$/);
  });

  it('SES-3: ⌘Z of text typed in a new paragraph puts the caret at the end of the paragraph above, not its start', () => {
    installFakeExec();
    const sim = setup('abc\n\nzzz\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    for (const ch of 'def') press(sim, ch);
    frame();
    sim.pump();
    frame();
    sim.pump();
    expect(sim.text()).toBe('abc\n\ndef\n\nzzz\n');
    expect(sim.editing()?.textContent?.trim()).toBe('def');
    // CodeMirror's undo of that write, as createSourceAccess.history reports it: the write was
    // replace(1, 2, "abc\n\ndef\n") = insert "\ndef\n" at offset 4 (common prefix "abc\n"); its inverse deletes
    // [4, 9) and the caret is the end of the changed range in the new document: offset 4 = line 2, column 0
    // (the blank line after "abc"). (Measured in Chromium: the session then types at the START of "abc".)
    sim.source.history = (redo) => {
      if (redo) return null;
      sim.lines = 'abc\n\nzzz\n'.split('\n');
      sim.resegment();
      return { line: 2, col: 0 };
    };
    expect(press(sim, 'z', { ctrlKey: true, code: 'KeyZ' }).defaultPrevented).toBe(true);
    sim.pump();
    frame();
    sim.pump();
    expect(sim.text()).toBe('abc\n\nzzz\n');
    expect(sim.editing()?.textContent?.trim()).toBe('abc');
    // today the caret lands at offset 0 (the start of "abc")
    expect(caretOffset(sim.editing()!)).toBe(3);
  });
  it('SES-8: pasting paragraphs whose last one is only whitespace at a paragraph start, then typing: nothing is duplicated', () => {
    installFakeExec();
    const sim = setup('before\n\nabcdef\n\nafter\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abcdef', true);
    const e = pasteInto(w.querySelector('p')!, 'vao\n\n ');
    expect(e.defaultPrevented).toBe(true);
    frame();
    sim.pump();
    frame();
    sim.pump();
    expect(sim.text()).toBe('before\n\nvao\n\nabcdef\n\nafter\n');
    press(sim, 'Q');
    frame();
    sim.pump();
    // today: "before\n\nvao\n\nvQao\n\nabcdef\n\nafter\n" — the session resumed on the old wrapper, which still showed
    // the pasted paragraphs, and wrote them a second time
    expect((sim.text().match(/ao/g) ?? []).length).toBe(1);
    expect(sim.text()).toBe('before\n\nvao\n\nQabcdef\n\nafter\n');
  });
});

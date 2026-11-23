// @vitest-environment jsdom
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

describe('session lifecycle', () => {
  it('mousedown makes the block editable, nothing is written until the DOM changes', () => {
    const sim = setup('# Title\n\nFirst para.\n\nSecond para.\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    expect(w.getAttribute('contenteditable')).toBe('true');
    expect(w.classList.contains('is-editing')).toBe(true);
    expect(sim.sessions).toEqual([{ id: Number(w.dataset.id) }]);
    const hint = sim.pv.el.parentElement!.querySelector<HTMLElement>('.mdr-preview__edit-hint')!;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(EDIT_HINT_TEXT);
    frame(); frame();
    expect(sim.replaces).toEqual([]);
  });

  it('typing writes the block with its trailing blank lines preserved, once per frame', () => {
    const sim = setup('# Title\n\nFirst para.\n\n\nSecond para.\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, ' more');
    typeAtEnd(w, ' and more');
    expect(sim.replaces).toEqual([]);          // coalesced into the next frame
    frame();
    expect(sim.replaces).toEqual([{ startLine: 3, lineCount: 3, text: 'First para. more and more\n\n' }]);
    expect(sim.text()).toBe('# Title\n\nFirst para. more and more\n\n\nSecond para.\n');
  });

  it('a structure update moves the session with its block (startLine / lineCount)', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    // the "editor" inserts two lines above the block
    sim.lines.splice(0, 0, 'zero', '');
    sim.resegment();
    typeAtEnd(w, '!');
    frame();
    expect(sim.replaces.at(-1)).toEqual({ startLine: 5, lineCount: 2, text: 'two!\n' });
    expect(sim.text()).toBe('zero\n\none\n\ntwo!\n\nthree\n');
    expect(sim.editing()).toBe(w);             // same wrapper, still editing
  });

  it('IME composition suppresses writes until compositionend', () => {
    const sim = setup('para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    w.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    w.querySelector('p')!.firstChild!.textContent = 'parazhong';
    input(w, { isComposing: true });
    frame(); frame();
    expect(sim.replaces).toEqual([]);
    w.querySelector('p')!.firstChild!.textContent = 'para中';
    w.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    frame();
    expect(sim.text()).toBe('para中\n');
  });

  it('holds back worker HTML while editing and applies it when the session ends (Esc)', () => {
    const sim = setup('para\n\nnext\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    typeAtEnd(w, ' x');
    frame();
    sim.pump();                                  // the worker's render of "para x" arrives…
    expect(w.querySelector('p')).toBe(p);        // …and is held: the edited DOM stays
    expect(w.classList.contains('is-stale')).toBe(false);
    const esc = key(p, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(sim.editing()).toBeNull();
    expect(w.hasAttribute('contenteditable')).toBe(false);
    expect(sim.sessions.at(-1)).toEqual({ id: null });
    frame();
    expect(w.querySelector('p')).not.toBe(p);    // re-rendered from the worker
    expect(w.querySelector('p')!.textContent).toBe('para x');
  });

  it('ending without a change re-renders the block from the worker', () => {
    const sim = setup('para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    sim.pv.endEditSession();
    expect(sim.requested.has(Number(w.dataset.id))).toBe(true);
    expect(sim.replaces).toEqual([]);
  });

  it('endEditSession commits a change the next frame would have written', () => {
    const sim = setup('para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '!');
    sim.pv.endEditSession();
    expect(sim.text()).toBe('para!\n');
    frame();
    expect(sim.replaces.length).toBe(1);
  });

  it('a click elsewhere ends the session and may start one on the other block', () => {
    const sim = setup('one\n\ntwo\n');
    mousedown(sim.block(0).querySelector('p')!);
    typeAtEnd(sim.block(0), '1');
    mousedown(sim.block(1).querySelector('p')!);
    expect(sim.text()).toBe('one1\n\ntwo\n');
    expect(sim.editing()).toBe(sim.block(1));
    mousedown(sim.pv.el);                        // outside any block
    expect(sim.editing()).toBeNull();
  });

  it('Enter that splits the block ends the session and resumes on the new block at the caret', () => {
    const sim = setup('first second\n\nafter\n');
    const focus: Array<{ line: number; source: string }> = [];
    sim.bus.on('focus:line', (e) => focus.push(e));
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    // what insertParagraph does in the browser: split the paragraph, caret at the start of the new one
    p.firstChild!.textContent = 'first';
    const p2 = document.createElement('p');
    p2.textContent = 'second';
    p.after(p2);
    setCaretAtOffset(p2, 0);
    input(w, { inputType: 'insertParagraph' });
    frame();
    expect(sim.text()).toBe('first\n\nsecond\n\nafter\n');
    expect(sim.editing()).toBeNull();            // the old session ended
    sim.pump();
    const next = sim.editing();
    expect(next).not.toBeNull();
    expect(next!.textContent!.trim()).toBe('second');
    expect(next).toBe(sim.block(1));
    const sel = document.getSelection()!;
    expect(textOffsetOf(next!, sel.focusNode!, sel.focusOffset)).toBe(0);
    // the focus line follows the caret into the resumed block: tinted here, mirrored to the editor
    expect(focus.at(-1)).toEqual({ line: 3, source: 'preview' });
    frame();
    const tinted = sim.pv.el.querySelectorAll('.is-focus');
    expect(tinted).toHaveLength(1);
    expect(next!.contains(tinted[0])).toBe(true);
    // and typing there writes the new block's lines only
    typeAtEnd(next!, '!');
    frame();
    expect(sim.text()).toBe('first\n\nsecond!\n\nafter\n');
  });

  it('does not resume on an old block that happens to sit at the target line before the update', () => {
    const sim = setup('aa\n\nbb\n\ncc\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    // Make the source NOT re-segment on replace (the worker's update is still in flight).
    const replace = sim.source.replace;
    sim.source.replace = (s, c, t) => { sim.replaces.push({ startLine: s, lineCount: c, text: t }); sim.lines.splice(s - 1, c, ...t.split('\n')); };
    const p = w.querySelector('p')!;
    const p2 = document.createElement('p');
    p2.textContent = 'x';
    p.after(p2);
    setCaretAtOffset(p2, 1);
    input(w);
    frame();
    expect(sim.text()).toBe('aa\n\nx\n\nbb\n\ncc\n');
    // block "bb" (old structure) starts at line 3 with 2 lines — exactly the target of the split
    sim.pump();
    expect(sim.editing()).toBeNull();
    sim.source.replace = replace;
    sim.resegment();
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('x');
    expect(sim.text()).toBe('aa\n\nx\n\nbb\n\ncc\n');
  });

  it('an emptied block is deleted at the next frame, with its own blank lines; the session stays on it (U9)', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    w.querySelector('p')!.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    expect(sim.text()).toBe('one\n\nthree\n');   // no extra blank line stays behind
    expect(sim.editing()).toBe(w);               // the emptied element, still in place and editable
    expect(w.isConnected).toBe(true);
    expect(sim.pv.blockCount()).toBe(2);
    const n = sim.replaces.length;
    sim.pv.endEditSession();                     // leaving it writes nothing more
    expect(sim.replaces.length).toBe(n);
    expect(sim.text()).toBe('one\n\nthree\n');
    expect(w.isConnected).toBe(false);
    expect(sim.editing()).toBeNull();
  });

  it('refuses non-editable blocks with a toast (throttled), and stale / pending ones silently', () => {
    const sim = setup('para\n\n---\n\n<div>html</div>\n');
    mousedown(sim.block(1).querySelector('hr')!);
    expect(sim.editing()).toBeNull();
    expect(sim.toasts.map((t) => t.text)).toEqual([NOT_EDITABLE_TEXT]);
    mousedown(sim.block(1).querySelector('hr')!);
    expect(sim.toasts.length).toBe(1);
    mousedown(sim.block(2).querySelector('div')!);
    expect(sim.editing()).toBeNull();
    expect(sim.toasts.length).toBe(2);
    // the editor changed the paragraph; its new HTML has not arrived: not editable yet
    sim.lines[0] = 'para changed';
    sim.resegment();
    mousedown(sim.block(0).querySelector('p')!);
    expect(sim.editing()).toBeNull();
    sim.pump();
    mousedown(sim.block(0).querySelector('p')!);
    expect(sim.editing()).toBe(sim.block(0));
  });

  it('refuses blocks the serializer cannot reproduce (reference definitions)', () => {
    const sim = setup('see [x][r]\n[r]: http://example.com\n');
    mousedown(sim.block(0).querySelector('p')!);
    expect(sim.editing()).toBeNull();
    expect(sim.toasts.map((t) => t.text)).toEqual([NOT_EDITABLE_TEXT]);
  });

  it('setPreviewEditable(false) ends the session and disables it; no source → never editable', () => {
    const sim = setup('para\n');
    mousedown(sim.block(0).querySelector('p')!);
    typeAtEnd(sim.block(0), '!');
    sim.pv.setPreviewEditable(false);
    expect(sim.text()).toBe('para!\n');
    expect(sim.pv.isPreviewEditable()).toBe(false);
    mousedown(sim.block(0).querySelector('p')!);
    expect(sim.editing()).toBeNull();
    const ro = setup('para\n', false);
    expect(ro.pv.isPreviewEditable()).toBe(false);
    mousedown(ro.block(0).querySelector('p')!);
    expect(ro.editing()).toBeNull();
  });

  it('Alt / Meta clicks and checkbox clicks outside a session do not start one', () => {
    const sim = setup('para\n\n- [ ] task\n');
    mousedown(sim.block(0).querySelector('p')!, { altKey: true });
    mousedown(sim.block(0).querySelector('p')!, { metaKey: true });
    expect(sim.editing()).toBeNull();
    mousedown(sim.block(1).querySelector('input')!);
    expect(sim.editing()).toBeNull();
  });

  it('a plain click on a link outside a session does not start one (the link navigates); inside one it stays', () => {
    const sim = setup('see [there](#x) now\n\nother\n');
    const w = sim.block(0);
    mousedown(w.querySelector('a')!);
    expect(sim.editing()).toBeNull();
    mousedown(w.querySelector('p')!);
    expect(sim.editing()).toBe(w);
    mousedown(w.querySelector('a')!);
    expect(sim.editing()).toBe(w);
  });

  it('a checkbox inside a session is serialized, not sent as a separate source edit', () => {
    const sim = setup('- [ ] task\n');
    const edits: unknown[] = [];
    sim.bus.on('source:edit', (e) => { edits.push(e); });
    const w = sim.block(0);
    mousedown(w.querySelector('li')!);
    const box = w.querySelector('input')!;
    mousedown(box);
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1);
    frame();
    expect(sim.text()).toBe('- [x] task\n');
    expect(edits).toEqual([]);
  });

  it('keys: Shift+Enter is a line break, Tab never leaves the block, ⌘E/⌘B inside code do nothing', () => {
    const sim = setup('para\n\n```\ncode\n```\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    expect(sim.editing()).toBe(w);
    const tabE = key(w.querySelector('p')!, 'Tab');
    expect(tabE.defaultPrevented, 'tab').toBe(true);
    expect(key(w.querySelector('p')!, 'Enter', { shiftKey: true }).defaultPrevented, 'shift-enter').toBe(true);
    sim.pv.endEditSession();
    const c = sim.block(1);
    mousedown(c.querySelector('code')!);
    expect(sim.editing()).toBe(c);
    setCaretAtOffset(c, 2);
    expect(key(c.querySelector('code')!, 'b', { metaKey: true, ctrlKey: false, code: 'KeyB' }).defaultPrevented || key(c.querySelector('code')!, 'b', { ctrlKey: true, code: 'KeyB' }).defaultPrevented).toBe(true);
    expect(sim.replaces).toEqual([]);
  });

  it('Tab / Shift+Tab indent and outdent list items', () => {
    const sim = setup('- a\n- b\n- c\n');
    const w = sim.block(0);
    const b = w.querySelectorAll('li')[1];
    mousedown(b);
    setCaretAtOffset(b, 1);
    key(b, 'Tab');
    frame();
    expect(sim.text()).toBe('- a\n  - b\n- c\n');
    key(w.querySelectorAll('li')[1], 'Tab', { shiftKey: true });
    frame();
    expect(sim.text()).toBe('- a\n- b\n- c\n');
  });

  it('Enter on an empty last item leaves the list (the paragraph is written once it has text)', () => {
    const sim = setup('- a\n- b\n');
    const w = sim.block(0);
    const ul = w.querySelector('ul')!;
    mousedown(ul);
    const empty = document.createElement('li');
    empty.appendChild(document.createElement('br'));
    ul.appendChild(empty);
    setCaretAtOffset(empty, 0);
    key(empty, 'Enter');
    expect(w.querySelectorAll('li').length).toBe(2);
    const p = w.querySelector(':scope > p')!;
    expect(p).not.toBeNull();
    frame();
    expect(sim.text()).toBe('- a\n- b\n');     // an empty paragraph has no source
    p.textContent = 'out';
    setCaretAtOffset(p, 3);
    input(w);
    frame();
    expect(sim.text()).toBe('- a\n- b\n\nout\n');
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('out');
  });

  it('never touches other blocks and keeps the edited wrapper across unrelated updates', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '2');
    frame();
    sim.lines[6 - 2] = 'three changed';     // an edit elsewhere (line 5)
    sim.resegment();
    sim.pump();
    expect(sim.editing()).toBe(w);
    typeAtEnd(w, '!');
    frame();
    for (const r of sim.replaces) expect(r.startLine).toBe(3);
    expect(sim.text()).toBe('one\n\ntwo2!\n\nthree changed\n');
  });
});

describe('caret offsets', () => {
  it('textOffsetOf / setCaretAtOffset round-trip over nested inline markup, skipping layout whitespace', () => {
    const el = document.createElement('section');
    el.innerHTML = '<ul>\n<li>ab<strong>cd</strong></li>\n<li>ef</li>\n</ul>';
    document.body.appendChild(el);
    for (let off = 0; off <= 6; off++) {
      setCaretAtOffset(el, off);
      const sel = document.getSelection()!;
      expect(textOffsetOf(el, sel.focusNode!, sel.focusOffset)).toBe(off);
      expect(sel.focusNode!.parentElement!.closest('li')).not.toBeNull();
    }
  });
});

describe('session block replaced', () => {
  it('a new document (full reset) ends the session without resuming on a foreign block', () => {
    const sim = setup('one\n\ntwo\n');
    mousedown(sim.block(1).querySelector('p')!);
    // setDoc: every id is new
    sim.blocks = [];
    sim.lines = 'alpha\n\nbeta\n'.split('\n');
    sim.resegment();
    sim.pump();
    expect(sim.editing()).toBeNull();
    expect(sim.sessions.at(-1)).toEqual({ id: null });
    expect(sim.replaces).toEqual([]);
  });

  it('when the identity rule moves the id away, the session resumes on the block with the same text', () => {
    const sim = setup('aa\n\nbb\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    // Editing "aa" into "bb": pass 1 of the identity rule hands the first block the old id of "bb".
    w.querySelector('p')!.textContent = 'bb';
    setCaretAtOffset(w, 2);
    input(w);
    frame();
    expect(sim.text()).toBe('bb\n\nbb\n');
    sim.pump();
    const now = sim.editing();
    expect(now).not.toBeNull();
    expect(now).toBe(sim.block(0));
    typeAtEnd(now!, '!');
    frame();
    expect(sim.text()).toBe('bb!\n\nbb\n');
  });
});

describe('endEditSession contract (App: ⌘S, mode switch, open, close)', () => {
  it('flushes text typed during an IME composition synchronously and emits {id:null}', () => {
    const sim = setup('para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    w.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    w.querySelector('p')!.firstChild!.textContent = 'para中';
    input(w, { isComposing: true });
    sim.pv.endEditSession();
    expect(sim.text()).toBe('para中\n');
    expect(sim.sessions.at(-1)).toEqual({ id: null });
    expect(sim.editing()).toBeNull();
  });

  it('writes a split still waiting for its frame, and no session starts afterwards', () => {
    const sim = setup('first second\n\nafter\n');
    const focus: Array<{ line: number; source: string }> = [];
    sim.bus.on('focus:line', (e) => focus.push(e));
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    p.firstChild!.textContent = 'first';
    const p2 = document.createElement('p');
    p2.textContent = 'second';
    p.after(p2);
    setCaretAtOffset(p2, 0);
    input(w, { inputType: 'insertParagraph' });
    sim.pv.endEditSession();                     // before the frame
    expect(sim.text()).toBe('first\n\nsecond\n\nafter\n');
    expect(sim.sessions.at(-1)).toEqual({ id: null });
    frame();
    sim.pump();
    expect(sim.editing()).toBeNull();            // an explicit end never resumes on the new block
    expect(sim.sessions.at(-1)).toEqual({ id: null });
    expect(sim.replaces.length).toBe(1);
  });

  it('drops a resume still waiting from an earlier split', () => {
    const sim = setup('first second\n\nafter\n');
    const focus: Array<{ line: number; source: string }> = [];
    sim.bus.on('focus:line', (e) => focus.push(e));
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    p.firstChild!.textContent = 'first';
    const p2 = document.createElement('p');
    p2.textContent = 'second';
    p.after(p2);
    setCaretAtOffset(p2, 0);
    input(w, { inputType: 'insertParagraph' });
    frame();                                     // written; the session waits for the new block's HTML
    expect(sim.editing()).toBeNull();
    sim.pv.endEditSession();
    sim.pump();
    expect(sim.editing()).toBeNull();
  });

  it('accepts synthetic format keydowns (toolbar / native menu) dispatched on the editing block', () => {
    const sim = setup('a `code` b\n');
    const w = sim.block(0);
    mousedown(w.querySelector('code')!);
    setCaretAtOffset(w, 4);                      // inside "code"
    const e = shortcutKeyEvent('Mod-e');
    expect(e.isTrusted).toBe(false);
    sim.editing()!.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(w.querySelector('code')).toBeNull();  // ⌘E toggled the inline code off
    frame();
    expect(sim.text()).toBe('a code b\n');
    expect(sim.editing()).toBe(w);               // still the same session
  });

  it('flushEditSession writes what is pending synchronously and keeps the session and caret', () => {
    const sim = setup('para\n\nnext\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    typeAtEnd(w, '!');
    const before = sim.sessions.length;
    (sim.pv as PreviewApi & { flushEditSession(): void }).flushEditSession();
    expect(sim.text()).toBe('para!\n\nnext\n');
    expect(sim.editing()).toBe(w);
    expect(sim.sessions.length).toBe(before);   // no session event
    const sel = document.getSelection()!;
    expect(textOffsetOf(w, sel.focusNode!, sel.focusOffset)).toBe(5);
    frame();
    expect(sim.replaces.length).toBe(1);         // the cancelled frame does not write again
  });
});

// ---------------------------------------------------------------- fix round 0.2.0 (fixer-B, decisions U1–U6)
const ctrlKey = (k: string, shift = false): KeyboardEventInit => ({ ctrlKey: true, shiftKey: shift, code: `Key${k.toUpperCase()}` });

describe('fix round 0.2.0 — paste, links, inline code (U5, U6)', () => {
  it('B1/U6: pasting several lines into a code block keeps every newline', () => {
    installFakeExec();
    const sim = setup('```\nconst a = 1;\nconst b = 2;\n```\n');
    const w = sim.block(0);
    mousedown(w.querySelector('code')!);
    expect(sim.editing()).toBe(w);
    caretAfterText(w, 'const a = 1;');
    expect(pasteInto(w.querySelector('code')!, '\nconst c = 3;\nconst d = 4;').defaultPrevented).toBe(true);
    frame();
    expect(sim.text()).toBe('```\nconst a = 1;\nconst c = 3;\nconst d = 4;\nconst b = 2;\n```\n');
  });

  it('B1/U6: a paste ending in a newline at the end of the code adds the line, nothing else', () => {
    installFakeExec();
    const sim = setup('```\nx\n```\n');
    const w = sim.block(0);
    mousedown(w.querySelector('code')!);
    caretAfterText(w, 'x');
    pasteInto(w.querySelector('code')!, '\ny\nz');
    frame();
    expect(sim.text()).toBe('```\nx\ny\nz\n```\n');
  });

  it('B2/U5: ⌘K with a collapsed caret inserts a link without raw HTML or baked-in styles', () => {
    installFakeExec();
    const sim = setup('合并。\n\nnext\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    caretAfterText(w, '合并。');
    expect(key(p, 'k', ctrlKey('k')).defaultPrevented).toBe(true);
    const input = sim.pv.el.querySelector<HTMLInputElement>('.mdr-preview__link-input input')!;
    input.value = 'https://c.example/';
    key(input, 'Enter');
    press(sim, '后');
    frame();
    const line = sim.lines[0];
    expect(line).not.toMatch(/<a|style=|<span|<font|&nbsp;/);
    expect(line.startsWith('合并。')).toBe(true);
    expect(line.endsWith('后')).toBe(true);
    expect(line).toContain('https://c.example/');
    // nothing the session created carries a style (the computed-style copy of insertHTML, finding high 3)
    const a = w.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://c.example/');
    expect(a.hasAttribute('style')).toBe(false);
    for (const e of Array.from(w.querySelectorAll('[style]'))) expect(e.hasAttribute('data-mdr-o')).toBe(true);
    expect(a.textContent).toBe('https://c.example/');
    expect(a.nextSibling?.textContent).toBe('后');   // typed after the link, not into it
    // (How the serializer spells this link — bare URL, <url> or [url](url) — is serialize.ts's business; a
    // bare URL followed directly by 后 reads back with 后 inside the link: reported to fixer-C.)
    key(sim.editing()!, 'Escape');
    sim.pump();
    const shown = sim.block(0).querySelector('a')!;
    expect(shown.hasAttribute('style')).toBe(false);
    expect(sim.block(0).innerHTML).not.toMatch(/style=/);
  });

  it('B6/U5: ⌘E with a collapsed caret starts inline code; typing lands inside; ⌘E again leaves it', () => {
    installFakeExec();
    const sim = setup('结尾\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    caretAfterText(w, '结尾');
    expect(key(p, 'e', ctrlKey('e')).defaultPrevented).toBe(true);
    for (const ch of 'npm i') press(sim, ch);
    expect(key(sim.editing()!, 'e', ctrlKey('e')).defaultPrevented).toBe(true);
    for (const ch of ' 完成') press(sim, ch);
    frame();
    expect(sim.text()).toBe('结尾`npm i` 完成\n');
    expect(w.querySelector('[style]')).toBeNull();
  });

  it('B6/U5: ⌘E twice without typing leaves nothing behind; ⌘E on existing code still unwraps it', () => {
    installFakeExec();
    const sim = setup('plain `old` end\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    caretAfterText(w, 'plain');
    key(p, 'e', ctrlKey('e'));
    key(p, 'e', ctrlKey('e'));
    press(sim, '!');
    frame();
    expect(sim.text()).toBe('plain! `old` end\n');
    caretAfterText(w, 'ol');
    key(p, 'e', ctrlKey('e'));
    frame();
    expect(sim.text()).toBe('plain! old end\n');
  });

  it('B7: pasting paragraphs separated by blank lines makes paragraphs (no lines holding only "  ")', () => {
    installFakeExec();
    const sim = setup('起点\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, '起点');
    pasteInto(w.querySelector('p')!, '段一\n\n段二\n\n\n段三');
    frame();
    expect(sim.text()).toBe('起点段一\n\n段二\n\n段三\n\nafter\n');
    expect(sim.text()).not.toMatch(/^[ \t]+$/m);
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('段三');
  });
});

describe('fix round 0.2.0 — input around a split (U4)', () => {
  it('B3/U4: keys and committed IME text between an Enter split and the resumed session are applied in order', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    press(sim, 'x');
    press(sim, 'Enter');
    frame();                                     // the split is written; the new block has no HTML yet
    expect(sim.text()).toBe('alphax\n\nbeta\n\nafter\n');
    expect(sim.editing()).toBeNull();
    // 0 ms apart, all before the resumed session exists: a character, Backspace, a character, CJK committed
    // without a keydown (what CDP Input.insertText / an IME commit does)
    press(sim, 'y');
    press(sim, 'Backspace');
    press(sim, 'z');
    commitText(sim, '中文');
    expect(sim.text()).toBe('alphax\n\nbeta\n\nafter\n');
    sim.pump();                                  // the new block mounts: the session resumes and replays
    frame();
    expect(sim.text()).toBe('alphax\n\nz中文beta\n\nafter\n');
    expect(sim.editing()).toBe(sim.block(1));
    expect(caretOffset(sim.editing()!)).toBe(3);
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(false);   // the capture let go
  });

  it('B3/U4: an Enter queued in the window splits again, and typing after it lands in the newest block', () => {
    installFakeExec();
    const sim = setup('ab\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'a');
    press(sim, 'Enter');
    frame();
    press(sim, 'A');
    press(sim, 'Enter');
    press(sim, 'B');
    sim.pump();
    sim.pump();
    expect(sim.text()).toBe('a\n\nA\n\nBb\n\nafter\n');
    expect(sim.editing()?.textContent?.trim()).toBe('Bb');
  });

  it('B3/U4: the first edit of a heading directly followed by a paragraph / a table loses nothing', () => {
    for (const body of ['紧跟的段落文字。', '| a | b |\n|---|---|\n| 1 | 2 |']) {
      installFakeExec();
      const table = body.startsWith('|');
      const doc0 = `## 标题\n${body}\n\n尾段\n`;
      const sim = setup(doc0);
      const w = sim.block(0);
      mousedown(w.querySelector(table ? 'td' : 'p')!);
      caretAfterText(w, table ? '1' : '段落');
      press(sim, 'x');
      frame();                                   // the first write (may re-segment the block)
      press(sim, 'Backspace');                   // ≤ 1 frame later: inside a resume window if it did
      sim.pump();
      frame();
      press(sim, 'y');
      sim.pump();
      frame();
      const t = sim.text();
      expect(t).not.toContain('x');
      expect(t).toContain(table ? '| 1y |' : '段落y文字。');
      if (!table) expect(t.replace('## 标题\n\n', '## 标题\n')).toBe(doc0.replace('段落', '段落y'));
      expect(sim.editing()).not.toBeNull();
      sim.pv.endEditSession();
    }
  });

  it('B3: endEditSession during a resume drops the queued input and releases the capture element', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    press(sim, 'Enter');
    frame();
    press(sim, 'q');
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(true);
    sim.pv.endEditSession();
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(false);
    sim.pump();
    expect(sim.editing()).toBeNull();
    expect(sim.text()).toBe('alpha\n\nbeta\n\nafter\n');
  });
});

describe('fix round 0.2.0 — Backspace merge and undo through the source (U1, U3)', () => {
  it('B4/U3: Backspace at the very start of a paragraph merges it into the paragraph before', () => {
    installFakeExec();
    const sim = setup('one two\n\nthree four\n\nlast\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    setCaretAtOffset(w, 0);
    const e = press(sim, 'Backspace');
    expect(e.defaultPrevented).toBe(true);
    expect(sim.text()).toBe('one twothree four\n\nlast\n');
    sim.pump();
    const now = sim.editing()!;
    expect(now).toBe(sim.block(0));
    expect(caretOffset(now)).toBe(7);
    press(sim, '!');
    frame();
    expect(sim.text()).toBe('one two!three four\n\nlast\n');
  });

  it('B4/U3: the merge keeps the source spelling of both paragraphs (multi-line, non-canonical)', () => {
    installFakeExec();
    const sim = setup('first _em_\nline two\n\n\nsecond __b__\nmore\n\nlast\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    setCaretAtOffset(w, 0);
    press(sim, 'Backspace');
    expect(sim.text()).toBe('first _em_\nline twosecond __b__\nmore\n\nlast\n');
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe('first em\nline two'.length);
  });

  it('B4/U3: every other combination keeps the browser behaviour', () => {
    installFakeExec();
    for (const [text, idx] of [['# H\n\npara\n', 1], ['- a\n\npara\n', 1], ['para\n\n- a\n', 1], ['> q\n\npara\n', 1]] as const) {
      const sim = setup(text);
      const w = sim.block(idx);
      mousedown(w.querySelector('p, li')!);
      setCaretAtOffset(w, 0);
      const e = key(w, 'Backspace');
      expect(e.defaultPrevented, text).toBe(false);
      frame();
      expect(sim.text(), text).toBe(text);
      expect(sim.editing(), text).toBe(w);
      sim.pv.endEditSession();
    }
    const sim = setup('aa\n\nbb\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    setCaretAtOffset(w, 1);
    expect(key(w, 'Backspace').defaultPrevented).toBe(false);
  });

  it('B4/U3+U4: an accidental Enter is undone by a Backspace typed before the session resumed', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    press(sim, 'Enter');
    frame();
    expect(sim.text()).toBe('alpha\n\nbeta\n\nafter\n');
    press(sim, 'Backspace');                     // queued: the resumed session is not there yet
    sim.pump();
    expect(sim.text()).toBe('alphabeta\n\nafter\n');
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe(5);
  });

  it('B4+B5/U1: ⌘Z right after an Enter split merges the blocks back through source.history', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    sim.enableHistory();
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    press(sim, 'Enter');
    frame();
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('beta');
    const z = press(sim, 'z', ctrlKey('z'));
    expect(z.defaultPrevented).toBe(true);
    expect(sim.text()).toBe('alphabeta\n\nafter\n');
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe(5);
  });

  it('B5/U1: ⌘Z / ⇧⌘Z flush, step the source history, and keep the session at the step', () => {
    installFakeExec();
    const sim = setup('para\n\nnext\n');
    sim.enableHistory();
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'para');
    for (const ch of ' more') press(sim, ch);
    frame();
    expect(sim.text()).toBe('para more\n\nnext\n');
    press(sim, '!');
    press(sim, '!');                             // pending: ⌘Z writes it first, then undoes that step
    expect(press(sim, 'z', ctrlKey('z')).defaultPrevented).toBe(true);
    expect(sim.historyCalls).toEqual([false]);
    expect(sim.text()).toBe('para more\n\nnext\n');
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe(9);
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    expect(sim.text()).toBe('para\n\nnext\n');
    expect(caretOffset(sim.editing()!)).toBe(4);
    press(sim, 'z', ctrlKey('z', true));
    sim.pump();
    expect(sim.text()).toBe('para more\n\nnext\n');
    press(sim, 'z', ctrlKey('z', true));
    sim.pump();
    expect(sim.text()).toBe('para more!!\n\nnext\n');
    // nothing left to redo: nothing happens, the session stays as it is
    const before = sim.editing()!;
    const n = sim.sessions.length;
    expect(press(sim, 'z', ctrlKey('z', true)).defaultPrevented).toBe(true);
    expect(sim.editing()).toBe(before);
    expect(sim.sessions.length).toBe(n);
    press(sim, '?');                             // at the position the step returned (this fake: where it begins)
    frame();
    expect(sim.text()).toBe('para more?!!\n\nnext\n');
  });

  it('B5/U1: after an undo the session waits for the structure that shows it (never edits the stale DOM)', () => {
    installFakeExec();
    const sim = setup('some _em_ text\n\nnext\n');
    sim.enableHistory(false);                    // the worker's structure for the step comes later
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'text');
    press(sim, '!');
    frame();
    expect(sim.text()).toBe('some *em* text!\n\nnext\n');
    sim.pump();                                  // the worker's render of the write is held
    press(sim, 'z', ctrlKey('z'));
    expect(sim.text()).toBe('some _em_ text\n\nnext\n');
    sim.pump();
    expect(sim.editing()).toBeNull();            // the old structure / the pre-undo DOM: no session yet
    sim.resegment();
    sim.pump();
    const now = sim.editing()!;
    expect(now).toBe(sim.block(0));
    expect(now.textContent!.trim()).toBe('some em text');
    expect(caretOffset(now)).toBe(5);            // where the step's change begins
    press(sim, 'Z');
    frame();
    expect(sim.text()).toBe('some Z*em* text\n\nnext\n');
  });

  it('B5: without source.history ⌘Z is left to the browser', () => {
    installFakeExec();
    const sim = setup('para\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const e = key(w, 'z', ctrlKey('z'));
    expect(e.defaultPrevented).toBe(false);
    expect(sim.editing()).toBe(w);
  });
});

describe('fix round 0.2.0 — cheap low items (B7)', () => {
  it('a block whose inline code contains `<!--` is editable (only real comments are refused)', () => {
    const sim = setup('- 规则 `/^ {0,3}<!--/` 匹配注释\n- 第二项\n\n真注释 <!-- x --> 在此\n');
    mousedown(sim.block(0).querySelector('li')!);
    expect(sim.editing()).toBe(sim.block(0));
    expect(sim.toasts).toEqual([]);
    sim.pv.endEditSession();
    mousedown(sim.block(1).querySelector('p')!);
    expect(sim.editing()).toBeNull();
    expect(sim.toasts.map((t) => t.text)).toEqual([NOT_EDITABLE_TEXT]);
  });
});

describe('fix round 0.2.0 — IME in the resume window (U4)', () => {
  it('a composition that starts in the window and lasts longer than the resume timeout still lands', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    press(sim, 'Enter');
    frame();
    const cap = document.activeElement as HTMLTextAreaElement;
    expect(cap instanceof HTMLTextAreaElement).toBe(true);
    cap.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    cap.value = 'zhong';
    sim.pump();                                  // the block is ready, but the composition is open
    vi.advanceTimersByTime(4000);                // longer than the resume timeout
    expect(sim.editing()).toBeNull();
    cap.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
    frame();
    expect(sim.text()).toBe('alpha\n\n中beta\n\nafter\n');
    expect(sim.editing()).toBe(sim.block(1));
  });
});

// ---------------------------------------------------------------- fix round 2 (fix-session-1)
/** Separate press / release / click events (U7). */
function down(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }));
}
function up(target: Element, init: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...init }));
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
}
function selectIn(a: Node, ao: number, b: Node, bo: number): void {
  const sel = document.getSelection()!;
  sel.removeAllRanges();
  const r = document.createRange();
  r.setStart(a, ao); r.setEnd(b, bo);
  sel.addRange(r);
}
/** The Sim's source without the synchronous worker: writes land in the text, the structure comes on `resegment()`. */
function slowWorker(sim: Sim): () => void {
  const replace = sim.source.replace;
  sim.source.replace = (s0, c, t) => { sim.replaces.push({ startLine: s0, lineCount: c, text: t }); sim.lines.splice(s0 - 1, c, ...t.split('\n')); };
  return () => { sim.source.replace = replace; };
}

describe('U7 — a session starts when the button is released', () => {
  it('the press alone starts nothing; the release in the same block starts the session with the browser caret kept', () => {
    const sim = setup('first para\n\nsecond para\n');
    const p = sim.block(1).querySelector('p')!;
    down(p);
    expect(sim.editing()).toBeNull();
    expect(sim.block(1).hasAttribute('contenteditable')).toBe(false);
    selectIn(p.firstChild!, 3, p.firstChild!, 3);           // where the browser put the caret
    up(p);
    expect(sim.editing()).toBe(sim.block(1));
    expect(caretOffset(sim.block(1))).toBe(3);
  });

  it('a selection dragged inside one block starts the session with that selection kept', () => {
    const sim = setup('first para\n\nsecond para\n');
    const p = sim.block(1).querySelector('p')!;
    down(p);
    selectIn(p.firstChild!, 0, p.firstChild!, 6);
    up(p);
    expect(sim.editing()).toBe(sim.block(1));
    expect(document.getSelection()!.toString()).toBe('second');
  });

  it('a drag across a block boundary starts no session and keeps the selection', () => {
    const sim = setup('first para\n\nsecond para\n');
    const p0 = sim.block(0).querySelector('p')!, p1 = sim.block(1).querySelector('p')!;
    down(p0);
    selectIn(p0.firstChild!, 2, p1.firstChild!, 3);
    up(p1);
    expect(sim.editing()).toBeNull();
    expect(document.getSelection()!.toString()).toContain('rst para');
    // released in the block it went down in, but the selection reaches beyond it: no session either
    down(p0);
    selectIn(p0.firstChild!, 2, p1.firstChild!, 3);
    up(p0);
    expect(sim.editing()).toBeNull();
  });

  it('a press in another block ends the session at once (written) and starts the next one on release', () => {
    const sim = setup('one\n\ntwo\n');
    mousedown(sim.block(0).querySelector('p')!);
    typeAtEnd(sim.block(0), '1');
    const p1 = sim.block(1).querySelector('p')!;
    down(p1);
    expect(sim.text()).toBe('one1\n\ntwo\n');
    expect(sim.editing()).toBeNull();
    up(p1);
    expect(sim.editing()).toBe(sim.block(1));
  });

  it('modifier presses keep their meaning: no session', () => {
    const sim = setup('one\n\ntwo\n');
    for (const m of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      mousedown(sim.block(1).querySelector('p')!, m);
      expect(sim.editing()).toBeNull();
    }
  });

  it('the end a press causes does not re-render the block before the release', () => {
    const sim = setup('one\n\ntwo\n');
    const w0 = sim.block(0);
    mousedown(w0.querySelector('p')!);
    typeAtEnd(w0, '1');
    const p = w0.querySelector('p')!;
    const p1 = sim.block(1).querySelector('p')!;
    down(p1);                                    // ends the session on "one1"
    sim.pump();                                  // the worker's HTML for "one1" arrives during the press
    expect(w0.querySelector('p')).toBe(p);       // held: nothing moves under the pointer
    up(p1);
    sim.pump();
    expect(w0.querySelector('p')).not.toBe(p);   // re-rendered after the click
    expect(w0.textContent!.trim()).toBe('one1');
  });

  it('⌘A selects the block; ⌘A again ends the session and selects the whole preview', () => {
    const sim = setup('one\n\ntwo\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    const first = key(w, 'a', ctrlKey('a'));
    expect(first.defaultPrevented).toBe(false);  // the browser's select-all inside the editing host
    const r = document.createRange(); r.selectNodeContents(w);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    const second = key(w, 'a', ctrlKey('a'));
    expect(second.defaultPrevented).toBe(true);
    expect(sim.editing()).toBeNull();
    const text = document.getSelection()!.toString();
    expect(text).toContain('one');
    expect(text).toContain('two');
  });

  it('a click while the write of the ended session is still on its way waits for the structure', () => {
    installFakeExec();
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w0 = sim.block(0);
    mousedown(w0.querySelector('p')!);
    const restore = slowWorker(sim);
    // a hard break: the block grows by one line, so every later block moves down
    w0.querySelector('p')!.innerHTML = 'one<br>more';
    input(w0);
    const p2 = sim.block(2).querySelector('p')!;
    down(p2);                                    // ends the session: written, the structure not there yet
    expect(sim.text()).toBe('one  \nmore\n\ntwo\n\nthree\n');
    selectIn(p2.firstChild!, 2, p2.firstChild!, 2);
    up(p2);
    expect(sim.editing()).toBeNull();            // waits instead of starting on stale line numbers
    press(sim, 'X');                             // typed meanwhile: queued
    restore();
    sim.resegment();
    sim.pump();
    expect(sim.editing()).toBe(sim.block(2));
    frame();
    expect(sim.text()).toBe('one  \nmore\n\ntwo\n\nthXree\n');
  });

  it('a checkbox clicked while the write is on its way is toggled once the structure caught up — the right task', () => {
    const toggles: number[] = [];
    const sim = setup('one\n\n- [ ] a\n- [ ] b\n');
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    const w0 = sim.block(0);
    mousedown(w0.querySelector('p')!);
    const restore = slowWorker(sim);
    w0.querySelector('p')!.innerHTML = 'one<br>more';
    input(w0);
    const box = sim.block(1).querySelectorAll('input')[1] as HTMLInputElement;
    down(box);
    box.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    box.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);    // not toggled against the old structure
    expect(toggles).toEqual([]);
    restore();
    sim.resegment();
    expect(toggles).toEqual([5]);                // "- [ ] b" is line 5 of the current source
  });
});

describe('U9 — an emptied block', () => {
  function emptyBlock(sim: Sim, i: number): HTMLElement {
    const w = sim.block(i);
    mousedown(w.querySelector('p, h1, h2, li')!);
    for (const e of Array.from(w.querySelectorAll('p, h1, h2'))) e.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    return w;
  }

  it('the first, the last and the only block: no blank line stays behind', () => {
    let sim = setup('# 标题\n\n甲段落文字。\n\n乙段落文字。\n');
    emptyBlock(sim, 1);
    expect(sim.text()).toBe('# 标题\n\n乙段落文字。\n');
    sim = setup('甲\n\n乙\n');
    emptyBlock(sim, 0);
    expect(sim.text()).toBe('乙\n');
    sim = setup('甲\n\n乙\n');
    emptyBlock(sim, 1);
    expect(sim.text()).toBe('甲\n');
    sim = setup('甲\n');
    const parent = sim.block(0).parentElement;
    const w = emptyBlock(sim, 0);
    expect(sim.text()).toBe('');
    expect(sim.editing()).toBe(w);
    expect(w.isConnected).toBe(true);
    expect(w.parentElement).toBe(parent);        // never moved (a move takes the focus away)
    sim.pv.endEditSession();
    expect(sim.pv.el.querySelectorAll('.is-editing, .md-ghost-holder, [contenteditable]').length).toBe(0);
  });

  it('flush() (⌘S) writes the deletion now and keeps the session', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    w.querySelector('p')!.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    (sim.pv as PreviewApi & { flushEditSession(): void }).flushEditSession();
    expect(sim.text()).toBe('one\n\nthree\n');
    expect(sim.editing()).toBe(w);
  });

  it('text typed next is written as a new block at the same place and the session continues on it', () => {
    installFakeExec();
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = emptyBlock(sim, 1);
    expect(sim.text()).toBe('one\n\nthree\n');
    w.querySelector('p')!.textContent = 'new';
    setCaretAtOffset(w, 3);
    input(w);
    frame();
    expect(sim.text()).toBe('one\n\nnew\n\nthree\n');
    sim.pump();
    const next = sim.editing();
    expect(next).not.toBeNull();
    expect(next).not.toBe(w);
    expect(next!.textContent!.trim()).toBe('new');
    expect(w.isConnected).toBe(false);           // the emptied wrapper went once the session moved on
    press(sim, '!');
    frame();
    expect(sim.text()).toBe('one\n\nnew!\n\nthree\n');
  });

  it('typed into an emptied last block: appended after a blank line', () => {
    const sim = setup('one\n\ntwo');
    const w = emptyBlock(sim, 1);
    expect(sim.text()).toBe('one\n');
    w.querySelector('p')!.textContent = 'X';
    setCaretAtOffset(w, 1);
    input(w);
    frame();
    expect(sim.text()).toBe('one\n\nX');
  });

  it('a click elsewhere leaves the emptied element: nothing more is written, the click acts on the current structure', () => {
    const toggles: number[] = [];
    const sim = setup('甲段落文字。\n\n- [ ] 任务一\n- [ ] 任务二\n');
    sim.bus.on('source:edit', (e) => { if (e.kind === 'toggleTask') toggles.push(e.line); });
    const w = emptyBlock(sim, 0);
    expect(sim.text()).toBe('- [ ] 任务一\n- [ ] 任务二\n');
    const n = sim.replaces.length;
    const box = sim.pv.el.querySelectorAll('input')[1] as HTMLInputElement;
    down(box);
    expect(w.isConnected).toBe(true);            // nothing moves before the release
    box.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    box.click();                                 // the browser's click: toggles, change event
    expect(toggles).toEqual([2]);
    expect(sim.replaces.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(w.isConnected).toBe(false);           // removed after the click
  });

  it('⌘Z in the emptied element brings the block back (U1)', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    sim.enableHistory();
    emptyBlock(sim, 1);
    expect(sim.text()).toBe('one\n\nthree\n');
    const w = sim.editing()!;
    key(w, 'z', ctrlKey('z'));
    expect(sim.text()).toBe('one\n\ntwo\n\nthree\n');
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('two');
  });
});

describe('G12 / G16 / robustness', () => {
  it('⌘Z whose step lands far away scrolls its line into view', () => {
    const sim = setup('one\n\ntwo\n\nthree\n');
    sim.enableHistory();
    mousedown(sim.block(0).querySelector('p')!);
    typeAtEnd(sim.block(0), '!');
    frame();
    sim.pv.endEditSession();
    // pretend the line is off screen: the scroller is 0 px high; record what is scrolled
    Object.defineProperty(sim.pv.el, 'clientHeight', { value: 0, configurable: true });
    const scrolled: number[] = [];
    Object.defineProperty(sim.pv.el, 'scrollTop', { get: () => 500, set: (v: number) => { scrolled.push(v); }, configurable: true });
    mousedown(sim.block(2).querySelector('p')!);
    key(sim.block(2), 'z', ctrlKey('z'));
    expect(sim.text()).toBe('one\n\ntwo\n\nthree\n');
    expect(scrolled.length).toBeGreaterThan(0);  // the step's line (1) was scrolled to
    expect(scrolled[0]).toBe(0);
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('one');
  });

  it('a new document (doc:loaded) ends a waiting resume: its queued keys never reach the new text', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    const restore = slowWorker(sim);
    press(sim, 'Enter');
    frame();
    press(sim, 'Q');                             // queued for the resume
    expect(sim.pv.el.querySelector('textarea')).not.toBeNull();
    restore();
    sim.lines = ['NEW', '', 'DOC', ''];
    sim.bus.emit('doc:loaded', { docId: 'x', name: 'x.md' });
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(false);
    sim.resegment();
    sim.pump();
    expect(sim.text()).toBe('NEW\n\nDOC\n');
    expect(sim.editing()).toBeNull();
  });

  it('end() while only a resume waits cancels it and gives the focus back', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    const restore = slowWorker(sim);
    press(sim, 'Enter');
    frame();
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(true);
    sim.pv.endEditSession();
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(false);
    restore();
    sim.resegment();
    sim.pump();
    expect(sim.editing()).toBeNull();
  });

  it('a resume completing while a modal question is up does not take its focus', () => {
    installFakeExec();
    const sim = setup('alphabeta\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'alpha');
    const restore = slowWorker(sim);
    press(sim, 'Enter');
    frame();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const btn = document.createElement('button');
    dialog.appendChild(btn);
    document.body.appendChild(dialog);
    btn.focus();
    restore();
    sim.resegment();
    sim.pump();
    expect(sim.editing()).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it('end() tears the session down even when the write throws', () => {
    const sim = setup('one\n\ntwo\n');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    sim.source.replace = () => { throw new Error('boom'); };
    typeAtEnd(w, '!');
    sim.pv.endEditSession();
    expect(err).toHaveBeenCalled();
    expect(sim.editing()).toBeNull();
    expect(w.hasAttribute('contenteditable')).toBe(false);
    expect(sim.sessions.at(-1)).toEqual({ id: null });
  });

  it('a new document forgets the refusal throttle', () => {
    const sim = setup('---\n');
    mousedown(sim.block(0).querySelector('hr')!);
    expect(sim.toasts.length).toBe(1);
    sim.bus.emit('doc:loaded', { docId: 'y', name: 'y.md' });
    mousedown(sim.block(0).querySelector('hr')!);
    expect(sim.toasts.length).toBe(2);
  });
});

// ---------------------------------------------------------------- fix-session-2 (stage 2b)
/** jsdom has no Selection.modify: the parts the resume replay uses (G10), on the editing host's visible text. */
function installFakeModify(): void {
  const modify = function (this: Selection, alter: string, dir: string, unit: string): void {
    const n = this.focusNode;
    if (!n) return;
    const host = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('[contenteditable="true"]');
    if (!host) return;
    const text = Array.from(host.querySelectorAll('p, li, h1, h2, h3, pre')).length > 0 ? null : null;
    void text;
    const all = (() => { const w = document.createTreeWalker(host, 4); let t = ''; for (let x = w.nextNode(); x; x = w.nextNode()) t += (x as Text).data; return t; })();
    const pos = textOffsetOf(host, n, this.focusOffset);
    let to = pos;
    const fwd = dir === 'forward';
    if (unit === 'character') to = pos + (fwd ? 1 : -1);
    else if (unit === 'word') {
      if (fwd) { const m = /\S*\s*/y; m.lastIndex = pos; m.exec(all); to = m.lastIndex; }
      else { let i = pos; while (i > 0 && /\s/.test(all[i - 1])) i--; while (i > 0 && !/\s/.test(all[i - 1])) i--; to = i; }
    } else to = fwd ? all.length : 0;          // line / paragraph / document boundary: one-line blocks here
    to = Math.max(0, Math.min(all.length, to));
    const anchor = { node: this.anchorNode!, offset: this.anchorOffset };
    setCaretAtOffset(host, to);
    if (alter === 'extend') {
      const f = { node: this.focusNode!, offset: this.focusOffset };
      this.setBaseAndExtent(anchor.node, anchor.offset, f.node, f.offset);
    }
  };
  Object.defineProperty(Selection.prototype, 'modify', { value: modify, configurable: true, writable: true });
}

describe('fix-session-2 — keys, resume, paste, lists (G10, G11, G13, U8)', () => {
  afterEach(() => { delete (Selection.prototype as { modify?: unknown }).modify; });

  it('G10: the ⌘ / Ctrl editing keys of each platform', () => {
    const k = (key: string, init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent('keydown', { key, ...init });
    // macOS key bindings
    expect(editCmdOf(k('ArrowRight', { metaKey: true }), true)).toBe('lineEnd');
    expect(editCmdOf(k('ArrowLeft', { metaKey: true }), true)).toBe('lineStart');
    expect(editCmdOf(k('ArrowUp', { metaKey: true }), true)).toBe('docStart');
    expect(editCmdOf(k('ArrowDown', { metaKey: true, shiftKey: true }), true)).toBe('docEnd');
    expect(editCmdOf(k('Backspace', { metaKey: true }), true)).toBe('delLineBack');
    expect(editCmdOf(k('a', { metaKey: true, code: 'KeyA' }), true)).toBe('selectAll');
    expect(editCmdOf(k('e', { ctrlKey: true, code: 'KeyE' }), true)).toBe('paraEnd');
    expect(editCmdOf(k('a', { ctrlKey: true, code: 'KeyA' }), true)).toBe('paraStart');
    expect(editCmdOf(k('k', { ctrlKey: true, code: 'KeyK' }), true)).toBe('delParaFwd');
    expect(editCmdOf(k('d', { ctrlKey: true, code: 'KeyD' }), true)).toBe('delFwd');
    expect(editCmdOf(k('h', { ctrlKey: true, code: 'KeyH' }), true)).toBe('delBack');
    expect(editCmdOf(k('b', { ctrlKey: true, altKey: true, code: 'KeyB' }), true)).toBe('wordBack');
    expect(editCmdOf(k('s', { metaKey: true, code: 'KeyS' }), true)).toBeNull();      // ⌘S goes its own way
    expect(editCmdOf(k('ArrowRight', { altKey: true }), true)).toBeNull();            // plain ⌥→ is a RESUME_KEY
    // elsewhere: Chrome's Ctrl editing keys
    expect(editCmdOf(k('ArrowRight', { ctrlKey: true }), false)).toBe('wordFwd');
    expect(editCmdOf(k('Backspace', { ctrlKey: true }), false)).toBe('delWordBack');
    expect(editCmdOf(k('End', { ctrlKey: true }), false)).toBe('docEnd');
    expect(editCmdOf(k('a', { ctrlKey: true, code: 'KeyA' }), false)).toBe('selectAll');
    expect(editCmdOf(k('e', { ctrlKey: true, code: 'KeyE' }), false)).toBeNull();
  });

  it('G10: Ctrl / ⌘ caret and deletion keys pressed in the resume window are queued and replayed in order', () => {
    installFakeExec();
    installFakeModify();
    const sim = setup('abcdef\n\nnext\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    frame();
    expect(sim.text()).toBe('abc\n\ndef\n\nnext\n');
    expect(sim.editing()).toBeNull();
    // (jsdom: not a Mac, so Ctrl is the platform's key) Ctrl+End = end of the block, then a character
    expect(press(sim, 'End', { ctrlKey: true }).defaultPrevented).toBe(true);
    press(sim, 'Q');
    sim.pump();
    frame();
    expect(sim.text()).toBe('abc\n\ndefQ\n\nnext\n');

    const sim2 = setup('abcdef\n\nnext\n');
    const w2 = sim2.block(0);
    mousedown(w2.querySelector('p')!);
    caretAfterText(w2, 'abc');
    press(sim2, 'Enter');
    frame();
    press(sim2, 'X');
    press(sim2, 'Y');
    expect(press(sim2, 'Backspace', { ctrlKey: true }).defaultPrevented).toBe(true);   // the word typed so far
    press(sim2, 'Q');
    sim2.pump();
    frame();
    expect(sim2.text()).toBe('abc\n\nQdef\n\nnext\n');
  });

  it('item 5 / G16: in the resume window keys meant for something else keep their meaning', () => {
    installFakeExec();
    const sim = setup('abcdef\n\nnext\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    frame();
    expect(document.activeElement instanceof HTMLTextAreaElement).toBe(true);    // the capture holds the focus
    // a toolbar / dialog button outside the preview: Tab and Escape are not taken
    const button = document.createElement('button');
    document.body.appendChild(button);
    expect(key(button, 'Tab').defaultPrevented).toBe(false);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    let reached = false;
    document.body.addEventListener('keydown', () => { reached = true; }, { once: true });
    button.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(false);
    expect(reached).toBe(true);
    // an app question came up while the capture element still had the focus: its keys are its own
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    const cap = document.activeElement as HTMLElement;
    expect(key(cap, 'Enter').defaultPrevented).toBe(false);
    expect(key(cap, 'x').defaultPrevented).toBe(false);
    dialog.remove();
    // none of these was queued for the session
    press(sim, 'Q');
    sim.pump();
    frame();
    expect(sim.text()).toBe('abc\n\nQdef\n\nnext\n');
  });

  it('G11: a split written while the caret sits in an empty last paragraph: typing goes where the caret was', () => {
    installFakeExec();
    const sim = setup('abc\n\nnext\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    commitText(sim, 'def');
    press(sim, 'Enter');                         // all in one frame: the caret is in an empty third paragraph
    frame();
    expect(sim.text()).toBe('abc\n\ndef\n\nnext\n');
    for (const ch of 'ghi') press(sim, ch);
    sim.pump();
    sim.pump();
    expect(sim.text()).toBe('abc\n\ndef\n\nghi\n\nnext\n');
    expect(sim.editing()?.textContent?.trim()).toBe('ghi');
  });

  it('G11: the empty paragraph between two others is recreated after the one before it', () => {
    installFakeExec();
    const sim = setup('abc\n\nnext\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    commitText(sim, 'def');
    // an empty paragraph between abc and def, the caret in it (as after Enter at the end of abc, then ↑)
    const empty = document.createElement('p');
    empty.appendChild(document.createElement('br'));
    w.querySelectorAll('p')[0].after(empty);
    const r = document.createRange();
    r.setStart(empty, 0);
    r.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    frame();
    expect(sim.text()).toBe('abc\n\ndef\n\nnext\n');
    press(sim, 'X');
    sim.pump();
    sim.pump();
    expect(sim.text()).toBe('abc\n\nX\n\ndef\n\nnext\n');
  });

  it('G13: Enter at the end of an item, then Tab / Shift+Tab: the caret stays in the moved, empty item', () => {
    installFakeExec();
    const sim = setup('- on\n- two\n\nafter\n');
    const w = sim.block(0);
    mousedown(w.querySelector('li')!);
    caretAfterText(w, 'on');
    press(sim, 'Enter');
    expect(press(sim, 'Tab').defaultPrevented).toBe(true);
    for (const ch of 'child') press(sim, ch);
    frame();
    expect(sim.text()).toBe('- on\n  - child\n- two\n\nafter\n');

    const sim2 = setup('- on\n  - in\n- two\n\nafter\n');
    const w2 = sim2.block(0);
    mousedown(w2.querySelectorAll('li')[1]);
    caretAfterText(w2, 'in');
    press(sim2, 'Enter');
    press(sim2, 'Tab', { shiftKey: true });
    for (const ch of 'out') press(sim2, ch);
    frame();
    expect(sim2.text()).toBe('- on\n  - in\n- out\n- two\n\nafter\n');
  });

  it('U8: a paste that would make the block longer than MAX_EDIT_CHARS is refused, nothing inserted', () => {
    const { calls } = installFakeExec();
    const sim = setup('abc\n\nq\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    caretAfterText(w, 'abc');
    const html = w.innerHTML;
    expect(pasteInto(p, 'y'.repeat(MAX_EDIT_CHARS)).defaultPrevented).toBe(true);
    expect(sim.toasts.at(-1)?.text).toBe(PASTE_TOO_LONG_TEXT);
    expect(PASTE_TOO_LONG_TEXT).toBe('粘贴的内容太长，请在源码编辑器中粘贴');
    expect(w.innerHTML).toBe(html);
    // lines count with their hard breaks: 20 000 lines of 1 character + 2 × 19 999 > 60 000
    pasteInto(p, Array.from({ length: 20000 }, () => 'x').join('\n'));
    expect(w.innerHTML).toBe(html);
    frame();
    expect(sim.text()).toBe('abc\n\nq\n');
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual([]);
  });

  it('U8: a long multi-line paste below the limit is one DOM insertion (no editing command per line)', () => {
    const { calls } = installFakeExec();
    const sim = setup('abc def\n\nq\n');
    const w = sim.block(0);
    const p = w.querySelector('p')!;
    mousedown(p);
    caretAfterText(w, 'abc');
    const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`);
    pasteInto(p, lines.join('\n'));
    expect(calls.filter((c) => c.startsWith('insert'))).toEqual([]);
    frame();
    expect(sim.text()).toBe(`abc${lines.join('  \n')} def\n\nq\n`);
    press(sim, 'Z');                             // the caret is at the end of the pasted text
    frame();
    expect(sim.lines[999]).toBe('line999Z def');
  });

  it('U8: paragraphs pasted into an emptied block (caret directly in the wrapper) become paragraphs there', () => {
    installFakeExec();
    const sim = setup('one\n\ntwo\n\nthree\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    w.replaceChildren();                         // everything selected and deleted: nothing left in the wrapper
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    expect(sim.text()).toBe('one\n\nthree\n');
    setCaretAtOffset(w, 0);
    pasteInto(w, 'A\n\nB');
    frame();
    expect(sim.text()).toBe('one\n\nA\n\nB\n\nthree\n');
  });

  it('item 6: the caret an undo step restores counts raw inline HTML as no text and never splits an emoji', () => {
    installFakeExec();
    const doc = 'a <kbd>K</kbd> b x😀😀😀😀😀😀😀😀 end\n\nnext\n';
    const sim = setup(doc);
    sim.enableHistory();
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, ' b');
    press(sim, 'Q');
    frame();
    expect(sim.lines[0]).toBe('a <kbd>K</kbd> bQ x😀😀😀😀😀😀😀😀 end');
    press(sim, 'z', ctrlKey('z'));
    sim.pump();
    expect(sim.text()).toBe(doc);
    expect(caretOffset(sim.editing()!)).toBe('a K b'.length);   // where the undone Q was
    press(sim, 'Z');
    frame();
    expect(sim.lines[0]).toBe('a <kbd>K</kbd> bZ x😀😀😀😀😀😀😀😀 end');
    // a visible-text offset inside a surrogate pair is never a caret position
    const p = sim.editing()!.querySelector('p')!;
    setCaretAtOffset(p, 'a K bZ x'.length + 3);
    const sel = document.getSelection()!;
    const t = sel.focusNode as Text;
    expect(/[\udc00-\udfff]/.test(t.data[sel.focusOffset] ?? '')).toBe(false);
  });
});

describe('fix-session-3 — U13 Enter before whitespace, U14 leading blank lines', () => {
  const nbsp = String.fromCharCode(0xa0);
  /** Enter with the caret after `needle` in block `i`; the split is written in the next frame. */
  function enterAfter(sim: Sim, i: number, needle: string, init: KeyboardEventInit = {}): HTMLElement {
    const w = sim.block(i);
    mousedown(w.querySelector('p, li, h1, h2, td')!);
    caretAfterText(w, needle);
    press(sim, 'Enter', init);
    frame();
    return w;
  }

  it('U13: the whitespace after the caret does not start the new paragraph (one space, three, a tab, a soft break)', () => {
    for (const doc of ['abc def\n\nnext\n', 'abc   def\n\nnext\n', 'abc\tdef\n\nnext\n', 'abc\ndef\n\nnext\n']) {
      installFakeExec();
      const sim = setup(doc);
      enterAfter(sim, 0, 'abc');
      expect(sim.text(), JSON.stringify(doc)).toBe('abc\n\ndef\n\nnext\n');
      sim.pump();
      expect(sim.editing()?.textContent?.trim(), JSON.stringify(doc)).toBe('def');
      expect(caretOffset(sim.editing()!)).toBe(0);
      press(sim, 'Q');
      frame();
      expect(sim.text(), JSON.stringify(doc)).toBe('abc\n\nQdef\n\nnext\n');
      sim.pv.endEditSession();
    }
  });

  it('U13: a heading, a quote paragraph, a list item, a nested item and a task item', () => {
    const cases: Array<[string, string]> = [
      ['# abc def\n', '# abc\n\ndef\n'],
      ['> abc def\n', '> abc\n>\n> def\n'],
      ['- abc def\n', '- abc\n- def\n'],
      ['- top\n  - abc   def\n', '- top\n  - abc\n  - def\n'],
      ['- [ ] abc def\n', '- [ ] abc\n- [ ] def\n'],
    ];
    for (const [doc, want] of cases) {
      installFakeExec();
      const sim = setup(doc);
      enterAfter(sim, 0, 'abc');
      sim.pv.endEditSession();
      expect(sim.text(), JSON.stringify(doc)).toBe(want);
    }
  });

  it('U13: the run after a selection\'s end; only whitespace after the caret leaves an empty paragraph', () => {
    installFakeExec();
    let sim = setup('xabc def\n');
    let w = sim.block(0);
    mousedown(w.querySelector('p')!);
    const t = w.querySelector('p')!.firstChild as Text;
    const r = document.createRange(); r.setStart(t, 1); r.setEnd(t, 4);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    press(sim, 'Enter');
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('x\n\ndef\n');
    sim = setup('abc&#32;&#32;\n\nnext\n');
    w = enterAfter(sim, 0, 'abc');
    expect(w.querySelectorAll('p').length).toBe(2);
    expect(w.querySelectorAll('p')[1].textContent).toBe('');           // an empty paragraph (G11), no NBSP
    sim.pv.endEditSession();
    expect(sim.text()).not.toContain('&nbsp;');
  });

  it('U13: the document\'s own non-breaking space, U+3000 and code keep their whitespace', () => {
    installFakeExec();
    let sim = setup('abc&nbsp;def\n');
    enterAfter(sim, 0, 'abc');
    sim.pv.endEditSession();
    expect(sim.text()).toBe('abc\n\n&nbsp;def\n');
    sim = setup('abc &nbsp;def\n');
    enterAfter(sim, 0, 'abc');
    sim.pv.endEditSession();
    expect(sim.text()).toBe('abc\n\n&nbsp;def\n');
    const ideo = String.fromCharCode(0x3000);
    sim = setup(`abc${ideo}def\n`);
    enterAfter(sim, 0, 'abc');
    sim.pv.endEditSession();
    expect(sim.text()).toBe(`abc\n\n${ideo}def\n`);
    sim = setup('```\nabc def\n```\n');
    const w = sim.block(0);
    mousedown(w.querySelector('pre')!);
    caretAfterText(w, 'abc');
    press(sim, 'Enter');
    frame();
    sim.pv.endEditSession();
    expect(sim.text()).toBe('```\nabc\n def\n```\n');
  });

  it('U13: Shift+Enter before a space writes the hard break without &nbsp;', () => {
    installFakeExec();
    const sim = setup('abc def\n');
    enterAfter(sim, 0, 'abc', { shiftKey: true });
    sim.pv.endEditSession();
    expect(sim.text()).toBe('abc  \ndef\n');
    expect(sim.text()).not.toContain(nbsp);
  });

  it('U13: an Enter replayed in the resume window drops the whitespace too', () => {
    installFakeExec();
    const sim = setup('abc def\n\nnext\n');
    sim.enableHistory();
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'X');
    frame();
    expect(sim.text()).toBe('abcX def\n\nnext\n');
    press(sim, 'z', ctrlKey('z'));              // the undo step resumes with the caret after "abc" ...
    expect(sim.text()).toBe('abc def\n\nnext\n');
    press(sim, 'Enter');                         // ... and this Enter waits in the queue for it
    sim.pump();
    frame();
    sim.pump();
    expect(sim.text()).toBe('abc\n\ndef\n\nnext\n');
  });

  it('U13: ⌘Z after an Enter before a space gives the original back, ⇧⌘Z the split', () => {
    installFakeExec();
    const sim = setup('abc def\n');
    sim.enableHistory();
    enterAfter(sim, 0, 'abc');
    expect(sim.text()).toBe('abc\n\ndef\n');
    sim.pump();
    press(sim, 'z', ctrlKey('z'));
    expect(sim.text()).toBe('abc def\n');
    sim.pump();
    press(sim, 'z', ctrlKey('z', true));
    expect(sim.text()).toBe('abc\n\ndef\n');
  });

  it('U14: a write keeps the blank lines before the first block\'s content (blank and whitespace-only)', () => {
    for (const lead of ['\n', '  \n', '\t\n']) {
      const doc = `${lead}abc\n\ndef\n`;
      const sim = setup(doc);
      expect(sim.blocks[0].startLine, JSON.stringify(doc)).toBe(1);
      expect(sim.blocks[0].lineCount, JSON.stringify(doc)).toBe(3);          // the blank line is in the block's range
      const w = sim.block(0);
      mousedown(w.querySelector('p')!);
      typeAtEnd(w, 'X');
      frame();
      expect(sim.text(), JSON.stringify(doc)).toBe(`${lead}abcX\n\ndef\n`);
      typeAtEnd(w, 'Y');
      frame();
      expect(sim.text(), JSON.stringify(doc)).toBe(`${lead}abcXY\n\ndef\n`);
      sim.pv.endEditSession();
      expect(sim.text(), JSON.stringify(doc)).toBe(`${lead}abcXY\n\ndef\n`);
    }
  });

  it('U14: an Enter in the first block keeps them, and the session resumes on the split-off part', () => {
    installFakeExec();
    const sim = setup('\nabcdef\n\nnext\n');
    enterAfter(sim, 0, 'abc');
    expect(sim.text()).toBe('\nabc\n\ndef\n\nnext\n');
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('def');
    press(sim, 'Q');
    frame();
    expect(sim.text()).toBe('\nabc\n\nQdef\n\nnext\n');
  });

  it('U14: an emptied first block leaves them; typed text goes after them and the session continues', () => {
    installFakeExec();
    const sim = setup('\nabc\n\ndef\n');
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    w.querySelector('p')!.textContent = '';
    input(w, { inputType: 'deleteContentBackward' });
    frame();
    expect(sim.text()).toBe('\ndef\n');
    w.querySelector('p')!.textContent = 'N';
    setCaretAtOffset(w, 1);
    input(w);
    frame();
    expect(sim.text()).toBe('\nN\n\ndef\n');
    sim.pump();
    expect(sim.editing()?.textContent?.trim()).toBe('N');
    press(sim, '!');
    frame();
    expect(sim.text()).toBe('\nN!\n\ndef\n');
    // the only block of the document
    const one = setup('\nabc\n');
    const w1 = one.block(0);
    mousedown(w1.querySelector('p')!);
    w1.querySelector('p')!.textContent = '';
    input(w1, { inputType: 'deleteContentBackward' });
    frame();
    expect(one.text()).toBe('');
    w1.querySelector('p')!.textContent = 'N';
    setCaretAtOffset(w1, 1);
    input(w1);
    frame();
    expect(one.text()).toBe('\nN\n');
  });

  it('U14: Backspace merges the second paragraph into a first block with a leading blank line', () => {
    installFakeExec();
    const sim = setup('\nabc\n\ndef\n');
    const w = sim.block(1);
    mousedown(w.querySelector('p')!);
    setCaretAtOffset(w, 0);
    expect(press(sim, 'Backspace').defaultPrevented).toBe(true);
    expect(sim.text()).toBe('\nabcdef\n');
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe(3);
    press(sim, 'Z');
    frame();
    expect(sim.text()).toBe('\nabcZdef\n');
  });

  it('U14: ⌘Z resumes in a first block with a leading blank line at the undone place', () => {
    installFakeExec();
    const doc = '\nabc def\n\nnext\n';
    const sim = setup(doc);
    sim.enableHistory();
    const w = sim.block(0);
    mousedown(w.querySelector('p')!);
    caretAfterText(w, 'abc');
    press(sim, 'X');
    frame();
    expect(sim.text()).toBe('\nabcX def\n\nnext\n');
    press(sim, 'z', ctrlKey('z'));
    expect(sim.text()).toBe(doc);
    sim.pump();
    expect(sim.editing()).toBe(sim.block(0));
    expect(caretOffset(sim.editing()!)).toBe(3);
    press(sim, 'Y');
    frame();
    expect(sim.text()).toBe('\nabcY def\n\nnext\n');
  });

  it('U14 mirror: the last block keeps 0, 1 or 3 trailing blank lines (and a missing final newline)', () => {
    for (const tail of ['', '\n', '\n\n', '\n\n\n\n']) {
      const doc = `abc\n\nlast${tail}`;
      const sim = setup(doc);
      const w = sim.block(1);
      mousedown(w.querySelector('p')!);
      typeAtEnd(w, 'X');
      frame();
      sim.pv.endEditSession();
      expect(sim.text(), JSON.stringify(doc)).toBe(`abc\n\nlastX${tail}`);
    }
  });
});

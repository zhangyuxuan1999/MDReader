// @vitest-environment jsdom
// test/r6-fr-guard.test.ts — fix-refs (0.2.0 stage 2g, fix round 6): THE GUARD of CONTRACT §11 "Round-5 verification
// decisions". (1) writeReveals as a function. (2) A real session (createPreview + the editing chunk, a CodeMirror / worker
// stand-in as in test/inlineEdit.test.ts): a forged serializer result that adds a character the user did not put in is
// refused — nothing is written, the toast 此块请在源码中编辑 shows, the session ends; what the user typed, composed or
// pasted passes (an emoji with a zero-width joiner and a variation selector, Persian text with a zero-width non-joiner, a
// pasted full-width space, consecutive spaces); the user's input survives a resume (a split).
// Characters are built from code points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-fr-guard.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { NOT_EDITABLE_TEXT, writeReveals, writeGuardStats } from '../src/preview/inlineEdit';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, DEFAULT_RENDER_OPTIONS,
  type HtmlItem, type PreviewApi, type PreviewSourceAccess, type StructureMsg, type ToastSpec,
} from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { blockSource, identify, segmentAll, type Block } from '../src/worker/segmenter';
import { loadInlineEdit } from '../src/preview/inlineEditLoader';

// A forged serializer: while FORGE.add is set, every serialization ends with it (a character nobody typed).
const FORGE = vi.hoisted(() => ({ add: '' }));
vi.mock('../src/preview/serialize', async (orig) => {
  const m = await orig<typeof import('../src/preview/serialize')>();
  return { ...m, serializeBlock: (...a: Parameters<typeof m.serializeBlock>) => m.serializeBlock(...a) + FORGE.add };
});
await loadInlineEdit();

const ch = (...cps: number[]): string => String.fromCodePoint(...cps);
const ZWJ = ch(0x200d), ZWNJ = ch(0x200c), VS16 = ch(0xfe0f), RLO = ch(0x202e), NBSP = ch(0xa0), IDSP = ch(0x3000);

describe('writeReveals', () => {
  it('a character that is not plainly visible and that the replaced text does not hold is refused', () => {
    expect(writeReveals('a b', 'a' + RLO + ' b')).toBe(RLO);
    expect(writeReveals('a b', 'a' + NBSP + 'b')).toBe(NBSP);
    expect(writeReveals('a' + RLO + 'b', 'a' + RLO + 'bX')).toBe(null);
    expect(writeReveals('a' + RLO + 'b', 'a' + RLO + RLO + 'b')).toBe(RLO);
    expect(writeReveals('x', 'x' + ch(0xe0041))).toBe(ch(0xe0041));
    expect(writeReveals('x', 'x' + ch(0x3164))).toBe(ch(0x3164));   // a blank glyph
    expect(writeReveals('x', 'x' + ch(0xfffc))).toBe(ch(0xfffc));
  });
  it('U+0020, line feed and tab never count; letters, digits, punctuation, symbols with ink never do', () => {
    expect(writeReveals('a', 'a  \n\t b 中文 😀 ½ → ¤')).toBe(null);
    expect(writeReveals('a', 'a &zwnj; &#x202E;')).toBe(null);   // references are visible characters
  });
  it('what the user put in is allowed, and only that much', () => {
    const put = new Map([[ZWJ, 1]]);
    expect(writeReveals('a', 'a' + ZWJ, put)).toBe(null);
    expect(writeReveals('a', 'a' + ZWJ + ZWJ, put)).toBe(ZWJ);
  });
});

// ---------------------------------------------------------------- a real session
const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
class FakeResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

class Sim {
  lines: string[];
  blocks: Block[] = [];
  version = 0;
  nextId = 1;
  requested = new Set<number>();
  dirty = new Set<number>();
  replaces: Array<{ startLine: number; lineCount: number; text: string }> = [];
  bus = createBus();
  toasts: ToastSpec[] = [];
  pv: PreviewApi;
  source: PreviewSourceAccess;
  constructor(text: string) {
    this.lines = text.split('\n');
    this.source = {
      read: (start, count) => this.lines.slice(start - 1, start - 1 + count).join('\n'),
      replace: (start, count, t) => {
        this.replaces.push({ startLine: start, lineCount: count, text: t });
        this.lines.splice(start - 1, count, ...t.split('\n'));
        this.resegment();
      },
    };
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    this.bus.on('toast', (t) => { this.toasts.push(t); });
    this.pv = createPreview({ parent, bus: this.bus, request: (ids) => { for (const id of ids) this.requested.add(id); }, viewport: () => {}, resync: () => {}, source: this.source });
    Object.defineProperty(this.pv.el, 'clientHeight', { value: 4000, configurable: true });
    this.resegment();
  }
  resegment(): void {
    const segs = segmentAll(this.lines);
    const { N, dirty } = identify(this.lines, this.blocks, segs, () => this.nextId++);
    this.blocks = N;
    for (const id of dirty) this.dirty.add(id);
    this.version++;
    const arr = new Int32Array(N.length * BLOCK_STRIDE);
    N.forEach((b, i) => { arr[i * BLOCK_STRIDE + B_ID] = b.id; arr[i * BLOCK_STRIDE + B_START] = b.startLine; arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount; arr[i * BLOCK_STRIDE + B_KIND] = b.kind; });
    const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: this.lines.length, readingMinutes: 0 };
    const m: StructureMsg = { type: 'structure', version: this.version, blocks: arr, changed: Int32Array.from(dirty), lineCount: this.lines.length, stats, outlineVersion: 1 };
    this.pv.applyStructure(m);
  }
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
}

/** Chrome's insertText, enough for these tests (fires `input` on the editing host). */
function installFakeExec(): void {
  const exec = (cmd: string, _ui?: boolean, value?: string): boolean => {
    if (cmd === 'defaultParagraphSeparator') return true;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const n = range.startContainer;
    const ed = (n.nodeType === 1 ? n as Element : n.parentElement)?.closest('[contenteditable="true"]');
    if (!ed || cmd !== 'insertText') return false;
    if (!range.collapsed) range.deleteContents();
    let t: Text;
    let at: number;
    if (n.nodeType === 3) { t = n as Text; at = range.startOffset; t.insertData(at, value ?? ''); } else { t = document.createTextNode(value ?? ''); n.insertBefore(t, n.childNodes[range.startOffset] ?? null); at = 0; }
    const r = document.createRange(); r.setStart(t, at + (value ?? '').length); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: cmd, data: value ?? null }));
    return true;
  };
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true, writable: true });
}
function click(target: Element): void {
  const o = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(new MouseEvent('mousedown', o));
  target.dispatchEvent(new MouseEvent('mouseup', o));
  target.dispatchEvent(new MouseEvent('click', o));
}
function caretAfterText(el: Element, needle: string): void {
  const w = document.createTreeWalker(el, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = (n as Text).data.indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange(); r.setStart(n, i + needle.length); r.collapse(true);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
    return;
  }
  throw new Error(`"${needle}" not in block`);
}
/** Text the user types or an IME commits: beforeinput, then the browser's insertion. */
function typeText(sim: Sim, text: string, inputType = 'insertText'): void {
  const ed = sim.editing()!;
  ed.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: text }));
  document.execCommand('insertText', false, text);
}
function compose(sim: Sim, text: string): void {
  const ed = sim.editing()!;
  ed.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  ed.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertCompositionText', data: text }));
  document.execCommand('insertText', false, text);
  ed.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
}
function paste(sim: Sim, text: string): void {
  const e = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(e, 'clipboardData', { value: { getData: (t: string) => (t === 'text/plain' ? text : '') } });
  sim.editing()!.dispatchEvent(e);
}
const live: Sim[] = [];
function setup(text: string): Sim {
  const sim = new Sim(text);
  live.push(sim);
  sim.pv.setPreviewEditable(true);
  frame();
  sim.pump();
  return sim;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  installFakeExec();
  FORGE.add = '';
});
afterEach(() => {
  for (const x of live.splice(0)) x.pv.dispose();
  delete (document as { execCommand?: unknown }).execCommand;
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
  FORGE.add = '';
});

describe('THE GUARD in a session', () => {
  it('a forged serializer result with an added invisible character is refused: nothing written, the toast, the session ends', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    const fired = writeGuardStats.fired;
    FORGE.add = RLO;
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'X');
    frame(); frame();
    expect(sim.replaces).toEqual([]);
    expect(sim.text()).toBe('# T\n\nFirst para words.\n\nSecond.\n');
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
    expect(sim.editing()).toBe(null);
    expect(writeGuardStats.fired).toBe(fired + 1);
  });
  it('a block whose untouched serialization already reveals a character is refused at the start', () => {
    // raw HTML <code> with a reference: it renders as inline code holding U+00AD, which code cannot spell as a reference
    const sim = setup('# T\n\nFirst <code>a&shy;b</code> words.\n');
    const starts = writeGuardStats.starts;
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).toBe(null);
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
    expect(writeGuardStats.starts).toBe(starts + 1);
  });
  const typedCases: Array<[string, (sim: Sim) => void, string]> = [
    ['an emoji with a zero-width joiner and a variation selector, typed', (sim) => typeText(sim, ch(0x1f469) + ZWJ + ch(0x2764) + VS16 + ZWJ + ch(0x1f468)), ch(0x1f469) + ZWJ + ch(0x2764) + VS16 + ZWJ + ch(0x1f468)],
    ['Persian text with a zero-width non-joiner, composed', (sim) => compose(sim, 'می' + ZWNJ + 'خواهم'), 'می' + ZWNJ + 'خواهم'],
    ['a pasted full-width space', (sim) => paste(sim, 'a' + IDSP + 'b'), 'a' + IDSP + 'b'],
    ['an emoji with a joiner, pasted', (sim) => paste(sim, ch(0x1f3f3) + VS16 + ZWJ + ch(0x1f308)), ch(0x1f3f3) + VS16 + ZWJ + ch(0x1f308)],
  ];
  for (const [name, act, want] of typedCases) {
    it(`what the user put in passes: ${name}`, () => {
      const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
      click(sim.block(1).querySelector('p')!);
      caretAfterText(sim.editing()!, 'words');
      act(sim);
      frame(); frame();
      expect(sim.text()).toBe(`# T\n\nFirst para words${want}.\n\nSecond.\n`);
      expect(sim.toasts.map((t) => t.text)).not.toContain(NOT_EDITABLE_TEXT);
    });
  }
  it('consecutive spaces (the browser shows them as non-breaking spaces) pass', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    caretAfterText(sim.editing()!, 'words');
    // Chromium puts U+00A0 for typed spaces where they would collapse
    sim.editing()!.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ' ' }));
    sim.editing()!.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: ' ' }));
    document.execCommand('insertText', false, NBSP + ' X');
    frame(); frame();
    expect(sim.toasts.map((t) => t.text)).not.toContain(NOT_EDITABLE_TEXT);
    expect(sim.replaces.length).toBe(1);
    expect(sim.text()).not.toContain(NBSP);
  });
  it('a forged character the user did type once passes once, a second one is refused', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, ZWJ);
    frame(); frame();
    expect(sim.text()).toBe(`# T\n\nFirst para words${ZWJ}.\n\nSecond.\n`);
    FORGE.add = ZWJ;            // the serializer now adds one more than the user typed
    typeText(sim, 'Y');
    frame(); frame();
    expect(sim.text()).toBe(`# T\n\nFirst para words${ZWJ}.\n\nSecond.\n`);
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
  });
  it('the user\'s input lasts across a resume (a split), and end() forgets it', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    caretAfterText(sim.editing()!, 'words');
    // typed, then taken out again before any write: the input is received and not spent
    typeText(sim, ZWJ);
    const t = document.getSelection()!.focusNode as Text;
    t.deleteData(t.data.indexOf(ZWJ), 1);
    caretAfterText(sim.editing()!, 'words');
    frame(); frame();
    // the split: a pasted blank line makes two paragraphs; the session resumes on the second
    paste(sim, 'one\n\ntwo');
    frame(); frame();
    sim.pump();
    frame(); frame();
    const ed = sim.editing();
    expect(ed).not.toBe(null);
    FORGE.add = ZWJ;            // a write holding the ZWJ the user typed before the split, once more
    typeText(sim, 'Z');
    frame(); frame();
    expect(sim.toasts.map((t) => t.text)).not.toContain(NOT_EDITABLE_TEXT);
    // Esc: end() forgets what the user put in; a new session on the same text refuses the forged character
    ed!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    frame(); frame(); sim.pump();
    FORGE.add = '';
    const before = sim.text();
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    caretAfterText(sim.editing()!, 'First');
    FORGE.add = ch(0x2060);
    typeText(sim, 'Q');
    frame(); frame();
    expect(sim.text()).toBe(before);
  });
});

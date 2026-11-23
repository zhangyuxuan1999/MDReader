// @vitest-environment jsdom
// test/r6-cr-guard.test.ts — challenge-refs (0.2.0 stage 2g, fix round 6): THE GUARD itself (inlineEdit.ts replaceSource),
// with a forged serializer (vi.mock, as in fix-refs' test/r6-fr-guard.test.ts, whose session stand-in is copied here
// unchanged): after a refused write the session is not stuck and the next edit behaves; a refusal in the merge path
// (Backspace at the start of a paragraph, tryMergeBackward); a refusal after earlier accepted writes keeps those writes;
// a refused session start can be clicked again (refused again, with the toast) and another block still edits.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-cr-guard.test.ts
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

function key(sim: Sim, k: string): void {
  sim.editing()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
function caretAtStart(el: Element): void {
  const w = document.createTreeWalker(el, 4);
  const n = w.nextNode() as Text;
  const r = document.createRange(); r.setStart(n, 0); r.collapse(true);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
}
const toastCount = (sim: Sim): number => sim.toasts.filter((t) => t.text === NOT_EDITABLE_TEXT).length;

describe('challenge-refs: THE GUARD, after it fired', () => {
  it('a refused write, then a new session on the same block: it starts and the next edit is written', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    FORGE.add = RLO;
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'X');
    frame(); frame();
    expect(sim.text()).toBe('# T\n\nFirst para words.\n\nSecond.\n');
    expect(sim.editing()).toBe(null);
    expect(toastCount(sim)).toBe(1);
    expect(sim.pv.el.querySelectorAll('[contenteditable="true"]').length).toBe(0);
    sim.pump();
    FORGE.add = '';
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'Y');
    frame(); frame();
    expect(sim.text()).toBe('# T\n\nFirst para wordsY.\n\nSecond.\n');
    expect(toastCount(sim)).toBe(1);
  });
  it('a refusal after accepted writes keeps them and writes nothing more', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond.\n');
    click(sim.block(1).querySelector('p')!);
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'A');
    frame(); frame();
    expect(sim.text()).toBe('# T\n\nFirst para wordsA.\n\nSecond.\n');
    const n = sim.replaces.length;
    FORGE.add = ch(0x2066);
    typeText(sim, 'B');
    frame(); frame();
    expect(sim.replaces.length).toBe(n);
    expect(sim.text()).toBe('# T\n\nFirst para wordsA.\n\nSecond.\n');
    expect(sim.editing()).toBe(null);
    expect(toastCount(sim)).toBe(1);
  });
  it('a refusal in the merge path (Backspace at the start of a paragraph): nothing written, the toast, not stuck', () => {
    const sim = setup('# T\n\nFirst para words.\n\nSecond words.\n');
    click(sim.block(2).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    caretAtStart(sim.editing()!);
    FORGE.add = RLO;
    key(sim, 'Backspace');
    frame(); frame(); sim.pump(); frame();
    expect(sim.text()).toBe('# T\n\nFirst para words.\n\nSecond words.\n');
    expect(toastCount(sim)).toBeGreaterThanOrEqual(1);
    FORGE.add = '';
    click(sim.block(2).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    caretAfterText(sim.editing()!, 'Second');
    typeText(sim, 'Q');
    frame(); frame();
    expect(sim.text()).toBe('# T\n\nFirst para words.\n\nSecondQ words.\n');
  });
  it('a refused session start: clicked again it is refused again (the toast), another block still edits', () => {
    const sim = setup('# T\n\nFirst <code>a&shy;b</code> words.\n\nSecond words.\n');
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).toBe(null);
    const t1 = toastCount(sim);
    expect(t1).toBe(1);
    vi.advanceTimersByTime(5000);
    click(sim.block(1).querySelector('p')!);
    expect(sim.editing()).toBe(null);
    expect(toastCount(sim)).toBeGreaterThanOrEqual(t1);
    click(sim.block(2).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    caretAfterText(sim.editing()!, 'Second');
    typeText(sim, 'Q');
    frame(); frame();
    expect(sim.text()).toBe('# T\n\nFirst <code>a&shy;b</code> words.\n\nSecondQ words.\n');
  });
});

// @vitest-environment jsdom
// test/r6-frb-session.test.ts — fix-refs-b (0.2.0 stage 2g, fix round 6 after the challenge): CONTRACT §11 "Checkpoint H"
// in a real session (createPreview + the editing chunk, a CodeMirror / worker stand-in; the harness of
// test/r6-fr-guard.test.ts): B2 refuses a write whose Markdown reveals a HIDDEN character while a dropped raw copy keeps
// the raw count equal (the count rule of the guard would let it through) — in a commit and in a Backspace merge; B2 does
// not fire on what the user typed (twice in a row: the allowance is not spent); rule T refuses a block whose raw HTML the
// sanitizer changed (and a Markdown link whose scheme the sanitizer took), with the toast and nothing written, and a block
// when the sanitizer throws; raw HTML the sanitizer leaves alone stays editable; B3: a block with &nbsp; in an alt starts.
// Characters are built from code points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-frb-session.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { NOT_EDITABLE_TEXT, writeGuardStats } from '../src/preview/inlineEdit';
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
import { renderedShows, sanitizerKept } from '../src/preview/fidelity';
import { sourceStyleHints } from '../src/preview/serialize';

// A forged serializer (FORGE.map applied to every serialization while set: a writer defect) and a sanitizer that throws
// while FORGE.throwSanitize is set.
const FORGE = vi.hoisted(() => ({ map: null as ((s: string) => string) | null, throwSanitize: false }));
vi.mock('../src/preview/serialize', async (orig) => {
  const m = await orig<typeof import('../src/preview/serialize')>();
  return { ...m, serializeBlock: (...a: Parameters<typeof m.serializeBlock>) => { const s = m.serializeBlock(...a); return FORGE.map ? FORGE.map(s) : s; } };
});
vi.mock('../src/preview/sanitize', async (orig) => {
  const m = await orig<typeof import('../src/preview/sanitize')>();
  return { ...m, sanitizeToFragment: (h: string) => { if (FORGE.throwSanitize) throw new Error('forged sanitizer failure'); return m.sanitizeToFragment(h); } };
});
await loadInlineEdit();

const ch = (...cps: number[]): string => String.fromCodePoint(...cps);
const IDSP = ch(0x3000), ZWJ = ch(0x200d);

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
  FORGE.map = null; FORGE.throwSanitize = false;
});
afterEach(() => {
  for (const x of live.splice(0)) x.pv.dispose();
  delete (document as { execCommand?: unknown }).execCommand;
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
  FORGE.map = null; FORGE.throwSanitize = false;
});

const toasted = (sim: Sim): boolean => sim.toasts.some((t) => t.text === NOT_EDITABLE_TEXT);
function keydown(sim: Sim, key: string): void {
  sim.editing()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('B2 in a session: a dropped raw copy cannot pay for a revealed one', () => {
  it('a commit: the reference written raw while the cell-edge copy is dropped is refused (the count rule alone passes it)', () => {
    const src = `# T\n\n| h | k |\n| --- | --- |\n| ${IDSP}a | y&#x3000;z words |\n`;
    const sim = setup(src);
    click(sim.block(1).querySelectorAll('td')[1]);
    expect(sim.editing()).not.toBe(null);
    const fired = writeGuardStats.fired;
    FORGE.map = (s) => s.replace('&#x3000;', IDSP);
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'X');
    frame(); frame();
    expect(sim.replaces).toEqual([]);
    expect(sim.text()).toBe(src);
    expect(toasted(sim)).toBe(true);
    expect(sim.editing()).toBe(null);
    expect(writeGuardStats.fired).toBe(fired + 1);
  });
  it('the same block without the forgery is written, the reference kept', () => {
    const sim = setup(`# T\n\n| h | k |\n| --- | --- |\n| ${IDSP}a | y&#x3000;z words |\n`);
    click(sim.block(1).querySelectorAll('td')[1]);
    caretAfterText(sim.editing()!, 'words');
    typeText(sim, 'X');
    frame(); frame();
    expect(toasted(sim)).toBe(false);
    expect(sim.text()).toBe('# T\n\n| h | k |\n| --- | --- |\n| a | y&#x3000;z wordsX |\n');
  });
  it('a Backspace merge: the merged paragraph\'s own Markdown is checked before it is joined to the one above', () => {
    const src = `# T\n\nFirst para.\n\n${IDSP}Second y&#x3000;z words.\n`;
    const sim = setup(src);
    click(sim.block(2).querySelector('p')!);
    expect(sim.editing()).not.toBe(null);
    FORGE.map = (s) => s.replace('&#x3000;', IDSP);
    caretAfterText(sim.editing()!, '');
    keydown(sim, 'Backspace');
    frame(); frame();
    expect(sim.replaces).toEqual([]);
    expect(sim.text()).toBe(src);
    expect(toasted(sim)).toBe(true);
  });
  it('a merge without the forgery is written', () => {
    const sim = setup(`# T\n\nFirst para.\n\n${IDSP}Second y&#x3000;z words.\n`);
    click(sim.block(2).querySelector('p')!);
    caretAfterText(sim.editing()!, '');
    keydown(sim, 'Backspace');
    frame(); frame();
    expect(toasted(sim)).toBe(false);
    expect(sim.text()).toBe(`# T\n\nFirst para.${IDSP}Second y&#x3000;z words.\n`);   // (an untouched block keeps its own source)
  });
  it('what the user typed into code passes at every write (the allowance is not spent)', () => {
    const sim = setup('# T\n\nLead `code` y&zwj;z words.\n');
    click(sim.block(1).querySelector('p')!);
    caretAfterText(sim.editing()!, 'co');
    typeText(sim, ZWJ);
    frame(); frame();
    typeText(sim, 'Q');
    frame(); frame();
    expect(toasted(sim)).toBe(false);
    expect(sim.text()).toBe(`# T\n\nLead \`co${ZWJ}Qde\` y&zwj;z words.\n`);
  });
});

describe('rule T in a session', () => {
  const refused: Array<[string, string]> = [
    ['an event handler', 'See <span onclick="f()">x</span> words.'],
    ['an inline frame', 'See <iframe src="https://player.example/v"></iframe> words.'],
    ['a script', 'See <script>f()</script> words.'],
    ['a javascript: href', 'See <a href="javascript:f()">x</a> words.'],
    ['a Markdown link whose scheme the sanitizer takes', 'See [x](obsidian://open) words.'],
  ];
  for (const [name, para] of refused) {
    it(`refused at the start: ${name}`, () => {
      const src = `# T\n\n${para}\n`;
      const sim = setup(src);
      click(sim.block(1).querySelector('p')!);
      expect(sim.editing()).toBe(null);
      expect(toasted(sim)).toBe(true);
      expect(sim.text()).toBe(src);
    });
  }
  const editable: Array<[string, string]> = [
    ['kbd', 'See <kbd>k</kbd> words.'],
    ['abbr with a title', 'See <abbr title="t">a</abbr> words.'],
    ['a span with a class', 'See <span class="note">x</span> words.'],
    ['an img with a width', 'See <img src="i.png" width="300"> words.'],
  ];
  for (const [name, para] of editable) {
    it(`editable: ${name}`, () => {
      const sim = setup(`# T\n\n${para}\n`);
      click(sim.block(1).querySelector('p')!);
      expect(sim.editing()).not.toBe(null);
      caretAfterText(sim.editing()!, 'words');
      typeText(sim, 'X');
      frame(); frame();
      expect(toasted(sim)).toBe(false);
      expect(sim.text()).toBe(`# T\n\n${para.replace('words.', 'wordsX.')}\n`);
    });
  }
  it('the sanitizer throwing: sanitizerKept refuses, renderedShows gives nothing (no exception reaches the session start)', () => {
    FORGE.throwSanitize = true;
    try {
      expect(sanitizerKept('See <kbd>k</kbd> words.')).toBe(false);
      expect(renderedShows('See <kbd>k</kbd> a&shy;b words.')).toBe(null);
      expect(sourceStyleHints('See <kbd>k</kbd> a&shy;b words.').hidden).toBe(undefined);
    } finally { FORGE.throwSanitize = false; }
    expect(sanitizerKept('See <kbd>k</kbd> words.')).toBe(true);
  });
});

describe('B3 in a session', () => {
  for (const para of ['Lead ![a&nbsp;b](i.png) words.', 'Lead [t](https://e.example/p "a&nbsp;b") words.', 'Lead <span title="a&nbsp;b">t</span> words.']) {
    it(`a block with the no-break-space reference in an alt, a title or a raw attribute starts and keeps it: ${para}`, () => {
      const sim = setup(`# T\n\n${para}\n`);
      const starts = writeGuardStats.starts;
      click(sim.block(1).querySelector('p')!);
      expect(sim.editing()).not.toBe(null);
      expect(writeGuardStats.starts).toBe(starts);
      caretAfterText(sim.editing()!, 'words');
      typeText(sim, 'X');
      frame(); frame();
      expect(sim.text()).toBe(`# T\n\n${para.replace('words.', 'wordsX.')}\n`);
    });
  }
});

// @vitest-environment jsdom
// test/r6-int-session.test.ts — integrate (0.2.0 stage 2g, fix round 6): rule T (CONTRACT §11, Checkpoint H: "a block is
// editable only if the sanitizer left its rendering as the renderer made it") for blocks WITHOUT raw HTML, in a real
// session (the harness of test/r6-frb-session.test.ts, copied). Before the integrator's change startAllowed checked
// sanitizerKept only for a source with `<`, so a Markdown title or alt that DOMPurify trims (edge spaces) or removes
// (SAFE_FOR_XML: a value holding `-->`) was written back sanitized at the first keystroke: `[x](u "a-->b")` became
// `[x](u)`. Also: raw HTML plus a reference link whose definition (another block) has a scheme the sanitizer takes.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-int-session.test.ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { NOT_EDITABLE_TEXT } from '../src/preview/inlineEdit';
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
import { sanitizerKept } from '../src/preview/fidelity';
import { sanitizeToFragment } from '../src/preview/sanitize';

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

describe('rule T for Markdown-only blocks (integrator)', () => {
  const refused: Array<[string, string]> = [
    ['a link title holding -->', 'See [x](https://e.example/ "a-->b") words.'],
    ['a link title with edge spaces', 'See [x](https://e.example/ " a ") words.'],
    ['an image title holding ]>', 'See ![i](p.png "a]>b") words.'],
    ['an image alt holding -->', 'See ![a-->b](p.png) words.'],
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
    ['a link with a title', 'See [x](https://e.example/ "a title") words.'],
    ['an image with alt and title', 'See ![an alt](p.png "t") words.'],
    ['an empty anchor in raw HTML', 'See <a name="anchor">n</a> words.'],
    ['a formula and emphasis', 'See $x^2$ and *em* words.'],
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
  it('a heading whose name DOMPurify would clobber-check stays editable', () => {
    const sim = setup('# Cookie\n\nText words.\n');
    click(sim.block(0).querySelector('h1')!);
    expect(sim.editing()).not.toBe(null);
    expect(toasted(sim)).toBe(false);
  });
});

describe('rule T: raw HTML plus a reference whose scheme the sanitizer takes (definition in another block)', () => {
  it('sanitizerKept with the mounted block refuses; without it the source alone passes', () => {
    const src = 'See <kbd>k</kbd> [x][r] words.';
    const r = mdk.renderBlock(src, { references: { R: { href: 'obsidian://open', title: '' } } as never });
    const w = document.createElement('section');
    w.replaceChildren(sanitizeToFragment(r.html));
    expect(w.querySelector('a:not([href])')).not.toBe(null);
    expect(sanitizerKept(src)).toBe(true);
    expect(sanitizerKept(src, w)).toBe(false);
    const ok = 'See <kbd>k</kbd> [x][r] words.';
    const r2 = mdk.renderBlock(ok, { references: { R: { href: 'https://e.example/', title: '' } } as never });
    const w2 = document.createElement('section');
    w2.replaceChildren(sanitizeToFragment(r2.html));
    expect(sanitizerKept(ok, w2)).toBe(true);
    const anchor = 'See <a name="n">t</a> words.';
    const w3 = document.createElement('section');
    w3.replaceChildren(sanitizeToFragment(mdk.renderBlock(anchor, { references: {} }).html));
    expect(sanitizerKept(anchor, w3)).toBe(true);
  });
});

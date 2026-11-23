// @vitest-environment jsdom
// test/r5-fa-session.test.ts — fix-atoms (stage 2f, fix round 5): N1 = PTR-1 + KEYS-1 (rule P-G, CONTRACT §11,
// Round-4 verification decisions) at the session, against the real preview (createPreview, inlineEdit), the real
// segmenter / identity rule and the real markdown-it renderer (a compact copy of test/inlineEdit.test.ts's simulator).
// The session stamps its block's atoms when it prepares the DOM (and never a document's stamp), the write after a join
// whose nodes the browser re-created keeps every atom's Markdown, the moved-in checkbox leaves the session DOM, the
// stamps leave the DOM when the session ends and are kept off the clipboard while the browser copies.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { NOT_EDITABLE_TEXT } from '../src/preview/inlineEdit';
import { STAMP_SELECTOR } from '../src/preview/serialize';
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
// Rule L: the editing module is a chunk of its own; load it first so setPreviewEditable(true) installs it at once.
await loadInlineEdit();

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
class FakeResizeObserver { constructor(public cb: unknown) {} observe(): void {} unobserve(): void {} disconnect(): void {} }
const BAKED = 'background-color: rgb(250, 248, 244);';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

class Sim {
  lines: string[];
  blocks: Block[] = [];
  version = 0;
  nextId = 1;
  requested = new Set<number>();
  dirty = new Set<number>();
  bus = createBus();
  toasts: ToastSpec[] = [];
  pv: PreviewApi;
  source: PreviewSourceAccess;
  constructor(text: string) {
    this.lines = text.split('\n');
    this.source = {
      read: (start, count) => this.lines.slice(start - 1, start - 1 + count).join('\n'),
      replace: (start, count, t) => { this.lines.splice(start - 1, count, ...t.split('\n')); this.resegment(); },
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
      this.requested.clear(); this.dirty.clear();
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
function click(target: Element): void {
  const o = { bubbles: true, cancelable: true, button: 0 };
  target.dispatchEvent(new MouseEvent('mousedown', o));
  target.dispatchEvent(new MouseEvent('mouseup', o));
  target.dispatchEvent(new MouseEvent('click', o));
}
const input = (t: Element): void => { t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' })); };
const key = (t: Element, k: string): void => { t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
function recreated(n: Node): Node {
  if (n.nodeType !== 1) return n.cloneNode(true);
  const t = document.createElement('template');
  t.innerHTML = (n as Element).outerHTML;
  const e = t.content.firstElementChild!;
  for (const a of Array.from(e.querySelectorAll('annotation'))) a.remove();
  if (!e.classList.contains('md-math')) e.setAttribute('style', BAKED);
  return e;
}
/** Chromium's join of list item `b` into `a`, the moved nodes re-created from markup inside a style span. */
function join(a: Element, b: Element): void {
  const wrap = document.createElement('span');
  wrap.setAttribute('style', BAKED);
  for (const c of Array.from(b.childNodes)) wrap.appendChild(recreated(c));
  a.appendChild(wrap);
  b.remove();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
const live: Sim[] = [];
afterEach(() => { for (const x of live.splice(0)) x.pv.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function setup(text: string): Sim {
  const sim = new Sim(text);
  live.push(sim);
  sim.pv.setPreviewEditable(true);
  frame();
  sim.pump();
  return sim;
}

describe('P-G at the session', () => {
  it('the session stamps its atoms, a join of re-created nodes writes every atom as it was, Esc leaves no stamp', () => {
    const sim = setup('- [ ] one $\\frac{a}{b}$\n- [x] Lead $x$ ![i](x.png) <span style="color:red">r</span> two\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('li')!);
    expect(sim.editing()).toBe(w);
    expect(w.querySelector('.md-math')!.getAttribute('data-mdr-tex')).toBe('\\frac{a}{b}');
    expect(w.querySelector('span[style*="color:red"]')!.getAttribute('data-mdr-ps')).toBe('{"style":"color:red"}');
    const [a, b] = Array.from(w.querySelectorAll('li'));
    join(a, b);
    for (const e of Array.from(w.querySelectorAll('[style*="color:red"]'))) e.setAttribute('style', 'color: red; ' + BAKED);
    input(w);
    frame(); frame();
    // (the space after the dropped box stays, P-G d)
    expect(sim.text()).toBe('- [ ] one $\\frac{a}{b}$ Lead $x$ ![i](x.png) <span style="color:red">r</span> two\n\nnext\n');
    // the moved-in box left the session DOM (the screen shows what is written)
    expect(w.querySelectorAll('input').length).toBe(1);
    key(w, 'Escape');
    expect(sim.editing()).toBe(null);
    expect(w.querySelector(STAMP_SELECTOR)).toBe(null);
  });

  it('a stamp the DOM already carried is not the session\'s: cleared at the start, the real TeX stamped', () => {
    const sim = setup('- one\n- Lead $x$ two\n\nnext\n');
    const w = sim.block(0);
    w.querySelector('.md-math')!.setAttribute('data-mdr-tex', '\\text{EVIL}');
    click(w.querySelector('li')!);
    expect(w.querySelector('.md-math')!.getAttribute('data-mdr-tex')).toBe('x');
    const [a, b] = Array.from(w.querySelectorAll('li'));
    join(a, b);
    input(w);
    frame(); frame();
    expect(sim.text()).toBe('- oneLead $x$ two\n\nnext\n');
  });

  it('a document carrying the stamp names: the block is refused at the click, nothing is written', () => {
    const sim = setup('Fix <span class="c" data-mdr-tex="\\text{EVIL}">here</span> $x$ now\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('p')!);
    expect(sim.editing()).toBe(null);
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
    expect(w.querySelector(STAMP_SELECTOR)).toBe(null);
    expect(sim.text()).toBe('Fix <span class="c" data-mdr-tex="\\text{EVIL}">here</span> $x$ now\n\nnext\n');
  });

  it('a formula re-created without its stamp: the write is refused (nothing written, the session ends, the toast)', () => {
    const sim = setup('- one\n- Lead $\\frac{a}{b}$ two\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('li')!);
    const [a, b] = Array.from(w.querySelectorAll('li'));
    join(a, b);
    w.querySelector('.md-math')!.removeAttribute('data-mdr-tex');   // (no gesture does this: the stamp is an attribute)
    input(w);
    frame(); frame();
    expect(sim.text()).toBe('- one\n- Lead $\\frac{a}{b}$ two\n\nnext\n');
    expect(sim.editing()).toBe(null);
    expect(sim.toasts.map((t) => t.text)).toContain(NOT_EDITABLE_TEXT);
  });

  it('a copy during the session: the stamps are off the DOM while the browser copies, back right after', () => {
    const sim = setup('Lead $x$ and <span style="color:red">r</span> two\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('p')!);
    const r = document.createRange();
    r.selectNodeContents(w.querySelector('p')!);
    const sel = document.getSelection()!;
    sel.removeAllRanges(); sel.addRange(r);
    let during = -1;
    const probe = (): void => { during = w.querySelectorAll(STAMP_SELECTOR).length; };
    document.addEventListener('copy', probe);           // (bubble phase: after the session's capture listener)
    document.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
    document.removeEventListener('copy', probe);
    expect(during).toBe(0);
    vi.advanceTimersByTime(1);
    expect(w.querySelector('.md-math')!.getAttribute('data-mdr-tex')).toBe('x');
    expect(w.querySelector('span[style*="color:red"]')!.getAttribute('data-mdr-ps')).toBe('{"style":"color:red"}');
  });

  it('a cut: the stamps of what it deletes whole go off for the browser\'s copy; an element it cuts into keeps its own', () => {
    const sim = setup('Lead $x$ and <span style="color:red">red words</span> two\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('p')!);
    const span = w.querySelector('span[style*="color:red"]')!;
    const r = document.createRange();
    r.setStart(w.querySelector('p')!.firstChild!, 0);                  // from "Lead" …
    r.setEnd(span.firstChild!, 3);                                      // … into the span ("red| words")
    const sel = document.getSelection()!;
    sel.removeAllRanges(); sel.addRange(r);
    let during: [boolean, boolean] = [true, true];
    const probe = (): void => { during = [w.querySelector('.md-math')!.hasAttribute('data-mdr-tex'), span.hasAttribute('data-mdr-ps')]; };
    document.addEventListener('cut', probe);
    document.dispatchEvent(new Event('cut', { bubbles: true, cancelable: true }));
    document.removeEventListener('cut', probe);
    expect(during).toEqual([false, true]);
    vi.advanceTimersByTime(1);
    expect(w.querySelector('.md-math')!.getAttribute('data-mdr-tex')).toBe('x');
  });

  it('a block whose baseline the gate refuses keeps no stamp', () => {
    // (a raw HTML checkbox in a paragraph: the serializer drops it, so the baseline does not render as shown)
    const sim = setup('Lead <input type="checkbox"> $x$ two\n\nnext\n');
    const w = sim.block(0);
    click(w.querySelector('p')!);
    expect(sim.editing()).toBe(null);
    expect(w.querySelector(STAMP_SELECTOR)).toBe(null);
  });
});

// @vitest-environment jsdom
// test/r7-fm-merge.test.ts — fix-merge (0.2.1, fix round 7): P1 (CONTRACT §11, Round-7 decisions; VF-1 of
// docs/FINDINGS-0.2.0-r6.md). Backspace at the start of a paragraph joins it to the paragraph above (U3). Before a merge
// is written, the block the session would continue in is tested as a start is tested; when it would be refused, the merge
// is refused: nothing is written, the toast 此块请在源码中编辑 shows, the session stays where it is (the caret at the start
// of its block) and the next typed character is written there. Before the change the join was written, the session on the
// merged block was refused at its start, and the typing was lost. The merges a start allows give what they gave.
// The session harness is the one of test/r6-int-session.test.ts (copied), with the document's reference definitions.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r7-fm-merge.test.ts
// R7FM_PRE=1 runs the same cases on the editing chunk as released in 0.2.0 (test/fixtures/src-0.2.0): the refused cases
// fail there (the join is written), the allowed ones pass.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { MAX_EDIT_CHARS, NOT_EDITABLE_TEXT } from '../src/preview/inlineEdit';
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
vi.mock('../src/preview/inlineEdit', async (orig) => (process.env.R7FM_PRE ? await import('./fixtures/src-0.2.0/preview/inlineEdit') : await orig()));
await loadInlineEdit();

const ch = (...cps: number[]): string => String.fromCodePoint(...cps);
const EMSP = ch(0x2003), SHY = ch(0xad);
const ZHE = ch(0x416);   // Ж, the typed character

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
  constructor(text: string, public refs: Record<string, { href: string; title: string }> = {}) {
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
        const r = mdk.renderBlock(blockSource(this.lines, b), { references: this.refs as never });
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
/** The caret at the very start of the block's first text. */
function caretAtStart(el: Element): void {
  const t = document.createTreeWalker(el, 4).nextNode();
  if (!t) throw new Error('no text in block');
  const r = document.createRange(); r.setStart(t, 0); r.collapse(true);
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(r);
}
function typeText(sim: Sim, text: string): void {
  const ed = sim.editing()!;
  ed.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  document.execCommand('insertText', false, text);
}
/** Backspace as the user presses it; true when the session handled it (the browser's own action prevented). */
function backspace(sim: Sim): boolean {
  const e = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true });
  sim.editing()!.dispatchEvent(e);
  return e.defaultPrevented;
}
const live: Sim[] = [];
function setup(text: string, refs?: Record<string, { href: string; title: string }>): Sim {
  const sim = new Sim(text, refs);
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
});
afterEach(() => {
  for (const x of live.splice(0)) x.pv.dispose();
  delete (document as { execCommand?: unknown }).execCommand;
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});
const toasted = (sim: Sim): number => sim.toasts.filter((t) => t.text === NOT_EDITABLE_TEXT).length;

const BELOW = '下面一段文字 below';
const doc = (prev: string, tail = ''): string => `# 合并\n\n${prev}\n\n${BELOW}\n${tail}`;

/** The paragraph above may not be edited in the preview, and neither may the block the merge would make. */
const REFUSED: Array<[string, string, string?, Record<string, { href: string; title: string }>?]> = [
  ['rule T: an inline iframe', '视频 <iframe src="https://www.youtube.com/embed/abc"></iframe> 说明文字'],
  ['rule T: an inline script', '统计 <script>window.x = 1;</script> 文字'],
  ['rule T: an event handler', '点 <a href="https://e.example/" onclick="track(1)">这里</a> 查看'],
  ['rule T: an event handler on an image', '图 <img src="a.png" onerror="x()"> 文字'],
  ['rule T: a javascript: link', '点 <a href="javascript:void(0)">展开</a> 查看'],
  ['rule T: a custom element', '组件 <my-card data-id="7">卡片</my-card> 文字'],
  ['rule T: a style element', '样式 <style>.n { color: gray }</style> 文字'],
  ['rule T: a button', '按钮 <button>点我</button> 文字'],
  ['rule T: a Markdown title the sanitizer removes', '链接 [x](https://e.example/ "a-->b") 文字'],
  ['rule T: a Markdown link whose scheme the sanitizer takes', '链接 [笔记](obsidian://open?vault=x) 文字'],
  ['rule T: a reference link whose definition (another block) has such a scheme', '见 [笔记][r] 文字', '\n[r]: obsidian://open\n', { R: { href: 'obsidian://open', title: '' } }],
  ['rule T: an id the sanitizer removes (clobbering)', '前文 <span id="title">锚点</span> 结尾文字'],
  ['the gate: del and ins side by side', '前文 <del>旧</del><ins>新</ins> 文本'],
  ['the gate: b and i side by side', '前文 <b>粗</b> <i>斜</i> 文本'],
  ['the guard: a raw soft hyphen in an autolink and its reference in the text', `Go <https://e.example/a${SHY}b> and c&shy;d 文字`],
  ['the guard: a raw soft hyphen in raw code and its reference in the text', `前 <code>a${SHY}b</code> c&shy;d 文字`],
  ['a control character written as a reference in a raw attribute', '前文 <a href="x" title="a&#1;b">t</a> 文字'],
];

describe('P1: a merge into a block a start refuses is refused', () => {
  for (const [name, prev, tail, refs] of REFUSED) {
    it(name, () => {
      const src = doc(prev, tail ?? '');
      const sim = setup(src, refs);
      // the paragraph above is refused at its own start (the precondition of the case)
      click(sim.block(1));
      expect(sim.editing(), 'the block above starts no session').toBe(null);
      const t0 = toasted(sim);
      expect(t0).toBe(1);
      vi.advanceTimersByTime(5000);                // (past the toast's repeat window)
      click(sim.block(2).querySelector('p')!);
      const el = sim.editing();
      expect(el).not.toBe(null);
      caretAtStart(el!);
      expect(backspace(sim)).toBe(true);
      frame(); frame(); sim.pump();
      expect(sim.replaces, 'nothing written').toEqual([]);
      expect(sim.text()).toBe(src);
      expect(toasted(sim) - t0, 'the toast').toBe(1);
      expect(sim.editing(), 'the session stays where it is').toBe(el);
      typeText(sim, ZHE);
      frame(); frame();
      expect(sim.text()).toBe(src.replace(BELOW, ZHE + BELOW));
      expect(sim.editing()).toBe(el);
    });
  }
  it('the block the merge would make is too long for a session (each paragraph alone is not)', () => {
    const prev = 'x'.repeat(MAX_EDIT_CHARS - 4);
    const src = doc(prev);
    const sim = setup(src);
    click(sim.block(2).querySelector('p')!);
    const el = sim.editing()!;
    expect(el).not.toBe(null);
    caretAtStart(el);
    expect(backspace(sim)).toBe(true);
    frame(); frame(); sim.pump();
    expect(sim.replaces).toEqual([]);
    expect(toasted(sim)).toBe(1);
    expect(sim.editing()).toBe(el);
    typeText(sim, ZHE);
    frame(); frame();
    expect(sim.text()).toBe(src.replace(BELOW, ZHE + BELOW));
  });
  it('text typed before the refused merge is still written, at the next write', () => {
    const src = doc('视频 <iframe src="https://www.youtube.com/embed/abc"></iframe> 说明文字');
    const sim = setup(src);
    click(sim.block(2).querySelector('p')!);
    const el = sim.editing()!;
    caretAtStart(el);
    typeText(sim, 'AB');
    caretAtStart(el);
    expect(backspace(sim)).toBe(true);
    frame(); frame(); sim.pump();
    expect(sim.editing()).toBe(el);
    expect(sim.text()).toBe(src.replace(BELOW, 'AB' + BELOW));
  });
  it('a formula of the session\'s own block whose TeX the DOM lost (stamp and annotation gone): H15 as before — nothing written, the toast', () => {
    // (a fresh rendering always carries the TeX — KaTeX's annotation, the gate's <code> form — so the block above or the
    // merged block never has an unknown formula; only a session's own DOM can, and its write is refused before any merge)
    const src = doc('普通的上一段文字', '').replace(BELOW, `公式 $x^2$ ${BELOW}`);
    const sim = setup(src);
    click(sim.block(2).querySelector('p')!);
    const el = sim.editing()!;
    expect(el).not.toBe(null);
    for (const m of Array.from(el.querySelectorAll('.md-math'))) { m.removeAttribute('data-mdr-tex'); m.querySelector('annotation')?.remove(); }
    caretAtStart(el);
    expect(backspace(sim)).toBe(true);
    frame(); frame(); sim.pump();
    expect(sim.replaces).toEqual([]);
    expect(sim.text()).toBe(src);
    expect(toasted(sim)).toBe(1);
  });
  it('a form inside the paragraph above (no paragraph of its own: never a merge) — nothing written, the session stays', () => {
    const src = doc('搜索 <form action="/s"><input name="q"> <button>搜</button></form> 文字');
    const sim = setup(src);
    click(sim.block(2).querySelector('p')!);
    const el = sim.editing()!;
    caretAtStart(el);
    expect(backspace(sim)).toBe(false);
    frame(); frame(); sim.pump();
    expect(sim.replaces).toEqual([]);
    expect(sim.editing()).toBe(el);
  });
});

describe('P1: the merges a start allows give what they gave', () => {
  // [name, the paragraph above, what the session writes for it once the merged block is written again (default: as it is)]
  const ALLOWED: Array<[string, string, string?]> = [
    ['a plain paragraph', '普通的上一段文字'],
    ['a formula', '公式 $x^2+1$ 文字'],
    ['raw HTML the sanitizer keeps', '按 <kbd>Ctrl</kbd>+<kbd>C</kbd> 复制'],
    ['a link with a title', '链接 [x](https://e.example/ "标题") 文字'],
    // (alone refused by the gate: its raw em space ends the paragraph; inside the merged block it does not. The write of
    // the merged block spells it as the block's reference does: B3 of round 6, as before round 7.)
    ['the paragraph alone refused by the gate, the merged block not', `段落中间&emsp;引用，结尾${EMSP}`, '段落中间&emsp;引用，结尾&emsp;'],
  ];
  for (const [name, prev, rewritten] of ALLOWED) {
    it(name, () => {
      const src = doc(prev);
      const sim = setup(src);
      click(sim.block(2).querySelector('p')!);
      expect(sim.editing()).not.toBe(null);
      caretAtStart(sim.editing()!);
      expect(backspace(sim)).toBe(true);
      frame(); frame(); sim.pump(); frame(); frame();
      const joined = `# 合并\n\n${prev}${BELOW}\n`;
      expect(sim.text()).toBe(joined);
      expect(toasted(sim)).toBe(0);
      expect(sim.editing(), 'the session continues in the merged block').not.toBe(null);
      typeText(sim, ZHE);
      frame(); frame();
      expect(sim.text()).toBe(`# 合并\n\n${rewritten ?? prev}${ZHE}${BELOW}\n`);
    });
  }
});

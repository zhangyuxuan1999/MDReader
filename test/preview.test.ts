// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLAIN_PIECE_CHARS, createPreview, splitPlain } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { BlockKind, HTML_FLAG_PLAIN, HTML_FLAG_TRUSTED, type PreviewApi, type StructureDeltaMsg, type ToastSpec } from '../src/shared/types';
import { htmlMsg, htmlOf, outlineOf, segment, structureFrom, structureOf } from './fixtures/fakeWorker';

const FAKED = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] as const;
const frame = (): void => { vi.advanceTimersByTime(17); };
const idsInDom = (pv: PreviewApi): number[] =>
  Array.from(pv.el.querySelectorAll<HTMLElement>('.md-block'), (c) => Number(c.dataset.id));
const idsOf = (spec: Array<[number, number, BlockKind?]>): number[] => spec.map((s) => s[0]);
const chunksOf = (pv: PreviewApi): HTMLElement[] =>
  Array.from(pv.el.querySelectorAll<HTMLElement>('article > div.md-chunk'));
/** Blocks covered by the chunk tiling (live wrappers + dormant placeholders). */
const chunkBlocks = (pv: PreviewApi): number => chunksOf(pv).reduce((a, c) => a + Number(c.dataset.n), 0);
/** Σ --chunk-h: the height the document occupies while most of it has no wrappers. */
const chunkHeight = (pv: PreviewApi): number =>
  chunksOf(pv).reduce((a, c) => a + parseFloat(c.style.getPropertyValue('--chunk-h') || '0'), 0);

/**
 * The chunk tiling invariants: chunks tile the structure in order, none is empty or larger than 2·CHUNK,
 * a dormant chunk holds no wrappers, a live one holds exactly its `data-n` wrappers, and the wrappers that
 * do exist are the structure's ids in document order.
 */
function checkChunks(pv: PreviewApi, ids: number[], ctx: string): void {
  const cs = chunksOf(pv);
  let at = 0;
  const inDom: number[] = [];
  for (const c of cs) {
    const n = Number(c.dataset.n);
    expect(n, `${ctx}: empty chunk`).toBeGreaterThan(0);
    expect(n, `${ctx}: chunk too large`).toBeLessThanOrEqual(512);
    const live = !c.classList.contains('is-dormant');
    expect(c.childElementCount, `${ctx}: chunk children`).toBe(live ? n : 0);
    if (live) {
      for (let k = 0; k < n; k++) {
        const w = c.children[k] as HTMLElement;
        expect(w.classList.contains('md-block'), ctx).toBe(true);
        expect(Number(w.dataset.id), `${ctx}: wrapper at ${at + k}`).toBe(ids[at + k]);
        inDom.push(Number(w.dataset.id));
      }
    }
    at += n;
  }
  expect(at, `${ctx}: chunks must tile the structure`).toBe(ids.length);
  expect(pv.blockCount(), ctx).toBe(ids.length);
  expect(idsInDom(pv), `${ctx}: DOM order`).toEqual(inDom);
}

interface Harness {
  pv: PreviewApi; request: ReturnType<typeof vi.fn>; viewport: ReturnType<typeof vi.fn>;
  resync: ReturnType<typeof vi.fn>; bus: ReturnType<typeof createBus>;
}

function setup(clientHeight = 800): Harness {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const bus = createBus();
  const request = vi.fn();
  const viewport = vi.fn();
  const resync = vi.fn();
  const pv = createPreview({ parent, bus, request, viewport, resync });
  Object.defineProperty(pv.el, 'clientHeight', { value: clientHeight, configurable: true });
  (pv.el as HTMLElement & { scrollTo(o: ScrollToOptions): void }).scrollTo = (o) => { pv.el.scrollTop = o.top ?? 0; };
  return { pv, request, viewport, resync, bus };
}

/** jsdom has no ResizeObserver; this fake records the callbacks so tests can report block heights. */
type RoCb = (entries: ResizeObserverEntry[]) => void;
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(public cb: RoCb) { FakeResizeObserver.instances.push(this); }
  observe(t: Element): void { this.observed.add(t); }
  unobserve(t: Element): void { this.observed.delete(t); }
  disconnect(): void { this.observed.clear(); }
}
/** Reports a measured border-box height for a wrapper through the block ResizeObserver (the first one created). */
const measure = (targets: Array<[HTMLElement, number]>): void => {
  const ro = FakeResizeObserver.instances[0];
  ro.cb(targets.map(([target, h]) => ({ target, borderBoxSize: [{ blockSize: h, inlineSize: 600 }], contentRect: { height: h, width: 600 } }) as unknown as ResizeObserverEntry));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKED] });
  // The mount / wrapper-creation slices compare performance.now() against a real-time budget; tie it to the fake
  // clock (marks/measures stay real, unlike faking `performance` wholesale) so a loaded CI machine can never break
  // a slice mid-frame and leave a block unmounted after a fixed number of frame() calls.
  const base = Date.now();
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - base);
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); performance.clearMarks(); });

describe('applyStructure — wrappers and reconcile', () => {
  it('creates one pending wrapper per block, in order, with estimated heights', () => {
    const { pv } = setup();
    const spec: Array<[number, number, BlockKind?]> = [[1, 1, BlockKind.Heading], [2, 3], [3, 5, BlockKind.Code]];
    pv.applyStructure(structureFrom(spec));
    expect(pv.blockCount()).toBe(3);
    expect(idsInDom(pv)).toEqual([1, 2, 3]);
    const w = pv.el.querySelector<HTMLElement>('.md-block[data-id="3"]')!;
    expect(w.classList.contains('is-pending')).toBe(true);
    expect(w.style.getPropertyValue('--est-h')).toBe(`${24 + 23 * 5}px`);
    expect(pv.blockAtLine(4)).toEqual({ index: 1, id: 2, startLine: 2, lineCount: 3, kind: BlockKind.Prose });
    expect(pv.blockAtLine(5).id).toBe(3);
    expect(performance.getEntriesByName('mdr:structure').length).toBe(1);
  });

  it('keeps DOM order equal to structure order across removals and insertions', () => {
    const { pv } = setup();
    const steps: Array<Array<[number, number, BlockKind?]>> = [
      [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]],
      [[1, 1], [7, 2], [8, 1], [4, 1], [5, 1]],       // replace middle
      [[1, 1], [7, 2], [4, 1], [5, 1]],               // remove one
      [[9, 1], [1, 1], [7, 2], [4, 1], [5, 1], [10, 3]], // insert at both ends
      [[9, 1], [1, 1], [7, 2], [4, 3], [5, 1], [10, 3]], // same ids, line counts change
      [[4, 3], [5, 1]],                               // drop prefix and suffix
      [],                                             // empty document
      [[11, 2]],
    ];
    let version = 1;
    for (const spec of steps) {
      pv.applyStructure(structureFrom(spec, version++));
      expect(idsInDom(pv)).toEqual(idsOf(spec));
      expect(pv.blockCount()).toBe(spec.length);
      let line = 1;
      spec.forEach(([id, lines], index) => {
        expect(pv.blockAtLine(line)).toMatchObject({ index, id, startLine: line, lineCount: lines });
        line += lines;
      });
    }
    expect(pv.blockAtLine(1).index).toBe(0);
  });

  it('recreates a block whose id moved', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1]]));
    const before = pv.el.querySelector('[data-id="2"]');
    pv.applyStructure(structureFrom([[1, 1], [3, 1], [2, 1]], 2));
    expect(idsInDom(pv)).toEqual([1, 3, 2]);
    expect(pv.el.querySelector('[data-id="2"]')).not.toBe(before);
  });

  it('covers a big structure with dormant chunks and only builds wrappers near the window', () => {
    const { pv } = setup();
    const n = 6000;
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: n }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    expect(pv.blockCount()).toBe(n);
    // the whole document is tiled by chunks straight away (the scrollbar is correct without any wrapper)
    expect(chunkBlocks(pv)).toBe(n);
    expect(chunkHeight(pv)).toBe(n * 28);
    checkChunks(pv, idsOf(spec), 'initial');
    const live = idsInDom(pv);
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThan(n);                  // far-away blocks cost no wrapper at all
    expect(live).toEqual(spec.slice(0, live.length).map((s) => s[0]));
    frame();
    checkChunks(pv, idsOf(spec), 'after a frame');

    // A structure change: insert inside the live region, remove near the end.
    const next: Array<[number, number, BlockKind?]> = [spec[0], [70001, 2], ...spec.slice(1, n - 10)];
    pv.applyStructure(structureFrom(next, 2));
    expect(pv.blockCount()).toBe(next.length);
    expect(chunkBlocks(pv)).toBe(next.length);
    checkChunks(pv, idsOf(next), 'after edit');
    expect(idsInDom(pv).slice(0, 3)).toEqual([1, 70001, 2]);
    for (let i = 0; i < 40; i++) frame();
    checkChunks(pv, idsOf(next), 'settled');
  });

  it('keeps the wrapper count bounded for a 100k-block structure (P13)', () => {
    const { pv } = setup();
    const n = 100_000;
    const blocks = new Int32Array(n * 4);
    for (let i = 0; i < n; i++) {
      blocks[i * 4] = i + 1;          // id
      blocks[i * 4 + 1] = i + 1;      // startLine
      blocks[i * 4 + 2] = 1;          // lineCount
      blocks[i * 4 + 3] = BlockKind.Prose;
    }
    pv.applyStructure({
      type: 'structure', version: 1, blocks, changed: new Int32Array(0), lineCount: n, outlineVersion: 0,
      stats: { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: n, readingMinutes: 0 },
    });
    for (let i = 0; i < 10; i++) frame();
    expect(pv.blockCount()).toBe(n);
    expect(chunkBlocks(pv)).toBe(n);                 // the whole document is tiled …
    expect(chunkHeight(pv)).toBe(n * 28);            // … and has its full height
    expect(pv.lineToScrollTop(n, 0)).toBe((n - 1) * 28);
    // … while only a few thousand wrappers exist (each one costs ~3 KB of renderer memory)
    expect(idsInDom(pv).length).toBeLessThanOrEqual(8 * 256);
    // scrolling to the end keeps the bound
    pv.el.scrollTop = pv.lineToScrollTop(99_000, 0);
    pv.el.dispatchEvent(new Event('scroll'));
    for (let i = 0; i < 5; i++) frame();
    expect(idsInDom(pv).length).toBeLessThanOrEqual(16 * 256);
    expect(pv.el.querySelector('[data-id="99000"]')).not.toBeNull();
  });

  it('materializes a chunk when it scrolls into the window and gives it back when it leaves', () => {
    const { pv, request } = setup();
    const n = 4000;
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: n }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    for (let i = 0; i < 5; i++) frame();
    expect(pv.el.querySelector('[data-id="3000"]')).toBeNull();   // dormant
    pv.el.scrollTop = 2999 * 28;
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="3000"]')!;
    expect(w).not.toBeNull();
    expect(request.mock.calls.at(-1)![0]).toContain(3000);
    pv.applyHtml(htmlMsg([{ id: 3000, flags: 0, payload: '<p>three thousand</p>' }]));
    frame();
    expect(w.textContent).toBe('three thousand');
    checkChunks(pv, idsOf(spec), 'scrolled');
    // back to the top: the far chunk (and its mounted content) is released, its height stays
    pv.el.scrollTop = 0;
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    expect(pv.el.querySelector('[data-id="3000"]')).toBeNull();
    expect(w.isConnected).toBe(false);
    expect(chunkHeight(pv)).toBe(n * 28);
    expect(pv.lineToScrollTop(3000, 0)).toBe(2999 * 28);
    checkChunks(pv, idsOf(spec), 'released');
  });
});

describe('applyStructure — large middle insertion', () => {
  it('covers a 3000-block paste with dormant chunks instead of creating thousands of wrappers', () => {
    const { pv } = setup();
    const n = 1000;
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: n }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    for (let i = 0; i < 20; i++) frame();
    checkChunks(pv, idsOf(spec), 'initial');
    pv.applyHtml(htmlMsg([{ id: 900, flags: 0, payload: '<p>s</p>' }]));   // outside the window → dropped
    frame();
    // paste 3000 blocks after block 500
    const pasted: Array<[number, number, BlockKind?]> = Array.from({ length: 3000 }, (_, i) => [10_000 + i, 1]);
    const next = [...spec.slice(0, 500), ...pasted, ...spec.slice(500)];
    pv.applyStructure(structureFrom(next, 2));
    expect(pv.blockCount()).toBe(next.length);
    expect(chunkBlocks(pv)).toBe(next.length);
    const now = idsInDom(pv);
    expect(now.length).toBeLessThanOrEqual(2 * 512);   // only the chunks around the window carry wrappers
    checkChunks(pv, idsOf(next), 'after paste');
    for (let i = 0; i < 60; i++) frame();
    checkChunks(pv, idsOf(next), 'settled');
    expect(pv.blockAtLine(3600)).toMatchObject({ id: 600, startLine: 3600 });
    expect(chunkHeight(pv)).toBe(next.length * 28);
  });
});

describe('materialization window + applyHtml', () => {
  it('requests pending blocks in the window and reports the viewport in lines', () => {
    const { pv, request, viewport } = setup();
    pv.applyStructure(structureFrom([[1, 2], [2, 3], [3, 4]]));
    frame();
    expect(request).toHaveBeenCalledWith([1, 2, 3]);
    expect(viewport).toHaveBeenCalledWith(1, 9);
    frame();
    expect(request).toHaveBeenCalledTimes(1);   // requested set prevents duplicates
  });

  it('mounts known ids with sanitized content and drops unknown ids', () => {
    const { pv, bus } = setup();
    const samples: number[] = [];
    bus.on('perf:sample', (s) => { samples.push(s.ms); });
    pv.applyStructure(structureFrom([[1, 2], [2, 1]]));
    frame();
    const html = '<p data-l="0">hi<script>alert(1)</script>' +
      '<a href="https://example.com">ext</a><a href="#top">in</a></p>' +
      '<ul class="contains-task-list"><li data-l="1" class="task-list-item"><input type="checkbox" checked> task</li></ul>' +
      '<input type="text"><img src="x" onerror="alert(1)">';
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: html }, { id: 999, flags: 0, payload: '<p>nope</p>' }]));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    expect(w.classList.contains('is-pending')).toBe(false);
    expect(w.querySelector('script')).toBeNull();
    expect(w.querySelector('p')?.textContent).toBe('hiextin');
    const ext = w.querySelector<HTMLAnchorElement>('a[href^="https"]')!;
    expect(ext.target).toBe('_blank');
    expect(ext.rel).toBe('noopener noreferrer');
    expect(w.querySelector<HTMLAnchorElement>('a[href="#top"]')!.getAttribute('target')).toBeNull();
    expect(w.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(w.querySelector('input[type="text"]')).toBeNull();
    expect(w.querySelector('img')!.getAttribute('onerror')).toBeNull();
    expect(pv.el.querySelector('[data-id="999"]')).toBeNull();
    expect(pv.el.querySelector<HTMLElement>('[data-id="2"]')!.classList.contains('is-pending')).toBe(true);
    expect(samples.length).toBe(1);
    expect(performance.getEntriesByName('mdr:first-visible').length).toBe(1);
  });

  it('mounts PLAIN payloads via textContent: pre > code for Code blocks, p.md-plain for prose', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 2], [2, 3, BlockKind.Code]]));
    frame();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: HTML_FLAG_PLAIN, payload: '<b>raw</b> & text' },
      { id: 2, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED, payload: '```\n<i>x</i>\n```' },
    ]));
    frame();
    const p = pv.el.querySelector('[data-id="1"] > p.md-plain')!;
    expect(p.textContent).toBe('<b>raw</b> & text');
    expect(p.querySelector('b')).toBeNull();
    expect(pv.el.querySelector('[data-id="1"] pre')).toBeNull();
    const code = pv.el.querySelector('[data-id="2"] > pre.md-code.md-code--plain > code')!;
    expect(code.textContent).toBe('```\n<i>x</i>\n```');
    expect(code.querySelector('i')).toBeNull();
  });

  it('mounts TRUSTED payloads without sanitizing (worker-escaped code HTML keeps its markup)', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 3, BlockKind.Code], [2, 1]]));
    frame();
    const code = '<pre class="md-code" data-l="0" data-lang="ts"><code><span class="hljs-keyword">const</span> a = <span data-x="1">1</span></code></pre>';
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_TRUSTED, payload: code }, { id: 2, flags: 0, payload: '<p><span onclick="x()">u</span></p>' }]));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    // the fence itself is untouched; it is only lifted into the badge wrapper (decision 2)
    expect(w.innerHTML).toBe(`<div class="md-codewrap" data-lang="ts">${code}</div>`);
    expect(w.classList.contains('is-pending')).toBe(false);
    // the untrusted one still goes through DOMPurify
    expect(pv.el.querySelector('[data-id="2"] span')!.hasAttribute('onclick')).toBe(false);
  });

  it('splits PLAIN text into ≤ 64 KB pieces at line boundaries', () => {
    expect(splitPlain('a\nb')).toEqual(['a\nb']);
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    const pieces = splitPlain(lines);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(lines);
    for (const pc of pieces) expect(pc.length).toBeLessThanOrEqual(PLAIN_PIECE_CHARS);
    for (const pc of pieces.slice(0, -1)) expect(pc.endsWith('\n')).toBe(true);
    const oneLine = 'y'.repeat(PLAIN_PIECE_CHARS * 2 + 10);
    const cut = splitPlain(oneLine);
    expect(cut.map((c) => c.length)).toEqual([PLAIN_PIECE_CHARS, PLAIN_PIECE_CHARS, 10]);
    expect(splitPlain('abc\n' + 'z'.repeat(20), 8)).toEqual(['abc\n', 'zzzzzzzz', 'zzzzzzzz', 'zzzz']);
  });

  it('re-mounting a multi-piece PLAIN block only touches the pieces whose text changed', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 6000, BlockKind.Code]]));
    frame();
    const text = Array.from({ length: 6000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED, payload: text }]));
    for (let i = 0; i < 40; i++) frame();   // giant guard: 500 ms settle, then a frame to mount
    const pre = pv.el.querySelector('[data-id="1"] > pre.md-code--plain')!;
    const before = Array.from(pre.children);
    expect(before.length).toBe(splitPlain(text).length);
    expect(before.every((c) => c.tagName === 'CODE' && c.classList.contains('md-plain__piece'))).toBe(true);
    expect(pre.textContent).toBe(text);
    // an edit inside the last line: only the last piece is rewritten, the others keep their node and text node
    const firstText = before[0].firstChild;
    const edited = text + ' // edit';
    pv.applyStructure(structureFrom([[1, 6000, BlockKind.Code]], 2, [1]));
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED, payload: edited }], 2));
    for (let i = 0; i < 40; i++) frame();
    const after = Array.from(pre.children);
    expect(after.length).toBe(before.length);
    for (let k = 0; k < after.length - 1; k++) expect(after[k]).toBe(before[k]);
    expect(before[0].firstChild).toBe(firstText);
    expect(pre.textContent).toBe(edited);
    expect(pv.el.querySelector('[data-id="1"]')!.classList.contains('is-stale')).toBe(false);
  });

  it('renders the fake worker output end to end', () => {
    const { pv } = setup();
    const blocks = segment('# 标题\n\n段落一\n\n- [ ] 待办\n- [x] 完成\n\n```ts\nconst a = 1;\n```\n');
    pv.applyStructure(structureOf(blocks));
    frame();
    pv.applyHtml(htmlOf(blocks));
    // The mount queue is budgeted (MOUNT_SLICE_MS per frame): under CPU load the first sanitize can use
    // up a whole slice, so give it a few frames.
    for (let i = 0; i < 4; i++) frame();
    expect(pv.el.querySelector('[data-id="1"] h1')?.textContent).toBe('标题');
    expect(pv.el.querySelector('[data-id="3"] li[data-l="1"]')).not.toBeNull();
    expect(pv.el.querySelector('[data-id="4"] pre.md-code[data-lang="ts"]')).not.toBeNull();
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
  });

  it('marks changed blocks stale until HTML of that version mounts', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1]], 1));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>v1</p>' }], 1));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    pv.applyStructure(structureFrom([[1, 1], [2, 1]], 2, [1]));
    expect(w.classList.contains('is-stale')).toBe(true);
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>late v1</p>' }], 1));
    frame();
    expect(w.classList.contains('is-stale')).toBe(true);
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>v2</p>' }], 2));
    frame();
    expect(w.classList.contains('is-stale')).toBe(false);
    expect(w.textContent).toBe('v2');
  });

  it('drops HTML for blocks outside the window and re-requests them when they enter it', () => {
    const { pv, request } = setup(100);   // window = [-150, 250] px → first ~9 blocks of 28px
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 100 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    expect(request.mock.calls[0][0]).not.toContain(50);
    pv.applyHtml(htmlMsg([{ id: 50, flags: 0, payload: '<p>far</p>' }]));
    frame();
    expect(pv.el.querySelector('[data-id="50"]')!.classList.contains('is-pending')).toBe(true);
    pv.el.scrollTop = 49 * 28;
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    expect(request.mock.calls.at(-1)![0]).toContain(50);
  });

  it('requests nothing while hidden and resumes on setVisible(true)', () => {
    const { pv, request } = setup();
    pv.setVisible(false);
    pv.applyStructure(structureFrom([[1, 1]]));
    frame();
    expect(request).not.toHaveBeenCalled();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>x</p>' }]));
    frame();
    expect(pv.el.querySelector('[data-id="1"]')!.classList.contains('is-pending')).toBe(true);
    pv.setVisible(true);
    frame();
    expect(request).toHaveBeenCalledWith([1]);
  });

  it('defers giant payloads until the block has been stable for 500 ms; a newer structure cancels the deferred one', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1]]));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    const giant = (v: number): void => { pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: `<p data-v="${v}">` + 'x'.repeat(300_000) + '</p>' }], v)); };
    giant(1);
    frame();
    expect(w.classList.contains('is-slow')).toBe(true);
    expect(w.classList.contains('is-pending')).toBe(true);
    vi.advanceTimersByTime(400);
    pv.applyStructure(structureFrom([[1, 1]], 2, [1]));   // still changing: the version-1 payload is dropped
    vi.advanceTimersByTime(600);
    frame();
    expect(w.classList.contains('is-pending')).toBe(true);   // nothing of version 1 was mounted
    giant(2);
    vi.advanceTimersByTime(400);
    expect(w.classList.contains('is-pending')).toBe(true);
    vi.advanceTimersByTime(120);
    frame();
    expect(w.classList.contains('is-pending')).toBe(false);
    expect(w.classList.contains('is-slow')).toBe(false);
    expect(w.querySelector('p')!.dataset.v).toBe('2');
  });

  it('a small payload supersedes a deferred giant one and an older payload never regresses the block', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 5, BlockKind.Code]]));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    // unclosed fence: a giant PLAIN payload of version 3 is deferred
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED, payload: '~'.repeat(300_000) }], 3));
    frame();
    expect(w.classList.contains('is-slow')).toBe(true);
    // fence closed: block 1 is small again (version 4)
    pv.applyStructure(structureFrom([[1, 2, BlockKind.Code], [2, 3]], 4, [1, 2]));
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_TRUSTED, payload: '<pre class="md-code"><code>~~~~\n~~~~</code></pre>' }], 4));
    frame();
    expect(w.textContent).toBe('~~~~\n~~~~');
    expect(w.classList.contains('is-slow')).toBe(false);
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 3; i++) frame();
    expect(w.textContent).toBe('~~~~\n~~~~');   // the giant payload never lands
    // a late payload of an older version is ignored
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_TRUSTED, payload: '<p>old</p>' }], 2));
    frame();
    expect(w.textContent).toBe('~~~~\n~~~~');
    // a small payload arriving while a giant one is deferred cancels the deferral
    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: '<p>' + 'y'.repeat(300_000) + '</p>' }], 4));
    frame();
    const w2 = pv.el.querySelector<HTMLElement>('[data-id="2"]')!;
    expect(w2.classList.contains('is-slow')).toBe(true);
    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: '<p>small</p>' }], 4));
    frame();
    expect(w2.textContent).toBe('small');
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 3; i++) frame();
    expect(w2.textContent).toBe('small');
  });

  it('evicts far-away mounted blocks with their height pinned, replacing the wrapper element', () => {
    const { pv } = setup(10);   // 20H = 200 px
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 100 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one</p>' }]));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    expect(w.classList.contains('is-pending')).toBe(false);
    measure([[w, 44]]);
    const ro = FakeResizeObserver.instances[0];
    expect(ro.observed.has(w)).toBe(true);
    pv.el.scrollTop = 90 * 28;
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    vi.advanceTimersByTime(600);   // eviction interval + idle fallback
    // The mounted wrapper is display-locked off-screen and would pin its removed subtree: it is replaced.
    expect(w.isConnected).toBe(false);
    expect(ro.observed.has(w)).toBe(false);
    const fresh = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    expect(fresh).not.toBe(w);
    expect(fresh.classList.contains('is-pending')).toBe(true);
    expect(fresh.childElementCount).toBe(0);
    expect(fresh.style.getPropertyValue('--est-h')).toBe('44px');
    expect(idsInDom(pv).slice(0, 3)).toEqual([1, 2, 3]);
    // Scrolling back re-requests it into the fresh wrapper.
    pv.el.scrollTop = 0;
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>again</p>' }]));
    frame();
    expect(fresh.textContent).toBe('again');
  });

  it('never evicts a tall block whose box spans the viewport, nor blocks inside the window', () => {
    const { pv, request } = setup(100);   // 20H = 2000 px
    // block 2 is 5000 lines of code: 24 + 23·5000 px tall, its top ends up > 20 screens above the viewport
    pv.applyStructure(structureFrom([[1, 1], [2, 5000, BlockKind.Code], [3, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>a</p>' }, { id: 2, flags: HTML_FLAG_PLAIN | HTML_FLAG_TRUSTED, payload: 'code' }, { id: 3, flags: 0, payload: '<p>c</p>' }]));
    frame();
    const tall = pv.el.querySelector<HTMLElement>('[data-id="2"]')!;
    expect(tall.classList.contains('is-pending')).toBe(false);
    pv.scrollToLine(2500, 0);   // viewport inside the tall block
    pv.el.dispatchEvent(new Event('scroll'));   // jsdom fires none on its own
    frame();
    expect(pv.isLineVisible(2500)).toBe(true);
    const calls = request.mock.calls.length;
    vi.advanceTimersByTime(600);
    expect(pv.el.querySelector<HTMLElement>('[data-id="2"]')).toBe(tall);
    expect(tall.classList.contains('is-pending')).toBe(false);
    expect(tall.textContent).toBe('code');
    // blocks 1 and 3 are > 20 screens away (57k px above / below the viewport) → evicted
    expect(pv.el.querySelector<HTMLElement>('[data-id="1"]')!.classList.contains('is-pending')).toBe(true);
    expect(pv.el.querySelector<HTMLElement>('[data-id="3"]')!.classList.contains('is-pending')).toBe(true);
    frame();
    expect(request.mock.calls.length).toBe(calls);   // nothing had to be re-requested
  });

  it('mountAll accepts HTML for every block and resolves once everything is mounted', async () => {
    const { pv, request } = setup(10);
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 30 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    const done = vi.fn();
    void pv.mountAll().then(done);
    for (let i = 0; i < 5; i++) frame();
    const all = new Set(request.mock.calls.flatMap((c) => c[0] as number[]));
    expect(all.size).toBe(30);
    pv.applyHtml(htmlMsg(spec.map(([id]) => ({ id, flags: 0, payload: `<p>${id}</p>` }))));
    for (let i = 0; i < 5; i++) frame();
    await Promise.resolve();
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
    expect(done).toHaveBeenCalled();
  });
});

describe('mountAll across dormant chunks', () => {
  it('materializes every chunk and mounts every block (view.mountAll)', async () => {
    const { pv, request } = setup(100);
    const n = 1200;   // 5 chunks: only the first two are live before mountAll
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: n }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    for (let i = 0; i < 5; i++) frame();
    expect(idsInDom(pv).length).toBeLessThan(n);
    const done = vi.fn();
    void pv.mountAll().then(done);
    for (let i = 0; i < 20; i++) frame();
    checkChunks(pv, idsOf(spec), 'mountAll');
    expect(idsInDom(pv).length).toBe(n);                     // every wrapper exists …
    const all = new Set(request.mock.calls.flatMap((c) => c[0] as number[]));
    expect(all.size).toBe(n);                                // … and every block was requested
    pv.applyHtml(htmlMsg(spec.map(([id]) => ({ id, flags: 0, payload: `<p>${id}</p>` }))));
    for (let i = 0; i < 60; i++) frame();
    await Promise.resolve();
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
    expect(done).toHaveBeenCalled();
    // eviction stays off until the next structure, so nothing is taken away again
    pv.el.scrollTop = pv.lineToScrollTop(1200, 0);
    pv.el.dispatchEvent(new Event('scroll'));
    for (let i = 0; i < 5; i++) frame();
    vi.advanceTimersByTime(1000);
    expect(idsInDom(pv).length).toBe(n);
  });
});

describe('scrolling', () => {
  it('scrollToLine writes scrollTop from the model and settles once', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 4], [2, 4], [3, 4]]));
    pv.scrollToLine(5, 0.5);
    expect(pv.el.scrollTop).toBe(28 * 4 + 14);
    expect(pv.topVisible()).toEqual({ line: 5, fraction: 0.5 });
    expect(pv.isLineVisible(6)).toBe(true);
    expect(pv.isLineVisible(1)).toBe(false);
    pv.el.scrollTop = 0;   // pretend the browser clamped
    frame();
    expect(pv.el.scrollTop).toBe(28 * 4 + 14);
  });

  it('keeps the navigation target on the top edge while blocks above it are measured', () => {
    const { pv } = setup();
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 40 }, (_, i) => [i + 1, 4]);   // 112 px each
    pv.applyStructure(structureFrom(spec));
    frame();
    pv.scrollToLine(81, 0);   // block index 20
    expect(pv.el.scrollTop).toBe(20 * 112);
    frame();
    const w5 = pv.el.querySelector<HTMLElement>('[data-id="5"]')!, w30 = pv.el.querySelector<HTMLElement>('[data-id="30"]')!;
    // A block above the target turns out taller than estimated: the target is re-applied at once.
    measure([[w5, 312]]);
    expect(pv.el.scrollTop).toBe(20 * 112 + 200);
    expect(pv.topVisible()).toEqual({ line: 81, fraction: 0 });
    // A block below the target does not move it.
    measure([[w30, 500]]);
    expect(pv.el.scrollTop).toBe(20 * 112 + 200);
    // After 600 ms the anchor is released.
    const t = performance.now();
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => t + 700);
    try {
      measure([[w5, 412]]);
    } finally { spy.mockRestore(); }
    expect(pv.el.scrollTop).toBe(20 * 112 + 200);
  });

  it('a user scroll gesture releases the navigation anchor', () => {
    const { pv } = setup();
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 40 }, (_, i) => [i + 1, 4]);
    pv.applyStructure(structureFrom(spec));
    frame();
    pv.scrollToLine(81, 0);
    pv.el.dispatchEvent(new Event('wheel', { bubbles: true }));
    pv.el.scrollTop = 100;
    const w5 = pv.el.querySelector<HTMLElement>('[data-id="5"]')!;
    measure([[w5, 312]]);
    expect(pv.el.scrollTop).toBe(100);
    frame();
    expect(pv.el.scrollTop).toBe(100);
  });

  it('notifies onScroll listeners when a measured block at or above the top edge changes the top line', () => {
    const { pv } = setup();
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 40 }, (_, i) => [i + 1, 4]);
    pv.applyStructure(structureFrom(spec));
    frame();
    pv.el.scrollTop = 20 * 112 + 50;   // inside block 21
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    const fn = vi.fn();
    pv.onScroll(fn);
    const w = (id: number): HTMLElement => pv.el.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    measure([[w(30), 300]]);   // below the viewport: the top line is unchanged
    frame();
    expect(fn).not.toHaveBeenCalled();
    measure([[w(21), 224]]);   // the block under the top edge grew: line under the edge moved
    expect(pv.topVisible().line).not.toBe(20 * 4 + 2);
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
    measure([[w(3), 224]]);    // above the viewport (the browser's scroll anchoring will follow up with a scroll)
    frame();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exposes the mounted block count for diagnostics', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>a</p>' }]));
    frame();
    expect((pv as PreviewApi & { mountedCount(): number }).mountedCount()).toBe(1);
  });

  it('notifies onScroll listeners once per frame', () => {
    const { pv } = setup();
    const fn = vi.fn();
    const off = pv.onScroll(fn);
    pv.el.dispatchEvent(new Event('scroll'));
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('interactions', () => {
  function mountDoc(): Harness {
    const h = setup();
    const blocks = segment('# 标题 A\n\n段落 [内部](#标题-a) [相对](./x.md) [外部](https://e.com)\n\n- [ ] 一\n- [x] 二\n');
    h.pv.applyStructure(structureOf(blocks));
    h.pv.applyOutline(outlineOf(blocks));
    frame();
    h.pv.applyHtml(htmlOf(blocks));
    frame();
    return h;
  }

  it('checkbox change emits source:edit with the absolute line', () => {
    const { pv, bus } = mountDoc();
    const edits: number[] = [];
    bus.on('source:edit', (e) => { edits.push(e.line); });
    const second = pv.el.querySelector<HTMLInputElement>('[data-id="3"] li[data-l="1"] input')!;
    second.dispatchEvent(new Event('change', { bubbles: true }));
    expect(edits).toEqual([6]);
  });

  it('checkbox nested in blockquotes resolves its line from the nearest li[data-l]', () => {
    const h = setup();
    const blocks = segment('# T\n\n> 引言\n> - [ ] 一\n> - [x] 二\n\n> > * [ ] 深\n');
    h.pv.applyStructure(structureOf(blocks));
    frame();
    h.pv.applyHtml(htmlOf(blocks));
    frame();
    const edits: number[] = [];
    h.bus.on('source:edit', (e) => { edits.push(e.line); });
    const boxes = Array.from(h.pv.el.querySelectorAll<HTMLInputElement>('blockquote input[type="checkbox"]'));
    expect(boxes.length).toBe(3);
    for (const b of boxes) b.dispatchEvent(new Event('change', { bubbles: true }));
    expect(edits).toEqual([4, 5, 7]);
  });

  it('Alt+click emits nav:gotoLine for the nearest data-l element', () => {
    const { pv, bus } = mountDoc();
    const gotos: Array<{ line: number; source: string }> = [];
    bus.on('nav:gotoLine', (e) => { gotos.push({ line: e.line, source: e.source }); });
    pv.el.querySelector('[data-id="3"] li[data-l="1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    pv.el.querySelector('[data-id="2"] p')!.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
    expect(gotos).toEqual([{ line: 6, source: 'preview' }, { line: 3, source: 'preview' }]);
  });

  it('resolves #anchors through the outline, toasts on relative links, leaves external links alone', () => {
    const { pv, bus } = mountDoc();
    const gotos: Array<{ line: number; source: string }> = [];
    const toasts: ToastSpec[] = [];
    bus.on('nav:gotoLine', (e) => { gotos.push({ line: e.line, source: e.source }); });
    bus.on('toast', (t) => { toasts.push(t); });
    const click = (sel: string): boolean => pv.el.querySelector(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(click('a[href^="#"]')).toBe(false);
    expect(gotos).toEqual([{ line: 1, source: 'link' }]);
    expect(click('a[href="./x.md"]')).toBe(false);
    expect(toasts.length).toBe(1);
    expect(click('a[href="https://e.com"]')).toBe(true);
    expect(gotos.length).toBe(1);
  });
});

describe('dispose', () => {
  it('removes the element and stops pending work', () => {
    const { pv, request } = setup();
    pv.applyStructure(structureFrom([[1, 1]]));
    request.mockClear();
    pv.dispose();
    frame();
    expect(document.querySelector('.mdr-preview')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});

describe('stale blocks outside the window (fix round)', () => {
  it('evicts a mounted block that becomes stale far outside the window; keeps is-stale content inside it', () => {
    const { pv } = setup(100);   // window ≈ [-150, 250] px at the top; blocks are 28 px estimates
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 80 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    for (let i = 0; i < 10; i++) frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one</p>' }]));
    frame();
    // mount block 60 by moving the window there (1652 px: outside the window but inside the eviction distance)
    pv.scrollToLine(60, 0);
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    pv.applyHtml(htmlMsg([{ id: 60, flags: 0, payload: '<p>sixty</p>' }]));
    frame();
    const w60 = pv.el.querySelector<HTMLElement>('[data-id="60"]')!;
    expect(w60.textContent).toBe('sixty');
    pv.scrollToLine(1, 0);
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    const w1 = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    expect(w1.textContent).toBe('one');
    // both change (e.g. a reference definition edit): 1 is in the window, 60 is > 16 blocks outside it
    pv.applyStructure(structureFrom(spec, 2, [1, 60]));
    expect(w1.classList.contains('is-stale')).toBe(true);
    expect(w1.textContent).toBe('one');                       // old content stays visible until the new HTML mounts
    const fresh = pv.el.querySelector<HTMLElement>('[data-id="60"]')!;
    expect(fresh).not.toBe(w60);                              // replaced by a pending wrapper …
    expect(fresh.classList.contains('is-pending')).toBe(true);
    expect(fresh.textContent).toBe('');
    expect(fresh.style.getPropertyValue('--est-h')).toBe('28px');   // … with its height pinned (no scroll jump)
    // coming back into the window re-requests it
    pv.scrollToLine(60, 0);
    pv.el.dispatchEvent(new Event('scroll'));
    frame();
    expect(fresh.classList.contains('is-pending')).toBe(true);
    pv.applyHtml(htmlMsg([{ id: 60, flags: 0, payload: '<p>sixty v2</p>' }], 2));
    frame();
    expect(pv.el.querySelector<HTMLElement>('[data-id="60"]')!.textContent).toBe('sixty v2');
  });
});

describe('mountAll across an edit (fix round)', () => {
  it('keeps accepting far-away HTML when an ordinary structure change arrives mid-mountAll; a new document ends it', async () => {
    const { pv, request } = setup(100);
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 60 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    for (let i = 0; i < 10; i++) frame();
    const done = vi.fn();
    void pv.mountAll().then(done);
    frame();
    const requested = new Set(request.mock.calls.flatMap((c) => c[0] as number[]));
    expect(requested.has(60)).toBe(true);
    // the worker's response to an edit made just before the command is dispatched now: block 1 changed
    pv.applyStructure(structureFrom(spec, 2, [1]));
    frame();
    // the HTML the command asked for arrives (version 2) and must be mounted although block 60 is far outside the window
    pv.applyHtml(htmlMsg(spec.map(([id]) => ({ id, flags: 0, payload: `<p>b${id}</p>` })), 2));
    for (let i = 0; i < 10; i++) frame();
    expect(pv.el.querySelectorAll('.md-block.is-pending').length).toBe(0);
    expect(pv.el.querySelector('[data-id="60"]')!.textContent).toBe('b60');
    await Promise.resolve();
    expect(done).toHaveBeenCalled();
    // a setDoc-sized replacement (no surviving id) ends a running mountAll
    const done2 = vi.fn();
    void pv.mountAll().then(done2);
    pv.applyStructure(structureFrom([[100, 1], [101, 1]], 3));
    await Promise.resolve();
    expect(done2).toHaveBeenCalled();
    for (let i = 0; i < 5; i++) frame();
    pv.applyHtml(htmlMsg([{ id: 101, flags: 0, payload: '<p>x</p>' }], 3));
    frame();
    expect(pv.el.querySelector('[data-id="101"]')!.textContent).toBe('x');   // in the window anyway
  });
});

// ---------------------------------------------------------------- structure deltas (CONTRACT §7)
/** One `structureDelta` exactly as the worker posts it: `inserted` carries absolute start lines. */
function deltaMsg(
  index: number, removed: number, inserted: Array<[id: number, start: number, lines: number, kind?: BlockKind]>,
  lineDelta: number, version: number, changed: number[], lineCount = 0,
): StructureDeltaMsg {
  const arr = new Int32Array(inserted.length * 4);
  inserted.forEach(([id, start, lines, kind], i) => {
    arr[i * 4] = id; arr[i * 4 + 1] = start; arr[i * 4 + 2] = lines; arr[i * 4 + 3] = kind ?? BlockKind.Prose;
  });
  const stats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: lineCount, readingMinutes: 0 };
  return {
    type: 'structureDelta', version, index, removed, inserted: arr, lineDelta,
    changed: Int32Array.from(changed), lineCount, stats, outlineVersion: 1,
  };
}

/** The preview's model must tile the spec: one block per entry, consecutive start lines. */
function expectTiles(pv: PreviewApi, spec: Array<[number, number, BlockKind?]>, ctx: string): void {
  expect(pv.blockCount(), ctx).toBe(spec.length);
  let line = 1;
  spec.forEach(([id, lines, kind], index) => {
    expect(pv.blockAtLine(line), `${ctx} @${line}`).toEqual({ index, id, startLine: line, lineCount: lines, kind: kind ?? BlockKind.Prose });
    line += lines;
  });
}

describe('applyStructureDelta', () => {
  it('a keystroke inside one block keeps every wrapper, its measurements and its content', () => {
    const { pv, request } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 2], [3, 1]]));
    frame();
    pv.applyHtml(htmlMsg([1, 2, 3].map((id) => ({ id, flags: 0, payload: `<p>v1-${id}</p>` }))));
    frame();
    const w = [1, 2, 3].map((id) => pv.el.querySelector<HTMLElement>(`[data-id="${id}"]`)!);
    measure(w.map((e, k) => [e, 100 + k] as [HTMLElement, number]));
    frame();
    const calls = request.mock.calls.length;

    // the edited block keeps its id, line count and kind: nothing is removed or inserted, only `changed`
    pv.applyStructureDelta(deltaMsg(1, 1, [[2, 2, 2]], 0, 2, [2], 4));
    expectTiles(pv, [[1, 1], [2, 2], [3, 1]], 'after keystroke');
    expect([1, 2, 3].map((id) => pv.el.querySelector(`[data-id="${id}"]`))).toEqual(w);   // same elements
    expect(w[1].classList.contains('is-stale')).toBe(true);
    expect(w[0].textContent).toBe('v1-1');
    expect(w[2].textContent).toBe('v1-3');
    frame();
    expect(request.mock.calls.length, 'no re-request for mounted neighbours').toBe(calls);

    pv.applyHtml(htmlMsg([{ id: 2, flags: 0, payload: '<p>v2-2</p>' }], 2));
    frame();
    expect(w[1].textContent).toBe('v2-2');
    expect(w[1].classList.contains('is-stale')).toBe(false);
    expect(pv.lineToScrollTop(2, 0)).toBe(100);    // measured heights survived the delta
  });

  it('splits a block in two and shifts the start lines of everything after it', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 3], [3, 2]]));
    frame();
    const first = pv.el.querySelector('[data-id="1"]');
    const last = pv.el.querySelector('[data-id="3"]');
    // block 2 (lines 2..4) becomes 2 (lines 2..3) + 4 (lines 4..6): one extra line after it
    pv.applyStructureDelta(deltaMsg(1, 1, [[2, 2, 2], [4, 4, 3, BlockKind.Code]], 2, 2, [2, 4], 8));
    expect(idsInDom(pv)).toEqual([1, 2, 4, 3]);
    expectTiles(pv, [[1, 1], [2, 2], [4, 3, BlockKind.Code], [3, 2]], 'after split');
    expect(pv.el.querySelector('[data-id="1"]')).toBe(first);     // untouched neighbours keep their wrapper
    expect(pv.el.querySelector('[data-id="3"]')).toBe(last);
    expect(pv.el.querySelector<HTMLElement>('[data-id="4"]')!.style.getPropertyValue('--est-h')).toBe(`${24 + 23 * 3}px`);
    checkChunks(pv, [1, 2, 4, 3], 'after split');
  });

  it('removes blocks and forgets them', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1], [4, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 3, flags: 0, payload: '<p>three</p>' }]));
    frame();
    pv.applyStructureDelta(deltaMsg(1, 3, [[5, 2, 2]], -1, 2, [5], 3));
    expect(idsInDom(pv)).toEqual([1, 5]);
    expectTiles(pv, [[1, 1], [5, 2]], 'after removal');
    expect(pv.el.querySelector('[data-id="3"]')).toBeNull();
    checkChunks(pv, [1, 5], 'after removal');
    // a late payload for a removed block is dropped, not resurrected
    pv.applyHtml(htmlMsg([{ id: 3, flags: 0, payload: '<p>ghost</p>' }], 2));
    frame();
    expect(pv.el.textContent).not.toContain('ghost');
  });

  it('deleting every block leaves an empty document', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1]]));
    frame();
    pv.applyStructureDelta(deltaMsg(0, 2, [], -2, 2, [], 0));
    expect(pv.blockCount()).toBe(0);
    expect(idsInDom(pv)).toEqual([]);
    frame();
    expect(pv.blockAtLine(1)).toEqual({ index: -1, id: -1, startLine: 1, lineCount: 0, kind: BlockKind.Prose });
  });

  // Lead decision 3: a delta the preview cannot apply must not be dropped silently — the worker has no
  // way of learning that the preview rejected it, so the preview asks for a full `structure` instead and
  // ignores every further delta until one arrives.
  it.each<[string, () => StructureDeltaMsg]>([
    ['index past the end', () => deltaMsg(5, 1, [[9, 1, 1]], 0, 2, [9], 2)],
    ['removes more than there is', () => deltaMsg(1, 4, [[9, 2, 1]], 0, 2, [9], 2)],
    ['negative index', () => deltaMsg(-1, 1, [[9, 1, 1]], 0, 2, [9], 2)],
    ['ragged inserted array', () => ({ ...deltaMsg(0, 1, [[9, 1, 1]], 0, 2, [9], 2), inserted: new Int32Array(3) })],
    ['version older than the applied structure', () => deltaMsg(0, 1, [[9, 1, 1]], 0, 0, [9], 2)],
    ['inserted block does not start where the previous one ends', () => deltaMsg(1, 1, [[9, 7, 1]], 0, 2, [9], 2)],
    ['inserted block with no lines', () => deltaMsg(1, 1, [[9, 2, 0]], -1, 2, [9], 1)],
    ['lineDelta contradicts the replacement', () => deltaMsg(1, 1, [[9, 2, 3]], 0, 2, [9], 4)],
    ['lineCount contradicts the replacement', () => deltaMsg(1, 1, [[9, 2, 3]], 2, 2, [9], 9)],
  ])('resyncs once instead of dropping an inapplicable delta (%s)', (_name, make) => {
    const { pv, resync } = setup();
    pv.applyStructure(structureFrom([[1, 1], [2, 1]]));   // version 1, 2 lines
    frame();
    pv.applyStructureDelta(make());
    expect(resync).toHaveBeenCalledTimes(1);
    expectTiles(pv, [[1, 1], [2, 1]], 'unchanged');
    expect(idsInDom(pv)).toEqual([1, 2]);

    // Desynced: every further delta — even a well-formed one — is ignored, and resync is not repeated.
    pv.applyStructureDelta(deltaMsg(1, 1, [[9, 2, 2]], 1, 3, [9], 3));
    expect(resync).toHaveBeenCalledTimes(1);
    expectTiles(pv, [[1, 1], [2, 1]], 'still unchanged');

    // …until the full structure the resync asked for arrives; deltas are applied again after it.
    pv.applyStructure(structureFrom([[1, 1], [9, 2]], 4));
    frame();
    expectTiles(pv, [[1, 1], [9, 2]], 'resynced');
    pv.applyStructureDelta(deltaMsg(1, 1, [[9, 2, 3]], 1, 5, [9], 4));
    expect(resync).toHaveBeenCalledTimes(1);
    expectTiles(pv, [[1, 1], [9, 3]], 'delta after resync');
  });

  it('converges with the equivalent full structures over a sequence of edits', () => {
    const a = setup(), b = setup();
    const steps: Array<{ spec: Array<[number, number, BlockKind?]>; delta: StructureDeltaMsg }> = [];
    const base: Array<[number, number, BlockKind?]> = Array.from({ length: 40 }, (_, i) => [i + 1, 2]);
    a.pv.applyStructure(structureFrom(base));
    b.pv.applyStructure(structureFrom(base));
    frame();
    // grow the 10th block, split the 20th, drop the 30th, then insert two blocks at the front
    steps.push({
      spec: base.map((s, i) => (i === 9 ? [s[0], 5] : s)),
      delta: deltaMsg(9, 1, [[10, 19, 5]], 3, 2, [10], 83),
    });
    steps.push({
      spec: [...steps[0].spec.slice(0, 20), [101, 1], [102, 1], ...steps[0].spec.slice(21)],
      delta: deltaMsg(20, 1, [[101, 44, 1], [102, 45, 1]], 0, 3, [101, 102], 83),
    });
    steps.push({
      spec: steps[1].spec.filter((s) => s[0] !== 31),
      delta: deltaMsg(31, 1, [], -2, 4, [], 81),
    });
    steps.push({
      spec: [[201, 3], [202, 1], ...steps[2].spec],
      delta: deltaMsg(0, 0, [[201, 1, 3], [202, 4, 1]], 4, 5, [201, 202], 85),
    });
    let version = 2;
    for (const step of steps) {
      // the full message's start lines are recomputed by structureFrom; the delta shifts them itself
      a.pv.applyStructure(structureFrom(step.spec, version, Array.from(step.delta.changed)));
      b.pv.applyStructureDelta(step.delta);
      version++;
      frame();
      expectTiles(a.pv, step.spec, `full v${version}`);
      expectTiles(b.pv, step.spec, `delta v${version}`);
      expect(idsInDom(b.pv), `delta v${version} DOM`).toEqual(idsInDom(a.pv));
      checkChunks(b.pv, idsOf(step.spec), `delta v${version}`);
    }
  });

  it('keeps a running mountAll alive and re-walks the document', async () => {
    const { pv, request } = setup(100);
    const spec: Array<[number, number, BlockKind?]> = Array.from({ length: 60 }, (_, i) => [i + 1, 1]);
    pv.applyStructure(structureFrom(spec));
    frame();
    const done = pv.mountAll();
    pv.applyStructureDelta(deltaMsg(30, 1, [[31, 31, 1], [99, 32, 1]], 1, 2, [31, 99], 61));
    let settled = false;
    void done.then(() => { settled = true; });
    for (let k = 0; k < 12; k++) {
      const ids = request.mock.calls.flatMap((c) => c[0]);
      pv.applyHtml(htmlMsg(Array.from(new Set(ids)).map((id) => ({ id, flags: 0, payload: `<p>${id}</p>` })), 2));
      frame();
    }
    await done;
    expect(settled).toBe(true);
    expect(pv.el.querySelector('[data-id="99"]')!.textContent).toBe('99');
  });
});

describe('redundant HTML pushes (lead decision C)', () => {
  it('drops a payload for a block that is mounted, not stale and not requested', () => {
    const { pv, bus } = setup();
    const samples: string[] = [];
    bus.on('perf:sample', (s) => { samples.push(s.name); });
    pv.applyStructure(structureFrom([[1, 1], [2, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one</p>' }, { id: 2, flags: 0, payload: '<p>two</p>' }]));
    frame();
    expect(samples.length).toBe(2);
    const inner = pv.el.querySelector('[data-id="1"] p');
    // the worker's background cache back-fill re-renders and re-pushes an unchanged block
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one</p>' }], 2));
    frame();
    expect(samples.length, 'no second mount').toBe(2);
    expect(pv.el.querySelector('[data-id="1"] p'), 'the subtree is untouched').toBe(inner);
    // …but a block the structure marked changed is still refreshed
    pv.applyStructureDelta(deltaMsg(0, 1, [[1, 1, 1]], 0, 3, [1], 2));
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one-v3</p>' }], 3));
    frame();
    expect(pv.el.querySelector('[data-id="1"]')!.textContent).toBe('one-v3');
    expect(samples.length).toBe(3);
  });

  it('still mounts a push whose payload differs from what is on screen', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 1]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>one</p>' }]));
    frame();
    // no structure said block 1 changed, but the HTML did: the guard must not swallow it
    pv.applyHtml(htmlMsg([{ id: 1, flags: 0, payload: '<p>two</p>' }], 2));
    frame();
    expect(pv.el.querySelector('[data-id="1"]')!.textContent).toBe('two');
  });
});

describe('oversize PLAIN prose blocks (lead decision I)', () => {
  it('prefixes a PLAIN prose block with a muted note and leaves code blocks alone', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 2], [2, 3, BlockKind.Code]]));
    frame();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: HTML_FLAG_PLAIN, payload: '**bold** [l](u)' },
      { id: 2, flags: HTML_FLAG_PLAIN, payload: 'const a = 1;' },
    ]));
    frame();
    const prose = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    const note = prose.firstElementChild!;
    expect(note.tagName).toBe('DIV');
    expect(note.className).toBe('md-plain__note');
    expect(note.textContent).toBe('此段落过长，已按纯文本显示');
    expect(Array.from(prose.querySelectorAll('.md-plain__piece'), (p) => p.textContent).join('')).toBe('**bold** [l](u)');
    expect(prose.querySelector('b')).toBeNull();
    expect(pv.el.querySelector('[data-id="2"] .md-plain__note')).toBeNull();
    expect(pv.el.querySelector('[data-id="2"] pre.md-code--plain code')!.textContent).toBe('const a = 1;');

    // a re-mount keeps exactly one note and does not duplicate the pieces
    pv.applyStructureDelta(deltaMsg(0, 1, [[1, 1, 2]], 0, 2, [1], 5));
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_PLAIN, payload: '**bold** [l](u)!' }], 2));
    frame();
    expect(prose.querySelectorAll('.md-plain__note').length).toBe(1);
    expect(prose.firstElementChild!.className).toBe('md-plain__note');
    expect(prose.querySelectorAll('.md-plain__piece').length).toBe(1);
    expect(prose.querySelector('.md-plain__piece')!.textContent).toBe('**bold** [l](u)!');
  });
});

/**
 * Lead decision 2. The language badge used to be a `float: right` `::before` INSIDE `pre.md-code`, where
 * `white-space: pre` lines ignore the float (so it was painted over the code) and `scrollLeft` carried it
 * into the middle of the line. The preview now lifts the fence into a `div.md-codewrap[data-lang]` at
 * mount time; preview.css paints the badge from that wrapper, outside the fence's horizontal scroller.
 */
describe('code-fence language badge wrapper (lead decision 2)', () => {
  const fence = (lang: string, cls = 'md-code'): string =>
    `<pre class="${cls}" data-l="0"${lang ? ` data-lang="${lang}"` : ''}><code>x</code></pre>`;

  it('wraps a fence that carries a language, on both the trusted and the sanitized path', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 2, BlockKind.Code], [2, 2, BlockKind.Code]]));
    frame();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: HTML_FLAG_TRUSTED, payload: fence('ts') },
      { id: 2, flags: 0, payload: fence('python', 'md-code md-code--unhighlighted') },
    ]));
    frame();
    for (const [id, lang] of [[1, 'ts'], [2, 'python']] as const) {
      const wrap = pv.el.querySelector<HTMLElement>(`[data-id="${id}"] > div.md-codewrap`)!;
      expect(wrap, `block ${id}`).not.toBeNull();
      expect(wrap.dataset.lang).toBe(lang);
      // the badge's box belongs to the wrapper, not to the scrolling <pre>
      expect(wrap.firstElementChild!.tagName).toBe('PRE');
      expect(wrap.childElementCount).toBe(1);
    }
  });

  it('leaves a fence without a language alone and wraps fences nested in a container block', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 2, BlockKind.Code], [2, 6, BlockKind.List]]));
    frame();
    pv.applyHtml(htmlMsg([
      { id: 1, flags: HTML_FLAG_TRUSTED, payload: fence('') },
      { id: 2, flags: 0, payload: `<ul data-l="0"><li>a${fence('js')}</li><li>b${fence('sh')}</li></ul>` },
    ]));
    frame();
    expect(pv.el.querySelector('[data-id="1"] .md-codewrap')).toBeNull();
    expect(pv.el.querySelector('[data-id="1"] > pre.md-code')).not.toBeNull();
    const wraps = pv.el.querySelectorAll<HTMLElement>('[data-id="2"] li > div.md-codewrap');
    expect(Array.from(wraps, (w) => w.dataset.lang)).toEqual(['js', 'sh']);
    // the fences keep their position and their own attributes (alt-click navigation uses data-l)
    expect(pv.el.querySelector('[data-id="2"] li > div.md-codewrap > pre.md-code[data-l="0"]')).not.toBeNull();
  });

  it('re-mounting the same block does not nest wrappers', () => {
    const { pv } = setup();
    pv.applyStructure(structureFrom([[1, 2, BlockKind.Code]]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_TRUSTED, payload: fence('ts') }]));
    frame();
    pv.applyHtml(htmlMsg([{ id: 1, flags: HTML_FLAG_TRUSTED, payload: fence('ts') + '<!-- v2 -->' }], 2));
    frame();
    expect(pv.el.querySelectorAll('[data-id="1"] .md-codewrap').length).toBe(1);
  });
});

/**
 * Lead decision 5 (preview half). A full `structure` means the worker rebuilt its render state — a
 * `setDoc`, a resync, or a RESTART. Every `need` the preview had outstanding went to a worker that no
 * longer exists, so it must forget them and ask again for everything in its window, synchronously:
 * waiting for the rAF pass left the window at the document top after a restart often enough that typing
 * at the cursor produced nothing until the user happened to scroll.
 */
describe('full structure re-requests the window (lead decision 5)', () => {
  const spec20: Array<[number, number]> = Array.from({ length: 20 }, (_, i) => [i + 1, 1]);

  it('forgets needs the old worker never answered so the new one is asked again', () => {
    const { pv, request } = setup(200);
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1]]));
    frame();
    expect(request.mock.calls.flatMap((c) => c[0])).toEqual([1, 2, 3]);
    request.mockClear();
    frame(); frame();
    expect(request).not.toHaveBeenCalled();          // still outstanding: never asked twice
    pv.applyStructure(structureFrom([[1, 1], [2, 1], [3, 1]], 2, []));
    expect(request.mock.calls.flatMap((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('re-requests mounted-but-stale blocks and re-sends the viewport, without waiting for a frame', () => {
    const { pv, request, viewport } = setup(200);
    pv.applyStructure(structureFrom(spec20));
    frame();
    const asked = request.mock.calls.flatMap((c) => c[0]) as number[];
    pv.applyHtml(htmlMsg(asked.map((id) => ({ id, flags: 0, payload: `<p>b${id}</p>` }))));
    frame();
    expect(pv.el.querySelector('[data-id="1"]')!.textContent).toBe('b1');
    request.mockClear();
    viewport.mockClear();

    // The restart: the same document arrives as a FULL structure with every block marked changed.
    pv.applyStructure(structureFrom(spec20, 2, spec20.map((s) => s[0])));
    const again = request.mock.calls.flatMap((c) => c[0]) as number[];
    expect(again).toContain(1);
    expect(again.length).toBeGreaterThanOrEqual(3);
    expect(viewport).toHaveBeenCalled();             // the new worker's viewport starts at lines 1..1
    // and the blocks really refresh, without any scroll
    pv.applyHtml(htmlMsg(again.map((id) => ({ id, flags: 0, payload: `<p>v2-${id}</p>` })), 2));
    frame();
    const w = pv.el.querySelector<HTMLElement>('[data-id="1"]')!;
    expect(w.textContent).toBe('v2-1');
    expect(w.classList.contains('is-stale')).toBe(false);
  });
});

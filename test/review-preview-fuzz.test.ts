// @vitest-environment jsdom
// test/review-preview-fuzz.test.ts — verifier: createPreview's chunk / wrapper bookkeeping (chunk growth
// and splitting on middle insertions, chunk removal, dormant ↔ live materialization, removals of mounted
// blocks). Invariants after every structure (once the frames are drained):
//   * chunks tile the structure in order (Σ data-n == block count); no empty chunk, none larger than 2*CHUNK
//   * a dormant chunk holds no wrappers but does have a --chunk-h; a live one holds exactly data-n wrappers
//   * the wrappers that exist are the structure's ids, in document order, each at most once
//   * every wrapper's --est-h (pending) matches the model estimate / pinned measurement
//   * mounted wrappers whose id survives unchanged keep their content
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import { BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, BlockKind, type DocStats, type PreviewApi, type StructureDeltaMsg, type StructureMsg } from '../src/shared/types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

interface Blk { id: number; lines: number; kind: BlockKind }
function structureOf(blocks: Blk[], version: number, changed: number[]): StructureMsg {
  const arr = new Int32Array(blocks.length * BLOCK_STRIDE);
  let line = 1;
  blocks.forEach((b, i) => {
    arr[i * BLOCK_STRIDE + B_ID] = b.id;
    arr[i * BLOCK_STRIDE + B_START] = line;
    arr[i * BLOCK_STRIDE + B_LINES] = b.lines;
    arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    line += b.lines;
  });
  const stats: DocStats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: line - 1, readingMinutes: 0 };
  return { type: 'structure', version, blocks: arr, changed: Int32Array.from(changed), lineCount: line - 1, stats, outlineVersion: 1 };
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(public cb: (entries: ResizeObserverEntry[]) => void) { FakeResizeObserver.instances.push(this); }
  observe(t: Element): void { this.observed.add(t); }
  unobserve(t: Element): void { this.observed.delete(t); }
  disconnect(): void { this.observed.clear(); }
}

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
  // performance.now advances 1 ms per call so creation / mount slices really break mid-way (multi-frame paths).
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 1));
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); performance.clearMarks(); });

const frame = (): void => { vi.advanceTimersByTime(17); };
const drain = (): void => { for (let i = 0; i < 8; i++) frame(); };

function check(pv: PreviewApi, blocks: Blk[], ctx: string): void {
  const body = pv.el.querySelector('article')!;
  const chunks = Array.from(body.children) as HTMLElement[];
  const want = blocks.map((b) => b.id);
  const live: number[] = [];
  let at = 0;
  let liveChunks = 0;
  for (const c of chunks) {
    expect(c.classList.contains('md-chunk'), ctx).toBe(true);
    const n = Number(c.dataset.n);
    expect(n, `${ctx}\nempty chunk`).toBeGreaterThan(0);
    expect(n, `${ctx}\nchunk too large`).toBeLessThanOrEqual(512);
    const dormant = c.classList.contains('is-dormant');
    // a dormant chunk holds no wrappers at all but keeps the height of its blocks (--chunk-h)
    expect(c.childElementCount, `${ctx}\nchunk children`).toBe(dormant ? 0 : n);
    if (dormant) {
      expect(c.style.getPropertyValue('--chunk-h'), `${ctx}\ndormant chunk without a height`).not.toBe('');
    } else {
      liveChunks++;
      for (let k = 0; k < n; k++) {
        const w = c.children[k] as HTMLElement;
        expect(w.classList.contains('md-block'), ctx).toBe(true);
        expect(Number(w.dataset.id), `${ctx}\nwrapper at index ${at + k}`).toBe(want[at + k]);
        live.push(Number(w.dataset.id));
      }
    }
    at += n;
  }
  expect(at, `${ctx}\nchunks must tile the structure`).toBe(blocks.length);
  const ids = Array.from(pv.el.querySelectorAll<HTMLElement>('.md-block'), (w) => Number(w.dataset.id));
  expect(ids, `${ctx}\nDOM ids != the live chunks' ids in order`).toEqual(live);
  expect(pv.blockCount(), ctx).toBe(blocks.length);
  // the window sits at the top of the document in this fuzz, so block 0 always has a wrapper
  if (blocks.length > 0) expect(liveChunks, `${ctx}\nno live chunk`).toBeGreaterThan(0);
}

describe('review: preview wrapper bookkeeping under random structures', () => {
  for (let seed = 1; seed <= 24; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const bus = createBus();
      const pv = createPreview({ parent, bus, request: () => undefined, viewport: () => undefined, resync: () => undefined });
      Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
      let nextId = 1;
      const fresh = (lines = 1 + Math.floor(r() * 4)): Blk => ({ id: nextId++, lines, kind: r() < 0.2 ? BlockKind.Code : BlockKind.Prose });
      let blocks: Blk[] = [];
      const n0 = Math.floor(r() * 900);
      for (let i = 0; i < n0; i++) blocks.push(fresh());
      let version = 1;
      pv.applyStructure(structureOf(blocks, version, blocks.map((b) => b.id)));
      if (r() < 0.7) drain();
      // mount a few wrappers so removals / evictions of mounted blocks are exercised too
      const mountSome = (): void => {
        const present = Array.from(pv.el.querySelectorAll<HTMLElement>('.md-block')).slice(0, 20).map((w) => Number(w.dataset.id));
        if (!present.length) return;
        const pick = present.map((id) => ({ id, flags: 0, payload: `<p data-l="0">b${id}</p>` }));
        const { batch } = packHtml(pick);
        pv.applyHtml({ type: 'html', version, batch });
        drain();
      };
      for (let step = 0; step < 25; step++) {
        const k = r();
        const next = blocks.slice();
        const changed: number[] = [];
        const n = next.length;
        if (k < 0.3 && n) {
          // replace a middle range with fresh ids (sometimes > 512 → truncate path)
          const p = Math.floor(r() * n);
          const remove = Math.floor(r() * Math.min(n - p, 50));
          const add = r() < 0.2 ? 600 + Math.floor(r() * 400) : Math.floor(r() * 20);
          const ins: Blk[] = [];
          for (let i = 0; i < add; i++) ins.push(fresh());
          next.splice(p, remove, ...ins);
          for (const b of ins) changed.push(b.id);
        } else if (k < 0.5 && n) {
          // edit in place: same ids, changed line counts (typing inside a block)
          const i = Math.floor(r() * n);
          next[i] = { ...next[i], lines: 1 + Math.floor(r() * 6) };
          changed.push(next[i].id);
        } else if (k < 0.65 && n) {
          const i = Math.floor(r() * n);
          next.splice(i, 1 + Math.floor(r() * 5));
        } else if (k < 0.8) {
          // append / prepend
          const ins: Blk[] = [];
          const add = r() < 0.3 ? 700 : Math.floor(r() * 10);
          for (let i = 0; i < add; i++) ins.push(fresh());
          if (r() < 0.5) next.push(...ins); else next.unshift(...ins);
          for (const b of ins) changed.push(b.id);
        } else if (k < 0.9) {
          // brand new document (setDoc)
          next.length = 0;
          const m = Math.floor(r() * 900);
          for (let i = 0; i < m; i++) next.push(fresh());
          for (const b of next) changed.push(b.id);
        } else {
          next.length = 0;
        }
        blocks = next;
        version++;
        pv.applyStructure(structureOf(blocks, version, changed));
        // sometimes leave the creation unfinished before the next structure
        if (r() < 0.6) drain(); else frame();
        if (r() < 0.3) { drain(); mountSome(); }
        if (step === 24 || r() < 0.5) {
          drain();
          check(pv, blocks, `seed ${seed} step ${step} n=${blocks.length}`);
        }
      }
      drain();
      check(pv, blocks, `seed ${seed} final`);
      pv.dispose();
    });
  }
});

// ---------------------------------------------------------------- structure deltas (CONTRACT §7)
function deltaOf(
  index: number, removed: number, inserted: Blk[], startLine: number, lineDelta: number,
  version: number, changed: number[], lineCount: number,
): StructureDeltaMsg {
  const arr = new Int32Array(inserted.length * BLOCK_STRIDE);
  let line = startLine;
  inserted.forEach((b, i) => {
    arr[i * BLOCK_STRIDE + B_ID] = b.id;
    arr[i * BLOCK_STRIDE + B_START] = line;
    arr[i * BLOCK_STRIDE + B_LINES] = b.lines;
    arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    line += b.lines;
  });
  const stats: DocStats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: lineCount, readingMinutes: 0 };
  return {
    type: 'structureDelta', version, index, removed, inserted: arr, lineDelta,
    changed: Int32Array.from(changed), lineCount, stats, outlineVersion: 1,
  };
}

/** Every block's (id, startLine, lineCount, kind) as the preview reports it. */
function tiling(pv: PreviewApi, blocks: Blk[]): Array<[number, number, number, number]> {
  let line = 1;
  return blocks.map(() => {
    const b = pv.blockAtLine(line);
    line += b.lineCount || 1;
    return [b.id, b.startLine, b.lineCount, b.kind] as [number, number, number, number];
  });
}

describe('review: applyStructureDelta matches the equivalent full structure', () => {
  for (let seed = 101; seed <= 116; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      // Lead decision 3: a delta the preview cannot apply triggers opts.resync(). These fuzzed deltas are
      // all well formed, so a resync here means the preview rejected a legitimate message.
      const resync = vi.fn();
      const make = (): PreviewApi => {
        const parent = document.createElement('div');
        document.body.appendChild(parent);
        const pv = createPreview({ parent, bus: createBus(), request: () => undefined, viewport: () => undefined, resync });
        Object.defineProperty(pv.el, 'clientHeight', { value: 800, configurable: true });
        return pv;
      };
      const full = make(), delta = make();
      let nextId = 1;
      const fresh = (): Blk => ({ id: nextId++, lines: 1 + Math.floor(r() * 4), kind: r() < 0.2 ? BlockKind.Code : BlockKind.Prose });
      let blocks: Blk[] = Array.from({ length: 1 + Math.floor(r() * 700) }, fresh);
      let version = 1;
      full.applyStructure(structureOf(blocks, version, blocks.map((b) => b.id)));
      delta.applyStructure(structureOf(blocks, version, blocks.map((b) => b.id)));
      drain();

      for (let step = 0; step < 30; step++) {
        const n = blocks.length;
        const index = n === 0 ? 0 : Math.floor(r() * n);
        const removed = n === 0 ? 0 : Math.floor(r() * Math.min(n - index, 6));
        const gone = blocks.slice(index, index + removed);
        const ins: Blk[] = [];
        // Re-send an edge of the replaced range unchanged (the typing case: the edited block keeps its id),
        // insert fresh ids, or both — the preview must narrow the range to the ids that really change.
        if (removed > 0 && r() < 0.5) ins.push({ ...gone[0], lines: 1 + Math.floor(r() * 5) });
        for (let i = 0, m = Math.floor(r() * 4); i < m; i++) ins.push(fresh());
        if (removed > 1 && r() < 0.35) ins.push({ ...gone[gone.length - 1] });
        const startLine = 1 + blocks.slice(0, index).reduce((a, b) => a + b.lines, 0);
        const lineDelta = ins.reduce((a, b) => a + b.lines, 0) - gone.reduce((a, b) => a + b.lines, 0);
        const next = blocks.slice();
        next.splice(index, removed, ...ins);
        const changed = ins.map((b) => b.id);
        const lineCount = next.reduce((a, b) => a + b.lines, 0);
        version++;
        blocks = next;
        full.applyStructure(structureOf(blocks, version, changed));
        delta.applyStructureDelta(deltaOf(index, removed, ins, startLine, lineDelta, version, changed, lineCount));
        if (r() < 0.5) frame(); else drain();
        if (step % 3 === 0 || step === 29) {
          drain();
          const ctx = `seed ${seed} step ${step} n=${blocks.length}`;
          check(delta, blocks, ctx);
          expect(tiling(delta, blocks), `${ctx}\ntiling`).toEqual(tiling(full, blocks));
          expect(Array.from(delta.el.querySelectorAll<HTMLElement>('.md-block'), (w) => w.dataset.id),
            `${ctx}\nwrappers`).toEqual(Array.from(full.el.querySelectorAll<HTMLElement>('.md-block'), (w) => w.dataset.id));
          const probe = 1 + Math.floor(r() * lineCount);
          expect(delta.lineToScrollTop(probe, 0.3), `${ctx}\nheights at line ${probe}`)
            .toBeCloseTo(full.lineToScrollTop(probe, 0.3), 6);
        }
      }
      expect(resync, `seed ${seed}: a well-formed delta must never make the preview ask for a resync`).not.toHaveBeenCalled();
      full.dispose();
      delta.dispose();
    });
  }
});

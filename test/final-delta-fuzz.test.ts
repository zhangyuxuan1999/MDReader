// @vitest-environment jsdom
// test/final-delta-fuzz.test.ts — FINAL VERIFIER (round 4), CONTRACT §7 structure deltas.
//
// Part 1 drives `createRenderCore` with a fake `post()` over 300 seeds (40 by default, see T1 below) of random multi-change edit
// transactions (inserts/deletes spanning blocks, headings, fences, blank lines, lists, refs) on
// test-data/small.md and generated documents. After every flush the received `structure` /
// `structureDelta` messages are applied to a plain mirror (`{id,start,lines,kind}[]`) and the mirror is
// compared with a from-scratch `segmentAll` of the current text: starts / lineCounts / kinds must match
// exactly and tile the document, ids must be unique, and `changed` must be a subset of the delta's own
// `inserted` ids (types.ts StructureDeltaMsg). At the end of each seed a forced full `structure`
// (`setOptions`) is compared with the mirror, so the worker's own block array is checked too.
//
// Part 2 replays the same message streams through the REAL preview (`createPreview` +
// `applyStructureDelta`) in jsdom and asserts `blockCount` / `blockAtLine` / `lineToScrollTop` agree with
// (a) a preview fed the equivalent full `structure` at every step and (b) a brand-new preview fed one
// full `structure` of the final state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, DEFAULT_RENDER_OPTIONS,
  type BlockKind, type DocStats, type FromWorker, type StructureDeltaMsg, type StructureMsg, type TextChange,
} from '../src/shared/types';
import { createRenderCore } from '../src/worker/core';
import { segmentAll } from '../src/worker/segmenter';
import { createPreview } from '../src/preview/createPreview';
import { createBus } from '../src/shared/bus';
import { packHtml } from '../src/shared/protocol';
import type { PreviewApi } from '../src/shared/types';

// ---------------------------------------------------------------- rng + fixtures
function rng(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}
const pick = <T>(a: readonly T[], r: () => number): T => a[Math.floor(r() * a.length) % a.length];

// jsdom environment: import.meta.url is an http URL, so resolve from the project root instead.
const small = readFileSync(resolve(process.cwd(), 'test-data/small.md'), 'utf8');
const smallHead = small.split('\n').slice(0, 220).join('\n');

/** Generated document with every construct the segmenter has a state for. */
function genDoc(r: () => number, blocks: number): string {
  const out: string[] = [];
  for (let i = 0; i < blocks; i++) {
    const k = Math.floor(r() * 12);
    if (k === 0) out.push(`# Heading ${i}`);
    else if (k === 1) out.push(`## 子标题 ${i}`);
    else if (k === 2) out.push('```js', `const a${i} = 1;`, 'if (a) { }', '```');
    else if (k === 3) out.push(`- item ${i}`, `- item ${i}b`, `  - nested ${i}`);
    else if (k === 4) out.push(`> quote ${i}`, `> more ${i}`);
    else if (k === 5) out.push(`| a | b |`, `| --- | --- |`, `| ${i} | ${i + 1} |`);
    else if (k === 6) out.push('---');
    else if (k === 7) out.push(`Paragraph ${i} with **bold**, [ref][r${i % 3}] and 中文文本。`);
    else if (k === 8) out.push(`[r${i % 3}]: https://example.com/${i}`);
    else if (k === 9) out.push(`<div align="center">`, `  html ${i}`, `</div>`);
    else if (k === 10) out.push('$$', `x_${i} = y`, '$$');
    else out.push(`Setext ${i} | with pipe`, '---');
    out.push('');
  }
  return out.join('\n');
}

const INSERTS = [
  '', 'x', 'abc', ' ', '\n', '\n\n', '\n\n\n',
  '# New heading\n', '\n# New heading\n\n', '## H2\n',
  '```\n', '```js\ncode();\n```\n', '\n```\nraw\n```\n', '~~~\n',
  '- item\n', '\n- a\n- b\n\n', '1. one\n', '> quote\n',
  '| a | b |\n| --- | --- |\n', '---\n', '===\n',
  '$$\nx\n$$\n', '$', '[lbl]: https://e.com\n', '[link][lbl]',
  '<div>\n', '</div>\n', '<!-- c -->\n', 'para text\n\n',
  '中文段落。\n', 'Title | Col\n---\n',
];

/** Ascending, non-overlapping changes in ORIGINAL coordinates, exactly like ChangeSet.iterChanges. */
function makeChanges(text: string, r: () => number): TextChange[] {
  const len = text.length;
  const n = 1 + Math.floor(r() * 4);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) pts.push(Math.floor(r() * (len + 1)));
  pts.sort((a, b) => a - b);
  const out: TextChange[] = [];
  let prevEnd = 0;
  for (const p of pts) {
    const from = Math.max(p, prevEnd);
    if (from > len) break;
    const span = r() < 0.5 ? Math.floor(r() * 120) : Math.floor(r() * 8);
    const to = Math.min(len, from + (r() < 0.55 ? span : 0));
    const insert = r() < 0.85 ? pick(INSERTS, r) : '';
    if (to === from && insert === '') continue;
    out.push({ from, to, insert });
    prevEnd = to;
  }
  return out;
}

function applyToText(text: string, changes: TextChange[]): string {
  let out = text;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

// ---------------------------------------------------------------- mirror
interface MBlock { id: number; start: number; lines: number; kind: BlockKind }

class Mirror {
  blocks: MBlock[] = [];
  lineCount = 0;
  version = -1;
  stats: DocStats | null = null;

  apply(m: StructureMsg | StructureDeltaMsg): void {
    if (m.type === 'structure') {
      this.blocks = read(m.blocks);
    } else {
      const ins = read(m.inserted);
      const tail = this.blocks.slice(m.index + m.removed);
      if (m.lineDelta !== 0) for (const b of tail) b.start += m.lineDelta;
      this.blocks = this.blocks.slice(0, m.index).concat(ins, tail);
    }
    this.version = m.version;
    this.lineCount = m.lineCount;
    this.stats = m.stats;
  }
}

function read(arr: Int32Array): MBlock[] {
  const out: MBlock[] = [];
  for (let o = 0; o < arr.length; o += BLOCK_STRIDE) {
    out.push({ id: arr[o + B_ID], start: arr[o + B_START], lines: arr[o + B_LINES], kind: arr[o + B_KIND] as BlockKind });
  }
  return out;
}

/** Expected block table of `text`, straight from the single source of truth (segmenter.segmentAll). */
function expected(text: string): { blocks: Array<{ start: number; lines: number; kind: BlockKind }>; lineCount: number } {
  const norm = text.indexOf('\r') >= 0 ? text.replace(/\r\n?/g, '\n') : text;
  const lines = norm === '' ? [] : norm.split('\n');
  const segs = segmentAll(lines);
  return { blocks: segs.map((s) => ({ start: s.start + 1, lines: s.count, kind: s.kind })), lineCount: lines.length };
}

function describeMismatch(ctx: string, got: MBlock[], want: ReturnType<typeof expected>): string {
  const g = got.map((b) => `${b.start}+${b.lines}/${b.kind}`).join(' ');
  const w = want.blocks.map((b) => `${b.start}+${b.lines}/${b.kind}`).join(' ');
  return `${ctx}\n  mirror  : ${g}\n  segmentAll: ${w}`;
}

function checkMirror(mirror: Mirror, text: string, ctx: string): void {
  const want = expected(text);
  expect(mirror.lineCount, `${ctx} lineCount`).toBe(want.lineCount);
  // tiling + unique ids
  let line = 1;
  const ids = new Set<number>();
  for (const b of mirror.blocks) {
    expect(b.start, describeMismatch(`${ctx}: tiling hole`, mirror.blocks, want)).toBe(line);
    expect(b.lines, `${ctx}: non-positive lineCount`).toBeGreaterThan(0);
    expect(ids.has(b.id), `${ctx}: duplicate id ${b.id}`).toBe(false);
    ids.add(b.id);
    line += b.lines;
  }
  expect(line - 1, describeMismatch(`${ctx}: coverage`, mirror.blocks, want)).toBe(want.lineCount);
  expect(mirror.blocks.length, describeMismatch(`${ctx}: block count`, mirror.blocks, want)).toBe(want.blocks.length);
  for (let i = 0; i < want.blocks.length; i++) {
    const g = mirror.blocks[i], w = want.blocks[i];
    if (g.start !== w.start || g.lines !== w.lines || g.kind !== w.kind) {
      throw new Error(describeMismatch(`${ctx}: block ${i} is ${g.start}+${g.lines}/${g.kind}, segmentAll says ${w.start}+${w.lines}/${w.kind}`, mirror.blocks, want));
    }
  }
}

// ---------------------------------------------------------------- core harness
interface Step { msg: StructureMsg | StructureDeltaMsg; text: string }

/** Which protocol paths the fuzz actually walked (asserted below, so the fuzz can never go blind). */
const STATS = { delta: 0, full: 0, deltaInsertOnly: 0, deltaRemoveOnly: 0, emptied: 0, maxBlocks: 0, transactions: 0 };

function coreHarness() {
  const msgs: FromWorker[] = [];
  const structural: Array<StructureMsg | StructureDeltaMsg> = [];
  const core = createRenderCore(
    (m) => {
      msgs.push(m);
      if (m.type === 'structure' || m.type === 'structureDelta') structural.push(m);
    },
    { cacheBytes: 1 << 20 },
  );
  core.handle({ type: 'init', options: { ...DEFAULT_RENDER_OPTIONS, highlight: false, math: false } });
  return { core, msgs, structural };
}

/** Runs one seed synchronously (the `viewport` message flushes queued edits in the same task) and
 *  returns every structural message plus the document text each one describes. */
function runSeed(seed: number, h: ReturnType<typeof coreHarness>, opts: { record: boolean }): Step[] {
  const r = rng(seed);
  // vary the document size so the preview's 256-block chunking and the typed-array capacity growth
  // (HeightModel.grow ×1.5, spliceBlocks copyWithin) are really crossed, not just single-chunk documents.
  const base = seed % 5 === 0 ? smallHead
    : seed % 7 === 0 ? genDoc(r, 150 + Math.floor(r() * 200))
    : genDoc(r, 8 + Math.floor(r() * 40));
  const steps: Step[] = [];
  let text = base;
  let version = 100 + seed * 1000;
  h.structural.length = 0;
  h.core.handle({ type: 'setDoc', docId: `fuzz-${seed}`, version, text });
  expect(h.structural.length, `seed ${seed}: setDoc must post one full structure`).toBe(1);
  const mirror = new Mirror();
  mirror.apply(h.structural[0]);
  checkMirror(mirror, text, `seed ${seed} after setDoc`);
  if (opts.record) steps.push({ msg: h.structural[0], text });

  const transactions = 4 + Math.floor(r() * 10);
  let t = 0;
  while (t < transactions) {
    h.structural.length = 0;
    // sometimes queue a burst of transactions and let ONE flush apply them all (CONTRACT §7 batching)
    const burst = r() < 0.55 ? 1 + Math.floor(r() * 5) : 1;
    for (let b = 0; b < burst && t < transactions; b++, t++) {
      let changes: TextChange[];
      const dice = r();
      if (dice < 0.04) changes = [{ from: 0, to: text.length, insert: '' }];                       // select-all + delete
      else if (dice < 0.08) changes = [{ from: 0, to: text.length, insert: genDoc(r, 120) }];      // replace all
      else if (dice < 0.13) {
        const at = Math.floor(r() * (text.length + 1));
        changes = [{ from: at, to: at, insert: genDoc(r, 90) }];                                   // giant paste
      } else changes = makeChanges(text, r);
      if (changes.length === 0) continue;
      text = applyToText(text, changes);
      version++;
      h.core.handle({ type: 'edit', version, changes });
    }
    // forces the pending flush in this very task
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 20 });
    const got = h.structural.slice();
    if (got.length === 0) continue;
    expect(got.length, `seed ${seed}: one flush must post exactly one structural message`).toBe(1);
    const m = got[0];
    if (m.type === 'structureDelta') {
      const insIds = new Set(read(m.inserted).map((b) => b.id));
      for (const id of Array.from(m.changed)) {
        expect(insIds.has(id), `seed ${seed}: delta.changed id ${id} is not among the inserted blocks`).toBe(true);
      }
      expect(m.index).toBeGreaterThanOrEqual(0);
      expect(m.index + m.removed).toBeLessThanOrEqual(mirror.blocks.length);
    }
    STATS.transactions++;
    if (m.type === 'structureDelta') {
      STATS.delta++;
      if (m.removed === 0) STATS.deltaInsertOnly++;
      if (m.inserted.length === 0) STATS.deltaRemoveOnly++;
    } else STATS.full++;
    mirror.apply(m);
    if (mirror.blocks.length === 0) STATS.emptied++;
    if (mirror.blocks.length > STATS.maxBlocks) STATS.maxBlocks = mirror.blocks.length;
    checkMirror(mirror, text, `seed ${seed} after flush v${m.version} (${m.type})`);
    if (opts.record) steps.push({ msg: m, text });
  }

  // the worker's OWN block array: setOptions re-posts a full structure built from `blocks`
  h.structural.length = 0;
  h.core.handle({ type: 'setOptions', options: {} });
  const full = h.structural.filter((m): m is StructureMsg => m.type === 'structure');
  if (text.replace(/\n/g, '') !== '' || expected(text).lineCount > 0) {
    expect(full.length, `seed ${seed}: setOptions must re-post a full structure`).toBe(1);
    const worker = read(full[0].blocks);
    expect(worker.length, `seed ${seed}: worker block count != mirror`).toBe(mirror.blocks.length);
    for (let i = 0; i < worker.length; i++) {
      expect(
        [worker[i].id, worker[i].start, worker[i].lines, worker[i].kind],
        `seed ${seed}: worker block ${i} != mirror block ${i}`,
      ).toEqual([mirror.blocks[i].id, mirror.blocks[i].start, mirror.blocks[i].lines, mirror.blocks[i].kind]);
    }
    expect(full[0].lineCount, `seed ${seed}: full structure lineCount`).toBe(mirror.lineCount);
  }
  return steps;
}

// ---------------------------------------------------------------- part 1
// Test strategy (CONTRACT §11 decision T1): a deterministic SAMPLE by default (seeds 1–40 of part 1,
// every 3rd seed of part 2, so both the mounting and the non-mounting branch run), the full 300 / 80 seeds only with MDR_FULL_FUZZ=1. The coverage floors
// below are scaled to the sample (measured: see the MDR_FUZZ_STATS line) so the sample can never go blind.
const FULL = process.env.MDR_FULL_FUZZ === '1';
const PART1_SEEDS = FULL ? 300 : 40;

describe(`createRenderCore structure-delta stream (${PART1_SEEDS} seeds)`, () => {
  it('every delta stream reproduces segmentAll exactly', () => {
    const h = coreHarness();
    for (let seed = 1; seed <= PART1_SEEDS; seed++) runSeed(seed, h, { record: false });
    if (process.env.MDR_FUZZ_STATS) console.log('[fuzz coverage]', JSON.stringify(STATS));
    expect(STATS.delta, 'the fuzz must exercise the structureDelta path').toBeGreaterThan(FULL ? 500 : 100);
    expect(STATS.full, 'the fuzz must exercise the full-structure fallback too').toBeGreaterThan(20);
    expect(STATS.emptied, 'the fuzz must empty the document at least once').toBeGreaterThan(0);
    expect(STATS.maxBlocks, 'the fuzz must cross the preview chunk size (256)').toBeGreaterThan(300);
  }, FULL ? 600_000 : 60_000);
});

describe('createRenderCore structure-delta stream, natural MessageChannel flush', () => {
  it('async flush of a queued burst reproduces segmentAll exactly', async () => {
    const h = coreHarness();
    for (let seed = 5001; seed <= 5030; seed++) {
      const r = rng(seed);
      let text = genDoc(r, 6 + Math.floor(r() * 10));
      let version = seed * 1000;
      h.structural.length = 0;
      h.core.handle({ type: 'setDoc', docId: `async-${seed}`, version, text });
      const mirror = new Mirror();
      mirror.apply(h.structural[0]);
      for (let t = 0; t < 4; t++) {
        h.structural.length = 0;
        const burst = 1 + Math.floor(r() * 3);
        for (let b = 0; b < burst; b++) {
          const changes = makeChanges(text, r);
          if (changes.length === 0) continue;
          text = applyToText(text, changes);
          version++;
          h.core.handle({ type: 'edit', version, changes });
        }
        const deadline = Date.now() + 5000;
        while (h.structural.length === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 1));
        if (h.structural.length === 0) continue;
        for (const m of h.structural) mirror.apply(m);
        checkMirror(mirror, text, `async seed ${seed} t${t}`);
      }
    }
  }, 60_000);
});

// ---------------------------------------------------------------- part 2: the real preview
class FakeResizeObserver {
  observed = new Set<Element>();
  constructor(public cb: (entries: ResizeObserverEntry[]) => void) {}
  observe(t: Element): void { this.observed.add(t); }
  unobserve(t: Element): void { this.observed.delete(t); }
  disconnect(): void { this.observed.clear(); }
}

function fullStructureOf(mirror: Mirror, version: number, changed: Int32Array = new Int32Array(0)): StructureMsg {
  const arr = new Int32Array(mirror.blocks.length * BLOCK_STRIDE);
  mirror.blocks.forEach((b, i) => {
    arr[i * BLOCK_STRIDE + B_ID] = b.id;
    arr[i * BLOCK_STRIDE + B_START] = b.start;
    arr[i * BLOCK_STRIDE + B_LINES] = b.lines;
    arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
  });
  const stats: DocStats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: mirror.lineCount, readingMinutes: 0 };
  return { type: 'structure', version, blocks: arr, changed: Int32Array.from(changed), lineCount: mirror.lineCount, stats, outlineVersion: 1 };
}

function makePreview(): { api: PreviewApi; host: HTMLElement; resync: ReturnType<typeof vi.fn> } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  // Lead decision 3: the preview asks for a full `structure` whenever it cannot apply a delta. Over the
  // real worker's message stream that must NEVER happen — every delta the worker emits has to satisfy the
  // preview's invariants (bounds, monotone version, blocks tiling the document, lineDelta / lineCount).
  const resync = vi.fn();
  const api = createPreview({ parent: host, bus: createBus(), request: () => {}, viewport: () => {}, resync });
  return { api, host, resync };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Mounts real HTML into the first blocks of both previews, so removals / evictions / chunk surgery run
 *  against live subtrees instead of empty wrappers (jsdom reports no height, so the model stays on
 *  estimates and the three previews remain comparable). */
function mountSome(previews: PreviewApi[], mirror: Mirror, version: number, r: () => number): void {
  const n = Math.min(mirror.blocks.length, 18);
  const items = [];
  for (let i = 0; i < n; i++) {
    if (r() < 0.4) continue;
    items.push({ id: mirror.blocks[i].id, flags: 0, payload: `<p data-l="0">b${mirror.blocks[i].id}</p>` });
  }
  if (items.length === 0) return;
  for (const pv of previews) {
    const { batch } = packHtml(items);
    pv.applyHtml({ type: 'html', version, batch });
  }
}

function snap(pv: PreviewApi, lineCount: number): string {
  const parts: string[] = [`n=${pv.blockCount()}`];
  for (let line = 1; line <= lineCount; line++) {
    const b = pv.blockAtLine(line);
    parts.push(`${line}:${b.index}/${b.id}/${b.startLine}/${b.lineCount}/${b.kind}/${round6(pv.lineToScrollTop(line, 0))}/${round6(pv.lineToScrollTop(line, 0.5))}`);
  }
  return parts.join('|');
}

/** Σ of the chunk placeholders' data-n must always equal the block count. */
function chunkTiling(pv: PreviewApi): number {
  let n = 0;
  for (const c of Array.from(pv.el.querySelectorAll('.md-chunk'))) n += Number((c as HTMLElement).dataset.n);
  return n;
}

describe('preview applyStructureDelta vs applyStructure (fuzz)', () => {
  beforeEach(() => {
    // performance is faked too (integrator, round 3): the preview's eviction schedule and mount slices read
    // performance.now(); with the real clock the result depended on how fast the machine ran (1 failure in 9 runs).
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    performance.clearMarks();
  });

  it('incremental preview state equals a full structure of the same state', () => {
    const h = coreHarness();
    for (let seed = 9001; seed <= 9080; seed += FULL ? 1 : 3) {
      const steps = runSeed(seed, h, { record: true });
      // Half the seeds mount real HTML, so removals / evictions / chunk surgery run against live
      // subtrees. A mounted block deliberately keeps its old height until the new HTML arrives
      // (SPEC §5.5), and jsdom never measures anything, so the brand-new preview below is only a valid
      // comparison for the seeds where nothing was mounted.
      const withMounting = seed % 2 === 0;
      const a = makePreview();   // fed the real delta stream
      const b = makePreview();   // fed an equivalent full structure at every step
      const mirror = new Mirror();
      for (let i = 0; i < steps.length; i++) {
        const { msg } = steps[i];
        mirror.apply(msg);
        if (msg.type === 'structure') a.api.applyStructure(msg);
        else a.api.applyStructureDelta(msg);
        b.api.applyStructure(fullStructureOf(mirror, msg.version, msg.changed));
        vi.advanceTimersByTime(50);
        if (withMounting) {
          mountSome([a.api, b.api], mirror, msg.version, rng(seed * 31 + i));
          vi.advanceTimersByTime(50);
        }
        const ctx = `seed ${seed} step ${i} (${msg.type})`;
        expect(a.api.blockCount(), `${ctx}: blockCount`).toBe(mirror.blocks.length);
        expect(chunkTiling(a.api), `${ctx}: chunk tiling (delta preview)`).toBe(mirror.blocks.length);
        expect(chunkTiling(b.api), `${ctx}: chunk tiling (full preview)`).toBe(mirror.blocks.length);
        const sa = snap(a.api, mirror.lineCount);
        const sb = snap(b.api, mirror.lineCount);
        if (sa !== sb) {
          const ia = sa.split('|'), ib = sb.split('|');
          const k = ia.findIndex((x, j) => x !== ib[j]);
          throw new Error(`${ctx}: delta preview != full preview at entry ${k}\n  delta: ${ia[k]}\n  full : ${ib[k]}`);
        }
      }
      // a brand-new preview fed one full structure of the final state
      const c = makePreview();
      c.api.applyStructure(fullStructureOf(mirror, 9_999_999));
      vi.advanceTimersByTime(50);
      if (!withMounting) {
        const sa = snap(a.api, mirror.lineCount);
        const sc = snap(c.api, mirror.lineCount);
        if (sa !== sc) {
          const ia = sa.split('|'), ic = sc.split('|');
          const k = ia.findIndex((x, j) => x !== ic[j]);
          throw new Error(`seed ${seed}: delta preview != fresh preview at entry ${k}\n  delta: ${ia[k]}\n  fresh: ${ic[k]}`);
        }
      } else {
        expect(a.api.blockCount(), `seed ${seed}: blockCount vs fresh preview`).toBe(c.api.blockCount());
        for (let line = 1; line <= mirror.lineCount; line++) {
          const x = a.api.blockAtLine(line), y = c.api.blockAtLine(line);
          expect([x.index, x.id, x.startLine, x.lineCount, x.kind], `seed ${seed}: blockAtLine(${line}) vs fresh preview`)
            .toEqual([y.index, y.id, y.startLine, y.lineCount, y.kind]);
        }
      }
      expect(a.resync, `seed ${seed}: the worker's delta stream must never desync the preview`).not.toHaveBeenCalled();
      a.api.dispose(); b.api.dispose(); c.api.dispose();
      document.body.replaceChildren();
    }
  }, FULL ? 600_000 : 60_000);
});

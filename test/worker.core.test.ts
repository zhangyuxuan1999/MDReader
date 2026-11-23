import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unpackHtml } from '../src/shared/protocol';
import {
  B_ID, B_LINES, B_START, BLOCK_STRIDE, DEFAULT_RENDER_OPTIONS, HTML_BATCH_MAX_ITEMS, HTML_FLAG_TRUSTED,
  type DocStats, type FromWorker, type HtmlMsg, type StructureDeltaMsg, type StructureMsg, type TextChange,
} from '../src/shared/types';
import { createRenderCore, mergeEffects, stripMathRegions } from '../src/worker/core';

const small = readFileSync(new URL('../test-data/small.md', import.meta.url), 'utf8');

/**
 * Mirror of the preview's persistent structure array (CONTRACT §7): a full `structure` resets it, a
 * `structureDelta` splices `inserted` over `[index, index+removed)` and shifts every later startLine.
 * Every assertion about "the structure" below goes through this model, so the delta stream is checked
 * against the same tiling invariants the old full-array protocol had.
 */
class Model {
  blocks: number[] = [];
  version = 0;
  lineCount = 0;
  outlineVersion = 0;
  stats: DocStats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: 0, readingMinutes: 0 };
  changed: number[] = [];

  apply(m: StructureMsg | StructureDeltaMsg): void {
    if (m.type === 'structure') {
      this.blocks = Array.from(m.blocks);
    } else {
      const tail = this.blocks.slice((m.index + m.removed) * BLOCK_STRIDE);
      if (m.lineDelta !== 0) for (let o = B_START; o < tail.length; o += BLOCK_STRIDE) tail[o] += m.lineDelta;
      this.blocks = this.blocks.slice(0, m.index * BLOCK_STRIDE).concat(Array.from(m.inserted), tail);
    }
    this.version = m.version;
    this.lineCount = m.lineCount;
    this.stats = m.stats;
    this.outlineVersion = m.outlineVersion;
    this.changed = Array.from(m.changed);
  }

  get count(): number {
    return this.blocks.length / BLOCK_STRIDE;
  }

  ids(): number[] {
    const out: number[] = [];
    for (let o = 0; o < this.blocks.length; o += BLOCK_STRIDE) out.push(this.blocks[o + B_ID]);
    return out;
  }

  /** Throws unless the blocks tile [1, lineCount] with unique ids. */
  checkTiling(): void {
    let line = 1;
    const seen = new Set<number>();
    for (let o = 0; o < this.blocks.length; o += BLOCK_STRIDE) {
      expect(this.blocks[o + B_START]).toBe(line);
      expect(this.blocks[o + B_LINES]).toBeGreaterThan(0);
      expect(seen.has(this.blocks[o + B_ID])).toBe(false);
      seen.add(this.blocks[o + B_ID]);
      line += this.blocks[o + B_LINES];
    }
    expect(line - 1).toBe(this.lineCount);
  }

  blockAtLine(line: number): number {
    for (let o = 0; o < this.blocks.length; o += BLOCK_STRIDE) {
      if (line >= this.blocks[o + B_START] && line < this.blocks[o + B_START] + this.blocks[o + B_LINES]) return this.blocks[o + B_ID];
    }
    throw new Error('no block at line ' + line);
  }
}

const isStructure = (m: FromWorker): m is StructureMsg | StructureDeltaMsg => m.type === 'structure' || m.type === 'structureDelta';

function harness(tuning?: Parameters<typeof createRenderCore>[1]) {
  const msgs: FromWorker[] = [];
  const transfers: ArrayBuffer[][] = [];
  const model = new Model();
  const core = createRenderCore((m, t) => {
    msgs.push(m);
    transfers.push(t ?? []);
    if (isStructure(m)) model.apply(m);
  }, tuning);
  let cursor = 0;
  /** Index the next drain() scans from: an `edit` is asynchronous now, so the `idle` that ends it can
   *  land before the test calls take(). Set by edit(), consumed by the next drain(). */
  let drainBase = -1;
  const api = {
    core,
    msgs,
    transfers,
    model,
    /** Messages posted since the previous take(). */
    take(): FromWorker[] {
      const out = msgs.slice(cursor);
      cursor = msgs.length;
      return out;
    },
    /** Queues an edit and waits for the flush task that applies it (CONTRACT §7). Returns the messages
     *  the flush itself posted (structure/structureDelta + outline), never the rendering that follows. */
    async edit(version: number, changes: TextChange[]): Promise<FromWorker[]> {
      const from = msgs.length;
      drainBase = from;
      core.handle({ type: 'edit', version, changes });
      const deadline = Date.now() + 10000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1));
        if (msgs.slice(from).some((m) => isStructure(m) && m.version >= version)) break;
        if (Date.now() > deadline) throw new Error('no structure for version ' + version);
      }
      const si = msgs.findIndex((m, i) => i >= from && isStructure(m));
      const end = msgs[si + 1]?.type === 'outline' ? si + 2 : si + 1;
      return msgs.slice(from, end);
    },
    async drain(): Promise<FromWorker[]> {
      const deadline = Date.now() + 10000;
      const from = drainBase >= 0 ? Math.min(drainBase, cursor) : cursor;
      drainBase = -1;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2));
        if (msgs.slice(from).some((m) => m.type === 'idle')) break;
        if (Date.now() > deadline) throw new Error('no idle within 10 s');
      }
      cursor = msgs.length;
      return msgs.slice(from);
    },
  };
  core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
  return api;
}

const structures = (ms: FromWorker[]) => ms.filter((m): m is StructureMsg => m.type === 'structure');
const deltas = (ms: FromWorker[]) => ms.filter((m): m is StructureDeltaMsg => m.type === 'structureDelta');
const htmls = (ms: FromWorker[]) => ms.filter((m): m is HtmlMsg => m.type === 'html');
const items = (ms: FromWorker[]) => htmls(ms).flatMap((m) => unpackHtml(m.batch));

describe('createRenderCore', () => {
  it('init → ready', () => {
    const h = harness();
    expect(h.take()).toEqual([{ type: 'ready' }]);
  });

  it('setDoc(small.md): structure, outline, html batches for the window, then idle', async () => {
    const h = harness();
    h.take();
    h.core.handle({ type: 'setDoc', docId: 'd1', version: 7, text: small });
    const sync = h.take();
    expect(sync.map((m) => m.type)).toEqual(['structure', 'outline']);
    const s = sync[0] as StructureMsg;
    expect(s.version).toBe(7);
    expect(s.lineCount).toBe(1024);
    expect(s.blocks[B_START]).toBe(1);
    h.model.checkTiling();
    expect(s.stats.lines).toBe(1024);
    expect(s.stats.chars).toBe(small.length);
    expect(s.stats.cjk).toBeGreaterThan(1000);
    expect(s.stats.readingMinutes).toBeGreaterThanOrEqual(1);
    expect(Array.from(s.changed).sort()).toEqual(h.model.ids().sort());
    expect(s.outlineVersion).toBe(1);
    expect(h.transfers[1]).toEqual([s.blocks.buffer, s.changed.buffer]);
    const o = sync[1] as Extract<FromWorker, { type: 'outline' }>;
    expect(o.outlineVersion).toBe(1);
    expect(o.items).toHaveLength(61);
    expect(o.items[0]).toMatchObject({ level: 1, line: 1, blockId: h.model.ids()[0] });

    const rest = await h.drain();
    expect(rest[rest.length - 1]).toEqual({ type: 'idle', version: 7 });
    // the default viewport is line 1: only the first block(s) are auto-pushed, the rest warm the cache
    const pushed = items(rest);
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed.length).toBeLessThan(10);
    expect(pushed[0].id).toBe(h.model.ids()[0]);
    expect(pushed[0].payload).toContain('<h1 data-l="0">');
    for (const m of htmls(rest)) expect(m.version).toBe(7);

    // need(): every block comes back from the cache, batched ≤ HTML_BATCH_MAX_ITEMS
    h.core.handle({ type: 'need', ids: [...h.model.ids(), 999999] });
    const got = await h.drain();
    const all = items(got);
    expect(all.map((i) => i.id).sort()).toEqual(h.model.ids().sort());
    for (const m of htmls(got)) expect(m.batch.ids.length).toBeLessThanOrEqual(HTML_BATCH_MAX_ITEMS);
    expect(all.find((i) => i.payload.includes('katex'))).toBeTruthy();
    expect(all.find((i) => i.payload.includes('hljs-keyword'))).toBeTruthy();
    expect(all.find((i) => i.payload.includes('task-list-item'))).toBeTruthy();
    expect(got[got.length - 1]).toEqual({ type: 'idle', version: 7 });
  });

  it('viewport(): dirty blocks inside the auto-push window are pushed nearest-centre first', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: small });
    h.take();
    await h.drain();
    h.core.handle({ type: 'viewport', firstLine: 500, lastLine: 540 });
    const got = await h.drain();
    const pushed = items(got);
    expect(pushed.length).toBeGreaterThan(5);
    expect(pushed[0].id).toBe(h.model.blockAtLine(520));
    const span = new Map<number, [number, number]>();
    for (let o = 0; o < h.model.blocks.length; o += BLOCK_STRIDE) {
      span.set(h.model.blocks[o + B_ID], [h.model.blocks[o + B_START], h.model.blocks[o + B_START] + h.model.blocks[o + B_LINES] - 1]);
    }
    // window = viewport ± 1.5 × its height (41 lines) → [438, 602]; pushed blocks overlap it
    for (const p of pushed) {
      const [first, last] = span.get(p.id)!;
      expect(last).toBeGreaterThanOrEqual(438);
      expect(first).toBeLessThanOrEqual(602);
    }
    expect(pushed.some((p) => span.get(p.id)![1] < 300)).toBe(false);
  });

  it('edit: ONE structureDelta with the changed id, then html for that id tagged with the new version', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: small });
    h.take();
    const before = h.model.ids();
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 40 });
    await h.drain();
    const target = h.model.blockAtLine(3);
    const off = small.indexOf('本文件由');
    const sync = await h.edit(2, [{ from: off, to: off, insert: '哈' }]);
    // an edit never re-sends the whole document structure (P13) and never re-sends an unchanged outline
    expect(sync.map((m) => m.type)).toEqual(['structureDelta']);
    const d = sync[0] as StructureDeltaMsg;
    expect(d.version).toBe(2);
    expect(d.lineDelta).toBe(0);
    expect(d.inserted.length / BLOCK_STRIDE).toBeLessThanOrEqual(3);
    expect(Array.from(d.changed)).toEqual([target]);
    h.model.checkTiling();
    expect(h.model.ids()).toEqual(before);
    expect(h.model.stats.cjk).toBe(small.match(/[一-鿿]/gu)!.length + 1);
    expect(h.model.outlineVersion).toBe(1);
    const got = await h.drain();
    const pushed = items(got);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].id).toBe(target);
    expect(pushed[0].payload).toContain('哈本文件由');
    expect(htmls(got)[0].version).toBe(2);
    expect(got[got.length - 1]).toEqual({ type: 'idle', version: 2 });

    // editing a heading re-sends the outline with a bumped outlineVersion
    const s2 = await h.edit(3, [{ from: 2, to: 2, insert: 'X' }]);
    expect(s2.map((m) => m.type)).toEqual(['structureDelta', 'outline']);
    expect((s2[0] as StructureDeltaMsg).outlineVersion).toBe(2);
    expect((s2[1] as Extract<FromWorker, { type: 'outline' }>).items[0].text).toMatch(/^X/);
    await h.drain();
  });

  it('a burst of edits queued in one task is applied in ONE flush with ONE structureDelta', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'one\n\ntwo\n\nthree' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    h.take();
    await h.drain();
    for (let v = 2; v <= 20; v++) h.core.handle({ type: 'edit', version: v, changes: [{ from: 0, to: 0, insert: 'a' }] });
    expect(h.take()).toEqual([]); // nothing applied synchronously: the flush is one task
    const flushed = await h.edit(21, [{ from: 0, to: 0, insert: 'a' }]);
    expect(deltas(flushed)).toHaveLength(1);
    expect(deltas(flushed)[0].version).toBe(21);
    h.model.checkTiling();
    const got = await h.drain();
    for (const m of htmls(got)) expect(m.version).toBe(21);
    const first = items(got).find((i) => i.payload.includes('one'));
    expect(first?.payload).toContain('a'.repeat(20) + 'one');
    expect(got[got.length - 1]).toEqual({ type: 'idle', version: 21 });
  });

  it('a multi-change transaction is applied in one pass (Replace-all inside one big block)', async () => {
    const h = harness();
    const body = Array.from({ length: 4000 }, (_, i) => `const v${i} = "tok value ${i}";`).join('\n');
    const text = '# Log\n\n```js\n' + body + '\n```\n';
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    h.take();
    await h.drain();
    const changes: TextChange[] = [];
    for (let i = text.indexOf('tok value'); i >= 0; i = text.indexOf('tok value', i + 9)) {
      changes.push({ from: i, to: i + 9, insert: 'TOKEN value' });
    }
    expect(changes).toHaveLength(4000);
    const t0 = Date.now();
    const sync = await h.edit(2, changes);
    const ms = Date.now() - t0;
    expect(deltas(sync)).toHaveLength(1);
    h.model.checkTiling();
    expect(h.model.lineCount).toBe(text.split('\n').length);
    // the fence is still one block and its source was rewritten exactly once
    const fenceId = h.model.blockAtLine(4);
    expect(h.model.count).toBe(2);
    h.take();
    h.core.handle({ type: 'need', ids: [fenceId] });
    const got = items(await h.drain()).find((i) => i.id === fenceId)!;
    expect(got.payload).toContain('TOKEN value 3999');
    expect(got.payload).not.toContain('tok value');
    // O(affected text + changes): the old per-change resegmentation took ~0.96 ms per change here
    expect(ms).toBeLessThan(2000);
  });

  it('reference definitions: changing a definition re-renders blocks that use it', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'see [docs][d]\n\nplain\n\n[d]: https://a.example' });
    h.take();
    const before = h.model.ids();
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    const first = items(await h.drain());
    expect(first.find((i) => i.id === before[0])?.payload).toContain('href="https://a.example"');
    const off = 'see [docs][d]\n\nplain\n\n[d]: https://'.length;
    const sync = await h.edit(2, [{ from: off, to: off + 1, insert: 'b' }]);
    // `changed` reaches outside the replaced range (a reference definition): a full structure is sent
    expect(structures(sync)).toHaveLength(1);
    expect(Array.from(structures(sync)[0].changed).sort()).toEqual([before[0], before[2]].sort());
    const again = items(await h.drain());
    expect(again.find((i) => i.id === before[0])?.payload).toContain('href="https://b.example"');
  });

  it('empty document: zero blocks, zero stats, idle', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '' });
    const s = structures(h.take())[0];
    expect(s.blocks.length).toBe(0);
    expect(s.lineCount).toBe(0);
    expect(s.stats).toEqual({ chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: 0, readingMinutes: 0 });
    const got = await h.drain();
    expect(got).toEqual([{ type: 'idle', version: 1 }]);
    await h.edit(2, [{ from: 0, to: 0, insert: '# hi' }]);
    expect(h.model.count).toBe(1);
    expect(h.model.stats.latinWords).toBe(1);
    await h.drain();
    await h.edit(3, [{ from: 0, to: 4, insert: '' }]);
    expect(h.model.count).toBe(0);
    expect(h.model.stats.chars).toBe(0);
    await h.drain();
  });

  it('setOptions re-renders everything (structure marks all changed)', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '```ts\nconst a = 1;\n```' });
    h.take();
    const before = h.model.ids();
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 3 });
    expect(items(await h.drain())[0].payload).toContain('hljs-keyword');
    h.core.handle({ type: 'setOptions', options: { highlight: false } });
    const s1 = structures(h.take())[0];
    expect(Array.from(s1.changed)).toEqual(before);
    const got = items(await h.drain());
    expect(got[0].payload).not.toContain('hljs-keyword');
    expect(got[0].payload).toContain('md-code--unhighlighted');
  });

  it('exportHtml renders the whole document with heading ids', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# A\n\n$x$\n\n# A' });
    h.take();
    h.core.handle({ type: 'exportHtml', requestId: 5 });
    await h.drain();
    const deadline = Date.now() + 5000;
    while (!h.msgs.some((m) => m.type === 'exportHtml') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    const e = h.msgs.find((m): m is Extract<FromWorker, { type: 'exportHtml' }> => m.type === 'exportHtml')!;
    expect(e.requestId).toBe(5);
    expect(e.html).toContain('<h1 data-l="0" id="a">A</h1>');
    expect(e.html).toContain('<h1 data-l="4" id="a-1">A</h1>');
    expect(e.html).toContain('katex');
  });

  it('exportHtml sees edits that are still queued', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# A\n' });
    h.take();
    h.core.handle({ type: 'edit', version: 2, changes: [{ from: 2, to: 2, insert: 'Z' }] });
    h.core.handle({ type: 'exportHtml', requestId: 9 });
    const deadline = Date.now() + 5000;
    while (!h.msgs.some((m) => m.type === 'exportHtml') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    const e = h.msgs.find((m): m is Extract<FromWorker, { type: 'exportHtml' }> => m.type === 'exportHtml')!;
    expect(e.html).toContain('ZA');
  });

  it('draft actions are safe without IndexedDB', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'x' });
    h.core.handle({ type: 'draft', action: 'enable' });
    await h.edit(2, [{ from: 0, to: 0, insert: 'y' }]);
    h.core.handle({ type: 'draft', action: 'flush' });
    h.core.handle({ type: 'draft', action: 'clear' });
    h.core.handle({ type: 'draft', action: 'disable' });
    await h.drain();
    expect(h.msgs.some((m) => m.type === 'draftSaved')).toBe(false);
    expect(h.msgs.some((m) => m.type === 'error')).toBe(false);
  });

  it('slow-block throttle: a slow block re-renders at most once per interval while edits continue', async () => {
    // every render counts as slow (threshold -1); interval 150 ms
    const h = harness({ slowRenderMs: -1, slowIntervalMs: 150 });
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'slow block' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 1 });
    const idleAt = async (version: number): Promise<number> => {
      const deadline = Date.now() + 5000;
      while (!h.msgs.some((m) => m.type === 'idle' && m.version === version)) {
        if (Date.now() > deadline) throw new Error('no idle');
        await new Promise((r) => setTimeout(r, 2));
      }
      return Date.now();
    };
    await idleAt(1);
    const t0 = Date.now();
    await h.edit(2, [{ from: 0, to: 0, insert: 'a' }]);
    await new Promise((r) => setTimeout(r, 20));
    await h.edit(3, [{ from: 0, to: 0, insert: 'b' }]);
    expect(htmls(h.msgs).filter((m) => m.version >= 2)).toHaveLength(0); // throttled, not yet re-rendered
    const t1 = await idleAt(3);
    expect(t1 - t0).toBeGreaterThanOrEqual(140);
    const pushed = htmls(h.msgs).filter((m) => m.version >= 2);
    expect(pushed).toHaveLength(1); // one render for both edits, tagged with the latest version
    expect(pushed[0].version).toBe(3);
    expect(unpackHtml(pushed[0].batch)[0].payload).toContain('baslow block');
  });

  it('code-block coalescing: edits within 150 ms of the last render are rendered once, 150 ms later', async () => {
    const h = harness({ codeCoalesceMs: 150 });
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '```ts\nconst a = 1;\n```' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 3 });
    const idleAt = async (version: number): Promise<number> => {
      const deadline = Date.now() + 5000;
      while (!h.msgs.some((m) => m.type === 'idle' && m.version === version)) {
        if (Date.now() > deadline) throw new Error('no idle');
        await new Promise((r) => setTimeout(r, 2));
      }
      return Date.now();
    };
    await idleAt(1);
    await new Promise((r) => setTimeout(r, 160));
    // first edit after a pause renders at once
    const t0 = Date.now();
    await h.edit(2, [{ from: 6, to: 6, insert: 'x' }]);
    const t1 = await idleAt(2);
    expect(t1 - t0).toBeLessThan(150);
    expect(htmls(h.msgs).filter((m) => m.version === 2)).toHaveLength(1);
    // a burst of edits right after: none rendered immediately, one render ≈ 150 ms after the first deferred edit
    const t2 = Date.now();
    await h.edit(3, [{ from: 6, to: 6, insert: 'y' }]);
    await new Promise((r) => setTimeout(r, 40));
    await h.edit(4, [{ from: 6, to: 6, insert: 'z' }]);
    await new Promise((r) => setTimeout(r, 40));
    expect(htmls(h.msgs).filter((m) => m.version >= 3)).toHaveLength(0);
    const t3 = await idleAt(4);
    expect(t3 - t2).toBeGreaterThanOrEqual(140);
    expect(t3 - t2).toBeLessThan(400);
    const pushed = htmls(h.msgs).filter((m) => m.version >= 3);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].version).toBe(4);
    const it0 = unpackHtml(pushed[0].batch)[0];
    expect(it0.payload).toContain('zyx');
    expect(it0.flags & HTML_FLAG_TRUSTED).toBe(HTML_FLAG_TRUSTED);
    // a paragraph is never coalesced
    await h.edit(5, [{ from: 0, to: 0, insert: 'para\n\n' }]);
    const t4 = Date.now();
    await h.edit(6, [{ from: 0, to: 0, insert: 'a' }]);
    await idleAt(6);
    expect(Date.now() - t4).toBeLessThan(150);
  });

  it('big fence: escaped text is pushed at once while typing, highlighted once it settles', async () => {
    const h = harness({ codeCoalesceMs: 80, fastCodeChars: 1000, slowIntervalMs: 40 });
    const msgs = h.msgs;
    const body = Array.from({ length: 300 }, (_, i) => `const value${i}: number = ${i}; // a comment`).join('\n');
    const text = '```ts\n' + body + '\n```';
    expect(text.length).toBeGreaterThan(8192);
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 302 });
    const waitFor = async (pred: () => boolean, label: string): Promise<number> => {
      const deadline = Date.now() + 5000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error('timeout: ' + label);
        await new Promise((r) => setTimeout(r, 2));
      }
      return Date.now();
    };
    await waitFor(() => msgs.some((m) => m.type === 'idle' && m.version === 1), 'idle v1');
    expect(items(msgs)[0].payload).toContain('hljs-keyword'); // the initial render is highlighted
    // typing inside the fence: the escaped text must not wait for highlight.js
    const t0 = Date.now();
    await h.edit(2, [{ from: 6, to: 6, insert: 'X' }]);
    const t1 = await waitFor(() => htmls(msgs).some((m) => m.version === 2), 'html v2');
    expect(t1 - t0).toBeLessThan(90);
    const first = items(msgs.filter((m) => m.type === 'html' && m.version === 2))[0];
    expect(first.payload).toContain('md-code--unhighlighted');
    expect(first.payload).toContain('Xconst value0');
    expect(first.flags & HTML_FLAG_TRUSTED).toBe(HTML_FLAG_TRUSTED);
    // …and the highlighted version follows once the block has been quiet
    await waitFor(() => msgs.some((m) => m.type === 'idle' && m.version === 2), 'idle v2');
    const last = items(msgs).at(-1)!;
    expect(last.payload).toContain('hljs-keyword');
    expect(last.payload.slice(0, 300)).toContain('Xconst');
    // a burst of edits pushes escaped text for every keystroke and highlights once at the end
    const before = htmls(msgs).length;
    for (let i = 0; i < 4; i++) {
      await h.edit(3 + i, [{ from: 6, to: 6, insert: 'Y' }]);
      await new Promise((r) => setTimeout(r, 12));
    }
    await waitFor(() => msgs.some((m) => m.type === 'idle' && m.version === 6), 'idle v6');
    const burst = htmls(msgs).slice(before);
    expect(burst.length).toBeGreaterThanOrEqual(4);
    expect(burst.filter((m) => items([m])[0].payload.includes('hljs-keyword'))).toHaveLength(1);
    expect(items([burst[burst.length - 1]])[0].payload.slice(0, 300)).toContain('YYYYXconst');
  });

  it('references: fences / <pre> / indented code never define; paragraphs are not interrupted; multi-line definitions work', async () => {
    const render = async (text: string): Promise<string> => {
      const h = harness();
      h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
      h.take();
      const all = h.model.ids();
      h.core.handle({ type: 'need', ids: all });
      const got = items(await h.drain());
      return all.map((id) => got.find((i) => i.id === id)?.payload ?? '').join('');
    };
    expect(await render('```\n[x]: https://example.com/fence\n```\n\nuse [x] here\n')).toContain('use [x] here');
    expect(await render('<pre>\n[y]: https://example.com/pre\n</pre>\n\nuse [y] here\n')).toContain('use [y] here');
    expect(await render('para\n\n    [z]: https://example.com/indented\n\nuse [z] here\n')).toContain('use [z] here');
    expect(await render('```\ncode\n```\n[w]: https://example.com/after\n\nuse [w]\n')).toContain('<a href="https://example.com/after">w</a>');
    const notRef = await render('text\n[notref]: https://example.com/n\n\nuse [notref]\n');
    expect(notRef).toContain('<p data-l="0">text\n[notref]: <a href="https://example.com/n">https://example.com/n</a></p>');
    expect(notRef).toContain('use [notref]');
    expect(await render('[a]\n\n[a]: https://example.com/a\n  "Title on next line"\n')).toContain('<a href="https://example.com/a" title="Title on next line">a</a>');
    expect(await render('[b]\n\n[b]:\n  https://example.com/b\n')).toContain('<a href="https://example.com/b">b</a>');
    expect(await render('> [q]: https://example.com/q\n\n- [l]: https://example.com/l\n\nuse [q] and [l].\n')).toContain('<a href="https://example.com/q">q</a> and <a href="https://example.com/l">l</a>');
    // first definition wins, in document order
    expect(await render('[d]: https://example.com/1\n\n[d]: https://example.com/2\n\nuse [d]\n')).toContain('href="https://example.com/1"');
  });

  it('a definition with no space after the colon is honoured, and rendering never poisons the reference set', async () => {
    // markdown-it's `reference` rule writes every definition it finds into `env.references`. Rendering a
    // block used to mutate the worker's shared `refs` (the prefilter had rejected `[ref]:===`), so the
    // output of a block depended on which blocks had been rendered before it.
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '[ref]:===\n\nuse [ref] here\n' });
    h.take();
    const all = h.model.ids();
    h.core.handle({ type: 'need', ids: all });
    const got = items(await h.drain());
    // a whole-document markdown-it render resolves it: `<p>use <a href="===">ref</a> here</p>`
    expect(got.find((i) => i.id === all[1])?.payload).toContain('href="==="');

    // …and a block that markdown-it would NOT treat as a definition must not leak into later renders
    const g = harness();
    g.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'text\n[leak]:https://example.com/x\n\nuse [leak] here\n' });
    g.take();
    const gids = g.model.ids();
    g.core.handle({ type: 'need', ids: gids });
    const out = items(await g.drain());
    const users = out.find((i) => i.id === gids[1])!.payload;
    expect(users).not.toContain('href="https://example.com/x"'); // the definition is inside a paragraph
    // render the paragraph again (cache miss via setOptions) — still no leak
    g.core.handle({ type: 'setOptions', options: { breaks: true } });
    g.take();
    g.core.handle({ type: 'need', ids: gids });
    const out2 = items(await g.drain());
    expect(out2.find((i) => i.id === gids[1])!.payload).not.toContain('href="https://example.com/x"');
  });

  it('exportHtml honours mathOutput', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '$x$' });
    h.take();
    h.core.handle({ type: 'exportHtml', requestId: 7, mathOutput: 'html' });
    const deadline = Date.now() + 5000;
    while (!h.msgs.some((m) => m.type === 'exportHtml') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
    const e = h.msgs.find((m): m is Extract<FromWorker, { type: 'exportHtml' }> => m.type === 'exportHtml')!;
    expect(e.html).toContain('katex-html');
    expect(e.html).not.toContain('<math');
  });

  it('README pattern: <details> region is one Html block; markdown headings inside the region are in the outline', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '<details>\n<summary>S</summary>\n\n# Inside\n\n</details>\n\n<div align="center">\n\n# Centered\n\n</div>\n' });
    const sync = h.take();
    expect(h.model.count).toBe(2);
    const o = sync.find((m): m is Extract<FromWorker, { type: 'outline' }> => m.type === 'outline')!;
    expect(o.items.map((e) => [e.level, e.text, e.line])).toEqual([[1, 'Inside', 4], [1, 'Centered', 10]]);
    // typing inside the region keeps it one block and updates the outline
    const at = '<details>\n<summary>S</summary>\n\n# '.length;
    const s2 = await h.edit(2, [{ from: at, to: at, insert: 'X' }]);
    expect(h.model.count).toBe(2);
    expect((s2.find((m) => m.type === 'outline') as Extract<FromWorker, { type: 'outline' }>).items[0].text).toBe('XInside');
  });

  it('CRLF input is normalised at setDoc', () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'a\r\n\r\nb' });
    const s = structures(h.take())[0];
    expect(s.lineCount).toBe(3);
    expect(h.model.count).toBe(2);
  });

  it('a reference definition swallowed by an unclosed $$ is not registered (matches a whole-document parse)', async () => {
    const h = harness();
    const text = '# T\n\nSee [later][r2].\n\n## Section\n$$\n\nTail.\n\n[r2]: https://example.com/r2\n';
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 4 });
    const out = await h.drain();
    const html = items(out).map((i) => i.payload).join('\n');
    expect(html).toContain('[later][r2]');   // literal text, exactly as a whole-document parse renders it
    expect(html).not.toContain('<a href="https://example.com/r2"');
  });

  it('a reference definition after a CLOSED $$ block is still registered', async () => {
    const h = harness();
    const text = '# T\n\nSee [ok][r1].\n\n$$\na = b\n$$\n[r1]: https://example.com/r1\n';
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 4 });
    const out = await h.drain();
    const html = items(out).map((i) => i.payload).join('\n');
    expect(html).toContain('<a href="https://example.com/r1"');
  });
});

// ------------------------------------------------------------------ P13: one keystroke = one item
describe('per-keystroke traffic (findings-r3 B + C)', () => {
  it('a keystroke posts ONE html item and a delta whose payload does not grow with the document', async () => {
    const h = harness();
    let text = '';
    for (let i = 0; i < 4000; i++) text += `段落 paragraph ${i} with a few words.\n\n`;
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.take();
    const blocks = h.model.count;
    expect(blocks).toBeGreaterThan(3000);
    const midLine = Math.floor(h.model.lineCount / 2);
    h.core.handle({ type: 'viewport', firstLine: midLine, lastLine: midLine + 40 });
    await h.drain();
    const off = text.split('\n').slice(0, midLine).join('\n').length + 3;
    let pushedItems = 0;
    let insertedBlocks = 0;
    let fullStructures = 0;
    for (let k = 0; k < 10; k++) {
      const from = h.msgs.length;
      await h.edit(2 + k, [{ from: off, to: off, insert: 'x' }]);
      await h.drain();
      for (const m of h.msgs.slice(from)) {
        if (m.type === 'html') pushedItems += unpackHtml(m.batch).length;
        if (m.type === 'structureDelta') insertedBlocks += m.inserted.length / BLOCK_STRIDE;
        if (m.type === 'structure') fullStructures++;
      }
    }
    h.model.checkTiling();
    expect(fullStructures).toBe(0);                 // no full-document array per keystroke (P13)
    expect(insertedBlocks).toBeLessThanOrEqual(30); // ≤ 3 blocks per keystroke, not `blocks`
    expect(pushedItems).toBe(10);                   // exactly one re-mount per keystroke
  });

  it('a keystroke never re-renders far-away blocks the LRU evicted', async () => {
    // The document-wide dirty walk (SPEC 4.5 priority 3) restarts after every edit flush, and a block it
    // rendered stays `dirty` until it is actually pushed. Without the `warmed` mark the walk therefore
    // picked, on every keystroke, every block in the document whose cache entry the LRU had since
    // evicted — 50 000 renders per keystroke on huge.md, and the bulk of P13's 1.45 GB typing peak.
    // A 16 KB budget makes eviction certain; only the bounded back-fill (priority 4, FILL_SCREENS around
    // the viewport) may legitimately re-render, so a render far outside it is the regression itself.
    const rendered: number[] = [];
    const h = harness({ cacheBytes: 16 * 1024, onRender: (id) => rendered.push(id) });
    let text = '';
    for (let i = 0; i < 4000; i++) text += `段落 paragraph ${i} with a few words to render.\n\n`;
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    h.take();
    expect(h.model.count).toBeGreaterThan(3000);
    const startOf = new Map<number, number>();
    for (let o = 0; o < h.model.blocks.length; o += BLOCK_STRIDE) startOf.set(h.model.blocks[o + B_ID], h.model.blocks[o + B_START]);
    const midLine = Math.floor(h.model.lineCount / 2);
    h.core.handle({ type: 'viewport', firstLine: midLine, lastLine: midLine + 40 });
    await h.drain();
    const off = text.split('\n').slice(0, midLine).join('\n').length + 3;
    const edited = h.model.blockAtLine(midLine + 1);
    rendered.length = 0;
    for (let k = 0; k < 5; k++) {
      await h.edit(2 + k, [{ from: off, to: off, insert: 'x' }]);
      await h.drain();
    }
    expect(rendered.filter((id) => id === edited)).toHaveLength(5);
    // FILL_SCREENS (20) × a 41-line viewport ≈ 820 lines each way; 2 000 is well outside it.
    const far = rendered.filter((id) => Math.abs((startOf.get(id) ?? midLine) - midLine) > 2000);
    expect(far).toEqual([]);
    expect(new Set(rendered).size).toBeLessThan(h.model.count / 2);
  });
});

describe('malformed messages (lead decision K)', () => {
  const MALFORMED: unknown[] = [
    { type: 'edit', version: 2 },
    { type: 'edit', version: 2, changes: [{ from: 0, to: 0 }] },
    { type: 'need' },
    { type: 'need', ids: ['x'] },
    { type: 'setDoc', docId: 'x', version: 1 },
    { type: 'viewport' },
    { type: 'draft' },
    { type: 'draft', action: 'constructor' },
    { type: 'exportHtml' },
    { type: 'init' },
  ];

  it('are ignored without throwing and without poisoning the state', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# a\n\nb\n' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 3 });
    await h.drain();
    const ids = h.model.ids();
    for (const m of MALFORMED) expect(() => h.core.handle(m as never)).not.toThrow();
    // the auto-push window still works after a malformed `viewport` (it used to become NaN)
    await h.edit(2, [{ from: 2, to: 2, insert: 'Z' }]);
    const got = items(await h.drain());
    expect(got.map((i) => i.id)).toEqual([ids[0]]);
    expect(got[0].payload).toContain('Za');
    expect(h.msgs.some((m) => m.type === 'error')).toBe(false);
  });
});

// CONTRACT §8 (lead decision 4): the preview could not apply a delta and asks for solid ground.
describe('resync', () => {
  it('answers with a full structure for the current version, identical to the incremental one', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# T\n\nalpha\n\nbeta\n' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    await h.drain();
    await h.edit(2, [{ from: 8, to: 8, insert: 'Z' }]);
    await h.drain();
    const idsBefore = h.model.ids();
    const linesBefore = h.model.lineCount;

    h.core.handle({ type: 'resync' });
    const out = h.take();
    const full = structures(out);
    expect(full).toHaveLength(1);
    expect(full[0].version).toBe(2);
    // the model is rebuilt from the full message alone and still matches what the deltas produced
    expect(h.model.ids()).toEqual(idsBefore);
    expect(h.model.lineCount).toBe(linesBefore);
    h.model.checkTiling();
    // nothing was left un-rendered, so nothing is announced as changed, and the outline the client
    // already has is not repeated
    expect(Array.from(full[0].changed)).toEqual([]);
    expect(out.filter((m) => m.type === 'outline')).toHaveLength(0);
    // the answer is followed by an `idle` for the same version: a structure puts the App back into
    // "rendering", so waitIdle() / the progress indicator must be released again
    expect((await h.drain()).some((m) => m.type === 'idle' && m.version === 2)).toBe(true);
  });

  it('drains queued edits first, so the full structure describes the version the client just sent', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# T\n\nalpha\n\nbeta\n' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 5 });
    await h.drain();
    const lines = h.model.lineCount;
    // queue two transactions WITHOUT awaiting the flush task, then resync in the same turn
    h.core.handle({ type: 'edit', version: 2, changes: [{ from: 8, to: 8, insert: 'X' }] });
    h.core.handle({ type: 'edit', version: 3, changes: [{ from: 8, to: 8, insert: 'Y' }] });
    h.core.handle({ type: 'resync' });
    const out = h.take();
    const order = out.filter((m) => m.type === 'structure' || m.type === 'structureDelta').map((m) => m.type);
    expect(order).toEqual(['structureDelta', 'structure']);   // the burst is applied, then the full answer
    const full = structures(out)[0];
    expect(full.version).toBe(3);
    expect(full.lineCount).toBe(lines);   // neither transaction added a line
    h.model.checkTiling();
    const rendered = items(await h.drain());
    expect(rendered.map((i) => i.payload).join('')).toContain('alpYXha');
  });

  it('never repeats an outline the client already has, however often it is asked', async () => {
    const h = harness();
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# A\n\nalpha\n\n## B\n\nbeta\n' });
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 7 });
    await h.drain();
    const sent = h.msgs.filter((m) => m.type === 'outline').length;
    expect(sent).toBe(1);
    for (let i = 0; i < 3; i++) {
      h.core.handle({ type: 'resync' });
      expect(h.take().filter((m) => m.type === 'outline')).toHaveLength(0);
      await h.drain();
    }
    // a heading edit still bumps and re-sends it, and the next resync stays quiet again
    const after = await h.edit(2, [{ from: 2, to: 2, insert: 'X' }]);
    expect(after.filter((m) => m.type === 'outline')).toHaveLength(1);
    await h.drain();
    h.core.handle({ type: 'resync' });
    expect(h.take().filter((m) => m.type === 'outline')).toHaveLength(0);
    await h.drain();
  });

  it('marks the blocks the preview has not been given as changed, and keeps rendering after the answer', async () => {
    const h = harness();
    // no viewport was ever sent: the window is lines 1..1, so most blocks stay dirty
    h.core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# T\n\nalpha\n\nbeta\n\ngamma\n' });
    await h.drain();
    h.core.handle({ type: 'resync' });
    const full = structures(h.take())[0];
    expect(full.changed.length).toBeGreaterThan(0);
    // every announced id exists in the structure that carries it
    const ids = new Set(h.model.ids());
    for (const id of full.changed) expect(ids.has(id)).toBe(true);
    h.core.handle({ type: 'viewport', firstLine: 1, lastLine: 7 });
    expect(items(await h.drain()).length).toBeGreaterThan(0);
  });
});

describe('mergeEffects', () => {
  it('is the identity for a single transaction', () => {
    const e = { fromLine: 5, toLineOld: 7, toLineNew: 9, lineDelta: 2 };
    expect(mergeEffects(null, e, 100)).toEqual(e);
  });

  it('covers both regions and sums the deltas', () => {
    const a = { fromLine: 5, toLineOld: 7, toLineNew: 9, lineDelta: 2 };
    const b = { fromLine: 20, toLineOld: 20, toLineNew: 20, lineDelta: 0 };
    const m = mergeEffects(a, b, 100);
    expect(m.fromLine).toBeLessThanOrEqual(5);
    expect(m.toLineOld).toBeGreaterThanOrEqual(18); // 20 in post-`a` coordinates ≥ 18 before it
    expect(m.toLineNew).toBeGreaterThanOrEqual(20);
    expect(m.lineDelta).toBe(2);
  });

  it('never runs past the old document', () => {
    const a = { fromLine: 1, toLineOld: 1, toLineNew: 1, lineDelta: -3 };
    const b = { fromLine: 4, toLineOld: 6, toLineNew: 6, lineDelta: 0 };
    const m = mergeEffects(a, b, 10);
    expect(m.toLineOld).toBeLessThanOrEqual(10);
    expect(m.toLineOld).toBeGreaterThanOrEqual(9); // 6 after 3 lines were removed ⇒ 9 before
    expect(m.fromLine).toBe(1);
  });
});

describe('stripMathRegions', () => {
  it('removes closed regions, keeps the tail, and drops everything after an unclosed opener', () => {
    expect(stripMathRegions('a\n$$\nx = 1\n$$\n[r]: u')).toBe('a\n[r]: u');
    expect(stripMathRegions('a\n$$\nx = 1\n[r]: u')).toBe('a');
    expect(stripMathRegions('$$a = b$$\n[r]: u')).toBe('[r]: u');   // self-closing opening line
    expect(stripMathRegions('no dollars here')).toBe('no dollars here');
    expect(stripMathRegions('inline $$x$$ stays')).toBe('inline $$x$$ stays');
  });
});

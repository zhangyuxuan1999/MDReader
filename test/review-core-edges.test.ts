// test/review-core-edges.test.ts — verifier: worker core edge cases suspected from the static review.
//  (1) mathInline scans forward from every `$` (math.ts): cost curve for a `$`-heavy paragraph that stays
//      under maxHtmlChars (200k) — the worker renders such a block synchronously inside one slice.
//  (2) `need` for unknown ids / `viewport` before any document never wedge the scheduler.
//  (3) an `edit` that empties the document, then one that recreates it, keeps structure/stats consistent.
import { describe, expect, it } from 'vitest';
import { createMarkdown } from '../src/worker/md';
import { createRenderCore } from '../src/worker/core';
import { BLOCK_STRIDE, DEFAULT_RENDER_OPTIONS, type FromWorker, type StructureDeltaMsg, type StructureMsg } from '../src/shared/types';

function timeRender(source: string): number {
  const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS });
  md.enableMath();
  md.renderBlock('warm $x$ up', { references: {} });
  const t0 = performance.now();
  md.renderBlock(source, { references: {} });
  return performance.now() - t0;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe('review: math inline parser cost curve', () => {
  it('reports render time for 4k / 8k / 16k unpaired `$` prices in one paragraph (< 200 KB)', () => {
    const rows: string[] = [];
    let last = 0;
    for (const n of [4000, 8000, 16000]) {
      const words: string[] = [];
      for (let i = 0; i < n; i++) words.push(`$${i} 元`);
      const src = words.join(' ');
      const ms = timeRender(src);
      rows.push(`${n} dollars / ${src.length} chars → ${ms.toFixed(0)} ms`);
      last = ms;
    }
    // eslint-disable-next-line no-console
    console.log('review-core-edges math curve:\n  ' + rows.join('\n  '));
    // A single block under the 200 KB PLAIN threshold must not block the worker for a second.
    expect(last).toBeLessThan(1000);
  });
});

describe('review: scheduler never wedges on odd message order', () => {
  it('viewport/need before setDoc, need for unknown ids, then a normal setDoc still reaches idle', async () => {
    const msgs: FromWorker[] = [];
    const core = createRenderCore((m) => { msgs.push(m); });
    core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
    core.handle({ type: 'viewport', firstLine: 1, lastLine: 40 });
    core.handle({ type: 'need', ids: [1, 2, 3, 999] });
    await flush();
    core.handle({ type: 'setDoc', docId: 'd', version: 1, text: '# a\n\npara\n\n- x\n' });
    core.handle({ type: 'need', ids: [999, 12345] });
    for (let i = 0; i < 20 && !msgs.some((m) => m.type === 'idle' && m.version === 1); i++) await flush();
    expect(msgs.some((m) => m.type === 'idle' && m.version === 1)).toBe(true);
    const s = msgs.find((m) => m.type === 'structure') as StructureMsg;
    expect(s.blocks.length / BLOCK_STRIDE).toBe(3);
  });

  it('emptying the document by edit and re-typing keeps blocks/stats consistent and reaches idle', async () => {
    const msgs: FromWorker[] = [];
    const core = createRenderCore((m) => { msgs.push(m); });
    core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
    const text = '# a\n\npara\n';
    core.handle({ type: 'setDoc', docId: 'd', version: 1, text });
    // CONTRACT §7: edits are queued and applied in one flush task, so each version needs its own flush
    core.handle({ type: 'edit', version: 2, changes: [{ from: 0, to: text.length, insert: '' }] });
    await flush();
    core.handle({ type: 'edit', version: 3, changes: [{ from: 0, to: 0, insert: 'hello' }] });
    await flush();
    core.handle({ type: 'edit', version: 4, changes: [{ from: 5, to: 5, insert: '\n\n# h' }] });
    await flush();
    for (let i = 0; i < 20 && !msgs.some((m) => m.type === 'idle' && m.version === 4); i++) await flush();
    const structures = msgs.filter((m): m is StructureMsg | StructureDeltaMsg => m.type === 'structure' || m.type === 'structureDelta');
    const v2 = structures.find((s) => s.version === 2)!;
    const v4 = structures.find((s) => s.version === 4)!;
    expect(v2.type === 'structure' ? v2.blocks.length : v2.inserted.length).toBe(0);
    expect(v2.stats.chars).toBe(0);
    expect(v4.type === 'structure' ? v4.blocks.length / BLOCK_STRIDE : v4.inserted.length / BLOCK_STRIDE).toBe(2);
    expect(v4.stats.chars).toBe('hello\n\n# h'.length);
    expect(msgs.some((m) => m.type === 'idle' && m.version === 4)).toBe(true);
  });
});

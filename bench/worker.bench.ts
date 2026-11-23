// bench/worker.bench.ts — SPEC P15 (Node-side): segmentAll on large.md, a local resegment, medium.md render,
// plus the incremental outline update for a 50k-heading document (fix round, lead decision 8g).
// Run: npm run bench (vitest 5 context API). Targets: < 40 ms, < 1 ms, < 800 ms, < 5 ms; the mean is printed per bench
// (written with process.stdout.write: vitest's bench reporter swallows console.log).
import { describe, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEFAULT_RENDER_OPTIONS, type TextChange } from '../src/shared/types';
import { applyChange, applyChanges, createDoc } from '../src/worker/doc';
import { blockSource, buildBlocks, resegmentWindow, segmentAll } from '../src/worker/segmenter';
import { createMarkdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { createOutlineState, updateOutline } from '../src/worker/outline';

const read = (name: string): string => readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');
const alloc = (): (() => number) => {
  let n = 1;
  return () => n++;
};

function report(name: string, meanMs: number, targetMs: number): void {
  process.stdout.write(`[bench] ${name}: mean ${meanMs.toFixed(3)} ms (target < ${targetMs} ms) ${meanMs < targetMs ? 'OK' : 'MISS'}\n`);
}

describe('worker benches (P15)', () => {
  test('segmentAll large.md (102k lines) < 40 ms', async ({ bench }) => {
    const lines = createDoc(read('large.md')).lines;
    const r = await bench('segmentAll large.md', () => {
      segmentAll(lines);
    }).run({ time: 2000 });
    report('segmentAll large.md', r.latency.mean, 40);
  });

  test('resegmentWindow single-char edit mid-document < 1 ms', async ({ bench }) => {
    const doc = createDoc(read('large.md'));
    const id = alloc();
    let blocks = buildBlocks(doc.lines, id);
    const mid = Math.floor(doc.lines.join('\n').length / 2);
    let flip = 0;
    const r = await bench('resegmentWindow mid-document insert/delete', () => {
      // alternate insert/delete so the document does not grow
      const eff = flip++ % 2 === 0 ? applyChange(doc, { from: mid, to: mid, insert: 'x' }) : applyChange(doc, { from: mid, to: mid + 1, insert: '' });
      blocks = resegmentWindow(blocks, doc.lines, eff, id).blocks;
    }).run({ time: 2000 });
    report('resegmentWindow local edit', r.latency.mean, 1);
  });

  test('Replace-all (5 000 changes) inside one 5 000-line fence < 100 ms', async ({ bench }) => {
    // findings-r3 worker finding A: the old per-change apply + resegment was O(changes × block lines)
    // and took 7 433 ms here (0.96 ms/change, measured before the fix); one pass is O(text + changes).
    let body = '# Log\n\n```js\n';
    for (let i = 0; i < 5000; i++) body += `const v${i} = "tok value ${i}";\n`;
    const text = body + '```\n';
    const forward = (src: string, from: string, to: string): TextChange[] => {
      const out: TextChange[] = [];
      for (let i = src.indexOf(from); i >= 0; i = src.indexOf(from, i + from.length)) out.push({ from: i, to: i + from.length, insert: to });
      return out;
    };
    const there = forward(text, 'tok value', 'TOKEN value');
    const replaced = text.replaceAll('tok value', 'TOKEN value');
    const back = forward(replaced, 'TOKEN value', 'tok value');
    const doc = createDoc(text);
    const id = alloc();
    let blocks = buildBlocks(doc.lines, id);
    let flip = 0;
    const r = await bench('replace-all in a 5 000-line fence', () => {
      const eff = applyChanges(doc, flip++ % 2 === 0 ? there : back)!;
      blocks = resegmentWindow(blocks, doc.lines, eff, id).blocks;
    }).run({ time: 2000 });
    report('replace-all, 5 000-line fence, 5 000 changes', r.latency.mean, 100);
  });

  test('render medium.md < 800 ms', async ({ bench }) => {
    await loadMath();
    const mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
    mdk.enableMath();
    const text = read('medium.md');
    const doc = createDoc(text);
    const blocks = buildBlocks(doc.lines, alloc());
    const r = await bench(`render medium.md (${blocks.length} blocks)`, () => {
      for (const b of blocks) mdk.renderBlock(blockSource(doc.lines, b), { references: {}, blockId: b.id });
    }).run({ iterations: 3, warmupIterations: 1, time: 0 });
    report(`render medium.md (${blocks.length} blocks, ${(text.length / 1024 / 1024).toFixed(2)} MB)`, r.latency.mean, 800);
    const mb = Buffer.byteLength(text, 'utf8') / 1024 / 1024;
    process.stdout.write(`[bench] throughput ${(mb / (r.latency.mean / 1000)).toFixed(2)} MB/s over ${mb.toFixed(2)} MB UTF-8 (target ≥ 5 MB/s)\n`);
  });

  test('outline update after a keystroke in a heading of a 50k-heading document < 5 ms', async ({ bench }) => {
    const text = Array.from({ length: 50000 }, (_, i) => `## 标题 heading ${i} *em* [l](u)\n\npara ${i}\n`).join('\n');
    const doc = createDoc(text);
    const id = alloc();
    let blocks = buildBlocks(doc.lines, id);
    const state = createOutlineState();
    updateOutline(state, blocks, doc.lines);
    const at = doc.lines.slice(0, 100000).join('\n').length + 1 + 4; // inside the heading on line 100001
    let flip = 0;
    const r = await bench('outline update (50k headings, heading edit)', () => {
      const eff = flip++ % 2 === 0 ? applyChange(doc, { from: at, to: at, insert: 'x' }) : applyChange(doc, { from: at, to: at + 1, insert: '' });
      blocks = resegmentWindow(blocks, doc.lines, eff, id).blocks;
      updateOutline(state, blocks, doc.lines);
    }).run({ time: 2000 });
    report('outline update, 50k headings', r.latency.mean, 5);
  });
});

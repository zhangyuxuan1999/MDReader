// test/review-outline-setdoc.test.ts — verifier: outline.ts patches entries in place when the heading count
// is unchanged. setDoc / restart / setOptions reuse the same OutlineState, so a new document with the same
// number of headings goes through the patch path; slugs and ranks must still equal a fresh build.
import { describe, expect, it } from 'vitest';
import { createRenderCore } from '../src/worker/core';
import { buildBlocks } from '../src/worker/segmenter';
import { buildOutline } from '../src/worker/outline';
import { DEFAULT_RENDER_OPTIONS, type FromWorker, type OutlineEntry } from '../src/shared/types';

const strip = (items: OutlineEntry[]) => items.map((e) => ({ level: e.level, text: e.text, slug: e.slug, line: e.line }));
function fresh(text: string) {
  const lines = text === '' ? [] : text.split('\n');
  let n = 1;
  return strip(buildOutline(buildBlocks(lines, () => n++), lines).entries);
}

describe('review: outline across setDoc with equal heading counts', () => {
  const DOCS = [
    '# a\n\n# a\n\n# b',
    '# b\n\n# a\n\n# a',
    '# a\n\n# b\n\n# a',
    '## x\n\n## x\n\n## x',
    '# a\n\nx\n\n# a\n\n# a',
    '# b b\n\n# b-b\n\n# b b',
  ];
  for (let i = 0; i < DOCS.length; i++) {
    for (let j = 0; j < DOCS.length; j++) {
      it(`doc ${i} → doc ${j}`, () => {
        const msgs: FromWorker[] = [];
        const core = createRenderCore((m) => { msgs.push(m); });
        core.handle({ type: 'init', options: { ...DEFAULT_RENDER_OPTIONS, math: false } });
        core.handle({ type: 'setDoc', docId: 'a', version: 1, text: DOCS[i] });
        core.handle({ type: 'setDoc', docId: 'b', version: 2, text: DOCS[j] });
        const outs = msgs.filter((m): m is Extract<FromWorker, { type: 'outline' }> => m.type === 'outline');
        const last = outs[outs.length - 1];
        expect(strip(last.items)).toEqual(fresh(DOCS[j]));
      });
    }
  }
  it('setOptions after an edit that only shifted lines keeps entries consistent', async () => {
    const msgs: FromWorker[] = [];
    const core = createRenderCore((m) => { msgs.push(m); });
    core.handle({ type: 'init', options: { ...DEFAULT_RENDER_OPTIONS, math: false } });
    core.handle({ type: 'setDoc', docId: 'a', version: 1, text: '# a\n\n# a\n\n# b' });
    core.handle({ type: 'edit', version: 2, changes: [{ from: 0, to: 0, insert: 'p\n\n' }] });
    await new Promise((r) => setTimeout(r, 30));   // CONTRACT §7: edits flush in one task
    const outs = msgs.filter((m): m is Extract<FromWorker, { type: 'outline' }> => m.type === 'outline');
    expect(strip(outs[outs.length - 1].items)).toEqual(fresh('p\n\n# a\n\n# a\n\n# b'));
  });
});

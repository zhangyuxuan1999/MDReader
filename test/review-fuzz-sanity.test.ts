import { it, expect } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { flattenChanges } from '../src/editor/changes';
import { createRenderCore } from '../src/worker/core';
import { DEFAULT_RENDER_OPTIONS, type FromWorker, type StructureDeltaMsg, type StructureMsg } from '../src/shared/types';
it('sanity: harness sees edits', async () => {
  const msgs: FromWorker[] = [];
  const core = createRenderCore((m) => { msgs.push(m); });
  core.handle({ type: 'init', options: DEFAULT_RENDER_OPTIONS });
  core.handle({ type: 'setDoc', docId: 'd', version: 1, text: 'a\n\nb' });
  const doc = Text.of(['a', '', 'b']);
  const cs = ChangeSet.of([{ from: 1, to: 1, insert: '\n# H' }], doc.length);
  core.handle({ type: 'edit', version: 2, changes: flattenChanges(cs) });
  await new Promise((r) => setTimeout(r, 30));   // CONTRACT §7: edits flush in one task
  const s = msgs.filter((m): m is StructureMsg => m.type === 'structure');
  const d = msgs.filter((m): m is StructureDeltaMsg => m.type === 'structureDelta');
  expect(s.length).toBe(1);
  expect(d.length).toBe(1);
  expect(d[0].lineCount).toBe(4);
  // apply the delta to the setDoc array the way the preview does: splice, then shift the tail
  const blocks = Array.from(s[0].blocks);
  blocks.splice(d[0].index * 4, d[0].removed * 4, ...Array.from(d[0].inserted));
  for (let o = (d[0].index + d[0].inserted.length / 4) * 4 + 1; o < blocks.length; o += 4) blocks[o] += d[0].lineDelta;
  expect(blocks).toEqual([1, 1, 1, 0, 3, 2, 2, 1, 2, 4, 1, 0]);
  console.log(JSON.stringify(msgs.map(m => m.type)));
});

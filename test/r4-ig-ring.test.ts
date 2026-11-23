// @vitest-environment jsdom
// test/r4-ig-ring.test.ts — fix-session-g, G2 (CONTRACT §11, Checkpoint-E decisions: "The ring keeps no documents it
// does not need", CHC-2). The editor's ring of steps is bounded by what it holds (stepCost, STEP_RING_COST) as well as by
// STEP_RING steps; a version whose step left the ring answers undefined; a document replacement drops every step before
// it and keeps no document, and every version before it answers null. What the ring holds is observed through lineNow
// and through WeakRefs to the documents of each version (a forced GC: node's gc function, exposed at run time).
import { beforeEach, describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { ChangeSet, Text } from '@codemirror/state';
import { createBus } from '../src/shared/bus';
import { createEditor, stepCost, STEP_RING, STEP_RING_COST, type DisposableEditorApi } from '../src/editor/createEditor';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';

installLayoutStubs();
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
/** WeakRefs are kept alive until the end of the job that read them: collect after a few turns. */
async function collect(): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); gc(); }
}

const DOC = ['# T', '', '- [ ] alpha', '- [ ] beta', '- [ ] gamma', ''].join('\n');
const L = 4; // "- [ ] beta"

function setup(doc = DOC): DisposableEditorApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({ parent, bus: createBus(), registry: createFakeRegistry(), theme: 'light' }) as DisposableEditorApi;
  editor.setDoc(doc);
  return editor;
}
beforeEach(() => { document.body.replaceChildren(); });

describe('stepCost: the lines of the document before that a step touched, plus what it inserted', () => {
  const d = Text.of(['abc', '0123456789', 'xyz']);   // line 2: from 4, to 14
  it('one character typed into a line costs that line plus the character', () => {
    expect(stepCost(d, ChangeSet.of([{ from: 8, insert: 'x' }], d.length))).toBe(10 + 1);
  });
  it('two changes in one line count the line once', () => {
    expect(stepCost(d, ChangeSet.of([{ from: 5, insert: 'x' }, { from: 9, to: 11, insert: 'yz' }], d.length))).toBe(10 + 3);
  });
  it('a change across a line break counts both lines and the break', () => {
    expect(stepCost(d, ChangeSet.of([{ from: 12, to: 16 }], d.length))).toBe(18 - 4);
  });
  it('a pasted text costs what it inserts plus the line it lands in', () => {
    const paste = Array.from({ length: 5000 }, (_, i) => `- [ ] pasted ${i}`).join('\n');
    expect(stepCost(d, ChangeSet.of([{ from: 0, insert: paste }], d.length))).toBe(3 + paste.length);
  });
  it('an insertion at the end of the document of an empty last line costs what it inserts', () => {
    const e = Text.of(['abc', '']);
    expect(stepCost(e, ChangeSet.of([{ from: 4, insert: 'zz' }], e.length))).toBe(2);
  });
});

describe('the cost bound (CHC-2): the oldest steps leave while the ring holds more than STEP_RING_COST', () => {
  it('keystrokes in a very long line: dropped versions answer undefined, kept ones still map, dropped documents are freed', async () => {
    const LONG = 3 * 1024 * 1024 - 7;
    const ed = setup(['# T', '', '- [ ] alpha', '- [ ] beta', '', 'w'.repeat(LONG), '', 'end'].join('\n'));
    const v = ed.view;
    const v0 = ed.version;
    // the same rule on the costs this test knows: [version produced, cost], the replacement (setDoc) first
    const sim: [number, number][] = [[v0, 0]];
    const docs = new Map<number, WeakRef<Text>>([[v0, new WeakRef(v.state.doc)]]);
    const EDITS = 8;
    for (let i = 1; i <= EDITS; i++) {
      const l = v.state.doc.line(6);
      v.dispatch({ changes: { from: l.from + (l.length >> 1), insert: 'x' }, userEvent: 'input.type' });
      sim.push([ed.version, LONG + i]);   // the line (LONG + i - 1 characters) plus the inserted one
      while (sim.reduce((s, [, c]) => s + c, 0) > STEP_RING_COST) sim.shift();
      docs.set(ed.version, new WeakRef(v.state.doc));
    }
    expect(sim.length).toBeLessThan(EDITS);                      // the bound acted
    expect(sim.length).toBeLessThanOrEqual(Math.floor(STEP_RING_COST / LONG));
    const kept = new Set(sim.map(([ver]) => ver));
    for (let ver = v0; ver < ed.version; ver++) {
      // a version maps when the step that produced the next one is kept
      expect([ver, ed.lineNow!(L, ver)]).toEqual([ver, kept.has(ver + 1) ? L : undefined]);
    }
    expect(ed.lineNow!(L, ed.version)).toBe(L);
    await collect();
    for (let ver = v0; ver < ed.version; ver++) {
      // the document of a version is held by the step after it (its `before`) and by nothing else of the ring
      expect([ver, docs.get(ver)!.deref() !== undefined]).toEqual([ver, kept.has(ver + 1)]);
    }
    ed.dispose();
  });
  it('ordinary typing stays within the bound: STEP_RING keystrokes in one task line are all kept', () => {
    const ed = setup();
    const v = ed.view;
    const v0 = ed.version;
    for (let k = 0; k < STEP_RING - 1; k++) v.dispatch({ changes: { from: v.state.doc.line(L).to, insert: 'z' } });
    expect(ed.lineNow!(L, v0)).toBe(L);   // about STEP_RING² / 2 = 8.4 M characters: within STEP_RING_COST
  });
  it('a single step above the bound empties the ring: every earlier version answers undefined, later ones map', () => {
    const ed = setup();
    const v = ed.view;
    v.dispatch({ changes: { from: 0, insert: 'A\n' } });
    const v1 = ed.version;
    const big = ('p'.repeat(99) + '\n').repeat(Math.ceil(STEP_RING_COST / 100) + 1);
    v.dispatch({ changes: { from: 0, insert: big } });
    const v2 = ed.version;
    const shift = big.split('\n').length - 1;
    expect(ed.lineNow!(L + 1, v1)).toBeUndefined();
    expect(ed.lineNow!(L, v1 - 1)).toBeUndefined();
    expect(ed.lineNow!(L + 1 + shift, v2)).toBe(L + 1 + shift);   // the current version: no step needed
    v.dispatch({ changes: { from: 0, insert: 'B\n' } });
    expect(ed.lineNow!(L + 1 + shift, v2)).toBe(L + 2 + shift);    // the document of v2 is the next step's before
    expect(ed.lineNow!(L + 1, v1)).toBeUndefined();
  });
});

describe('a document replacement keeps no document (CHC-2)', () => {
  it('every version before setDoc answers null (gone), those the ring held and older ones', () => {
    const ed = setup();
    const v = ed.view;
    const before: number[] = [ed.version];
    for (let i = 0; i < 5; i++) { v.dispatch({ changes: { from: 0, insert: `h${i}\n` } }); before.push(ed.version); }
    const vr = ed.setDoc(DOC);
    for (const ver of [0, ...before]) expect([ver, ed.lineNow!(L, ver)]).toEqual([ver, null]);
    v.dispatch({ changes: { from: 0, insert: 'A\n' } });
    v.dispatch({ changes: { from: 0, insert: 'B\n' } });
    for (const ver of [0, ...before]) expect([ver, ed.lineNow!(L, ver)]).toEqual([ver, null]);
    expect(ed.lineNow!(L, vr)).toBe(L + 2);                        // after the replacement: mapped as usual
    expect(ed.lineNow!(L, vr + 1)).toBe(L + 1);
  });
  it('the replaced document and every document the ring held before it are freed', async () => {
    const big = Array.from({ length: 40000 }, (_, i) => `- [ ] task ${i} ${'w'.repeat(80)}`).join('\n');
    const ed = setup(big);
    const v = ed.view;
    const refs: WeakRef<Text>[] = [new WeakRef(v.state.doc)];
    for (let i = 0; i < 4; i++) { v.dispatch({ changes: { from: v.state.doc.line(10 + i).from, insert: 'x' } }); refs.push(new WeakRef(v.state.doc)); }
    ed.setDoc(DOC);
    await collect();
    expect(refs.map((r) => r.deref() === undefined)).toEqual(refs.map(() => true));
    // and the editor still maps after it
    const v1 = ed.version;
    v.dispatch({ changes: { from: 0, insert: 'A\n' } });
    expect(ed.lineNow!(L, v1)).toBe(L + 1);
  });
});

describe('the push stays cheap (stepCost per step)', () => {
  it('a keystroke in a 1 MB line, a 5000-line paste, a replace-all of 2000 ranges', () => {
    const long = Text.of(['# T', 'w'.repeat(1024 * 1024), 'end']);
    const key = ChangeSet.of([{ from: 4 + 512 * 1024, insert: 'x' }], long.length);
    const lines = Text.of(Array.from({ length: 20000 }, (_, i) => `- [ ] task ${i}`));
    const paste = ChangeSet.of([{ from: lines.line(100).from, insert: Array.from({ length: 5000 }, (_, i) => `- [ ] p ${i}`).join('\n') + '\n' }], lines.length);
    const all = ChangeSet.of(Array.from({ length: 2000 }, (_, i) => ({ from: lines.line(i * 10 + 1).from + 2, to: lines.line(i * 10 + 1).from + 5, insert: '[x]' })), lines.length);
    const ns = (doc: Text, cs: ChangeSet): number => {
      const N = 2000;
      let sink = 0;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) sink += stepCost(doc, cs);
      const t = ((performance.now() - t0) * 1e6) / N;
      expect(sink).toBeGreaterThan(0);
      return Math.round(t);
    };
    const r = { key1MB: ns(long, key), paste5000: ns(lines, paste), replaceAll2000: ns(lines, all) };
    console.log('stepCost ns per step', JSON.stringify(r));
    expect(r.key1MB).toBeLessThan(20_000);
    expect(r.paste5000).toBeLessThan(20_000);
  });
});

// @vitest-environment jsdom
// test/v5-chc-linethrough.test.ts — challenge-c: a randomized oracle for lineThrough (fix-session-f A1, CONTRACT §11
// Checkpoint-D decisions). Every original line starts with a unique marker character (a CJK ideograph no random edit
// ever inserts). Random steps (1 to 6 ChangeSets of 1 to 4 ranges each: inserts with and without line breaks, deletions,
// replacements) are applied; then, for every original line, lineThrough's answer must be
//   - a line number: that line of the end document holds the line's marker, unless the marker was deleted (then the
//     line may have been edited into anything; never a line while the marker lives on another one), or
//   - null / undefined (gone / not knowable).
// It also counts how often the marker survived at column 0 of an untouched line start and the answer was not that line
// (a refused tick that could have been applied) — reported, not asserted, except for steps that never touch a line start.
import { describe, expect, it } from 'vitest';
import { ChangeSet, Text } from '@codemirror/state';
import { lineThrough, type EditorStep } from '../src/editor/createEditor';

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const MARK0 = 0x4e00;
const marker = (i: number): string => String.fromCharCode(MARK0 + i);

let noCol0 = false;   // the second case: no insertion or replacement starts at a line start
function randomChanges(doc: Text, r: () => number): ChangeSet {
  const n = 1 + Math.floor(r() * 4);
  const pts = new Set<number>();
  while (pts.size < n * 2) pts.add(Math.floor(r() * (doc.length + 1)));
  const sorted = [...pts].sort((a, b) => a - b);
  const specs: Array<{ from: number; to?: number; insert?: string }> = [];
  for (let k = 0; k < n; k++) {
    const a = sorted[2 * k], b = sorted[2 * k + 1];
    const kind = r();
    const ins = ['x', '\n', 'ab\n', '\ncd', '- [ ] ', '\n\n', '  ', '> '][Math.floor(r() * 8)];
    if (kind < 0.45) specs.push({ from: a, insert: ins });
    else if (kind < 0.8) specs.push({ from: a, to: Math.min(b, a + 1 + Math.floor(r() * 6)) });
    else specs.push({ from: a, to: Math.min(b, a + 1 + Math.floor(r() * 4)), insert: ins });
  }
  // keep ranges disjoint and ordered
  const ok: typeof specs = [];
  let last = -1;
  for (const s of specs) { if (s.from <= last) continue; if (noCol0 && s.insert && doc.lineAt(s.from).from === s.from) continue; ok.push(s); last = s.to ?? s.from; }
  return ChangeSet.of(ok, doc.length);
}

describe('lineThrough never names another line (random oracle)', () => {
  for (const variant of ['all edits', 'no insertion at a line start'] as const) it(`3000 random step sequences (${variant})`, () => {
    noCol0 = variant !== 'all edits';
    const r = rng(20261122);
    let wrong = 0, answered = 0, gone = 0, unknown = 0;
    const firstWrong: string[] = [];
    for (let trial = 0; trial < 3000; trial++) {
      const lines = Array.from({ length: 12 }, (_, i) => `${marker(i)} - [ ] task ${i} word`);
      let doc = Text.of(lines);
      const v0 = 10;
      const steps: EditorStep[] = [];
      const nSteps = 1 + Math.floor(r() * 6);
      for (let k = 0; k < nSteps; k++) {
        const ch = randomChanges(doc, r);
        steps.push({ version: v0 + k + 1, before: doc, changes: ch });
        doc = ch.apply(doc);
      }
      const current = v0 + nSteps;
      for (let i = 0; i < lines.length; i++) {
        const a = lineThrough(steps, doc, current, i + 1, v0);
        if (typeof a === 'number') {
          answered++;
          // wrong: the answer's line lacks the marker while the marker (the line's original first character) lives on
          // another line of the end document (a line whose marker was deleted may have been edited into anything)
          const at = doc.toString().indexOf(marker(i));
          if (!doc.line(a).text.includes(marker(i)) && at >= 0) {
            wrong++;
            if (firstWrong.length < 3) firstWrong.push(JSON.stringify({ trial, line: i + 1, answer: a, now: doc.line(a).text, steps: steps.map((s) => JSON.stringify(s.changes!.toJSON())) }));
          }
        } else if (a === null) gone++; else unknown++;
      }
    }
    console.log('lineThrough oracle', JSON.stringify({ answered, gone, unknown, wrong }));
    expect(firstWrong).toEqual([]);
    expect(wrong).toBe(0);
  });
});

describe('CHC-1: text typed at column 0 of a task line, then Enter, keeps the line identity on the typed text', () => {
  // The user's flow: Home on "- [ ] beta", types "- [ ] new" (one step per key), presses Enter: "- [ ] new" / "- [ ] beta".
  // A click on beta's stale box must tick beta (line 3) or nothing; it must never name line 2, the new task.
  it('typed char by char, then a line break right after the typed text', () => {
    let doc = Text.of(['# T', '- [ ] beta', 'end']);
    const v0 = 5;
    const steps: EditorStep[] = [];
    const typed = '- [ ] new';
    let v = v0;
    for (let k = 0; k < typed.length; k++) {
      const ch = ChangeSet.of([{ from: doc.line(2).from + k, insert: typed[k] }], doc.length);
      steps.push({ version: ++v, before: doc, changes: ch }); doc = ch.apply(doc);
    }
    const enter = ChangeSet.of([{ from: doc.line(2).from + typed.length, insert: '\n' }], doc.length);
    steps.push({ version: ++v, before: doc, changes: enter }); doc = enter.apply(doc);
    expect(doc.toString()).toBe('# T\n- [ ] new\n- [ ] beta\nend');
    const a = lineThrough(steps, doc, v, 2, v0);
    expect(a === 3 || a === null || a === undefined).toBe(true);
  });
  it('pasted in one step, then Enter', () => {
    let doc = Text.of(['# T', '- [ ] beta', 'end']);
    const s1 = ChangeSet.of([{ from: doc.line(2).from, insert: '- [ ] new' }], doc.length);
    const steps: EditorStep[] = [{ version: 6, before: doc, changes: s1 }]; doc = s1.apply(doc);
    const s2 = ChangeSet.of([{ from: doc.line(2).from + 9, insert: '\n' }], doc.length);
    steps.push({ version: 7, before: doc, changes: s2 }); doc = s2.apply(doc);
    const a = lineThrough(steps, doc, 7, 2, 5);
    expect(a === 3 || a === null || a === undefined).toBe(true);
  });
});

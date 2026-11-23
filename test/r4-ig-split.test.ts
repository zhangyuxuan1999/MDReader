// @vitest-environment jsdom
// test/r4-ig-split.test.ts — fix-session-g, G1 (CONTRACT §11, Checkpoint-E decisions: "A line that was split is gone",
// CHC-1). lineThrough against the rule as it was before (fix-session-f's, copied below as `before`) on random step
// sequences: the only answers that may change are a line that becomes null, and only where a step put a line break
// into the line (an inserted text with a line break at or inside its span). Every other answer is the same.
import { describe, expect, it } from 'vitest';
import { ChangeSet, MapMode, Text } from '@codemirror/state';
import { lineThrough, type EditorStep } from '../src/editor/createEditor';

/** fix-session-f's lineThrough (the snapshot of round 4 after fix-session-f), the reference. */
function before(steps: readonly EditorStep[], end: Text, current: number, line: number, version: number): number | null | undefined {
  if (version === current) return line >= 1 && line <= end.lines ? line : undefined;
  let k = 0;
  while (k < steps.length && steps[k].version <= version) k++;
  if (k >= steps.length || steps[k].version !== version + 1 || steps[steps.length - 1].version !== current) return undefined;
  let n = line;
  for (; k < steps.length; k++) {
    const st = steps[k];
    if (!st.changes) return null;
    if (n < 1 || n > st.before.lines) return undefined;
    const at = k + 1 < steps.length ? steps[k + 1].before! : end;
    const start = st.before.line(n).from;
    const p1 = st.changes.mapPos(start, 1, MapMode.TrackAfter);
    if (p1 === null) return null;
    const l = at.lineAt(p1);
    if (l.from !== p1 && st.changes.mapPos(start, -1) !== l.from) return null;
    n = l.number;
  }
  return n;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const INS = ['x', '\n', 'ab\n', '\ncd', '- [ ] ', '\n\n', '  ', '> ', '- [ ] new\n', 'q\nr'];
function randomChanges(doc: Text, r: () => number): ChangeSet {
  const n = 1 + Math.floor(r() * 3);
  const specs: { from: number; to?: number; insert?: string }[] = [];
  let last = -1;
  const pts = Array.from({ length: n }, () => Math.floor(r() * (doc.length + 1))).sort((a, b) => a - b);
  for (const a of pts) {
    if (a <= last) continue;
    const kind = r();
    const ins = INS[Math.floor(r() * INS.length)];
    const to = Math.min(doc.length, a + 1 + Math.floor(r() * 5));
    const s = kind < 0.5 ? { from: a, insert: ins } : kind < 0.8 ? { from: a, to } : { from: a, to, insert: ins };
    specs.push(s);
    last = s.to ?? s.from;
  }
  return ChangeSet.of(specs, doc.length);
}

/** Did some step put a line break into the span of the line (tracked by the reference rule) — at or inside it? */
function breakInto(steps: readonly EditorStep[], line: number, v0: number): boolean {
  let n = line;
  for (const st of steps) {
    if (st.version <= v0 || !st.changes) continue;
    const l = st.before.line(n);
    let hit = false;
    st.changes.iterChanges((fromA, toA, _fb, _tb, ins) => { if (ins.lines > 1 && toA >= l.from && fromA <= l.to) hit = true; });
    if (hit) return true;
    const at = st.changes.apply(st.before);
    const p = st.changes.mapPos(l.from, 1, MapMode.TrackAfter);
    if (p === null) return false;
    n = at.lineAt(p).number;
  }
  return false;
}

describe('G1: the only answers that change are lines put apart by a line break, and they become null', () => {
  it('4000 random step sequences of 1 to 6 steps over 10 lines', () => {
    const r = rng(4242);
    let same = 0, changed = 0;
    const bad: string[] = [];
    for (let trial = 0; trial < 4000; trial++) {
      let doc = Text.of(Array.from({ length: 10 }, (_, i) => `- [ ] task ${i} word`));
      const v0 = 3;
      const steps: EditorStep[] = [];
      const nSteps = 1 + Math.floor(r() * 6);
      for (let k = 0; k < nSteps; k++) {
        const ch = randomChanges(doc, r);
        steps.push({ version: v0 + k + 1, before: doc, changes: ch });
        doc = ch.apply(doc);
      }
      for (let line = 1; line <= 10; line++) {
        const a = lineThrough(steps, doc, v0 + nSteps, line, v0);
        const b = before(steps, doc, v0 + nSteps, line, v0);
        if (a === b) { same++; continue; }
        changed++;
        if (!(typeof b === 'number' && a === null && breakInto(steps, line, v0)) && bad.length < 3) {
          bad.push(JSON.stringify({ trial, line, now: a, before: b, steps: steps.map((s) => s.changes!.toJSON()) }));
        }
      }
    }
    console.log('G1 against the rule before', JSON.stringify({ same, changed }));
    expect(bad).toEqual([]);
    expect(changed).toBeGreaterThan(0);
  });
});

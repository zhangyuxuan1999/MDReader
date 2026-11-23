import { describe, expect, it } from 'vitest';
import { ChangeSet, EditorSelection, EditorState, Text } from '@codemirror/state';
import { flattenChanges } from '../src/editor/changes';
import type { TextChange } from '../src/shared/types';

/** Applies a TextChange[] the way consumers must: in REVERSE array order on the original text. */
function applyReverse(text: string, changes: TextChange[]): string {
  let out = text;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  }
  return out;
}

function expectAscendingNonOverlapping(changes: TextChange[]): void {
  for (let i = 0; i < changes.length; i++) {
    expect(changes[i].to).toBeGreaterThanOrEqual(changes[i].from);
    if (i > 0) expect(changes[i].from).toBeGreaterThanOrEqual(changes[i - 1].to);
  }
}

describe('flattenChanges', () => {
  it('yields original-coordinate changes for a single insertion', () => {
    const cs = ChangeSet.of({ from: 2, insert: 'XY' }, 5);
    expect(flattenChanges(cs)).toEqual([{ from: 2, to: 2, insert: 'XY' }]);
  });

  it('flattens a multi-cursor transaction into ascending, non-overlapping original offsets', () => {
    const doc = 'alpha\nbeta\ngamma';
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(6), EditorSelection.cursor(11)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    // Insert at every cursor — like typing with three cursors.
    const tr = state.update(state.replaceSelection('++'));
    const changes = flattenChanges(tr.changes);
    expect(changes).toEqual([
      { from: 0, to: 0, insert: '++' },
      { from: 6, to: 6, insert: '++' },
      { from: 11, to: 11, insert: '++' },
    ]);
    expectAscendingNonOverlapping(changes);
    expect(applyReverse(doc, changes)).toBe(tr.newDoc.toString());
  });

  it('handles mixed replacements and deletions (reverse application reproduces the new text)', () => {
    const doc = 'one two three four';
    const state = EditorState.create({ doc });
    const tr = state.update({
      changes: [
        { from: 0, to: 3, insert: '1' },        // replace "one"
        { from: 4, to: 8, insert: '' },         // delete "two "
        { from: 14, insert: '!' },              // insert before "four"
      ],
    });
    const changes = flattenChanges(tr.changes);
    expectAscendingNonOverlapping(changes);
    expect(applyReverse(doc, changes)).toBe(tr.newDoc.toString());
    expect(tr.newDoc.toString()).toBe('1 three !four');
  });

  it('merges adjacent/overlapping specs the way ChangeSet does and still round-trips', () => {
    const doc = Text.of(['abcdef']);
    const cs = ChangeSet.of([{ from: 1, to: 3, insert: 'Q' }, { from: 3, to: 4, insert: 'R' }], doc.length);
    const changes = flattenChanges(cs);
    expectAscendingNonOverlapping(changes);
    expect(applyReverse(doc.toString(), changes)).toBe(cs.apply(doc).toString());
  });
});

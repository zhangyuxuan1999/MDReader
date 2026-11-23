// src/editor/changes.ts — ChangeSet → TextChange[] in ORIGINAL (pre-transaction) coordinates.
import type { ChangeSet } from '@codemirror/state';
import type { TextChange } from '../shared/types';

/**
 * Flattens a transaction's ChangeSet exactly as `iterChanges` yields it: ascending, non-overlapping,
 * every offset relative to the document BEFORE the transaction. Consumers apply the array in reverse
 * order so earlier offsets stay valid (see TextChange in shared/types).
 */
export function flattenChanges(changes: ChangeSet): TextChange[] {
  const out: TextChange[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return out;
}

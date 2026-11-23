// @vitest-environment jsdom
// test/r4-if-linenow.test.ts — fix-session-f, part 1 of "the tick that does not wait" (CONTRACT §11, Checkpoint-D
// decisions: "The editor remembers its recent changes"). The editor's ring of steps and lineNow, through a real
// createEditor: every case of bench/verify/v5-rrc-mappos.mjs (review-records' 40 CodeMirror edits and commands around
// task line 4) keeps that script's answer, except the three column-0 insertions the decision changed (PTK-3: still that
// line); no case answers another line. Plus a version gap, a setDoc on the way, a version above the current one, the
// ring's bound, one step per view update, the step pushed before the change handlers run, and the pass-through.
import { beforeEach, describe, expect, it } from 'vitest';
import * as cmds from '@codemirror/commands';
import { EditorSelection, Text, ChangeSet } from '@codemirror/state';
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { createBus } from '../src/shared/bus';
import { createEditor, lineThrough, STEP_RING, type DisposableEditorApi, type EditorStep } from '../src/editor/createEditor';
import { createSourceAccess } from '../src/app/previewEdit';
import { createFakeRegistry, installLayoutStubs } from './editor.helpers';

installLayoutStubs();

const DOC = ['# T', '', '- [ ] alpha', '- [ ] beta', '- [ ] gamma', '- [ ] delta', ''].join('\n');
const L = 4; // "- [ ] beta"

function setup(doc = DOC): DisposableEditorApi {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const editor = createEditor({ parent, bus: createBus(), registry: createFakeRegistry(), theme: 'light' }) as DisposableEditorApi;
  editor.setDoc(doc);
  return editor;
}

beforeEach(() => { document.body.replaceChildren(); });

type Api = {
  ed: DisposableEditorApi;
  pos(line: number, col?: number): number;
  sel(line: number, col?: number): void;
  ch(spec: unknown, userEvent?: string): void;
  cmd(c: (t: { state: unknown; dispatch: unknown }) => boolean): void;
};
function api(ed: DisposableEditorApi): Api {
  const v = ed.view;
  return {
    ed,
    pos: (line, col = 0) => v.state.doc.line(line).from + col,
    sel(line, col = 0) { v.dispatch({ selection: EditorSelection.cursor(v.state.doc.line(line).from + col) }); },
    ch(spec, userEvent = 'input') { v.dispatch({ changes: spec as never, userEvent }); },
    cmd(c) { c(v as never); },
  };
}

/** [name, edit, answer of v5-rrc-mappos.mjs, answer of lineNow as decided] — undefined in the 4th slot: the same. */
const CASES: [string, (a: Api) => void, number | null, (number | null)?][] = [
  ['type x at col 0 of line', (a) => a.ch({ from: a.pos(L), insert: 'x' }), null, 4],
  ['indent (2 spaces at col 0)', (a) => a.ch({ from: a.pos(L), insert: '  ' }), null, 4],
  ['indentMore command', (a) => { a.sel(L, 3); a.cmd(cmds.indentMore as never); }, null, 4],
  ['Enter at col 0 (plain \\n)', (a) => a.ch({ from: a.pos(L), insert: '\n' }), 5],
  ['Enter at col 0 (continueMarkup)', (a) => { a.sel(L, 0); a.cmd(insertNewlineContinueMarkup as never); }, 4],
  ['Enter at end of prev line (continueMarkup)', (a) => { a.sel(L - 1, a.ed.view.state.doc.line(L - 1).length); a.cmd(insertNewlineContinueMarkup as never); }, 5],
  ['Enter at end of prev line (plain)', (a) => a.ch({ from: a.pos(L) - 1, insert: '\n' }), 5],
  ['Backspace at col 0 (join)', (a) => a.ch({ from: a.pos(L) - 1, to: a.pos(L) }, 'delete.backward'), null],
  ['deleteMarkupBackward at col 6', (a) => { a.sel(L, 6); a.cmd(deleteMarkupBackward as never); }, null],
  ['delete line with break after', (a) => a.ch({ from: a.pos(L), to: a.pos(L + 1) }), null],
  ['delete line with break before', (a) => a.ch({ from: a.pos(L) - 1, to: a.ed.view.state.doc.line(L).to }), null],
  ['delete previous line (break after)', (a) => a.ch({ from: a.pos(L - 1), to: a.pos(L) }), 3],
  ['delete previous line (break before)', (a) => a.ch({ from: a.pos(L - 1) - 1, to: a.pos(L) - 1 }), 3],
  ['replace whole line by same text', (a) => a.ch({ from: a.pos(L), to: a.ed.view.state.doc.line(L).to, insert: a.ed.view.state.doc.line(L).text }), null],
  ['replace whole doc by same text', (a) => a.ch({ from: 0, to: a.ed.view.state.doc.length, insert: a.ed.view.state.doc.toString() }), null],
  ['tick own box [ ]->[x]', (a) => a.ch({ from: a.pos(L, 3), to: a.pos(L, 4), insert: 'x' }), 4],
  ['insert "- [ ] new\\n" ending at line start', (a) => a.ch({ from: a.pos(L), insert: '- [ ] new\n' }), 5],
  ['insert "\\n- [ ] new" at end of prev line', (a) => a.ch({ from: a.pos(L) - 1, insert: '\n- [ ] new' }), 5],
  ['paste replacing prev line incl break', (a) => a.ch({ from: a.pos(L - 1), to: a.pos(L), insert: '- [ ] X\n- [ ] Y\n' }), 5],
  ['several changes around the line', (a) => a.ch([{ from: a.pos(L - 1), insert: '- [ ] p\n' }, { from: a.pos(L, 6), insert: 'Z' }, { from: a.pos(L + 1), to: a.pos(L + 2) }]), 5],
  ['moveLineUp', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineUp as never); }, 3],
  ['moveLineDown', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineDown as never); }, 5],
  ['moveLineDown of previous line (swap)', (a) => { a.sel(L - 1, 2); a.cmd(cmds.moveLineDown as never); }, null],
  ['moveLineUp of next line (swap)', (a) => { a.sel(L + 1, 2); a.cmd(cmds.moveLineUp as never); }, null],
  ['copyLineUp', (a) => { a.sel(L, 2); a.cmd(cmds.copyLineUp as never); }, 4],
  ['copyLineDown', (a) => { a.sel(L, 2); a.cmd(cmds.copyLineDown as never); }, 5],
  ['copyLineDown of previous line', (a) => { a.sel(L - 1, 2); a.cmd(cmds.copyLineDown as never); }, 5],
  ['copyLineUp of previous line', (a) => { a.sel(L - 1, 2); a.cmd(cmds.copyLineUp as never); }, 5],
  ['select lines 3-4, type over with same text', (a) => { const f = a.pos(L - 1), t = a.ed.view.state.doc.line(L).to; a.ch({ from: f, to: t, insert: a.ed.view.state.doc.sliceString(f, t) }); }, null],
  ['cut line 4 (incl break), paste above line 3', (a) => { const t = a.ed.view.state.doc.line(L).text + '\n'; a.ch({ from: a.pos(L), to: a.pos(L + 1) }); a.ch({ from: a.pos(L - 1), insert: t }); }, null],
  ['insert line above then undo', (a) => { a.ch({ from: a.pos(L), insert: '- [ ] new\n' }); a.cmd(cmds.undo as never); }, 4],
  ['delete line then undo', (a) => { a.ch({ from: a.pos(L), to: a.pos(L + 1) }); a.cmd(cmds.undo as never); }, null],
  ['delete prev line then undo', (a) => { a.ch({ from: a.pos(L - 1), to: a.pos(L) }); a.cmd(cmds.undo as never); }, 4],
  ['Backspace join then undo', (a) => { a.ch({ from: a.pos(L) - 1, to: a.pos(L) }, 'delete.backward'); a.cmd(cmds.undo as never); }, null],
  ['type at col0 then undo', (a) => { a.ch({ from: a.pos(L), insert: 'x' }); a.cmd(cmds.undo as never); }, null],
  ['moveLineUp then undo', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineUp as never); a.cmd(cmds.undo as never); }, 4],
  ['undo of an earlier insert above (history)', (a) => { a.ch({ from: 0, insert: 'A\n' }); a.ch({ from: a.pos(L + 1), insert: 'q' }, 'input.type'); a.cmd(cmds.undo as never); a.cmd(cmds.undo as never); }, null],
  ['swap line 4 and 5 by one replace (sort)', (a) => { const f = a.pos(L), t = a.ed.view.state.doc.line(L + 1).to; a.ch({ from: f, to: t, insert: a.ed.view.state.doc.line(L + 1).text + '\n' + a.ed.view.state.doc.line(L).text }); }, null],
  ['composed: insert above + delete line (one tr)', (a) => a.ch([{ from: a.pos(L), insert: '- [ ] new\n' }, { from: a.pos(L), to: a.pos(L + 1) }]), null],
];

describe('lineNow: the cases of v5-rrc-mappos.mjs (Checkpoint-D decisions; PTK-3 for column 0)', () => {
  for (const [name, edit, script, decided] of CASES) {
    it(name, () => {
      const ed = setup();
      const v0 = ed.version;
      edit(api(ed));
      const want = decided === undefined ? script : decided;
      const got = ed.lineNow!(L, v0);
      expect(got).toBe(want);
      // never another line: a line answer still holds beta's text (a column-0 prefix or a tick aside)
      if (typeof got === 'number') expect(ed.view.state.doc.line(got).text).toMatch(/- \[[ x]\] Z?beta$/);
      ed.dispose();
    });
  }
  it('the column-0 refinement does not accept a replaced line break (a join with a task prefix stays gone)', () => {
    const doc = Text.of(['- [ ] a', '- [ ] b', '- [ ] c']);
    const at = doc.line(2).from;
    const cs = ChangeSet.of([{ from: at - 1, to: at, insert: '\n- [ ] other ' }], doc.length);
    const steps: EditorStep[] = [{ version: 1, before: doc, changes: cs }];
    expect(lineThrough(steps, cs.apply(doc), 1, 2, 0)).toBeNull();
    const ins = ChangeSet.of([{ from: at, insert: '> ' }], doc.length);
    expect(lineThrough([{ version: 1, before: doc, changes: ins }], ins.apply(doc), 1, 2, 0)).toBe(2);
  });
});

describe('lineNow: a line that was split is gone (Checkpoint-E decisions, CHC-1; fix-session-g)', () => {
  // [name, edit, answer]: a line break put INSIDE beta's line answers null (gone: nothing is ticked, the toast asks for a
  // second click); one exactly at its end, or a join with the next line, keeps the line.
  const typeAt = (a: Api, line: number, col: number, text: string): void => {
    for (let k = 0; k < text.length; k++) a.ch({ from: a.pos(line, col + k), insert: text[k] }, 'input.type');
  };
  const SPLITS: [string, (a: Api) => void, number | null][] = [
    ['a break in the middle of the line', (a) => a.ch({ from: a.pos(L, 8), insert: '\n' }), null],
    ['a break right after the marker (Enter between box and text)', (a) => a.ch({ from: a.pos(L, 6), insert: '\n' }), null],
    ['Enter between box and text (continueMarkup)', (a) => { a.sel(L, 6); a.cmd(insertNewlineContinueMarkup as never); }, null],
    ['a task typed at column 0 char by char, then a break right after it', (a) => { typeAt(a, L, 0, '- [ ] new'); a.ch({ from: a.pos(L, 9), insert: '\n' }); }, null],
    ['a task pasted at column 0, then a break right after it', (a) => { a.ch({ from: a.pos(L), insert: '- [ ] new' }); a.ch({ from: a.pos(L, 9), insert: '\n' }); }, null],
    ['a break at the very end of the line (still the line)', (a) => a.ch({ from: a.ed.view.state.doc.line(L).to, insert: '\n' }), L],
    ['Enter at the end of the line (continueMarkup; still the line)', (a) => { a.sel(L, a.ed.view.state.doc.line(L).length); a.cmd(insertNewlineContinueMarkup as never); }, L],
    ['a join with the next line (still the line)', (a) => a.ch({ from: a.ed.view.state.doc.line(L).to, to: a.pos(L + 1) }, 'delete.forward'), L],
    ['a join with the next line by Backspace at its start (still the line)', (a) => a.ch({ from: a.pos(L + 1) - 1, to: a.pos(L + 1) }, 'delete.backward'), L],
    ['a split followed by its undo (gone: the stated limit about undo)', (a) => { a.ch({ from: a.pos(L, 8), insert: '\n' }); a.cmd(cmds.undo as never); }, null],
    ['two splits', (a) => { a.ch({ from: a.pos(L, 8), insert: '\n' }); a.ch({ from: a.pos(L, 7), insert: '\n' }); }, null],
    ['two breaks in one change', (a) => a.ch([{ from: a.pos(L, 7), insert: '\n' }, { from: a.pos(L, 9), insert: '\n' }]), null],
    // the old end is the end of the replaced range, which maps past the inserted text: a break inside the line, gone
    ['a replacement of the line\'s tail by text with a break', (a) => a.ch({ from: a.pos(L, 8), to: a.ed.view.state.doc.line(L).to, insert: 'x\ny' }), null],
    ['a replacement of the line\'s tail by text without a break (still the line)', (a) => a.ch({ from: a.pos(L, 8), to: a.ed.view.state.doc.line(L).to, insert: 'xy' }), L],
    ['a deletion from the line\'s middle into the next line (still the line)', (a) => a.ch({ from: a.pos(L, 8), to: a.pos(L + 1, 3) }), L],
    ['a split of the line above (moves the line down)', (a) => a.ch({ from: a.pos(L - 1, 8), insert: '\n' }), L + 1],
  ];
  for (const [name, edit, want] of SPLITS) {
    it(name, () => {
      const ed = setup();
      const v0 = ed.version;
      edit(api(ed));
      const got = ed.lineNow!(L, v0);
      expect(got).toBe(want);
      if (typeof got === 'number') expect(ed.view.state.doc.line(got).text.startsWith('- [ ] be')).toBe(true);
      ed.dispose();
    });
  }
});

describe('lineNow: versions, replacement, gaps, the bound (Checkpoint-D decisions)', () => {
  it('the current version: that line when it exists; undefined for a line the document does not have', () => {
    const ed = setup();
    expect(ed.lineNow!(L, ed.version)).toBe(L);
    expect(ed.lineNow!(99, ed.version)).toBeUndefined();
    expect(ed.lineNow!(0, ed.version)).toBeUndefined();
  });
  it('a version above the current one, a negative or a non-integer one: undefined', () => {
    const ed = setup();
    expect(ed.lineNow!(L, ed.version + 1)).toBeUndefined();
    expect(ed.lineNow!(L, -1)).toBeUndefined();
    expect(ed.lineNow!(L, 0.5)).toBeUndefined();
    expect(ed.lineNow!(Number.NaN, ed.version)).toBeUndefined();
  });
  it('a setDoc on the way: null (gone), not undefined — the ring is not cleared', () => {
    const ed = setup();
    const v0 = ed.version;
    api(ed).ch({ from: 0, insert: 'x' });
    const v1 = ed.version;
    ed.setDoc(DOC);
    expect(ed.lineNow!(L, v0)).toBeNull();
    expect(ed.lineNow!(L, v1)).toBeNull();
    api(ed).ch({ from: 0, insert: 'A\n' });
    expect(ed.lineNow!(L, v1)).toBeNull();
    expect(ed.lineNow!(L, ed.version - 1)).toBe(L + 1);   // after the replacement: mapped normally
  });
  it('the version before the first remembered step (the editor started at 0, setDoc made 1): the replacement answers null', () => {
    const ed = setup();
    expect(ed.version).toBe(1);
    expect(ed.lineNow!(1, 0)).toBeNull();
  });
  it('one step per view update: two transactions dispatched together are one version and one step', () => {
    const ed = setup();
    const v0 = ed.version;
    const v = ed.view;
    const t1 = v.state.update({ changes: { from: 0, insert: 'A\n' } });
    const t2 = t1.state.update({ changes: { from: 0, insert: 'B\n' } });
    v.update([t1, t2]);
    expect(ed.version).toBe(v0 + 1);
    expect(ed.lineNow!(L, v0)).toBe(L + 2);
  });
  it('the step is pushed before the change handlers run (a handler that throws leaves no version without a step)', () => {
    const ed = setup();
    const v0 = ed.version;
    let seen: number | null | undefined = -1;
    ed.onChanges((ver) => { seen = ed.lineNow!(L, v0); expect(ver).toBe(ed.version); });
    api(ed).ch({ from: 0, insert: 'A\n' });
    expect(seen).toBe(L + 1);
    const off = ed.onChanges(() => { throw new Error('handler'); });
    try { api(ed).ch({ from: 0, insert: 'B\n' }); } catch { /* CodeMirror may rethrow in tests */ }
    off();
    expect(ed.lineNow!(L, v0)).toBe(L + 2);
  });
  it(`the ring's bound: ${STEP_RING} steps are remembered, one more is not (undefined, never a wrong line)`, () => {
    const ed = setup();
    const v0 = ed.version;
    const v = ed.view;
    for (let k = 0; k < STEP_RING - 1; k++) v.dispatch({ changes: { from: v.state.doc.length, insert: 'z' } });
    // v0 .. v0 + STEP_RING - 1: the setDoc step plus STEP_RING - 1 edits are kept, so v0 (produced by setDoc) maps
    expect(ed.lineNow!(L, v0)).toBe(L);
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'z' } });
    expect(ed.lineNow!(L, v0)).toBe(L);                    // the step after v0 is still kept (v0 + 1 .. v0 + STEP_RING)
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'z' } });
    expect(ed.lineNow!(L, v0)).toBeUndefined();            // the step that produced v0 + 1 has left the ring
    expect(ed.lineNow!(L, v0 + 1)).toBe(L);
    expect(ed.lineNow!(L, ed.version - STEP_RING)).toBe(L);
    expect(ed.lineNow!(L, ed.version - STEP_RING - 1)).toBeUndefined();
  });
  it('lineThrough: a gap in the step versions answers undefined', () => {
    const d0 = Text.of(['a', '- [ ] b']);
    const c1 = ChangeSet.of([{ from: 0, insert: 'x' }], d0.length);
    const d1 = c1.apply(d0);
    const c2 = ChangeSet.of([{ from: 0, insert: 'y' }], d1.length);
    const d2 = c2.apply(d1);
    expect(lineThrough([{ version: 1, before: d0, changes: c1 }, { version: 2, before: d1, changes: c2 }], d2, 2, 2, 0)).toBe(2);
    expect(lineThrough([{ version: 1, before: d0, changes: c1 }, { version: 3, before: d1, changes: c2 }], d2, 3, 2, 0)).toBeUndefined();
    expect(lineThrough([{ version: 2, before: d1, changes: c2 }], d2, 2, 2, 0)).toBeUndefined();   // the step that made 1 is not kept
    expect(lineThrough([], d2, 2, 2, 0)).toBeUndefined();
  });
});

describe('the pass-through (createSourceAccess)', () => {
  it('PreviewSourceAccess.lineNow is the editor\'s, present only when the editor has one', () => {
    const ed = setup();
    const src = createSourceAccess(ed);
    const v0 = ed.version;
    api(ed).ch({ from: 0, insert: 'A\n' });
    expect(src.lineNow!(L, v0)).toBe(L + 1);
    expect(src.version!()).toBe(ed.version);
    expect(createSourceAccess({ view: ed.view }).lineNow).toBeUndefined();
  });
});

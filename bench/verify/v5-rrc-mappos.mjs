// bench/verify/v5-rrc-mappos.mjs — review-records (0.2.0, Checkpoint-C design 'the tick that does not wait', part 1).
// The design's lineNow (ChangeSet.mapPos(lineStart, 1, MapMode.TrackAfter), the mapped position must start a line)
// applied to CodeMirror 6 edits and commands around task line 4 of a small list. Node only, no server, writes nothing.
// Run: node bench/verify/v5-rrc-mappos.mjs   (SHOW=1 also prints the document and the change sets)
// Expected on @codemirror/state 6.7.4: no case answers another line; 'gone' (null) for typing at column 0, indentation,
// a same-text replacement of the line or the document, swaps by the neighbour, and the undo of a deletion or join.
// Probe of the design's lineNow (CONTRACT Checkpoint-C, part 1) against CodeMirror 6 changes.
import { createRequire } from 'node:module';
const req = createRequire('/Users/zyx/LocalDocuments/MDReader/package.json');
const { EditorState, EditorSelection, MapMode } = req('@codemirror/state');
const cmds = req('@codemirror/commands');
const { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } = req('@codemirror/lang-markdown');

// steps: { before: Text, changes: ChangeSet }
function lineNow(steps, line) {
  for (const st of steps) {
    if (st.replaced) return null;
    if (line < 1 || line > st.before.lines) return undefined;
    const pos = st.before.line(line).from;
    const m = st.changes.mapPos(pos, 1, MapMode.TrackAfter);
    if (m === null) return null;
    const after = st.changes.apply(st.before);
    const l = after.lineAt(m);
    if (l.from !== m) return null;
    line = l.number;
  }
  return line;
}

const DOC = ['# T', '', '- [ ] alpha', '- [ ] beta', '- [ ] gamma', '- [ ] delta', ''].join('\n');
const L = 4; // "- [ ] beta"

function run(name, prep) {
  let state = EditorState.create({ doc: DOC, extensions: [cmds.history(), markdown()] });
  const steps = [];
  const dispatch = (tr) => { if (tr.docChanged) steps.push({ before: tr.startState.doc, changes: tr.changes }); state = tr.state; };
  const api = {
    get state() { return state; },
    sel(line, col = 0) { const p = state.doc.line(line).from + col; state = state.update({ selection: EditorSelection.cursor(p) }).state; },
    selRange(a, b) { state = state.update({ selection: EditorSelection.range(a, b) }).state; },
    ch(spec, userEvent = 'input') { dispatch(state.update({ changes: spec, userEvent })); },
    cmd(c) { c({ state, dispatch }); },
  };
  try { prep(api); } catch (e) { console.log(name, 'ERR', e.message); return; }
  const r = lineNow(steps, L);
  const text = r ? state.doc.line(r).text : String(r);
  console.log(`${name.padEnd(48)} -> ${String(r).padEnd(9)} ${JSON.stringify(text)}`);
  if (process.env.SHOW) console.log('   ', JSON.stringify(state.doc.toString()), JSON.stringify(steps.map(s=>s.changes.toJSON())));
}

const pos = (a, line, col = 0) => a.state.doc.line(line).from + col;
run('type x at col 0 of line', (a) => a.ch({ from: pos(a, L), insert: 'x' }));
run('indent (2 spaces at col 0)', (a) => a.ch({ from: pos(a, L), insert: '  ' }));
run('indentMore command', (a) => { a.sel(L, 3); a.cmd(cmds.indentMore); });
run('Enter at col 0 (plain \\n)', (a) => a.ch({ from: pos(a, L), insert: '\n' }));
run('Enter at col 0 (continueMarkup)', (a) => { a.sel(L, 0); a.cmd(insertNewlineContinueMarkup); });
run('Enter at end of prev line (continueMarkup)', (a) => { a.sel(L - 1, a.state.doc.line(L - 1).length); a.cmd(insertNewlineContinueMarkup); });
run('Enter at end of prev line (plain)', (a) => a.ch({ from: pos(a, L) - 1, insert: '\n' }));
run('Backspace at col 0 (join)', (a) => a.ch({ from: pos(a, L) - 1, to: pos(a, L) }, 'delete.backward'));
run('deleteMarkupBackward at col 6', (a) => { a.sel(L, 6); a.cmd(deleteMarkupBackward); });
run('delete line with break after', (a) => a.ch({ from: pos(a, L), to: pos(a, L + 1) }));
run('delete line with break before', (a) => a.ch({ from: pos(a, L) - 1, to: a.state.doc.line(L).to }));
run('delete previous line (break after)', (a) => a.ch({ from: pos(a, L - 1), to: pos(a, L) }));
run('delete previous line (break before)', (a) => a.ch({ from: pos(a, L - 1) - 1, to: pos(a, L) - 1 }));
run('replace whole line by same text', (a) => a.ch({ from: pos(a, L), to: a.state.doc.line(L).to, insert: a.state.doc.line(L).text }));
run('replace whole doc by same text', (a) => a.ch({ from: 0, to: a.state.doc.length, insert: a.state.doc.toString() }));
run('tick own box [ ]->[x]', (a) => a.ch({ from: pos(a, L, 3), to: pos(a, L, 4), insert: 'x' }));
run('insert "- [ ] new\\n" ending at line start', (a) => a.ch({ from: pos(a, L), insert: '- [ ] new\n' }));
run('insert "\\n- [ ] new" at end of prev line', (a) => a.ch({ from: pos(a, L) - 1, insert: '\n- [ ] new' }));
run('paste replacing prev line incl break', (a) => a.ch({ from: pos(a, L - 1), to: pos(a, L), insert: '- [ ] X\n- [ ] Y\n' }));
run('several changes around the line', (a) => a.ch([{ from: pos(a, L - 1), insert: '- [ ] p\n' }, { from: pos(a, L, 6), insert: 'Z' }, { from: pos(a, L + 1), to: pos(a, L + 2) }]));
run('moveLineUp', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineUp); });
run('moveLineDown', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineDown); });
run('moveLineDown of previous line (swap)', (a) => { a.sel(L - 1, 2); a.cmd(cmds.moveLineDown); });
run('moveLineUp of next line (swap)', (a) => { a.sel(L + 1, 2); a.cmd(cmds.moveLineUp); });
run('copyLineUp', (a) => { a.sel(L, 2); a.cmd(cmds.copyLineUp); });
run('copyLineDown', (a) => { a.sel(L, 2); a.cmd(cmds.copyLineDown); });
run('copyLineDown of previous line', (a) => { a.sel(L - 1, 2); a.cmd(cmds.copyLineDown); });
run('copyLineUp of previous line', (a) => { a.sel(L - 1, 2); a.cmd(cmds.copyLineUp); });
run('select lines 3-4, type over with same text', (a) => { const f = pos(a, L - 1), t = a.state.doc.line(L).to; a.ch({ from: f, to: t, insert: a.state.doc.sliceString(f, t) }); });
run('cut line 4 (incl break), paste above line 3', (a) => { const t = a.state.doc.line(L).text + '\n'; a.ch({ from: pos(a, L), to: pos(a, L + 1) }); a.ch({ from: pos(a, L - 1), insert: t }); });
run('insert line above then undo', (a) => { a.ch({ from: pos(a, L), insert: '- [ ] new\n' }); a.cmd(cmds.undo); });
run('delete line then undo', (a) => { a.ch({ from: pos(a, L), to: pos(a, L + 1) }); a.cmd(cmds.undo); });
run('delete prev line then undo', (a) => { a.ch({ from: pos(a, L - 1), to: pos(a, L) }); a.cmd(cmds.undo); });
run('Backspace join then undo', (a) => { a.ch({ from: pos(a, L) - 1, to: pos(a, L) }, 'delete.backward'); a.cmd(cmds.undo); });
run('type at col0 then undo', (a) => { a.ch({ from: pos(a, L), insert: 'x' }); a.cmd(cmds.undo); });
run('moveLineUp then undo', (a) => { a.sel(L, 2); a.cmd(cmds.moveLineUp); a.cmd(cmds.undo); });
run('undo of an earlier insert above (history)', (a) => { a.ch({ from: 0, insert: 'A\n' }); a.ch({ from: pos(a, L + 1), insert: 'q' }, 'input.type'); a.cmd(cmds.undo); a.cmd(cmds.undo); });
run('swap line 4 and 5 by one replace (sort)', (a) => { const f = pos(a, L), t = a.state.doc.line(L + 1).to; a.ch({ from: f, to: t, insert: a.state.doc.line(L + 1).text + '\n' + a.state.doc.line(L).text }); });
run('composed: insert above + delete line (one tr)', (a) => a.ch([{ from: pos(a, L), insert: '- [ ] new\n' }, { from: pos(a, L), to: pos(a, L + 1) }]));

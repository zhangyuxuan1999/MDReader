// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { headingContentOffset, insertLink, markerDeleteStart, quotePrefixLength, setHeading, taskToggleChange, toggleTask, toggleWrap } from '../src/editor/commands';
import { installLayoutStubs } from './editor.helpers';

installLayoutStubs();

function makeView(doc: string, ranges: Array<[number, number?]> = [[0]]): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.create(ranges.map(([a, h]) => EditorSelection.range(a, h ?? a))),
      extensions: EditorState.allowMultipleSelections.of(true),
    }),
    parent,
  });
}

describe('toggleWrap', () => {
  const bold = toggleWrap('**');

  it('wraps a selection and keeps the inner text selected', () => {
    const v = makeView('hello world', [[0, 5]]);
    expect(bold(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('**hello** world');
    expect(v.state.selection.main.from).toBe(2);
    expect(v.state.selection.main.to).toBe(7);
  });

  it('unwraps when the selection includes the markers', () => {
    const v = makeView('**hello** world', [[0, 9]]);
    bold(v);
    expect(v.state.doc.toString()).toBe('hello world');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('hello');
  });

  it('unwraps when the markers surround the selection', () => {
    const v = makeView('**hello** world', [[2, 7]]);
    bold(v);
    expect(v.state.doc.toString()).toBe('hello world');
    expect(v.state.selection.main.from).toBe(0);
    expect(v.state.selection.main.to).toBe(5);
  });

  it('cursor only: inserts a pair and puts the cursor inside; again removes the pair', () => {
    const v = makeView('ab', [[1]]);
    bold(v);
    expect(v.state.doc.toString()).toBe('a****b');
    expect(v.state.selection.main.head).toBe(3);
    bold(v);
    expect(v.state.doc.toString()).toBe('ab');
    expect(v.state.selection.main.head).toBe(1);
  });

  it('is multi-selection aware', () => {
    const v = makeView('one two', [[0, 3], [4, 7]]);
    toggleWrap('_')(v);
    expect(v.state.doc.toString()).toBe('_one_ _two_');
    const ranges = v.state.selection.ranges;
    expect(ranges.map((r) => v.state.sliceDoc(r.from, r.to))).toEqual(['one', 'two']);
  });

  it('inline code uses a single backtick', () => {
    const v = makeView('x', [[0, 1]]);
    toggleWrap('`')(v);
    expect(v.state.doc.toString()).toBe('`x`');
  });
});

describe('setHeading', () => {
  it('rewrites the prefix of every selected line', () => {
    const v = makeView('a\n## b\nc', [[0, 8]]);
    expect(setHeading(1)(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('# a\n# b\n# c');
  });

  it('does not include a line the selection only touches at its start', () => {
    const v = makeView('a\nb', [[0, 2]]);
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('## a\nb');
  });

  it('paragraph removes the prefix; same level toggles off', () => {
    const v = makeView('### t', [[1]]);
    setHeading(0)(v);
    expect(v.state.doc.toString()).toBe('t');
    setHeading(3)(v);
    expect(v.state.doc.toString()).toBe('### t');
    setHeading(3)(v);
    expect(v.state.doc.toString()).toBe('t');
  });

  it('returns false when nothing changes', () => {
    const v = makeView('plain', [[0]]);
    expect(setHeading(0)(v)).toBe(false);
  });

  // fix round 3: the marker goes after the block prefix, never in front of it (`# - a` was rendered
  // as a heading whose text starts with the literal list marker).
  it('writes the marker after a list marker instead of stacking it', () => {
    const v = makeView('- 项目一', [[3]]);
    expect(setHeading(1)(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('- # 项目一');
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('- ## 项目一');
    setHeading(0)(v);
    expect(v.state.doc.toString()).toBe('- 项目一');
  });

  it('writes the marker after blockquote markers (nested too)', () => {
    const v = makeView('> 引用一\n> > 深引用\n  > 缩进引用', [[0, 20]]);
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('> ## 引用一\n> > ## 深引用\n  > ## 缩进引用');
    setHeading(2)(v);
    expect(v.state.doc.toString()).toBe('> 引用一\n> > 深引用\n  > 缩进引用');
  });

  it('handles quoted / ordered / task list items', () => {
    const v = makeView('> - 引用列表\n1. 有序\n- [ ] 任务\n  * 缩进项', [[0, 31]]);
    setHeading(3)(v);
    expect(v.state.doc.toString()).toBe('> - ### 引用列表\n1. ### 有序\n- [ ] ### 任务\n  * ### 缩进项');
    setHeading(0)(v);
    expect(v.state.doc.toString()).toBe('> - 引用列表\n1. 有序\n- [ ] 任务\n  * 缩进项');
  });

  it('replaces an ATX marker that already sits after the block prefix', () => {
    const v = makeView('> ### 引用标题\n- ## 列表标题', [[0, 18]]);
    setHeading(1)(v);
    expect(v.state.doc.toString()).toBe('> # 引用标题\n- # 列表标题');
    setHeading(1)(v);   // same level toggles off, in the same position
    expect(v.state.doc.toString()).toBe('> 引用标题\n- 列表标题');
  });

  it('headingContentOffset locates the content start', () => {
    expect(headingContentOffset('文本')).toBe(0);
    expect(headingContentOffset('  文本')).toBe(0);
    expect(headingContentOffset('> a')).toBe(2);
    expect(headingContentOffset('> > a')).toBe(4);
    expect(headingContentOffset('- a')).toBe(2);
    expect(headingContentOffset('1. a')).toBe(3);
    expect(headingContentOffset('> - a')).toBe(4);
    expect(headingContentOffset('- [ ] a')).toBe(6);
    expect(headingContentOffset('- [x] a')).toBe(6);
    expect(headingContentOffset('[ ] a')).toBe(0);   // not a list item: no checkbox skip
    expect(headingContentOffset('- ')).toBe(2);
    expect(headingContentOffset('')).toBe(0);
  });
});

describe('tasks', () => {
  it('taskToggleChange flips [ ] / [x] / [X] after the marker only', () => {
    const s = EditorState.create({ doc: '- [ ] a [x]\n* [X] b\n1. [x] c\n- no' });
    const l = (n: number) => s.doc.line(n);
    expect(s.update({ changes: taskToggleChange(l(1))! }).newDoc.line(1).text).toBe('- [x] a [x]');
    expect(s.update({ changes: taskToggleChange(l(2))! }).newDoc.line(2).text).toBe('* [ ] b');
    expect(s.update({ changes: taskToggleChange(l(3))! }).newDoc.line(3).text).toBe('1. [ ] c');
    expect(taskToggleChange(l(4))).toBeNull();
  });

  it('taskToggleChange tolerates blockquote markers and indentation before the list marker', () => {
    const s = EditorState.create({ doc: '> - [ ] task in quote\n> > * [x] deep\n  > 1. [ ] num\n>   - [X] indented\n> plain' });
    const l = (n: number) => s.doc.line(n);
    expect(s.update({ changes: taskToggleChange(l(1))! }).newDoc.line(1).text).toBe('> - [x] task in quote');
    expect(s.update({ changes: taskToggleChange(l(2))! }).newDoc.line(2).text).toBe('> > * [ ] deep');
    expect(s.update({ changes: taskToggleChange(l(3))! }).newDoc.line(3).text).toBe('  > 1. [x] num');
    expect(s.update({ changes: taskToggleChange(l(4))! }).newDoc.line(4).text).toBe('>   - [ ] indented');
    expect(taskToggleChange(l(5))).toBeNull();
  });

  it('toggleTask inserts the box after the marker of a quoted list item', () => {
    const v = makeView('> - item', [[3]]);
    toggleTask(v);
    expect(v.state.doc.toString()).toBe('> - [ ] item');
  });

  it('toggleTask adds a checkbox to list items and plain lines that lack one', () => {
    const v = makeView('- item\n  text\n- [x] done', [[0, 19]]);
    toggleTask(v);
    expect(v.state.doc.toString()).toBe('- [ ] item\n  - [ ] text\n- [ ] done');
  });
});

describe('marker helpers', () => {
  it('quotePrefixLength measures leading blockquote markers only', () => {
    expect(quotePrefixLength('- a')).toBe(0);
    expect(quotePrefixLength('> - a')).toBe(2);
    expect(quotePrefixLength('> > - a')).toBe(4);
    expect(quotePrefixLength('  > x')).toBe(4);
  });

  it('markerDeleteStart matches only when the text before the cursor is exactly a list/task marker', () => {
    expect(markerDeleteStart('- ')).toBe(0);
    expect(markerDeleteStart('  - ')).toBe(0);
    expect(markerDeleteStart('1. ')).toBe(0);
    expect(markerDeleteStart('- [ ] ')).toBe(0);
    expect(markerDeleteStart('* [x]')).toBe(0);
    expect(markerDeleteStart('> - ')).toBe(2);
    expect(markerDeleteStart('> >   - [ ] ')).toBe(4);
    expect(markerDeleteStart('- a')).toBeNull();
    expect(markerDeleteStart('-')).toBeNull();
    expect(markerDeleteStart('')).toBeNull();
    expect(markerDeleteStart('text ')).toBeNull();
  });
});

describe('history isolation', () => {
  it('a wrap command is its own undo step: undo after Mod-b + typing removes only the typed text', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const v = new EditorView({ state: EditorState.create({ doc: 'hello world', selection: { anchor: 11 }, extensions: history() }), parent });
    toggleWrap('**')(v);
    expect(v.state.doc.toString()).toBe('hello world****');
    v.dispatch(v.state.replaceSelection('x'), { userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('hello world**x**');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('hello world****');
    expect(undo(v)).toBe(true);
    expect(v.state.doc.toString()).toBe('hello world');
  });

  it('a heading rewrite followed by typing undoes in two steps', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const v = new EditorView({ state: EditorState.create({ doc: 'title', selection: { anchor: 5 }, extensions: history() }), parent });
    setHeading(2)(v);
    v.dispatch(v.state.replaceSelection('!'), { userEvent: 'input.type' });
    expect(v.state.doc.toString()).toBe('## title!');
    undo(v);
    expect(v.state.doc.toString()).toBe('## title');
  });
});

describe('insertLink', () => {
  it('wraps the selection and selects the url placeholder', () => {
    const v = makeView('see docs now', [[4, 8]]);
    insertLink(v);
    expect(v.state.doc.toString()).toBe('see [docs](url) now');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('url');
  });

  it('uses the supplied url', () => {
    const v = makeView('', [[0]]);
    insertLink(v, 'https://example.com');
    expect(v.state.doc.toString()).toBe('[](https://example.com)');
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('https://example.com');
  });
});

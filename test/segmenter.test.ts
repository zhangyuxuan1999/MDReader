import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { BlockKind } from '../src/shared/types';
import { applyChange, applyChanges, applyResolved, createDoc, docText, lineStartsOf, normaliseEmpty, offsetToPos, resolveChanges, type Doc } from '../src/worker/doc';
import {
  buildBlocks, checkInvariants, indexOfBlockContaining, kindOf, resegmentWindow, segmentAll, setextLevel, setextHeadings,
  listContentIndent, isHtmlBlockStart, mayDefineReference, HTML_GLUE_MAX_LINES, type Block,
} from '../src/worker/segmenter';

const fixture = (name: string): string => readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');

function allocator(): () => number {
  let n = 1;
  return () => n++;
}

function shape(blocks: Block[]): Array<[number, number, BlockKind]> {
  return blocks.map((b) => [b.startLine, b.lineCount, b.kind]);
}

function fullShape(lines: string[]): Array<[number, number, BlockKind]> {
  return segmentAll(lines).map((s) => [s.start + 1, s.count, s.kind]);
}

/** A tiny in-memory worker document: apply one transaction the way core.ts does. */
function makeState(text: string) {
  const alloc = allocator();
  const doc = createDoc(text);
  let blocks = buildBlocks(doc.lines, alloc);
  return {
    doc,
    get blocks() {
      return blocks;
    },
    edit(changes: Array<{ from: number; to: number; insert: string }>): number[] {
      const dirty: number[] = [];
      const resolved = resolveChanges(doc, changes);
      for (let i = resolved.length - 1; i >= 0; i--) {
        const eff = applyResolved(doc, resolved[i]);
        const r = resegmentWindow(blocks, doc.lines, eff, alloc);
        blocks = r.blocks;
        dirty.push(...r.dirty);
      }
      normaliseEmpty(doc);
      if (doc.lines.length === 0) blocks = [];
      checkInvariants(blocks, doc.lines);
      expect(shape(blocks)).toEqual(fullShape(doc.lines));
      return dirty;
    },
  };
}

describe('doc.ts', () => {
  it('normalises CRLF and splits lines', () => {
    const d = createDoc('a\r\nb\rc\n');
    expect(d.lines).toEqual(['a', 'b', 'c', '']);
    expect(createDoc('').lines).toEqual([]);
  });

  it('applies single changes in offset coordinates', () => {
    const d = createDoc('hello\nworld');
    expect(applyChange(d, { from: 5, to: 6, insert: ' ' })).toEqual({ fromLine: 1, toLineOld: 2, toLineNew: 1, lineDelta: -1 });
    expect(d.lines).toEqual(['hello world']);
    expect(applyChange(d, { from: 5, to: 6, insert: '\n\n' })).toEqual({ fromLine: 1, toLineOld: 1, toLineNew: 3, lineDelta: 2 });
    expect(d.lines).toEqual(['hello', '', 'world']);
  });

  it('applies multi-change transactions in reverse and matches the naive result', () => {
    const text = 'foo bar foo\nbaz foo\n\nfoo';
    const naive = text.replaceAll('foo', 'quux');
    const d = createDoc(text);
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    for (let i = text.indexOf('foo'); i >= 0; i = text.indexOf('foo', i + 3)) changes.push({ from: i, to: i + 3, insert: 'quux' });
    expect(changes).toHaveLength(4);
    const resolved = resolveChanges(d, changes);
    for (let i = resolved.length - 1; i >= 0; i--) applyResolved(d, resolved[i]);
    expect(docText(d)).toBe(naive);
  });

  it('handles multi-cursor inserts with newlines', () => {
    const text = 'ab\ncd\nef';
    const d = createDoc(text);
    const changes = [
      { from: 1, to: 1, insert: '\nX' },
      { from: 4, to: 4, insert: 'Y\n' },
      { from: 8, to: 8, insert: '\n' },
    ];
    const naive = 'a\nXb\ncY\nd\nef\n';
    const resolved = resolveChanges(d, changes);
    for (let i = resolved.length - 1; i >= 0; i--) applyResolved(d, resolved[i]);
    expect(docText(d)).toBe(naive);
  });

  it('edits an empty document and returns to it', () => {
    const d: Doc = createDoc('');
    applyChange(d, { from: 0, to: 0, insert: 'x' });
    expect(d.lines).toEqual(['x']);
    applyChange(d, { from: 0, to: 1, insert: '' });
    normaliseEmpty(d);
    expect(d.lines).toEqual([]);
  });
});

describe('segmentation rules', () => {
  const seg = (text: string) => fullShape(createDoc(text).lines);

  it('splits paragraphs on blank lines, trailing blanks belong to the preceding block', () => {
    expect(seg('a\nb\n\n\nc\n')).toEqual([
      [1, 4, BlockKind.Prose],
      [5, 2, BlockKind.Prose],
    ]);
  });

  it('headings always start a block', () => {
    expect(seg('para\n# H1\n## H2\ntext')).toEqual([
      [1, 1, BlockKind.Prose],
      [2, 1, BlockKind.Heading],
      [3, 2, BlockKind.Heading],
    ]);
    expect(kindOf(['#not heading'], 0)).toBe(BlockKind.Prose);
    expect(kindOf(['####### seven'], 0)).toBe(BlockKind.Prose);
  });

  it('keeps fences together across blank lines and closes on a matching fence', () => {
    expect(seg('```js\n\ncode\n\n```\n\nafter')).toEqual([
      [1, 6, BlockKind.Code],
      [7, 1, BlockKind.Prose],
    ]);
    // a shorter or different-char closer does not close
    expect(seg('````\n```\n\n~~~~\n\n````\nx')).toEqual([[1, 7, BlockKind.Code]]);
    // backtick fence with a backtick in the info string is not a fence
    expect(seg('``` a`b\n\nx')).toEqual([
      [1, 2, BlockKind.Prose],
      [3, 1, BlockKind.Prose],
    ]);
  });

  it('unclosed fence at line 1 swallows the document; closing it restores blocks', () => {
    const s = makeState('```\n\na\n\nb\n');
    expect(shape(s.blocks)).toEqual([[1, 6, BlockKind.Code]]);
    s.edit([{ from: 4, to: 4, insert: '```\n' }]);
    expect(shape(s.blocks)).toEqual([
      [1, 3, BlockKind.Code],
      [4, 2, BlockKind.Prose],
      [6, 2, BlockKind.Prose],
    ]);
  });

  it('html1 blocks and comments span blank lines until their close', () => {
    expect(seg('<pre>\n\nx\n</pre>\n\ny')).toEqual([
      [1, 5, BlockKind.Html],
      [6, 1, BlockKind.Prose],
    ]);
    expect(seg('<!-- a\n\nb -->\n\nc')).toEqual([
      [1, 4, BlockKind.Html],
      [5, 1, BlockKind.Prose],
    ]);
    expect(seg('<pre>x</pre>\n\ny')).toEqual([
      [1, 2, BlockKind.Html],
      [3, 1, BlockKind.Prose],
    ]);
    // an unclosed container glues the following blocks (README pattern, fix round); a closed one does not
    expect(seg('<div>\n\nx')).toEqual([[1, 3, BlockKind.Html]]);
    expect(seg('<div>x</div>\n\nx')).toEqual([
      [1, 2, BlockKind.Html],
      [3, 1, BlockKind.Prose],
    ]);
    expect(seg('<span>x\n\nx')).toEqual([
      [1, 2, BlockKind.Html],
      [3, 1, BlockKind.Prose],
    ]);
  });

  it('math blocks', () => {
    expect(seg('$$\n\na\n$$\n\nb')).toEqual([
      [1, 5, BlockKind.Math],
      [6, 1, BlockKind.Prose],
    ]);
    expect(seg('$$x$$\n\nb')).toEqual([
      [1, 2, BlockKind.Math],
      [3, 1, BlockKind.Prose],
    ]);
  });

  it('glues loose lists and quotes, but not other kinds', () => {
    expect(seg('- a\n\n- b\n\n  cont\n\npara')).toEqual([
      [1, 6, BlockKind.List],
      [7, 1, BlockKind.Prose],
    ]);
    expect(seg('1. a\n\n2) b\n\nx')).toEqual([
      [1, 4, BlockKind.List],
      [5, 1, BlockKind.Prose],
    ]);
    expect(seg('> q\n\n> r\n\nx')).toEqual([
      [1, 4, BlockKind.Quote],
      [5, 1, BlockKind.Prose],
    ]);
    expect(seg('para\n\n- a')).toEqual([
      [1, 2, BlockKind.Prose],
      [3, 1, BlockKind.List],
    ]);
  });

  it('decides kinds from the first line', () => {
    expect(kindOf(['---'], 0)).toBe(BlockKind.Hr);
    expect(kindOf(['* * *'], 0)).toBe(BlockKind.Hr);
    expect(kindOf(['___'], 0)).toBe(BlockKind.Hr);
    expect(kindOf(['- item'], 0)).toBe(BlockKind.List);
    expect(kindOf(['+ item'], 0)).toBe(BlockKind.List);
    expect(kindOf(['12. item'], 0)).toBe(BlockKind.List);
    expect(kindOf(['> q'], 0)).toBe(BlockKind.Quote);
    expect(kindOf(['<div>'], 0)).toBe(BlockKind.Html);
    expect(kindOf(['<!-- c -->'], 0)).toBe(BlockKind.Html);
    expect(kindOf(['a | b', '--|--'], 0)).toBe(BlockKind.Table);
    expect(kindOf(['| a | b |', '| :-- | --: |'], 0)).toBe(BlockKind.Table);
    expect(kindOf(['a | b', 'x'], 0)).toBe(BlockKind.Prose);
    expect(kindOf(['    code'], 0)).toBe(BlockKind.Code);
    expect(kindOf(['\tcode'], 0)).toBe(BlockKind.Code);
    expect(kindOf(['   three'], 0)).toBe(BlockKind.Prose);
    expect(kindOf(['~~~'], 0)).toBe(BlockKind.Code);
    expect(kindOf([''], 0)).toBe(BlockKind.Prose);
  });

  it('detects setext headings for the outline only', () => {
    const lines = ['Title', '===', '', 'Sub', '---', 'x', 'not', '---'];
    const blocks = buildBlocks(lines, allocator());
    expect(shape(blocks)).toEqual([
      [1, 3, BlockKind.Prose],
      [4, 5, BlockKind.Prose],
    ]);
    expect(setextLevel(lines, blocks[0])).toBe(1);
    // `Sub\n---\nx\nnot\n---` is two h2 headings in CommonMark (the underline ends the paragraph)
    expect(setextLevel(lines, blocks[1])).toBe(2);
    expect(setextHeadings(lines, blocks[1])).toEqual([
      { level: 2, from: 3, to: 4 },
      { level: 2, from: 5, to: 7 },
    ]);
    const two = buildBlocks(['Sub', '---'], allocator());
    expect(setextLevel(['Sub', '---'], two[0])).toBe(2);
    // multi-line paragraph underlined → one heading over both lines; `---` first is a thematic break
    const multi = ['first line', 'second line', '=========='];
    expect(setextHeadings(multi, buildBlocks(multi, allocator())[0])).toEqual([{ level: 1, from: 0, to: 2 }]);
    const hr = ['---', 'text', '---'];
    expect(setextHeadings(hr, { kind: BlockKind.Prose, startLine: 1, lineCount: 3 })).toEqual([{ level: 2, from: 1, to: 2 }]);
    expect(setextHeadings(['a', '', 'b', '==='], { kind: BlockKind.Prose, startLine: 1, lineCount: 4 })).toEqual([]);
  });

  it('indexOfBlockContaining', () => {
    const blocks = buildBlocks(['a', '', 'b', '', 'c'], allocator());
    expect(blocks.map((b) => b.startLine)).toEqual([1, 3, 5]);
    expect(indexOfBlockContaining(blocks, 1)).toBe(0);
    expect(indexOfBlockContaining(blocks, 2)).toBe(0);
    expect(indexOfBlockContaining(blocks, 3)).toBe(1);
    expect(indexOfBlockContaining(blocks, 99)).toBe(2);
  });
});

describe('fix-round segmentation rules', () => {
  const seg = (text: string) => fullShape(createDoc(text).lines);

  it('(b) indented code glues across blank lines when the next non-blank line is indented ≥ 4', () => {
    expect(seg('para\n\n    indented code line 1\n    # not a heading\n\n    after blank still code\n\npara2\n')).toEqual([
      [1, 2, BlockKind.Prose],
      [3, 5, BlockKind.Code],
      [8, 2, BlockKind.Prose],
    ]);
    expect(seg('    code\n\n  two spaces\n')).toEqual([
      [1, 2, BlockKind.Code],
      [3, 2, BlockKind.Prose],
    ]);
    expect(seg('\tcode\n\n\tmore\n\n- list\n')).toEqual([
      [1, 4, BlockKind.Code],
      [5, 2, BlockKind.List],
    ]);
    // a fence is not indented code: no glue across the blank after it closed
    expect(seg('```\nx\n```\n\n    y')).toEqual([
      [1, 4, BlockKind.Code],
      [5, 1, BlockKind.Code],
    ]);
  });

  it('(c) an ATX heading indented inside a list item stays in the list', () => {
    expect(seg('- item\n\n  # heading in item\n\n- item2\n  ## h2 directly\n')).toEqual([[1, 7, BlockKind.List]]);
    // a heading at the list's own indent ends the list
    expect(seg('- item\n# top\n')).toEqual([
      [1, 1, BlockKind.List],
      [2, 2, BlockKind.Heading],
    ]);
    expect(seg('- item\n\n # one space\n')).toEqual([
      [1, 2, BlockKind.List],
      [3, 2, BlockKind.Heading],
    ]);
    // ordered list: content indent 3
    expect(seg('1. item\n   ## in item\n')).toEqual([[1, 3, BlockKind.List]]);
    expect(seg('1. item\n  ## outside\n')).toEqual([
      [1, 1, BlockKind.List],
      [2, 2, BlockKind.Heading],
    ]);
    expect(listContentIndent('- a')).toBe(2);
    expect(listContentIndent('10. a')).toBe(4);
    expect(listContentIndent('-   a')).toBe(4);
    expect(listContentIndent('-      a')).toBe(2);
    expect(listContentIndent('-')).toBe(2);
    expect(listContentIndent(' * a')).toBe(3);
  });

  it('(d) `#` lines inside a type-6/7 HTML block are raw until the first blank line', () => {
    expect(seg('<div>\n# inside div\n</div>\n\n<div>\n\n# real heading after blank\n\n</div>\n')).toEqual([
      [1, 4, BlockKind.Html],
      [5, 6, BlockKind.Html],
    ]);
    expect(seg('<table>\n# raw\n</table>\n\n# H\n')).toEqual([
      [1, 4, BlockKind.Html],
      [5, 2, BlockKind.Heading],
    ]);
    // a complete tag alone on the line (type 7) is raw too; an inline-html paragraph is not
    expect(seg('<custom-el>\n# raw\n</custom-el>\n\nx')).toEqual([
      [1, 4, BlockKind.Html],
      [5, 1, BlockKind.Prose],
    ]);
    expect(seg('<span>span start</span> text\n# heading\n')).toEqual([
      [1, 1, BlockKind.Html],
      [2, 2, BlockKind.Heading],
    ]);
    expect(isHtmlBlockStart('<div align="center">')).toBe(true);
    expect(isHtmlBlockStart('</details>')).toBe(true);
    expect(isHtmlBlockStart('<pre>')).toBe(true);
    expect(isHtmlBlockStart('<!-- c')).toBe(true);
    expect(isHtmlBlockStart('<my-tag data-x="1" />')).toBe(true);
    expect(isHtmlBlockStart('<span>x</span> y')).toBe(false);
    expect(isHtmlBlockStart('<https://auto.link>')).toBe(false);
  });

  it('(f) README pattern: an unclosed container glues the following blocks up to its closing tag', () => {
    const details = '<details>\n<summary>Show more</summary>\n\nHIDDEN-PARAGRAPH\n\n</details>\n\n<div align="center">\n\nCENTERED-PARA\n\n</div>\n';
    expect(seg(details)).toEqual([
      [1, 7, BlockKind.Html],
      [8, 6, BlockKind.Html],
    ]);
    // nested containers of the same tag are balanced; fences inside do not count
    const nested = '<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\ninner text\n\n</details>\n\n</details>\n\nafter';
    expect(seg(nested)).toEqual([
      [1, 12, BlockKind.Html],
      [13, 1, BlockKind.Prose],
    ]);
    const fenced = '<details>\n<summary>S</summary>\n\n```js\n</details>\n```\n\n- hidden\n\n</details>\n\nvisible after\n';
    expect(seg(fenced)).toEqual([
      [1, 11, BlockKind.Html],
      [12, 2, BlockKind.Prose],
    ]);
    // headings inside the region do not split it; the block holding the closer ends at its natural end
    expect(seg('<div align="center">\n\n# Centered Title\n\n![logo](x.png)\n\n</div>\n# after (raw: same html block as </div>)\n\nz')).toEqual([
      [1, 9, BlockKind.Html],
      [10, 1, BlockKind.Prose],
    ]);
    // self-closing / closed on the same line: no glue
    expect(seg('<div>x</div>\n\ny\n\n<p/>\n\nz')).toEqual([
      [1, 2, BlockKind.Html],
      [3, 2, BlockKind.Prose],
      [5, 2, BlockKind.Html],
      [7, 1, BlockKind.Prose],
    ]);
  });

  it('(f) the glue is capped at HTML_GLUE_MAX_LINES lines and incremental edits agree with a full scan', () => {
    const paras = Array.from({ length: 300 }, (_, i) => `p${i}\n`).join('\n'); // 600 lines
    const s = makeState('<div>\n\n' + paras + '\nend\n');
    expect(s.blocks[0].kind).toBe(BlockKind.Html);
    expect(s.blocks[0].lineCount).toBeGreaterThanOrEqual(HTML_GLUE_MAX_LINES);
    expect(s.blocks[0].lineCount).toBeLessThan(HTML_GLUE_MAX_LINES + 3);
    expect(s.blocks.length).toBeGreaterThan(50);
    // typing the closer far below the cap does not extend the region; typing it inside the region does
    const text = docText(s.doc);
    const at = text.indexOf('p250\n');
    s.edit([{ from: at, to: at, insert: '</div>\n\n' }]);
    expect(s.blocks[0].lineCount).toBeGreaterThanOrEqual(HTML_GLUE_MAX_LINES);
    const t2 = docText(s.doc);
    const at2 = t2.indexOf('p10\n');
    s.edit([{ from: at2, to: at2, insert: '</div>\n\n' }]);
    expect(s.blocks[0].lineCount).toBe(2 + 2 * 10 + 2); // <div>, blank, 10 × (pN, blank), </div>, trailing blank
    // removing the closer again re-glues (rescan starts at the capped region)
    s.edit([{ from: at2, to: at2 + '</div>\n\n'.length, insert: '' }]);
    expect(s.blocks[0].lineCount).toBeGreaterThanOrEqual(HTML_GLUE_MAX_LINES);
    // a container whose closer sits right after the cap boundary: edits below the region rescan it
    const s2 = makeState('<section>\n\n' + paras + '\n</section>\n\ntail\n');
    const t3 = docText(s2.doc);
    const tail = t3.lastIndexOf('tail');
    s2.edit([{ from: tail, to: tail, insert: 'X' }]);
    s2.edit([{ from: 0, to: 0, insert: '<article>\n\n' }]);
  });

  it('(e) reference prefilter: no definitions from inside fences, indented code or raw HTML', () => {
    expect(mayDefineReference(BlockKind.Code, '```\n[x]: https://example.com/fence\n```')).toBe(false);
    expect(mayDefineReference(BlockKind.Code, '```\ncode\n```\n[x]: https://example.com/after')).toBe(true);
    expect(mayDefineReference(BlockKind.Code, '~~~\n[x]: u\n```\n[y]: u\n~~~')).toBe(false);
    expect(mayDefineReference(BlockKind.Code, '    [z]: https://example.com/indented')).toBe(false);
    expect(mayDefineReference(BlockKind.Html, '<pre>\n[y]: https://example.com/pre\n</pre>')).toBe(false);
    expect(mayDefineReference(BlockKind.Html, '<pre>x</pre>\n[y]: u')).toBe(true);
    expect(mayDefineReference(BlockKind.Html, '<!-- [y]: u -->')).toBe(false);
    expect(mayDefineReference(BlockKind.Html, '<div>\n[y]: u\n</div>')).toBe(false);
    expect(mayDefineReference(BlockKind.Html, '<div>\n\n[y]: u\n\n</div>')).toBe(true);
    expect(mayDefineReference(BlockKind.Prose, 'text\n[notref]: u')).toBe(true); // markdown-it decides (paragraph)
    expect(mayDefineReference(BlockKind.Prose, '[b]:\n  https://example.com/b')).toBe(true);
    expect(mayDefineReference(BlockKind.Quote, '> [q]: u')).toBe(true);
    expect(mayDefineReference(BlockKind.Prose, 'plain')).toBe(false);
  });

  it('(a) `$$x$$ text` stays one block; the closing line keeps its trailing text', () => {
    expect(seg('$$x^2$$ TRAILING\n\n$$\na = b\n$$ TAIL\n\nend')).toEqual([
      [1, 2, BlockKind.Math],
      [3, 4, BlockKind.Math],
      [7, 1, BlockKind.Prose],
    ]);
  });
});

describe('structure invariants', () => {
  it('hold for fixtures and pathological inputs', () => {
    const cases: Record<string, string> = {
      small: fixture('small.md'),
      medium: fixture('medium.md'),
      empty: '',
      blankOnly: '\n\n\n',
      trailingBlanks: '# a\n\ntext\n\n\n',
      leadingBlanks: '\n\n# a',
      unclosedFence: '```\n' + 'x\n'.repeat(1000),
      giantParagraph: 'x'.repeat(5 * 1024 * 1024),
      manyOneLiners: Array.from({ length: 20000 }, (_, i) => `line ${i}\n`).join(''),
      crlf: '# a\r\n\r\nb\r\nc',
    };
    for (const [name, text] of Object.entries(cases)) {
      const doc = createDoc(text);
      const blocks = buildBlocks(doc.lines, allocator());
      expect(() => checkInvariants(blocks, doc.lines), name).not.toThrow();
      if (text === '') expect(blocks).toHaveLength(0);
    }
    expect(buildBlocks(createDoc('```\n' + 'x\n'.repeat(1000)).lines, allocator())).toHaveLength(1);
    expect(buildBlocks(createDoc(Array.from({ length: 20000 }, (_, i) => `l${i}\n`).join('')).lines, allocator())).toHaveLength(1);
    expect(buildBlocks(createDoc(Array.from({ length: 2000 }, (_, i) => `l${i}\n\n`).join('')).lines, allocator())).toHaveLength(2000);
    expect(buildBlocks(createDoc('\n\n\n').lines, allocator())).toHaveLength(1);
  });

  it('small.md segments into the expected kinds', () => {
    const blocks = buildBlocks(createDoc(fixture('small.md')).lines, allocator());
    const kinds = new Set(blocks.map((b) => b.kind));
    for (const k of [BlockKind.Heading, BlockKind.Prose, BlockKind.List, BlockKind.Code, BlockKind.Table, BlockKind.Quote, BlockKind.Math]) {
      expect(kinds.has(k), `kind ${k}`).toBe(true);
    }
    expect(blocks[0].kind).toBe(BlockKind.Heading);
    expect(blocks.filter((b) => b.kind === BlockKind.Heading)).toHaveLength(1 + 30 * 2);
  });
});

describe('resegmentWindow + identity', () => {
  it('typing inside a paragraph keeps the id and marks it dirty; others untouched', () => {
    const s = makeState('# T\n\npara one\n\npara two\n\n- list\n');
    const ids = s.blocks.map((b) => b.id);
    const dirty = s.edit([{ from: 9, to: 9, insert: 'X' }]);
    expect(dirty).toEqual([ids[1]]);
    expect(s.blocks.map((b) => b.id)).toEqual(ids);
    expect(s.doc.lines[2]).toBe('paraX one');
  });

  it('splitting a paragraph: first half keeps the id, second half gets a new id; later blocks shift', () => {
    const s = makeState('a\n\nb b\n\nc\n');
    const [ia, ib, ic] = s.blocks.map((b) => b.id);
    const dirty = s.edit([{ from: 4, to: 5, insert: '\n\n' }]);
    expect(s.doc.lines).toEqual(['a', '', 'b', '', 'b', '', 'c', '']);
    expect(s.blocks.map((b) => b.id)).toEqual([ia, ib, expect.any(Number), ic]);
    expect(s.blocks[2].id).not.toBe(ib);
    expect(dirty.sort()).toEqual([ib, s.blocks[2].id].sort());
    expect(s.blocks[3].startLine).toBe(7);
  });

  it('joining two paragraphs keeps the first id; the second is dropped', () => {
    const s = makeState('a\n\nb\n\nc\n');
    const [ia, ib, ic] = s.blocks.map((b) => b.id);
    const dirty = s.edit([{ from: 2, to: 3, insert: '' }]);
    expect(s.doc.lines).toEqual(['a', 'b', '', 'c', '']);
    expect(s.blocks.map((b) => b.id)).toEqual([ia, ic]);
    expect(dirty).toEqual([ia]);
    expect(ib).not.toBe(ia);
  });

  it('undo restores content and identity is stable (same id, clean)', () => {
    const s = makeState('a\n\nbb\n\nc\n');
    const ids = s.blocks.map((b) => b.id);
    s.edit([{ from: 3, to: 3, insert: 'Z' }]);
    const dirty = s.edit([{ from: 3, to: 4, insert: '' }]);
    expect(dirty).toEqual([ids[1]]);
    expect(s.blocks.map((b) => b.id)).toEqual(ids);
  });

  it('multi-change transactions (replace-all, multi-cursor) match the full re-segmentation', () => {
    const text = fixture('small.md');
    const s = makeState(text);
    const before = s.blocks.map((b) => b.id);
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    let n = 0;
    for (let i = text.indexOf('列表项 A'); i >= 0 && n < 3; i = text.indexOf('列表项 A', i + 1), n++) changes.push({ from: i, to: i + 5, insert: 'Item\nA' });
    expect(changes).toHaveLength(3);
    s.edit(changes);
    const expected = text.replace('列表项 A', 'Item\nA').replace('列表项 A', 'Item\nA').replace('列表项 A', 'Item\nA');
    expect(docText(s.doc)).toBe(expected);
    // untouched blocks keep their ids
    const after = s.blocks.map((b) => b.id);
    const kept = after.filter((id) => before.includes(id));
    expect(kept.length).toBeGreaterThan(before.length - 4);
    // multi-cursor insert of a heading marker on three lines
    const t2 = docText(s.doc);
    const ins = [t2.indexOf('性能是一种特性'), t2.indexOf('性能是一种特性', t2.indexOf('性能是一种特性') + 1), t2.lastIndexOf('性能是一种特性')].map((p) => ({ from: p, to: p, insert: '# ' }));
    expect(ins[0].from < ins[1].from && ins[1].from < ins[2].from).toBe(true);
    s.edit(ins);
    let naive = t2;
    for (const c of [...ins].reverse()) naive = naive.slice(0, c.from) + c.insert + naive.slice(c.from);
    expect(docText(s.doc)).toBe(naive);
  });

  it('random edits on small.md never break the invariants or diverge from segmentAll', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const s = makeState(fixture('small.md'));
    const snippets = ['\n', '\n\n', '# ', '```\n', '```', '- ', '> ', '$$', '|', 'x', '中文', '\n---\n', '<pre>', '</pre>', '[a]: http://x', '  '];
    for (let i = 0; i < 400; i++) {
      const text = docText(s.doc);
      const from = rnd(text.length + 1);
      const to = Math.min(text.length, from + (rnd(4) === 0 ? rnd(40) : 0));
      s.edit([{ from, to, insert: rnd(3) === 0 ? '' : snippets[rnd(snippets.length)] }]);
    }
    expect(s.blocks.length).toBeGreaterThan(10);
  });

  it('deleting everything yields zero blocks; typing again recreates them', () => {
    const s = makeState('a\n\nb');
    s.edit([{ from: 0, to: 4, insert: '' }]);
    expect(s.blocks).toHaveLength(0);
    expect(s.doc.lines).toEqual([]);
    s.edit([{ from: 0, to: 0, insert: '# hi\n\nthere' }]);
    expect(shape(s.blocks)).toEqual([
      [1, 2, BlockKind.Heading],
      [3, 1, BlockKind.Prose],
    ]);
  });

  it('a 5 MB single paragraph and 20k one-line blocks accept edits', () => {
    const big = makeState('x'.repeat(5 * 1024 * 1024));
    big.edit([{ from: 1000, to: 1000, insert: 'y' }]);
    expect(big.blocks).toHaveLength(1);
    const many = makeState(Array.from({ length: 20000 }, (_, i) => `l${i}\n\n`).join(''));
    const ids = many.blocks.map((b) => b.id);
    many.edit([{ from: 10, to: 10, insert: 'Q' }]);
    expect(many.blocks.map((b) => b.id)).toEqual(ids);
  });
});

// ------------------------------------------------------------------ one-pass transaction apply
describe('applyChanges (CONTRACT §7 one-pass apply)', () => {
  /** Reference implementation: the old per-change path (reverse order, one splice per change). */
  function slow(text: string, changes: Array<{ from: number; to: number; insert: string }>): string {
    const doc = createDoc(text);
    const resolved = resolveChanges(doc, changes);
    for (let i = resolved.length - 1; i >= 0; i--) applyResolved(doc, resolved[i]);
    normaliseEmpty(doc);
    return docText(doc);
  }
  function fast(text: string, changes: Array<{ from: number; to: number; insert: string }>): { text: string; eff: ReturnType<typeof applyChanges> } {
    const doc = createDoc(text);
    const eff = applyChanges(doc, changes);
    normaliseEmpty(doc);
    return { text: docText(doc), eff };
  }

  it('matches the per-change apply on hand-picked transactions', () => {
    const cases: Array<[string, Array<{ from: number; to: number; insert: string }>]> = [
      ['abc\ndef\nghi', [{ from: 1, to: 2, insert: 'X' }]],
      ['abc\ndef\nghi', [{ from: 1, to: 2, insert: 'X' }, { from: 5, to: 6, insert: 'YY' }]],
      ['abc\ndef\nghi', [{ from: 0, to: 0, insert: '\n\n' }, { from: 4, to: 8, insert: '' }]],
      ['abc\ndef\nghi', [{ from: 3, to: 7, insert: '' }]],                       // joins three lines
      ['abc\ndef\nghi', [{ from: 0, to: 11, insert: '' }]],                      // empties the document
      ['abc\ndef\nghi', [{ from: 2, to: 2, insert: 'p\nq\nr' }, { from: 9, to: 11, insert: '\n' }]],
      ['a', [{ from: 0, to: 1, insert: '' }, { from: 1, to: 1, insert: 'z' }]],  // touching ranges
      ['', [{ from: 0, to: 0, insert: 'hello\nworld' }]],
      ['x\ny', [{ from: 2, to: 2, insert: '' }, { from: 3, to: 3, insert: '!' }]], // empty inserts
    ];
    for (const [text, changes] of cases) {
      expect(fast(text, changes).text, JSON.stringify([text, changes])).toBe(slow(text, changes));
    }
  });

  it('matches the per-change apply on randomised ascending transactions', () => {
    let s = 12345 >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x1234567) >>> 0;
      s ^= s >>> 13;
      return (s >>> 0) / 4294967296;
    };
    const INSERTS = ['', 'x', '\n', '\n\n', 'ab\ncd', '中文', 'q\n'];
    for (let round = 0; round < 300; round++) {
      const lines: string[] = [];
      for (let i = 0, n = 1 + Math.floor(rnd() * 12); i < n; i++) lines.push('abcdef'.slice(0, Math.floor(rnd() * 7)));
      const text = lines.join('\n');
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      let cursor = 0;
      while (cursor <= text.length && changes.length < 6) {
        const from = cursor + Math.floor(rnd() * 4);
        if (from > text.length) break;
        const to = Math.min(text.length, from + Math.floor(rnd() * 4));
        changes.push({ from, to, insert: INSERTS[Math.floor(rnd() * INSERTS.length)] });
        cursor = to + 1;
      }
      if (changes.length === 0) continue;
      const ctx = JSON.stringify({ text, changes });
      const got = fast(text, changes);
      expect(got.text, ctx).toBe(slow(text, changes));
      // the effect window must cover the change and report the real line delta
      const before = text === '' ? [] : text.split('\n');
      const after = got.text === '' ? [] : got.text.split('\n');
      if (got.eff) {
        // normaliseEmpty collapses the single empty line back to a 0-line document
        const rawAfter = got.text === '' ? 1 : after.length;
        expect(got.eff.lineDelta, ctx).toBe(rawAfter - Math.max(before.length, 1));
        expect(got.eff.fromLine, ctx).toBeLessThanOrEqual(Math.max(1, before.length));
        for (let i = 0; i < got.eff.fromLine - 1 && i < before.length; i++) expect(after[i], ctx).toBe(before[i]);
      }
    }
  });

  it('returns null for an empty change list and leaves the document alone', () => {
    const doc = createDoc('a\nb');
    expect(applyChanges(doc, [])).toBeNull();
    expect(docText(doc)).toBe('a\nb');
  });
});

// ------------------------------------------------------------------ P13: no per-edit large allocation
describe('lineStarts is rebuilt into a persistent buffer (P13)', () => {
  it('never reallocates while the document does not grow, and stays correct', () => {
    const doc = createDoc(Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n'));
    lineStartsOf(doc);
    const buf = doc.startsBuf;
    expect(buf.length).toBeGreaterThanOrEqual(2000);
    for (let k = 0; k < 50; k++) {
      applyChanges(doc, [{ from: 5, to: 5, insert: 'x' }]);
      expect(doc.lineStarts).toBeNull();           // invalidated by the edit
      const starts = lineStartsOf(doc);
      expect(doc.startsBuf, `edit ${k} reallocated the prefix-sum buffer`).toBe(buf);
      expect(starts.length).toBe(doc.lines.length);
      // spot-check the prefix sums against a fresh computation
      let acc = 0;
      for (let i = 0; i < doc.lines.length; i++) {
        expect(starts[i]).toBe(acc);
        acc += doc.lines[i].length + 1;
      }
    }
  });

  it('grows (×1.5) when the document outgrows the buffer and keeps offsets exact', () => {
    const doc = createDoc('a\nb');
    lineStartsOf(doc);
    const small = doc.startsBuf;
    applyChanges(doc, [{ from: 3, to: 3, insert: '\nc\nd\ne\nf\ng' }]);
    const grown = lineStartsOf(doc);
    expect(doc.startsBuf).not.toBe(small);
    expect(grown.length).toBe(7);
    expect(offsetToPos(doc, 0)).toEqual({ line: 0, col: 0 });
    expect(offsetToPos(doc, docText(doc).length)).toEqual({ line: 6, col: 1 });
  });

  it('an emptied document reports offset 0 even though the buffer is reused', () => {
    const doc = createDoc('hello\nworld');
    lineStartsOf(doc);
    applyChanges(doc, [{ from: 0, to: 11, insert: '' }]);
    normaliseEmpty(doc);
    expect(doc.lines).toEqual([]);
    expect(Array.from(lineStartsOf(doc))).toEqual([0]);
    expect(offsetToPos(doc, 0)).toEqual({ line: 0, col: 0 });
  });
});

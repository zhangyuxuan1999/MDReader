// test/segmenter.render.test.ts — block-independent rendering must equal a whole-document markdown-it
// render (the accepted deviations of SPEC §13 aside). This is the Node-side twin of
// bench/verify/render3.mjs: the segmenter decides the block boundaries, md.ts renders each block on its
// own, and the concatenation is compared structurally (tags + text, class/data attributes ignored).
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import { BlockKind, DEFAULT_RENDER_OPTIONS, type OutlineEntry } from '../src/shared/types';
import { createDoc } from '../src/worker/doc';
import { blockSource, buildBlocks, mayDefineReference, segmentAll } from '../src/worker/segmenter';
import { createMarkdown } from '../src/worker/md';
import { buildOutline } from '../src/worker/outline';

const reference = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false })
  .enable(['table', 'strikethrough'])
  .use(taskLists, { enabled: true, label: false });

const KEEP = new Set(['href', 'src', 'alt', 'title', 'start', 'type', 'checked', 'disabled', 'align', 'width', 'height', 'open', 'colspan', 'rowspan']);

/** Structural canonical form: one line per element/text node, indented by depth. */
function canonical(html: string): string[] {
  const dom = new JSDOM(`<body>${html}</body>`);
  const out: Array<{ d: number; s: string }> = [];
  const walk = (node: Node, depth: number): void => {
    if (node.nodeType === 3) {
      const t = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push({ d: depth, s: `#${t}` });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'code' || tag === 'pre') {
      out.push({ d: depth, s: `<${tag}>` });
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push({ d: depth + 1, s: `#${t}` });
      out.push({ d: depth, s: `</${tag}>` });
      return;
    }
    const attrs: string[] = [];
    for (const a of Array.from(el.attributes)) if (KEEP.has(a.name)) attrs.push(`${a.name}=${JSON.stringify(a.value)}`);
    attrs.sort();
    out.push({ d: depth, s: `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>` });
    for (const c of Array.from(el.childNodes)) walk(c, depth + 1);
    out.push({ d: depth, s: `</${tag}>` });
  };
  for (const c of Array.from(dom.window.document.body.childNodes)) walk(c, 0);
  // merge adjacent text at the same depth (the app splits text across block wrappers)
  const merged: Array<{ d: number; s: string }> = [];
  for (const l of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.d === l.d && prev.s.startsWith('#') && l.s.startsWith('#')) prev.s += ' ' + l.s.slice(1);
    else merged.push({ ...l });
  }
  return merged.map((l) => '  '.repeat(l.d) + l.s);
}

/** Renders every block on its own, with the reference definitions collected the way core.ts does. */
function blocksHtml(text: string): string {
  const lines = createDoc(text).lines;
  const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false, highlight: false });
  const sources = segmentAll(lines).map((s) => ({ kind: s.kind, src: blockSource(lines, { startLine: s.start + 1, lineCount: s.count }) }));
  const env: { references?: Record<string, { href: string; title: string }> } = {};
  for (const b of sources) if (mayDefineReference(b.kind, b.src)) md.md.block.parse(b.src, md.md, env, []);
  const references = env.references ?? {};
  return sources.map((b) => md.renderBlock(b.src, { references }).html).join('\n');
}

function outline(text: string): Array<[number, string, number]> {
  const lines = createDoc(text).lines;
  let n = 1;
  return buildOutline(buildBlocks(lines, () => n++), lines).entries.map((e: OutlineEntry) => [e.level, e.text, e.line]);
}

function expectSameAsReference(text: string): void {
  expect(canonical(blocksHtml(text))).toEqual(canonical(reference.render(text)));
}

describe('per-block rendering equals whole-document rendering', () => {
  // a list that directly follows a heading / paragraph / quote line (no blank line in between)
  const cases: Array<[string, string]> = [
    ['list directly after heading, items separated by blank line', '# Title\n- a\n\n- b\n'],
    ['ordered list after a paragraph line, blank-separated items', 'Steps:\n1. one\n\n2. two\n\n3. three\n'],
    ['list after heading with a continuation paragraph', '## H\n- item\n\n  continuation of item\n- next\n'],
    ['list directly after a quote line', '> q\n- a\n\n- b\n'],
    ['task list directly after a paragraph', 'Todo:\n- [ ] a\n\n- [x] b\n'],
    ['indented heading inside a list that follows a heading', '### Mid list\n- item two\n  # continuation\n- item three\n'],
    ['indented heading inside a list that follows a paragraph', 'text\n- item two\n  # continuation\n- item three\n'],
    ['ordered list not starting at 1 cannot interrupt a paragraph', 'text\n2. two\n3. three\n'],
    ['empty list item cannot interrupt a paragraph', 'text\n-\nmore\n'],
    ['thematic break after a paragraph is not a list', 'text\n- - -\nmore\n'],
    ['setext underline after a paragraph is not a list', 'Title\n---\n\ntext\n'],
    ['html block type 6 interrupts a paragraph, `#` inside stays raw', 'text\n<div>\n# inside\n</div>\nafter\n'],
    ['html container with a multi-line open tag', '<div\n  class="x"\n  align="center">\n\ncontent **md**\n\n</div>\n'],
    ['html container with a multi-line open tag, attribute holding `>`', '<details\n  data-x="a>b"\n>\n\ninner *md*\n\n</details>\n'],
    ['type 7 tag cannot interrupt a paragraph', 'text\n<custom-el>\nstill paragraph\n'],
    ['list inside an unclosed container region is not split out', '<details>\n<summary>s</summary>\n\n- a\n\n- b\n\n</details>\n'],
    ['indented code followed by a list', '    code\n- a\n\n- b\n'],
    ['nested list after a heading', '# T\n- a\n  - b\n\n- c\n'],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      expectSameAsReference(text);
    });
  }

  it('reference definition whose label contains an escaped `]`', () => {
    expectSameAsReference('[a\\]b]\n\n[a\\]b]: https://example.com/ab\n');
    expectSameAsReference('see [x\\]y][k] here\n\n[k]: https://example.com/k\n');
  });
});

describe('outline mirrors the rendered headings', () => {
  it('a setext heading directly under an ATX heading line is in the outline', () => {
    expect(outline('# Title\nSubtitle\n---\n\ntext\n\n## Real H2\n')).toEqual([
      [1, 'Title', 1],
      [2, 'Subtitle', 2],
      [2, 'Real H2', 7],
    ]);
  });

  it('a list following a heading line does not hide the heading', () => {
    expect(outline('# Title\n- a\n\n- b\n')).toEqual([[1, 'Title', 1]]);
  });

  it('multi-line setext heading inside a heading block', () => {
    expect(outline('## H\nfirst\nsecond\n===\n')).toEqual([
      [2, 'H', 1],
      [1, 'first second', 2],
    ]);
  });
});

describe('table rows carry data-l for click-to-source', () => {
  it('every body row gets its own line offset', () => {
    const lines = createDoc('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n').lines;
    const md = createMarkdown({ ...DEFAULT_RENDER_OPTIONS, math: false });
    const html = md.renderBlock(lines.join('\n'), { references: {} }).html;
    const rows = html.match(/<tr data-l="(\d+)"/g) ?? [];
    expect(rows).toEqual(['<tr data-l="0"', '<tr data-l="2"', '<tr data-l="3"']);
    expect(segmentAll(lines)[0].kind).toBe(BlockKind.Table);
  });
});

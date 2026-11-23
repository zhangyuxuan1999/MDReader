// test/fixtures/fakeWorker.ts — test-only stand-in for the render worker (E2 development helper).
// A trivial blank-line segmenter + markdown-it produce StructureMsg / HtmlMsg objects; the real
// segmentation and identity rules live in E1's worker and are NOT reproduced here.
import MarkdownIt from 'markdown-it';
// @ts-expect-error markdown-it-task-lists ships no type declarations
import taskLists from 'markdown-it-task-lists';
import { packHtml } from '../../src/shared/protocol';
import {
  BLOCK_STRIDE, B_ID, B_KIND, B_LINES, B_START, BlockKind,
  type DocStats, type HtmlItem, type HtmlMsg, type OutlineEntry, type StructureMsg,
} from '../../src/shared/types';

export interface FakeBlock { id: number; startLine: number; lineCount: number; kind: BlockKind; source: string }

const LINE_TYPES = new Set(['paragraph_open', 'heading_open', 'list_item_open', 'blockquote_open', 'table_open', 'html_block']);

const md = new MarkdownIt({ html: true, linkify: true });
md.use(taskLists, { enabled: true, label: false });
md.core.ruler.push('line_attrs', (state) => {
  for (const t of state.tokens) if (t.map && LINE_TYPES.has(t.type)) t.attrSet('data-l', String(t.map[0]));
});
md.renderer.rules.fence = (tokens, idx) => {
  const t = tokens[idx];
  const lang = t.info.trim().split(/\s+/)[0] ?? '';
  const langAttr = lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : '';
  return `<pre class="md-code" data-l="${t.map ? t.map[0] : 0}"${langAttr}><code>${md.utils.escapeHtml(t.content)}</code></pre>\n`;
};

function kindOf(first: string, second: string | undefined): BlockKind {
  if (/^ {0,3}#{1,6}(\s|$)/.test(first)) return BlockKind.Heading;
  if (/^ {0,3}(`{3,}|~{3,})/.test(first)) return BlockKind.Code;
  if (/^ {0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(first)) return BlockKind.Hr;
  if (/^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(first)) return BlockKind.List;
  if (/^ {0,3}>/.test(first)) return BlockKind.Quote;
  if (/^ {0,3}\$\$/.test(first)) return BlockKind.Math;
  if (/^ {0,3}<[a-zA-Z!/?]/.test(first)) return BlockKind.Html;
  if (first.includes('|') && second !== undefined && /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(second)) return BlockKind.Table;
  return BlockKind.Prose;
}

/** Blank-line segmenter: trailing blanks belong to the previous block, headings start a block, fences glue. */
export function segment(text: string): FakeBlock[] {
  const lines = text.split('\n');
  const out: FakeBlock[] = [];
  let start = 0;
  let inFence = false;
  const close = (end: number): void => {
    if (end <= start) return;
    const src = lines.slice(start, end);
    out.push({ id: out.length + 1, startLine: start + 1, lineCount: end - start, kind: kindOf(src[0], src[1]), source: src.join('\n') });
    start = end;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (inFence) continue;
    if (i > start && /^ {0,3}#{1,6}(\s|$)/.test(line) && lines[i - 1].trim() !== '') close(i);
    if (line.trim() === '') {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      close(j);
      i = j - 1;
    }
  }
  close(lines.length);
  return out;
}

export function structureOf(blocks: FakeBlock[], version = 1, changed?: number[]): StructureMsg {
  const arr = new Int32Array(blocks.length * BLOCK_STRIDE);
  let lineCount = 0;
  blocks.forEach((b, i) => {
    arr[i * BLOCK_STRIDE + B_ID] = b.id;
    arr[i * BLOCK_STRIDE + B_START] = b.startLine;
    arr[i * BLOCK_STRIDE + B_LINES] = b.lineCount;
    arr[i * BLOCK_STRIDE + B_KIND] = b.kind;
    lineCount += b.lineCount;
  });
  const stats: DocStats = { chars: 0, charsNoSpace: 0, cjk: 0, latinWords: 0, lines: lineCount, readingMinutes: 0 };
  return { type: 'structure', version, blocks: arr, changed: Int32Array.from(changed ?? blocks.map((b) => b.id)), lineCount, stats, outlineVersion: 1 };
}

export function htmlOf(blocks: FakeBlock[], ids?: number[], version = 1): HtmlMsg {
  const wanted = ids ? new Set(ids) : null;
  const items: HtmlItem[] = blocks
    .filter((b) => !wanted || wanted.has(b.id))
    .map((b) => ({ id: b.id, flags: 0, payload: md.render(b.source) }));
  return { type: 'html', version, batch: packHtml(items).batch };
}

export function htmlMsg(items: HtmlItem[], version = 1): HtmlMsg {
  return { type: 'html', version, batch: packHtml(items).batch };
}

export function outlineOf(blocks: FakeBlock[]): OutlineEntry[] {
  const seen = new Map<string, number>();
  const out: OutlineEntry[] = [];
  for (const b of blocks) {
    const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(b.source.split('\n')[0]);
    if (!m) continue;
    let slug = m[2].toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    out.push({ level: m[1].length as OutlineEntry['level'], text: m[2], slug, line: b.startLine, blockId: b.id });
  }
  return out;
}

/** Structure from a compact description: [id, lineCount, kind][] with startLines derived. */
export function structureFrom(spec: Array<[id: number, lines: number, kind?: BlockKind]>, version = 1, changed: number[] = []): StructureMsg {
  let start = 1;
  const blocks: FakeBlock[] = spec.map(([id, lines, kind]) => {
    const b = { id, startLine: start, lineCount: lines, kind: kind ?? BlockKind.Prose, source: '' };
    start += lines;
    return b;
  });
  return structureOf(blocks, version, changed);
}

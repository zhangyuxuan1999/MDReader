// @vitest-environment jsdom
// test/r6-frb-walk.test.ts — fix-refs-b (0.2.0 stage 2g, fix round 6): which blocks of the project's own documents does
// rule T (CONTRACT §11, Checkpoint H) refuse that every other start check lets through? For every block of the corpus of
// bench/verify/fix2-g-walk.mjs (segmented as the worker segments, rendered and sanitized as the preview mounts it) whose
// source can hold raw HTML or that shows a link or image without its URL: begin()'s checks at unit level with and without
// rule T. Prints "R6FRB-WALK <doc>:<line> <kind of change> src=<source>" for each block only rule T refuses and the totals.
// Run: FRB_OUT=<file> perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-frb-walk.test.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { blockSource, segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import * as S from '../src/preview/serialize';
import { baselineFaithful, sanitizerKept } from '../src/preview/fidelity';
import { blockReveals, writeReveals } from '../src/preview/inlineEdit';

const DOCS = ['README.md', 'docs/CONTRACT.md', 'docs/SPEC.md', 'docs/FINDINGS-inline-r1.md', 'docs/WIP-inline-edit.md', 'docs/FINDINGS-0.2.0-r1.md', 'test-data/small.md', 'test-data/medium.md'];
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

const KINDS = new Set([BlockKind.Prose, BlockKind.Heading, BlockKind.List, BlockKind.Quote, BlockKind.Code, BlockKind.Table, BlockKind.Math]);
/** 'other' when an earlier check refuses, 'T' when only rule T does, 'ok' when the block starts. */
function start(src: string, kind: BlockKind): 'other' | 'T' | 'ok' {
  const w = document.createElement('section');
  w.className = 'md-block';
  const r = mdk.renderBlock(src, { references: {} });
  w.replaceChildren(r.flags & 2 ? document.createRange().createContextualFragment(r.html) : sanitizeToFragment(r.html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  // (a reserved name: the preview marks the block data-mdr-x and never edits it, U10; PLAIN: too long)
  if (r.flags & (1 | 4) || !KINDS.has(kind) || src.length > 60000 || S.unsupportedReason(w, src) !== null) return 'other';
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true } as S.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, kind, hints); } catch { return 'other'; }
  if (!baselineFaithful(w, kind, base)) return 'other';
  if (hints.hidden && !baselineFaithful(w, kind, S.serializeBlock(w, kind, { ...hints, hidden: undefined }))) return 'other';
  if (writeReveals(src, base) !== null || blockReveals(base, hints) !== null) return 'other';
  const t = src.includes('<') ? !sanitizerKept(src) : w.querySelector('a:not([href]), img:not([src])') !== null;
  return t ? 'T' : 'ok';
}
/** What the sanitizer changes in `src` (for the report). */
function change(src: string): string {
  const html = mdk.renderBlock(src, { references: {} }).html;
  const inert = document.createElement('template');
  inert.innerHTML = html;
  let clean: DocumentFragment;
  try { clean = sanitizeToFragment(html); } catch { return 'the sanitizer throws'; }
  const a = Array.from(inert.content.querySelectorAll('*')), b = Array.from(clean.querySelectorAll('*'));
  const names = (l: Element[]): string[] => l.map((e) => e.localName);
  const gone = names(a).filter((n, i, all) => all.filter((x) => x === n).length > names(b).filter((x) => x === n).length && all.indexOf(n) === i);
  if (gone.length) return 'elements removed: ' + gone.join(',');
  for (let i = 0; i < a.length; i++) for (const at of Array.from(a[i].attributes)) if (b[i]?.getAttribute(at.name) !== at.value) return `attribute ${a[i].localName}[${at.name}] ${b[i]?.hasAttribute(at.name) ? 'changed' : 'removed'}`;
  return 'a comment or processing instruction removed, or an element moved';
}

describe('rule T over the project documents', () => {
  it('walk', () => {
    const lines: string[] = [];
    const tot = { blocks: 0, checked: 0, ok: 0, other: 0, T: 0 };
    for (const doc of DOCS) {
      let text: string;
      try { text = readFileSync(doc, 'utf8'); } catch { continue; }
      const all = text.split('\n');
      for (const seg of segmentAll(all)) {
        tot.blocks++;
        const bl = blockSource(all, { startLine: seg.start + 1, lineCount: seg.count }).split('\n');
        while (bl.length > 0 && bl[bl.length - 1].trim() === '') bl.pop();
        while (bl.length > 0 && bl[0].trim() === '') bl.shift();
        const src = bl.join('\n');
        const probe = mdk.renderBlock(src, { references: {} }).html;
        if (!src.includes('<') && !/<(a|img)(?![^>]*\b(href|src)=)/.test(probe)) continue;
        tot.checked++;
        const v = start(src, seg.kind);
        tot[v]++;
        if (v === 'T') lines.push(`R6FRB-WALK ${doc}:${seg.start + 1} ${change(src)} src=${JSON.stringify(src.length > 300 ? src.slice(0, 300) + '…' : src)}`);
      }
    }
    lines.push(`R6FRB-WALK TOTAL ${JSON.stringify(tot)}`);
    if (process.env.FRB_OUT) writeFileSync(process.env.FRB_OUT, lines.join('\n') + '\n');
  });
});

// The raw-HTML atoms the session scripts edit (bench/verify/r5-ca-joins.mjs sets, r5-fa-recreate.mjs, v6-von-style.mjs):
// rule T leaves every one of them editable.
describe('rule T keeps the raw-HTML atoms of the session scripts editable', () => {
  const CONTAINERS = [
    (a: string, b: string) => `- one first\n- Lead ${a} two\n- three ${b} end`,
    (a: string, b: string) => `> one first\n>\n> Lead ${a} two\n>\n> three ${b} end`,
    (a: string, b: string) => `- [ ] one first\n- [x] Lead ${a} two\n- [ ] three ${b} end`,
    (a: string, b: string) => `- one first\n\n- Lead ${a} two\n\n- three ${b} end`,
  ];
  const SETS: Array<[string, string]> = [
    ['<sub>s</sub><sup>p</sup>', '<img src="y.png" alt="a" title="t">'],
    ['$$E=mc^2$$', '<span style="color:red">r</span> $z$'],
    ['<http://e.x/a>$x$', 'http://e.x/b $y$'],
    ['<kbd>$x$</kbd>', '*$\\alpha$*'],
    ['<font color="red">f</font> <u>u</u>', '<mark>m</mark> <small style="color:blue">s</small>'],
    ['<span style="font-weight:bold">w</span>', '<b style="color:red">b</b> <span style="background:yellow">y</span>'],
    ['<br> $x$ <sup>2</sup>', '`` a`|`b `` $y$'],
  ];
  const OTHERS = [
    '- one\n- Lead <kbd>K</kbd> two', '- one\n- Lead <span class="c">s</span> two', '- one\n- Lead <span style="color:red">r</span> two',
    '- one\n- Lead <img src="x.png" width="10"> two', '> one\n>\n> Lead x<sup>2</sup> two',
    'Text <span style="color:red">red words</span> end here', 'Text <font color="blue">blue words</font> end here',
    'Text <span style="font-weight:bold">heavy words</span> end here',
  ];
  it('every container and atom set', () => {
    for (const c of CONTAINERS) for (const [a, b] of SETS) expect(sanitizerKept(c(a, b)), c(a, b)).toBe(true);
    for (const s of OTHERS) expect(sanitizerKept(s), s).toBe(true);
  });
});

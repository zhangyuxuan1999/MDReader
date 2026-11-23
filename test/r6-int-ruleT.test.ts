// @vitest-environment jsdom
// test/r6-int-ruleT.test.ts — integrate (0.2.0 stage 2g, fix round 6). Rule T (CONTRACT §11, Checkpoint H) says a block
// is editable only if the sanitizer left its rendering as the renderer made it. fix-refs-b checked sanitizerKept only for
// a source with `<`; DOMPurify also changes Markdown-only blocks (it trims a title's edge spaces, and SAFE_FOR_XML removes
// a title that holds `-->`), and a session then wrote the sanitized title back. (1) these blocks are refused by
// sanitizerKept; (2) over the project documents, how many Markdown-only blocks that otherwise start would sanitizerKept
// refuse (printed: "R6INT-T <doc>:<line> src=…" and the total; asserted: none of the ordinary ones).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-int-ruleT.test.ts
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

/** begin()'s checks before rule T: true when the block would start. */
function startsWithoutT(src: string, kind: BlockKind): boolean {
  const w = document.createElement('section');
  w.className = 'md-block';
  const r = mdk.renderBlock(src, { references: {} });
  w.replaceChildren(r.flags & 2 ? document.createRange().createContextualFragment(r.html) : sanitizeToFragment(r.html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  if (r.flags & (1 | 4) || !KINDS.has(kind) || src.length > 60000 || S.unsupportedReason(w, src) !== null) return false;
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true } as S.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, kind, hints); } catch { return false; }
  if (!baselineFaithful(w, kind, base)) return false;
  if (hints.hidden && !baselineFaithful(w, kind, S.serializeBlock(w, kind, { ...hints, hidden: undefined }))) return false;
  if (writeReveals(src, base) !== null || blockReveals(base, hints) !== null) return false;
  return w.querySelector('a:not([href]), img:not([src])') === null;
}

describe('rule T for Markdown-only blocks', () => {
  it('a title the sanitizer trims or removes is refused', () => {
    for (const s of ['See [x](https://e.example/ " a ") words', 'See [x](https://e.example/ "a-->b") words', 'See ![i](p.png " t") words', 'See ![i](p.png "a]>b") words'])
      expect(sanitizerKept(s), s).toBe(false);
  });
  it('ordinary Markdown-only blocks are kept', () => {
    for (const s of ['Plain words here', '# Cookie', '## location', '- [ ] task\n- [x] done', '| a | b |\n| --- | --- |\n| c | d |', 'See [x](https://e.example/ "a title") words', '![i](p.png "t")', 'Text $x^2$ and $$y$$', '```js\nlet a = 1;\n```', '> quote *em* **strong** ~~del~~', 'a[^1]\n\n[^1]: note', 'https://e.example/a%E2%80%AEb', '<https://e.example/x>', 'mail@e.example'])
      expect(sanitizerKept(s), s).toBe(true);
  });
  it('walk: Markdown-only blocks of the project documents that start today are kept', () => {
    const lines: string[] = [];
    const tot = { blocks: 0, checked: 0, kept: 0, refused: 0 };
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
        if (src.includes('<') || !startsWithoutT(src, seg.kind)) continue;
        tot.checked++;
        if (sanitizerKept(src)) tot.kept++;
        else { tot.refused++; lines.push(`R6INT-T ${doc}:${seg.start + 1} src=${JSON.stringify(src.slice(0, 200))}`); }
      }
    }
    lines.push(`R6INT-T TOTAL ${JSON.stringify(tot)}`);
    if (process.env.R6INT_OUT) writeFileSync(process.env.R6INT_OUT, lines.join('\n') + '\n');
    console.log(lines.slice(-20).join('\n'));
    expect(tot.refused).toBe(0);
  }, 100000);
});

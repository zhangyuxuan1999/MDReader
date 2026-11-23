// @vitest-environment jsdom
// test/v5-rev-zwdoc.test.ts — verify-review (round 4): does the session keep a zero-width character the DOCUMENT
// holds (U+200B / U+FEFF / U+200D in an emoji sequence) when another word of the block is edited? Informational
// probe of the P-A class (helpers are U+200B too). Bounded: < 10 s.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

const C = (n: number): string => String.fromCharCode(n);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  document.body.appendChild(w);
  return w;
}
import { segmentAll } from '../src/worker/segmenter';
import { wrapCodeFences } from '../src/preview/createPreview';
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };
describe('a zero-width character of the document in code, inline code and TeX survives an edit elsewhere in the block', () => {
  const Z = C(0x200b);
  for (const [name, src] of [['fence', '```\na' + Z + 'b\nwords\n```'], ['inline code', 'x `a' + Z + 'b` words'], ['tex', 'x $a' + Z + 'b$ words'], ['indented code', '    a' + Z + 'b\n    words']] as const) {
    it(name, () => {
      const w = mount(src);
      wrapCodeFences(w);
      const kind = kindOf(src);
      const gate = unsupportedReason(w, src) === null && baselineFaithful(w, kind, serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true }));
      const tw = document.createTreeWalker(w, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); break; }
      const md = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
      console.log(name, 'gate', gate, JSON.stringify(md));
      expect(gate ? md.includes(Z) : true, JSON.stringify(md)).toBe(true);
    });
  }
});
describe('a zero-width character of the document survives an edit elsewhere in the block', () => {
  for (const [name, z] of [['ZWSP', C(0x200b)], ['BOM', C(0xfeff)], ['ZWJ', C(0x200d)], ['ZWNJ', C(0x200c)]] as const) {
    it(name, () => {
      const src = 'a' + z + 'b words';
      const w = mount(src);
      const gate = unsupportedReason(w, src) === null && baselineFaithful(w, BlockKind.Prose, serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true }));
      const tw = document.createTreeWalker(w, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) (n as Text).data = (n as Text).data.replace('words', 'wordsX');
      const md = serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
      console.log(name, 'gate', gate, JSON.stringify(md), Array.from(md).map((c) => c.charCodeAt(0).toString(16)).filter((h) => h.length > 2).join(','));
      expect(gate ? md.includes(z) : true, JSON.stringify(md)).toBe(true);
    });
  }
});

// @vitest-environment jsdom
// test/v6-vr-entity.test.ts — verify-review (stage 2f, after fix round 5): an invisible character the block's source
// writes as a character reference (an entity) OUTSIDE the URL writers of rule J19 extended — in text, in a raw HTML
// attribute, in a raw <img src> that stays raw HTML — and a session that types one character elsewhere in the block.
// The tree's serializer (stampAtoms + stamped, as begin() does) and pre-r5's (as its begin() did) are asked the same:
// is the block accepted (baseline + fidelity gate), and does the write hold a raw invisible character the source did not
// hold raw? A case FAILS when the write adds one (the source gets a character the user did not type and cannot see).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-vr-entity.test.ts
// Special characters are built from code points (no typed escapes).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const invisible = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
const count = (s: string): number => Array.from(s).filter(invisible).length;
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/g, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));

type Ser = { serializeBlock: typeof serializeBlock; sourceStyleHints: typeof sourceStyleHints };
function session(which: 'tree' | 'pre', src: string): { accepted: boolean; out: string | null } {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  wrapCodeFences(w);
  document.body.replaceChildren(w);
  const kind = w.querySelector('ul,ol') ? BlockKind.List : w.querySelector('h1,h2,h3') ? BlockKind.Heading : BlockKind.Prose;
  if (unsupportedReason(w, src) !== null) return { accepted: false, out: null };
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  const ser: Ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : (pre5 as unknown as Ser);
  if (which === 'tree') stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}), editing: true };
  let base: string;
  try { base = ser.serializeBlock(w, kind, hints); } catch { return { accepted: false, out: null }; }
  if (!baselineFaithful(w, kind, base)) return { accepted: false, out: null };
  // the session types X after "words" (the last text node holding it)
  const tw = document.createTreeWalker(w, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) last = n as Text;
  if (last) last.data = last.data.replace('words', 'wordsX');
  return { accepted: true, out: ser.serializeBlock(w, kind, hints) };
}

const ENT = [['ZWSP', 0x200b], ['ZWNJ', 0x200c], ['ZWJ', 0x200d], ['RLO', 0x202e], ['SHY', 0xad], ['WJ', 0x2060], ['LRM', 0x200e], ['BOM', 0xfeff], ['HANGUL FILLER', 0x3164], ['TAG A', 0xe0041]] as const;
const SHAPES: Array<[string, (e: string) => string]> = [
  ['text', (e) => `Lead a${e}b words`],
  ['raw img src (stays raw HTML)', (e) => `Lead <img src="x${e}y.png" width="20"> words`],
  ['raw span title', (e) => `Lead <span title="a${e}b">t</span> words`],
  ['raw a title', (e) => `Lead <a href="https://e.example/p" title="a${e}b">t</a> words`],
  ['image alt', (e) => `Lead ![a${e}b](i.png) words`],
  ['link title', (e) => `Lead [t](https://e.example/p "a${e}b") words`],
  ['list item text', (e) => `- Lead a${e}b words\n- two`],
];

describe('an entity of an invisible character outside the URL writers, and a session elsewhere in the block', () => {
  for (const [shape, mk] of SHAPES) {
    for (const [name, cp] of ENT) {
      it(`${shape} / &#x${cp.toString(16)}; (${name}): no raw invisible character is added`, () => {
        const src = mk('&#x' + cp.toString(16) + ';');
        const t = session('tree', src);
        const p = session('pre', src);
        const line = `src=${show(src)} tree(accepted=${t.accepted})=${show(t.out)} pre(accepted=${p.accepted})=${show(p.out)}`;
        console.log(`CASE ${shape} / ${name}: ${line} treeAdds=${t.out !== null && count(t.out) > count(src)} preAdds=${p.out !== null && count(p.out) > count(src)}`);
        if (t.out !== null) expect(count(t.out), line).toBe(count(src));
      });
    }
  }
});

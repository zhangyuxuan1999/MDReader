// @vitest-environment jsdom
// test/r6-cr-dropped.test.ts — challenge-refs (0.2.0 stage 2g, fix round 6), outside round 6's scope: which raw HTML that
// the sanitizer removes from the preview does a session drop from the source when the user types elsewhere in the block?
// Prints one line per case "R6CR-DROP <name> tree=<kept|DROPPED|refused:why> pre=<…> out=<written source>", along the
// session's path (as test/r6-cr-holes.test.ts). Records; since rule T (CONTRACT section 11, Checkpoint H) the tree must
// refuse the cases whose markup the sanitizer changes (fix-refs-b).
// Run: R6CR_OUT=<file> perl -e 'alarm 110; exec @ARGV' npx vitest run test/r6-cr-dropped.test.ts
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import * as tree from '../src/preview/serialize';
import * as treeFid from '../src/preview/fidelity';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre from './fixtures/src-0.2.0/preview/serialize';
import * as preFid from './fixtures/src-0.2.0/preview/fidelity';

let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });
function run(impl: 'tree' | 'pre', src: string): string {
  const S = (impl === 'tree' ? tree : pre) as typeof tree;
  const F = impl === 'tree' ? treeFid : preFid;
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: {} }).html));
  document.body.replaceChildren(w);
  const u = S.unsupportedReason(w, src);
  if (u !== null) return 'refused:' + u;
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  S.stampAtoms(w);
  const hints = { ...S.sourceStyleHints(src), stamped: true, editing: true } as tree.SerializeHints;
  let base: string;
  try { base = S.serializeBlock(w, BlockKind.Prose, hints); } catch { return 'refused:markers'; }
  if (!F.baselineFaithful(w, BlockKind.Prose, base)) return 'refused:gate';
  // rule T (CONTRACT section 11, Checkpoint H; fix-refs-b): the tree's session start refuses a block whose raw HTML the
  // sanitizer changed (inlineEdit.ts startAllowed, fidelity.ts sanitizerKept)
  if (impl === 'tree' && src.includes('<') && !treeFid.sanitizerKept(src)) return 'refused:T';
  const tw = document.createTreeWalker(w, 4);
  let last: Text | null = null;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) last = n as Text;
  if (!last) return 'refused:no-text';
  last.data = last.data.replace(/words(?!.*words)/, 'wordsX');
  return S.serializeBlock(w, BlockKind.Prose, hints);
}
const CASES: Array<[string, string, string]> = [
  ['a target', 'See <a href="https://e.example/" target="_blank">link</a> words', 'target="_blank"'],
  ['a rel', 'See <a href="https://e.example/" rel="nofollow">link</a> words', 'rel="nofollow"'],
  ['img width', 'See <img src="i.png" width="300"> words', 'width="300"'],
  ['img height+alt', 'See <img src="i.png" alt="a" height="20"> words', 'height="20"'],
  ['span id', 'See <span id="anchor">x</span> words', 'id="anchor"'],
  ['a name', 'See <a name="anchor"></a> words', 'name="anchor"'],
  ['span class', 'See <span class="note">x</span> words', 'class="note"'],
  ['inline iframe', 'See <iframe src="https://player.example/v"></iframe> words', '<iframe'],
  ['onclick', 'See <span onclick="f()">x</span> words', 'onclick'],
  ['script', 'See <script>f()</script> words', '<script'],
  ['javascript href', 'See <a href="javascript:f()">x</a> words', 'javascript:'],
  ['input checkbox', 'See <input type="checkbox" checked> words', '<input'],
  ['video', 'See <video src="v.mp4" controls></video> words', '<video'],
  ['font face', 'See <font face="serif">x</font> words', 'face="serif"'],
  ['kbd title', 'See <kbd title="t">k</kbd> words', 'title="t"'],
  ['abbr', 'See <abbr title="t">a</abbr> words', '<abbr'],
];
describe('challenge-refs: sanitized raw HTML in an edited block', () => {
  it('records', () => {
    const out: string[] = [];
    for (const [name, src, needle] of CASES) {
      const t = run('tree', src), p = run('pre', src);
      const v = (o: string): string => (o.startsWith('refused:') ? o : o.includes(needle) ? 'kept' : 'DROPPED');
      out.push(`R6CR-DROP ${name} tree=${v(t)} pre=${v(p)} out=${JSON.stringify(t)}`);
    }
    console.log(out.join('\n'));
    if (process.env.R6CR_OUT) writeFileSync(process.env.R6CR_OUT, out.join('\n') + '\n');
    // rule T: what the sanitizer took (an element, an attribute, a changed value), a session of the tree does not delete
    for (const name of ['a rel', 'inline iframe', 'onclick', 'script', 'javascript href']) {
      expect(out.find((l) => l.startsWith(`R6CR-DROP ${name} `)), name).toMatch(/ tree=refused:T /);
    }
  });
});

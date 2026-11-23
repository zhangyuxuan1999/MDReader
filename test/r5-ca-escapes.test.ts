// @vitest-environment jsdom
// test/r5-ca-escapes.test.ts — challenge-atoms (stage 2f, fix round 5): attacks the repair of N2 (REV-1, rule "J19
// extended", CONTRACT §11 Round-4 verification decisions) at unit level, along the session's own path: the worker's
// rendering of the block, stampAtoms + sourceStyleHints + stamped: true (what inlineEdit begin() does), one typed
// character after "words", serializeBlock(..., editing: true).
// Each case prints a RESULT line and asserts what the rule asks: the number of raw stay-escaped characters in what the
// session writes equals the number in the source (an escape is never turned into the raw character, whatever other link
// of the block spells the same href), and the href list after a re-render equals the one before.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-ca-escapes.test.ts
// The pre-r5 serializer (a snapshot taken before round 5) was run on the same cases for the "before" column (printed only);
// since round 7 (CONTRACT §11 Checkpoint I) that column is the released 0.2.0's (test/fixtures/src-0.2.0).
// Special characters are built from code points (no typed escapes).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
let mdk: Markdown;
beforeAll(async () => { expect(await loadMath()).toBe(true); mdk = createMarkdown(DEFAULT_RENDER_OPTIONS); mdk.enableMath(); });

function mount(src: string, refs: References = {}): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: { ...refs } }).html));
  wrapCodeFences(w);
  document.body.appendChild(w);
  return w;
}
const urls = (w: Element): string[] => Array.from(w.querySelectorAll('a[href], img[src]')).map((e) => e.getAttribute(e.tagName === 'A' ? 'href' : 'src') ?? '');
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1,h2,h3,h4,h5,h6') ? BlockKind.Heading : BlockKind.Prose);
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const staysEscaped = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
const rawCount = (s: string): number => Array.from(s).filter(staysEscaped).length;
const hex = (s: string): string => Array.from(s).filter(staysEscaped).map((c) => c.codePointAt(0)!.toString(16)).join(',');

/** The session's write after typing X after "words": tree (stamped, as begin() does) or pre-r5. */
function session(which: 'tree' | 'pre', src: string, refs: References = {}): { md: string | null; refused: string | null } {
  const w = mount(src, refs);
  const kind = kindOf(w);
  const ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : pre5;
  if (which === 'tree') stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}) };
  const reason = unsupportedReason(w, src);
  let base: string;
  try { base = ser.serializeBlock(w, kind, { ...hints, editing: true }); } catch (e) { w.remove(); return { md: null, refused: 'throw ' + String(e) }; }
  if (reason !== null || !baselineFaithful(w, kind, base)) { w.remove(); return { md: null, refused: reason ?? 'fidelity' }; }
  const tw = document.createTreeWalker(w, 4);
  let typed = false;
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); typed = true; break; }
  expect(typed).toBe(true);
  const md = ser.serializeBlock(w, kind, { ...hints, editing: true });
  w.remove();
  return { md, refused: null };
}

const Z = C(0x200b);
const CASES: Array<[string, string, References?]> = [
  // the same href, spelled once raw and once escaped in one block
  ['dest raw then dest escaped', `See [a](https://e.example/a${Z}b) and [b](https://e.example/a%E2%80%8Bb) here\nsecond line words`],
  ['dest escaped then dest raw', `See [b](https://e.example/a%E2%80%8Bb) and [a](https://e.example/a${Z}b) here\nsecond line words`],
  ['image raw then image escaped', `See ![a](https://e.example/a${Z}b.png) and ![b](https://e.example/a%E2%80%8Bb.png) here\nsecond line words`],
  ['bare raw then autolink escaped', `See https://e.example/a${Z}b and <https://e.example/a%E2%80%8Bb> here\nsecond line words`],
  ['dest raw then bare escaped', `See [a](https://e.example/a${Z}b) and https://e.example/a%E2%80%8Bb here\nsecond line words`],
  ['item: dest raw, next item dest escaped', `- [a](https://e.example/a${Z}b)\n- [b](https://e.example/a%E2%80%8Bb) words`],
  ['dest raw RLO then dest escaped', `See [a](https://e.example/a${C(0x202e)}b) and [b](https://e.example/a%E2%80%AEb) here\nsecond line words`],
  ['dest raw NBSP-free BOM then escaped', `See [a](https://e.example/a${C(0xfeff)}b) and [b](https://e.example/a%EF%BB%BFb) here\nsecond line words`],
  // entity spellings of invisible characters (an escape too: the source does not hold the raw character)
  ['dest entity hex ZWSP', 'See [x](https://e.example/a&#x200B;b) here\nsecond line words'],
  ['dest entity dec ZWSP', 'See [x](https://e.example/a&#8203;b) here\nsecond line words'],
  ['dest entity RLO', 'See [x](https://e.example/a&#x202E;b) here\nsecond line words'],
  ['dest entity BOM', 'See [x](https://e.example/a&#xFEFF;b) here\nsecond line words'],
  ['dest entity shy', 'See [x](https://e.example/a&shy;b) here\nsecond line words'],
  ['dest entity nbsp', 'See [x](https://e.example/a&nbsp;b) here\nsecond line words'],
  ['dest entity ideographic space', 'See [x](https://e.example/a&#x3000;b) here\nsecond line words'],
  ['image entity ZWSP', 'See ![i](https://e.example/a&#x200B;b.png) here\nsecond line words'],
  ['dest entity ZWSP with title', 'See [x](https://e.example/a&#x200B;b "t") here\nsecond line words'],
  ['dest entity ZWSP in angle brackets', 'See [x](<https://e.example/a&#x200B;b>) here\nsecond line words'],
  ['bare URL entity ZWSP', 'See https://e.example/a&#x200B;b here\nsecond line words'],
  ['quote: dest entity ZWSP', '> See [x](https://e.example/a&#x200B;b) here\n> second line words'],
  ['cell: dest entity ZWSP', '| [x](https://e.example/a&#x200B;b) | c |\n|---|---|\n| d | words |'],
  ['heading: dest entity ZWSP', '# See [x](https://e.example/a&#x200B;b) words'],
  ['item: dest entity ZWSP', '- See [x](https://e.example/a&#x200B;b) words'],
  // positions and other spellings (escaped in the source)
  ['userinfo ZWSP', 'See [x](https://u%E2%80%8B@e.example/) here\nsecond line words'],
  ['host ZWSP bare', 'See https://e%E2%80%8B.example/ here\nsecond line words'],
  ['fragment ZWSP bare', 'See https://e.example/#a%E2%80%8Bb here\nsecond line words'],
  ['query ZWSP autolink', 'See <https://e.example/?a=%E2%80%8B> here\nsecond line words'],
  ['escape of an escape', 'See [x](https://e.example/a%25E2%2580%258Bb) and https://e.example/c%25E2%2580%258Bd here\nsecond line words'],
  ['broken sequence', 'See [x](https://e.example/a%E2%80b) and https://e.example/c%FFd and <https://e.example/e%C0%80f> here\nsecond line words'],
  ['lone surrogate bytes', 'See [x](https://e.example/a%ED%A0%80b) and https://e.example/c%ED%A0%80d here\nsecond line words'],
  ['lower-case hex', 'See [x](https://e.example/a%e2%80%8bb) and https://e.example/c%e2%80%8bd and <https://e.example/e%e2%80%8bf> here\nsecond line words'],
  ['raw and escaped in one URL', `See [x](https://e.example/a${Z}b%E2%80%8Bc) and https://e.example/d${Z}e%E2%80%8Bf here\nsecond line words`],
  ['dest with spaces', 'See [x](<https://e.example/a b%E2%80%8Bc>) here\nsecond line words'],
  ['dest with parentheses', 'See [x](https://e.example/a(b)%E2%80%8Bc) here\nsecond line words'],
  ['IDN host bare and dest', 'See https://xn--r8jz45g.jp/a%E2%80%8Bb and [y](https://例え.jp/c%E2%80%8Bd) here\nsecond line words'],
  ['e-mail autolink with escape', 'See <a%E2%80%8Bb@e.example> here\nsecond line words'],
  ['bare e-mail with escape', 'See a%E2%80%8Bb@e.example here\nsecond line words'],
  ['www link with escape', 'See www.e.example/a%E2%80%8Bb here\nsecond line words'],
  ['www link with entity in a destination', 'See [x](www.e.example/a&#x200B;b) and www.e.example/c%E2%80%8Bd here\nsecond line words'],
  ['reference link defined elsewhere', 'See [x][r] here\nsecond line words', { R: { href: 'https://e.example/a%E2%80%8Bb', title: '' } }],
  ['reference link with entity-spelled def elsewhere', 'See [x][r] and [y](https://e.example/c&#x200B;d) here\nsecond line words', { R: { href: 'https://e.example/a%E2%80%8Bb', title: '' } }],
];

describe('J19 extended attacks (challenge-atoms)', () => {
  for (const [name, src, refs] of CASES) {
    it(name, () => {
      const w = mount(src, refs ?? {});
      const before = urls(w);
      w.remove();
      const t = session('tree', src, refs ?? {});
      const p = session('pre', src, refs ?? {});
      const srcRaw = rawCount(src);
      const tRaw = t.md === null ? -1 : rawCount(t.md);
      const pRaw = p.md === null ? -1 : rawCount(p.md);
      const after = t.md === null ? null : urls(mount(t.md, refs ?? {}));
      document.body.replaceChildren();
      console.log(`RESULT ${name} | src raw ${srcRaw} [${hex(src)}] | tree raw ${tRaw} [${t.md === null ? 'refused ' + t.refused : hex(t.md)}] | pre raw ${pRaw} | hrefSame ${after === null ? 'n/a' : JSON.stringify(after) === JSON.stringify(before)}\n  tree: ${JSON.stringify(t.md)}\n  pre:  ${JSON.stringify(p.md)}`);
      if (t.md === null) return;
      expect(after).toEqual(before);
      expect(tRaw, JSON.stringify(t.md)).toBeLessThanOrEqual(srcRaw);
    });
  }
});

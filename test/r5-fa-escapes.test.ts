// @vitest-environment jsdom
// test/r5-fa-escapes.test.ts — fix-atoms (stage 2f, fix round 5): N2 = REV-1, the rule "J19 extended" (CONTRACT §11,
// Round-4 verification decisions): for every URL a session writes (a bare URL, an autolink, a link destination, an image
// source, a reference link written inline), a percent-escape is not turned into the raw character unless that character
// is plainly visible (L, N, P, S, minus the blank letters U+115F, U+1160, U+3164, U+FFA0, U+2800). The table below holds
// one code point of every general category, the blank list, a visible Latin letter, a CJK character, an emoji followed by
// its variation selector and a combining mark after a slash. For each URL construct: (a) no character of the
// stay-escaped classes appears raw in what the session writes unless the block's source held it raw; (b) the href of the
// re-rendered output equals the href before. Plus: every URL the source writes keeps the source's own spelling (escapes,
// %20 and raw characters alike), and a URL whose spelling is not known gets the predicate: a visible escape decoded as
// before (K5), an invisible one kept. Special characters are built from code points (no typed escapes).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';

const C = (...cps: number[]): string => String.fromCodePoint(...cps);
const pct = (s: string): string => encodeURIComponent(s);
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

// THE classes that stay escaped, written independently of serialize.ts: everything but L / N / P / S, plus the blank list.
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const staysEscaped = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
/** The stay-escaped code points of `md` that `src` does not hold raw. */
const added = (md: string, src: string): string[] => {
  const raw = new Set(Array.from(src));
  return Array.from(md).filter((c) => staysEscaped(c) && !raw.has(c)).map((c) => c.codePointAt(0)!.toString(16));
};

/** [name, code points]: one of every general category, the blank list and the visible checks. */
const TABLE: Array<[string, number[]]> = [
  ['Lu', [0xc9]], ['Ll', [0xe9]], ['Lt', [0x1c5]], ['Lm', [0x2b0]], ['Lo CJK', [0x4e2d]], ['Latin a', [0x61]],
  ['Mn after a slash', [0x2f, 0x301]], ['Mc', [0x903]], ['Me', [0x20dd]],
  ['Nd', [0x663]], ['Nl', [0x2160]], ['No', [0xb2]],
  ['Pc', [0x203f]], ['Pd', [0x2014]], ['Ps', [0x300c]], ['Pe', [0x300d]], ['Pi', [0xab]], ['Pf', [0xbb]], ['Po', [0x3002]],
  ['Sm', [0xd7]], ['Sc', [0x20ac]], ['Sk', [0xb4]], ['So', [0x2603]], ['emoji + VS16', [0x2764, 0xfe0f]], ['emoji astral', [0x1f600]],
  ['Zs NBSP', [0xa0]], ['Zs U+3000', [0x3000]], ['Zs em space', [0x2003]], ['Zs U+202F', [0x202f]], ['Zl', [0x2028]], ['Zp', [0x2029]],
  ['Cc C1 NEL', [0x85]], ['Cc C0', [0x1]], ['Cc DEL', [0x7f]],
  ['Cf ZWSP', [0x200b]], ['Cf BOM', [0xfeff]], ['Cf soft hyphen', [0xad]], ['Cf RLO', [0x202e]], ['Cf word joiner', [0x2060]], ['Cf tag', [0xe0041]], ['Cf ZWJ', [0x200d]],
  ['Co marker range', [0xe001]], ['Co astral', [0xf0000]],
  ['Cn unassigned', [0x378]], ['Cn non-character marker range', [0xfdd0]], ['Cn U+FFFF', [0xffff]],
  ['blank U+115F', [0x115f]], ['blank U+1160', [0x1160]], ['blank U+3164', [0x3164]], ['blank U+FFA0', [0xffa0]], ['blank U+2800', [0x2800]],
];

type Construct = [string, (esc: string) => string, References?];
const CONSTRUCTS: Construct[] = [
  ['bare URL', (e) => 'See https://e.example/?q=a' + e + 'b here\nsecond line words'],
  ['bare URL at the end of a list item', (e) => '- see https://e.example/a' + e + 'b\n  second line words'],
  ['autolink', (e) => 'See <https://e.example/?q=a' + e + 'b> here\nsecond line words'],
  ['autolink in a table cell', (e) => '| <https://e.example/a' + e + 'b> | c |\n|---|---|\n| d | words |'],
  ['link destination', (e) => 'See [x](https://e.example/a' + e + 'b) here\nsecond line words'],
  ['link destination with a title', (e) => 'See [x](https://e.example/a' + e + 'b "t") here\nsecond line words'],
  ['image source', (e) => 'See ![i](https://e.example/a' + e + 'b.png) here\nsecond line words'],
  ['image in a link', (e) => 'See [![i](https://e.example/i' + e + '.png)](https://e.example/a' + e + 'b) here\nsecond line words'],
  ['reference link (written inline)', () => 'See [x][r] here\nsecond line words'],
];

/** What a session writes after typing X after "words" (the URLs themselves untouched). */
function edit(ser: typeof pre5, src: string, refs: References = {}): string {
  const w = mount(src, refs);
  const tw = document.createTreeWalker(w, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); break; }
  const md = ser.serializeBlock(w, w.querySelector('table') ? BlockKind.Table : w.querySelector('ul') ? BlockKind.List : BlockKind.Prose, { ...ser.sourceStyleHints(src), editing: true });
  w.remove();
  return md;
}
const tree = { serializeBlock, sourceStyleHints } as unknown as typeof pre5;
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul') ? BlockKind.List : BlockKind.Prose);

describe('J19 extended: every general category in every URL construct (escaped in the source)', () => {
  let refused = 0;
  for (const [cn, cps] of TABLE) {
    for (const [kn, mk, refs0] of CONSTRUCTS) {
      it(`${kn}: ${cn} ${cps.map((c) => c.toString(16)).join('+')}`, () => {
        const e = cps[0] === 0x2f ? '/' + pct(C(...cps.slice(1))) : pct(C(...cps));   // a combining mark right after a raw slash
        const src = mk(e);
        const refs: References = kn.startsWith('reference') ? { R: { href: 'https://e.example/a' + e + 'b', title: '' } } : refs0 ?? {};
        const w = mount(src, refs);
        const before = urls(w);
        expect(before.length).toBeGreaterThan(0);
        const kind = kindOf(w);
        const base = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
        // the click's gates: a refusal writes nothing (K4) and is fine; it is counted below
        if (unsupportedReason(w, src) !== null || !baselineFaithful(w, kind, base)) { refused++; w.remove(); return; }
        expect(added(base, src), JSON.stringify(base)).toEqual([]);
        w.remove();
        const md = edit(tree, src, refs);
        expect(md, 'the edit is written').toContain('wordsX');
        expect(added(md, src), JSON.stringify(md)).toEqual([]);                 // (a)
        expect(urls(mount(md, refs)), JSON.stringify(md)).toEqual(before);     // (b)
      });
    }
  }
  it('no construct with an escape is refused at the click', () => expect(refused).toBe(0));
});

describe('J19 extended: the same characters RAW in the source (bare and destination forms that can hold them)', () => {
  // a raw character is allowed back only because the source held it; the href must stay the same
  for (const [cn, cps] of TABLE) {
    const ch = C(...cps);
    if (/[\s\p{Cc}]/u.test(ch)) continue;                     // a raw space / control ends a URL or a destination
    for (const [kn, mk] of CONSTRUCTS.filter(([k]) => k === 'link destination' || k === 'image source' || k === 'autolink')) {
      it(`${kn}: raw ${cn}`, () => {
        const src = mk(ch);
        const w = mount(src);
        const before = urls(w);
        const kind = kindOf(w);
        const base = serializeBlock(w, kind, { ...sourceStyleHints(src), editing: true });
        const gate = unsupportedReason(w, src) === null && baselineFaithful(w, kind, base);
        w.remove();
        if (!gate) return;
        const md = edit(tree, src);
        expect(added(md, src), JSON.stringify(md)).toEqual([]);
        expect(urls(mount(md)), JSON.stringify(md)).toEqual(before);
      });
    }
  }
});

describe('J19 extended: spellings', () => {
  it('an autolink is written in the source spelling: visible escapes, lower-case escapes, mixed case', () => {
    for (const u of ['https://e.example/%E4%B8%AD%E6%96%87', 'https://e.example/a%e2%80%8bb', 'https://e.example/a%E2%80%8bb%e4%B8%AD', 'https://e.example/%C3%A9%E2%80%AE']) {
      const src = 'See <' + u + '> here\nsecond line words';
      expect(edit(tree, src)).toBe(src.replace('words', 'wordsX'));
    }
  });
  it('a bare URL with lower-case escapes of invisible characters keeps them escaped (lower case)', () => {
    for (const u of ['https://e.example/a%e2%80%8bb', 'https://e.example/a%e2%80%aeb%c2%a0c']) {
      const src = 'See ' + u + ' here\nsecond line words';
      const w = mount(src);
      const before = urls(w);
      w.remove();
      const md = edit(tree, src);
      expect(added(md, src), md).toEqual([]);
      expect(urls(mount(md))).toEqual(before);
      expect(md).toBe(src.replace('words', 'wordsX'));
    }
  });
  it('a destination the source spells with a raw private-use character keeps it raw (J19 of round 4)', () => {
    const src = 'See [x](https://e.example/a' + C(0xe001) + 'b) here\nsecond line words';
    expect(edit(tree, src)).toBe(src.replace('words', 'wordsX'));
  });
  it('every URL the source writes keeps its own spelling: visible escapes, %20, raw characters (no K5 respelling of it)', () => {
    for (const e of [pct(C(0x4e2d, 0x6587)), pct(C(0xe9)), pct(C(0x1f600)), pct(C(0x2603)), '%20', C(0x4e2d), C(0xf0000), pct(C(0x4e2d)) + pct(C(0x200b))]) {
      for (const [kn, mk] of CONSTRUCTS.filter(([k]) => !k.startsWith('reference') && !k.includes('table'))) {
        const src = mk(e);
        expect(edit(tree, src), `${kn} ${e}`).toBe(src.replace('words', 'wordsX'));
      }
    }
  });
  /** What a session writes for a link whose href no URL of the block's source has (a link the DOM got otherwise). */
  function editForeign(href: string): string {
    const src = 'See [x](https://e.example/old) here\nsecond line words';
    const w = mount(src);
    w.querySelector('a')!.setAttribute('href', href);
    const tw = document.createTreeWalker(w, 4);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) (n as Text).data = (n as Text).data.replace('words', 'wordsX');
    const md = serializeBlock(w, BlockKind.Prose, { ...sourceStyleHints(src), editing: true });
    w.remove();
    return md;
  }
  it('a URL whose spelling is not known: a visible escape decoded as before (K5), an invisible one kept, %20 kept', () => {
    expect(editForeign('https://e.example/' + pct(C(0x4e2d)) + pct(C(0x200b)))).toBe('See [x](https://e.example/' + C(0x4e2d) + pct(C(0x200b)) + ') here\nsecond line wordsX');
    expect(editForeign('https://e.example/' + pct(C(0x4e2d)) + '%20b')).toBe('See [x](https://e.example/' + pct(C(0x4e2d)) + '%20b) here\nsecond line wordsX');
    for (const [, cps] of TABLE) {
      const e = pct(C(...cps));
      const md = editForeign('https://e.example/a' + e + 'b');
      expect(added(md, ''), md).toEqual([]);
      expect(urls(mount(md))).toEqual(['https://e.example/a' + e + 'b']);
    }
  });
});

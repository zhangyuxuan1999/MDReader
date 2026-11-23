// @vitest-environment jsdom
// test/r5-fc-escapes.test.ts — fix-clean (stage 2f, fix round 5): CA-1 and CA-2 of challenge-atoms, rules C1 and C2 of
// CONTRACT §11 "Checkpoint F, after the challenge". The session's own path: the worker's rendering of the block,
// stampAtoms + sourceStyleHints + stamped: true (what inlineEdit begin() does), one edit, serializeBlock(..., editing).
// C1: a source spelling is the literal text of the source, or it is nothing (an entity or a backslash escape in a
//     destination gives no spelling; the predicate then writes the href's percent-escape).
// C2: an href whose places in the block spell it differently gets no source spelling (the predicate decides each).
// The second line (urlText): no character rawInUrl rejects is written raw unless it is the literal, agreed source
// spelling — also for a link the source does not spell (a reference link defined elsewhere, a link whose href the DOM got
// otherwise). Every case: the hrefs after a re-render equal the hrefs before. Special characters are built from code
// points (no typed escapes).
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/r5-fc-escapes.test.ts
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';

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
const kindOf = (w: Element): BlockKind => (w.querySelector('table') ? BlockKind.Table : w.querySelector('ul,ol') ? BlockKind.List : w.querySelector('blockquote') ? BlockKind.Quote : w.querySelector('h1,h2,h3,h4,h5,h6') ? BlockKind.Heading : BlockKind.Prose);
const BLANK = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800];
const VISIBLE = /^[\p{L}\p{N}\p{P}\p{S}]$/u;
const staysEscaped = (c: string): boolean => c !== ' ' && c !== '\n' && (!VISIBLE.test(c) || BLANK.includes(c.codePointAt(0)!));
const rawCount = (s: string): number => Array.from(s).filter(staysEscaped).length;

/** What the session writes after `change` edits the DOM (default: X typed after "words"). */
function session(src: string, refs: References = {}, change?: (w: HTMLElement) => void, uncached = false): string {
  const w = mount(src, refs);
  const kind = kindOf(w);
  stampAtoms(w);
  const hints = { ...sourceStyleHints(src), stamped: true, editing: true, uncached };
  const base = serializeBlock(w, kind, hints);
  expect(unsupportedReason(w, src), 'the click is accepted').toBeNull();
  expect(baselineFaithful(w, kind, base), 'the fidelity gate accepts the block').toBe(true);
  if (change) change(w);
  else {
    const tw = document.createTreeWalker(w, 4);
    let typed = false;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) { (n as Text).data = (n as Text).data.replace('words', 'wordsX'); typed = true; break; }
    expect(typed).toBe(true);
  }
  const md = serializeBlock(w, kind, hints);
  w.remove();
  return md;
}
/** The session's write, with the two checks every case makes: the hrefs survive, no raw stay-escaped character is added. */
function check(src: string, refs: References = {}): string {
  const w = mount(src, refs);
  const before = urls(w);
  w.remove();
  const md = session(src, refs);
  expect(md).toContain('wordsX');
  expect(urls(mount(md, refs)), JSON.stringify(md)).toEqual(before);
  document.body.replaceChildren();
  expect(rawCount(md), JSON.stringify(md)).toBeLessThanOrEqual(rawCount(src));
  return md;
}

const Z = C(0x200b);
const ENTITIES: Array<[string, number]> = [['&#x200B;', 0x200b], ['&#8203;', 0x200b], ['&#x202E;', 0x202e], ['&#xFEFF;', 0xfeff], ['&shy;', 0xad], ['&nbsp;', 0xa0], ['&#x3000;', 0x3000], ['&#x2060;', 0x2060], ['&#xE000;', 0xe000], ['&#x3164;', 0x3164]];

describe('C1: an entity in a destination is not a source spelling (CA-1)', () => {
  const SHAPES: Array<[string, (u: string) => string]> = [
    ['destination', (u) => `See [x](${u}) here\nsecond line words`],
    ['destination with a title', (u) => `See [x](${u} "t") here\nsecond line words`],
    ['destination in <>', (u) => `See [x](<${u}>) here\nsecond line words`],
    ['image', (u) => `See ![i](${u}.png) here\nsecond line words`],
    ['quote', (u) => `> See [x](${u}) here\n> second line words`],
    ['list item', (u) => `- See [x](${u}) here\n- second line words`],
    ['table cell', (u) => `| [x](${u}) | c |\n|---|---|\n| d | words |`],
    ['heading', (u) => `# See [x](${u}) words`],
  ];
  for (const [ent, cp] of ENTITIES) {
    for (const [shape, mk] of SHAPES) {
      it(`${shape}: ${ent}`, () => {
        const md = check(mk('https://e.example/a' + ent + 'b'));
        expect(md.includes(C(cp)), JSON.stringify(md)).toBe(false);
        expect(md).toContain('https://e.example/a' + pct(C(cp)) + 'b');
      });
    }
  }
  it('the same href once raw (literal) and once as an entity: the entity is not written raw (tied to its place)', () => {
    for (const s of [`See [a](https://e.example/a${Z}b) and [b](https://e.example/a&#x200B;b) here\nsecond line words`,
      `See [b](https://e.example/a&#x200B;b) and [a](https://e.example/a${Z}b) here\nsecond line words`,
      `See https://e.example/a${Z}b and [b](https://e.example/a&#x200B;b) here\nsecond line words`,
      `See ![a](https://e.example/a${Z}b) and ![b](https://e.example/a&#x200B;b) here\nsecond line words`]) {
      const md = check(s);
      expect(rawCount(md), JSON.stringify(md)).toBe(0);
    }
  });
  it('a backslash escape in a destination is no source spelling either (the predicate writes it)', () => {
    const md = check('See [x](https://e.example/a\\_b' + pct(Z) + 'c) here\nsecond line words');
    expect(md).toContain('https://e.example/a_b' + pct(Z) + 'c');
  });
  it('a literal destination keeps its spelling byte for byte (raw, escaped, lower case, %20)', () => {
    for (const u of [`https://e.example/a${Z}b`, 'https://e.example/a%e2%80%8bb', 'https://e.example/a%E2%80%8Bb%20c', 'https://e.example/' + pct(C(0x4e2d))]) {
      const src = `See [x](${u}) and ![i](${u}) here\nsecond line words`;
      expect(session(src)).toBe(src.replace('words', 'wordsX'));
    }
  });
  it('an e-mail autolink keeps its mixed-case escapes (the mailto: markdown-it adds is not a reason to drop it)', () => {
    const src = 'See <a%e2%80%8Bb@e.example> here\nsecond line words';
    expect(session(src)).toBe(src.replace('words', 'wordsX'));
  });
});

describe('C2: an href whose places differ gets no source spelling (CA-2)', () => {
  const PAIRS: Array<[string, string, string]> = [];
  for (const cp of [0x200b, 0x202e, 0xfeff, 0x2060]) {
    const raw = 'https://e.example/a' + C(cp) + 'b', esc = 'https://e.example/a' + pct(C(cp)) + 'b';
    PAIRS.push([`dest ${cp.toString(16)}`, `[a](${raw})`, `[b](${esc})`]);
    PAIRS.push([`image ${cp.toString(16)}`, `![a](${raw})`, `![b](${esc})`]);
    PAIRS.push([`bare + autolink ${cp.toString(16)}`, `${raw}`, `<${esc}>`]);
    PAIRS.push([`dest + bare ${cp.toString(16)}`, `[a](${raw})`, `${esc}`]);
  }
  for (const [name, x, y] of PAIRS) {
    for (const order of ['raw first', 'escaped first']) {
      it(`${name}, ${order}`, () => {
        const [p, q] = order === 'raw first' ? [x, y] : [y, x];
        const md = check(`See ${p} and ${q} here\nsecond line words`);
        expect(rawCount(md), JSON.stringify(md)).toBe(0);   // the escape stays; the raw one may become its escape
      });
    }
  }
  it('two list items, raw then escaped', () => {
    const md = check(`- [a](https://e.example/a${Z}b)\n- [b](https://e.example/a${pct(Z)}b) words`);
    expect(rawCount(md)).toBe(0);
  });
  it('when every place agrees, the spelling is used for all of them', () => {
    const src = `See [a](https://e.example/a${Z}b) and [b](https://e.example/a${Z}b) and ![c](https://e.example/a${Z}b) here\nsecond line words`;
    expect(session(src)).toBe(src.replace('words', 'wordsX'));
  });
  it('a visible raw character and its escape: neither is respelled outside the edit beyond the predicate', () => {
    const src = 'See [a](https://e.example/' + C(0x4e2d) + ') and [b](https://e.example/' + pct(C(0x4e2d)) + ') here\nsecond line words';
    const md = check(src);
    expect(md).toBe('See [a](https://e.example/' + C(0x4e2d) + ') and [b](https://e.example/' + C(0x4e2d) + ') here\nsecond line wordsX');
  });
});

describe('the second line: a link the source does not spell never gets a raw invisible character', () => {
  it('a reference link defined in another block (escaped there) next to a raw literal of the same href', () => {
    const refs: References = { R: { href: 'https://e.example/a' + pct(Z) + 'b', title: '' } };
    const md = check(`See [a](https://e.example/a${Z}b) and [x][r] here\nsecond line words`, refs);
    expect(rawCount(md), JSON.stringify(md)).toBe(0);
  });
  it('a link split in two by the session (one more link with the href than the source has)', () => {
    const src = `See [ab](https://e.example/a${Z}b) here\nsecond line words`;
    const md = session(src, {}, (w) => {
      const a = w.querySelector('a')!;
      const b = a.cloneNode(false) as Element;
      b.textContent = 'b';
      a.textContent = 'a';
      a.after(' ', b);
      const tw = document.createTreeWalker(w, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) (n as Text).data = (n as Text).data.replace('words', 'wordsX');
    });
    expect(rawCount(md), JSON.stringify(md)).toBe(0);
    expect(md).toBe('See [a](https://e.example/a' + pct(Z) + 'b) [b](https://e.example/a' + pct(Z) + 'b) here\nsecond line wordsX');
  });
  it('a link whose href attribute holds the raw character (set by the DOM, not by the source)', () => {
    for (const cp of [0x200b, 0x202e, 0xa0, 0x3000, 0xad, 0xe000]) {
      const src = 'See [x](https://e.example/old) here\nsecond line words';
      const md = session(src, {}, (w) => {
        w.querySelector('a')!.setAttribute('href', 'https://e.example/a' + C(cp) + 'b');
        const tw = document.createTreeWalker(w, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) if ((n as Text).data.includes('words')) (n as Text).data = (n as Text).data.replace('words', 'wordsX');
      });
      expect(md.includes(C(cp)), JSON.stringify(md)).toBe(false);
      expect(urls(mount(md))).toEqual(['https://e.example/a' + pct(C(cp)) + 'b']);
      document.body.replaceChildren();
    }
  });
  it('the list cache gives what one pass gives (a raw spelling dropped for a second link in another item)', () => {
    const items = Array.from({ length: 10 }, (_, i) => `- item ${i} words`);
    items[2] = `- see [a](https://e.example/a${Z}b) words`;
    const src = items.join('\n');
    const addLink = (w: HTMLElement): void => {
      const li = w.querySelectorAll('li')[7];
      const a = w.querySelector('a')!.cloneNode(true) as Element;
      li.append(' ', a);
    };
    const fast = session(src, {}, addLink);
    const slow = session(src, {}, addLink, true);
    expect(fast).toBe(slow);
    expect(rawCount(fast), JSON.stringify(fast)).toBe(0);
    // and without the second link the raw spelling is the source's
    const plain = session(src, {}, () => undefined);
    expect(plain).toBe(src);
  });
});

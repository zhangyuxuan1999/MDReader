// test/r3-t-reserved-scan.test.ts — fix-trust (stage 2d, round 3): U15 (CONTRACT §11, H1) at unit level.
// rawHtmlReserved decides on the TEXT of a raw-HTML token: numeric references decoded as HTML decodes them,
// lower-cased, then the substring rules; plus a conservative "may end inside a tag" rule (mayEndInTag) for a token
// whose open tag would read the worker's following HTML and the document's following text as its attributes.
// R3T_OLD=1 ran the same cases against the round-2 scan (a snapshot taken before round 3): the bypass cases failed there.
// Since round 7 (CONTRACT §11 Checkpoint I) it runs them against the released 0.2.0 (test/fixtures/src-0.2.0), which has
// the repair: they pass there.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeHTML, decodeHTMLStrict } from 'entities';
import { DEFAULT_RENDER_OPTIONS, HTML_FLAG_RESERVED } from '../src/shared/types';
import * as current from '../src/worker/md';

const md: typeof current = process.env.R3T_OLD
  ? await import('./fixtures/src-0.2.0/worker/md') as unknown as typeof current
  : current;
const scan = (s: string): boolean => md.rawHtmlReserved(s);
const NUL = String.fromCharCode(0);
const FF = String.fromCharCode(12);
const CR = String.fromCharCode(13);
const EACUTE = String.fromCharCode(0xe9);

describe('U15 (c): the substring rules on decoded, lower-cased text', () => {
  const reserved = [
    'data-l', 'data-l=', 'data-l ', 'data-l>', 'data-l/', `data-l${NUL}`, `data-l${EACUTE}`, 'data-l"', "data-l'", 'data-l<',
    'data-lang', 'data-lang=x', 'xdata-l=1', 'DATA-L=1', 'Data-Lang', 'data-md', 'data-mdx', 'data-mdr-ui', 'data-md-block',
    'md-', 'MD-MATH', 'class="md-math"', ' mdr-x', '"md-', ';md-', '\tmd-', `${FF}md-`, `${CR}md-`, '.md-', ':md-', '=md-',
    // decoded numeric references (decimal / hex, x or X, with or without ;, leading zeros, before a letter)
    '&#109;d-math', '&#109d-math', '&#x6D;d-x', '&#X6d;d-x', '&#x4d;&#x44;&#x2d;', 'm&#100;-x', 'md&#45;x', 'data&#45;l=',
    'data-&#76;=1', 'data-&#108;', 'data-&#x6c', 'a&#32;md-x', 'a&#9md-x', 'a&#x9md-x', '&#0000109;d-', '&#100;ata-md',
    // named whitespace references end with `;`, a separator for the rule; so does every other named reference
    '&Tab;md-math', 'x&NewLine;md-block', '&lowbar;md-x', '&amp;md-x', '&nbsp;mdr-x',
    // anywhere in the text: a comment, RAWTEXT, CDATA, a value (false positives by design)
    '<!-- <b data-l="9"> -->', '<style>.md-math{}</style>', '<![CDATA[md-x]]>', '<b title="data-md">', 'a < b data-md',
  ];
  for (const s of reserved) it(`reserved: ${JSON.stringify(s)}`, () => expect(scan(s)).toBe(true));

  const plain = [
    'data-la', 'data-label', 'data-langs', 'data-l.x', 'data-l:x', 'data-l_x', 'data-l-x', 'data-l9', 'data-lang9',
    'xmd-math', '_md-', '-md-', '9md-', 'amdr-x', 'mdx-', 'md', 'mdr', 'data-', 'data-m', 'data-mx', 'class="note"',
    '&#x6dd-', '&#1090;d-', '&#109', 'data-&#109', 'Kmd-', `md${NUL}-math`,
  ];
  for (const s of plain) it(`not reserved: ${JSON.stringify(s)}`, () => expect(scan(s)).toBe(false));
});

describe('U15 (a): the named-reference claim, checked against the table markdown-it ships (node_modules/entities)', () => {
  it('only &Tab; &NewLine; &lowbar; &UnderBar; &fjlig; give a-z 0-9 _ - or ASCII whitespace, all with `;`', () => {
    // Every name of the WHATWG table (domino's copy lists them), decoded by the entities package itself.
    const src = readFileSync(new URL('../node_modules/@mixmark-io/domino/lib/HTMLParser.js', import.meta.url), 'utf8');
    const a = src.indexOf('var namedCharRefs = {');
    const table = Function('return ' + src.slice(a + 'var namedCharRefs = '.length, src.indexOf('};', a) + 1))() as Record<string, number | number[]>;
    const names = Object.keys(table);
    expect(names.length).toBe(2231);
    const bad = /[a-z0-9_\-\t\n\f\r ]/;
    const hits: string[] = [];
    const legacyValues = new Set<number>();
    for (const n of names) {
      if (n.endsWith(';')) {
        const v = decodeHTMLStrict('&' + n);
        const d = table[n];
        expect(v, n).toBe(Array.isArray(d) ? String.fromCodePoint(...d) : String.fromCodePoint(d));
        if (bad.test(v)) hits.push(n);
      } else {
        const v = decodeHTML('&' + n + ' ').slice(0, -1);   // a legacy name, decoded without `;`
        expect(v.length, n).toBe(1);
        legacyValues.add(v.codePointAt(0)!);
      }
    }
    expect(hits.sort()).toEqual(['NewLine;', 'Tab;', 'UnderBar;', 'fjlig;', 'lowbar;']);
    expect(names.filter((n) => !n.endsWith(';')).length).toBe(106);
    for (const c of legacyValues) expect(c === 0x22 || c === 0x26 || c === 0x3c || c === 0x3e || (c >= 0xa0 && c <= 0xff), c.toString(16)).toBe(true);
    for (const h of hits) expect(scan(`<b class="a&${h}md-x">`), h).toBe(true);
  });
});

describe('mayEndInTag: a raw-HTML token that may leave the tokenizer inside a tag', () => {
  const open = [
    "<div class='", '<div class="a', '<b', '<b ', '<b title=x', '</b x', "<b title='>'", '<b title=">" x', "<div>\n<b title='\n",
    "<p>it's <b title='x", '<b title="a=\'b\'"', "<pre title='</pre>\n", '<b x=1 y', `<b title=${CR}"x>`, '<B TITLE="X>" Y',
  ];
  for (const s of open) it(`counts as reserved: ${JSON.stringify(s)}`, () => expect(scan(s)).toBe(true));
  const closed = [
    '<b>', '<b title="x">', "<b title='x>'>", '<img src="a.png">', '<input class="task-list-item-checkbox" type="checkbox">',
    '<input class="task-list-item-checkbox" checked="" type="checkbox">', '<!-- a -->', '<div>\ntext\n</div>\n', '<p>a="b"</p>',
    'a < b', '<br/>', '</b>', '<a href="#x">', '<details>\n<summary>Click</summary>\n', '<p align="center">\n  <img src="x.png" width="80">\n</p>\n',
  ];
  for (const s of closed) it(`not reserved: ${JSON.stringify(s)}`, () => expect(scan(s)).toBe(false));

  it('is linear (no quadratic regex or quote search)', () => {
    const big = 200_000;
    for (const s of ['="'.repeat(big / 2), "='".repeat(big / 2), '=' + ' '.repeat(big), '<a'.repeat(big / 2), '="x"'.repeat(big / 4) + '>',
      'data-'.repeat(big / 5), 'md'.repeat(big / 2), '&#'.repeat(big / 2), '&#1'.repeat(big / 3), '="' + '>"'.repeat(big / 2)]) {
      const t0 = performance.now();
      scan(s);
      expect(performance.now() - t0, s.slice(0, 12)).toBeLessThan(250);
    }
  });
});

describe('through the worker (renderBlock)', () => {
  const mdk = md.createMarkdown(DEFAULT_RENDER_OPTIONS);
  const reservedBit = (src: string): boolean => (mdk.renderBlock(src, { references: {} }).flags & HTML_FLAG_RESERVED) !== 0;
  it('the H1 shapes are flagged; the worker\'s own task-list checkbox token and data-l are not the document', () => {
    for (const s of [
      '<style><!--</style><ul><li data-l="-4"><input type="checkbox"> I agree</li></ul>-->',
      'Read <style><![CDATA[</style x="a><b title="><span class="md-math"><code>X</code></span>"]]> this',
      'Read <span class="&Tab;md-math"><code>x</code></span> this',
      "<div>\n<b title='\n\n' data-l=7 x='a'\n\n</div>",
    ]) expect(reservedBit(s), s).toBe(true);
    for (const s of ['- [ ] todo\n- [x] done', '<div class="note">\nx\n</div>\n', 'a <kbd>Ctrl</kbd> b', '<p align="center"><img src="a.png"></p>\n', 'plain']) {
      expect(reservedBit(s), s).toBe(false);
    }
  });
});

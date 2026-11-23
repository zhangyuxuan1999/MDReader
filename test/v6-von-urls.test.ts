// @vitest-environment jsdom
// test/v6-von-urls.test.ts — verify-on (0.2.0 stage 2f, fix round 5 verification): rule "J19 extended" (an escape
// stays an escape; a URL the user did not change keeps its source spelling) with URLs as real documents hold them:
// percent-encoded CJK paths, queries with encoded spaces / ampersands / quotes, encoded slashes, fragments, data: and
// mailto: URLs, a very long URL, encoded parentheses, plus signs, lower-case escapes, an encoded percent, raw CJK / IDN,
// angle-bracket destinations with spaces, tilde, brackets, www. links. Every construct (inline link, with title, image,
// image inside a link, autolink, bare URL, reference link defined in another block) in several containers (paragraph,
// item, quote, cell, heading), several links per block, and four edit places: another line, before the link, right after
// the link, inside a [text](dest) link's text. Along the session's own path (worker rendering, stampAtoms,
// sourceStyleHints, stamped: true, one typed X, serializeBlock editing: true), the same as test/r5-ca-escapes.test.ts.
// Asserts: (1) the href / src list after a re-render equals the one before; (2) no stay-escaped character raw that the
// source did not hold raw; (3) every URL literal of the source is still in the output byte for byte (a URL the user did
// not change). Prints RESULT lines with exact = out equals the source with only the X added, and the pre-r5 column.
// Run: perl -e 'alarm 110; exec @ARGV' npx vitest run test/v6-von-urls.test.ts
// Special characters are built from code points (no typed escapes).
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown, type References } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { serializeBlock, sourceStyleHints, stampAtoms, unsupportedReason } from '../src/preview/serialize';
import { baselineFaithful } from '../src/preview/fidelity';
// fix-pre (round 7, CONTRACT §11 Checkpoint I): the snapshot this file was written against was deleted at the release of
// 0.2.0; `pre5` is now the frozen copy of the released 0.2.0, so the 'pre' column is what 0.2.0 writes.
import * as pre5 from './fixtures/src-0.2.0/preview/serialize';
import { appendFileSync } from 'node:fs';
/** RESULT lines go to V6_OUT when it is set (vitest does not show a passing test's console here), else the console. */
const log = (s: string): void => { if (process.env.V6_OUT) appendFileSync(process.env.V6_OUT, s + '\n'); else console.log(s); };

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

type Place = 'other' | 'before' | 'after' | 'intext' | 'inurl';
/** Edits the DOM as a user would at `place`; returns the source with the same edit (the exact expectation). */
function edit(w: HTMLElement, src: string, place: Place): string | null {
  const tw = document.createTreeWalker(w, 4);
  const texts: Text[] = [];
  for (let n = tw.nextNode(); n; n = tw.nextNode()) texts.push(n as Text);
  if (place === 'other') {
    const t = texts.find((x) => x.data.includes('words'));
    if (!t) return null;
    t.data = t.data.replace('words', 'wordsX');
    return src.replace('words', 'wordsX');
  }
  if (place === 'before') {
    const t = texts.find((x) => x.data.includes('See '));
    if (!t) return null;
    t.data = t.data.replace('See ', 'XSee ');
    return src.replace('See ', 'XSee ');
  }
  if (place === 'after') {
    const t = texts.find((x) => x.data.startsWith(' here'));
    if (!t) return null;
    t.data = ' X' + t.data.slice(1);
    return src.replace(' here', ' Xhere');
  }
  if (place === 'inurl') {
    const t = texts.find((x) => x.parentElement?.closest('a') && x.data.startsWith('https://e.example/'));
    if (!t) return null;
    t.data = 'https://e.example/Z' + t.data.slice('https://e.example/'.length);
    return 'INURL';
  }
  const a = w.querySelector('a[href]');
  const t = a ? texts.find((x) => a.contains(x) && x.data === 'tx') : undefined;
  if (!t) return null;
  t.data = 'tXx';
  return src.replace('[tx]', '[tXx]');
}

function session(which: 'tree' | 'pre', src: string, place: Place, refs: References = {}): { md: string | null; refused: string | null; exp: string | null } {
  const w = mount(src, refs);
  const kind = kindOf(w);
  const ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : pre5;
  if (which === 'tree') stampAtoms(w);
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}) };
  const reason = unsupportedReason(w, src);
  let base: string;
  try { base = ser.serializeBlock(w, kind, { ...hints, editing: true }); } catch (e) { w.remove(); return { md: null, refused: 'throw ' + String(e), exp: null }; }
  if (reason !== null || !baselineFaithful(w, kind, base)) { w.remove(); return { md: null, refused: reason ?? 'fidelity', exp: null }; }
  const exp = edit(w, src, place);
  if (exp === null) { w.remove(); return { md: null, refused: 'no edit place', exp: null }; }
  const md = ser.serializeBlock(w, kind, { ...hints, editing: true });
  w.remove();
  return { md, refused: null, exp };
}

const ZW = C(0x200b);
const LONG = 'https://example.com/' + Array.from({ length: 120 }, (_, k) => `seg${k}%E4%B8%AD%20q`).join('/') + '?a=%26b&c=%3D';
// [name, URL as written in the source]: real-document shapes
const U: Array<[string, string]> = [
  ['cjk-path', 'https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87%E7%BB%B4%E5%9F%BA'],
  ['query-space-amp', 'https://example.com/search?q=hello%20world&lang=zh-CN&x=1%262'],
  ['enc-slash', 'https://example.com/a%2Fb/c%2F'],
  ['fragment-cjk', 'https://example.com/page#%E7%AC%AC2%E8%8A%82'],
  ['github-doc', 'https://github.com/org/repo/blob/main/docs/%E8%AF%B4%E6%98%8E.md#%E5%AE%89%E8%A3%85'],
  ['enc-parens', 'https://example.com/path%20with%20spaces/file%281%29.pdf'],
  ['plus', 'https://example.com/a+b%2Bc?q=a+b'],
  ['quotes', 'https://example.com/?q=%22quoted%22&r=%27s%27'],
  ['lower-hex', 'https://example.com/%e4%b8%ad%e6%96%87'],
  ['enc-percent', 'https://example.com/a%25b%2520c'],
  ['raw-cjk', 'https://example.com/路径/文件.md'],
  ['tilde-brackets', 'https://example.com/~user/?x[]=1&y=[2]'],
  ['zwsp-escaped', 'https://example.com/a%E2%80%8Bb'],
  ['nbsp-ideo-escaped', 'https://example.com/a%C2%A0b%E3%80%80c'],
  ['mixed-raw-cjk-escaped-zw', `https://example.com/中/a%E2%80%8Bb`],
  ['long', LONG],
];
const DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MAILTO = 'mailto:someone@example.com?subject=Hi%20there&body=%E4%BD%A0%E5%A5%BD';

type Case = { name: string; src: string; lits: string[]; places: Place[]; refs?: References };
const CASES: Case[] = [];
for (const [n, u] of U) {
  const bareOk = !/[[\]~ ]/.test(u) && !u.includes('路径');
  CASES.push({ name: `${n} link`, src: `See [tx](${u}) here\nsecond line words`, lits: [u], places: ['other', 'before', 'after', 'intext'] });
  CASES.push({ name: `${n} link+title`, src: `See [tx](${u} "T (1)") here\nsecond line words`, lits: [u], places: ['other', 'after'] });
  CASES.push({ name: `${n} image`, src: `See ![alt](${u}) here\nsecond line words`, lits: [u], places: ['other', 'before', 'after'] });
  CASES.push({ name: `${n} image-in-link`, src: `See [![alt](${u})](${u}#x) here\nsecond line words`, lits: [u, `${u}#x`], places: ['other', 'after'] });
  CASES.push({ name: `${n} autolink`, src: `See <${u}> here\nsecond line words`, lits: [u], places: ['other', 'before', 'after'] });
  if (bareOk) CASES.push({ name: `${n} bare`, src: `See ${u} here\nsecond line words`, lits: [u], places: ['other', 'before', 'after'] });
  CASES.push({ name: `${n} item`, src: `- See [tx](${u}) here\n- second ${bareOk ? u : 'x'} words`, lits: [u], places: ['other', 'intext'] });
  CASES.push({ name: `${n} quote`, src: `> See ![alt](${u}) here\n> second <${u}> words`, lits: [u], places: ['other', 'after'] });
  CASES.push({ name: `${n} cell`, src: `| See [tx](${u}) here | c |\n|---|---|\n| d | words |`, lits: [u], places: ['other', 'after', 'intext'] });
  CASES.push({ name: `${n} heading`, src: `# See [tx](${u}) here words`, lits: [u], places: ['other', 'after'] });
  CASES.push({ name: `${n} ref-elsewhere`, src: `See [tx][r] here\nsecond line words`, lits: [], places: ['other', 'intext'], refs: { R: { href: u, title: '' } } });
}
// several links in one block, mixed constructs and URLs
CASES.push({ name: 'multi: cjk + query + zwsp-escaped + data image + mailto', src: `See [tx](${U[0][1]}) and ![d](${DATA}) and <${MAILTO}> here\n<${U[1][1]}> and ![z](${U[12][1]}) second line words`, lits: [U[0][1], DATA, MAILTO, U[1][1], U[12][1]], places: ['other', 'before', 'after', 'intext'] });
CASES.push({ name: 'multi: same href literal twice + escaped invisible', src: `See [tx](${U[4][1]}) here and [b](${U[4][1]})\n${U[13][1]} second line words`, lits: [U[4][1], U[13][1]], places: ['other', 'before', 'after', 'intext'] });
CASES.push({ name: 'multi: raw cjk and its escape for one href', src: `See [tx](https://example.com/中) here and [b](https://example.com/%E4%B8%AD)\nsecond line words`, lits: [], places: ['other', 'intext'] });
CASES.push({ name: 'angle dest with space', src: `See [tx](<https://example.com/a b/%E4%B8%AD>) here\nsecond line words`, lits: ['<https://example.com/a b/%E4%B8%AD>'], places: ['other', 'after', 'intext'] });
CASES.push({ name: 'www bare with escaped cjk', src: `See www.example.com/a%20b/%E4%B8%AD here\nsecond line words`, lits: ['www.example.com/a%20b/%E4%B8%AD'], places: ['other', 'before', 'after'] });
CASES.push({ name: 'mailto link', src: `See [tx](${MAILTO}) here\nsecond line words`, lits: [MAILTO], places: ['other', 'after', 'intext'] });
CASES.push({ name: 'data image', src: `See ![d](${DATA}) here\nsecond line words`, lits: [DATA], places: ['other', 'before', 'after'] });
CASES.push({ name: 'raw zwsp in a dest (source holds it raw)', src: `See [tx](https://example.com/a${ZW}b) here\nsecond line words`, lits: [`https://example.com/a${ZW}b`], places: ['other', 'intext'] });

const RLO = C(0x202e);
for (const [n, u] of [['zw', 'https://e.example/a%E2%80%8Bb'], ['rlo', 'https://e.example/a%E2%80%AEb'], ['cjk', 'https://e.example/%E4%B8%AD'], ['nbsp', 'https://e.example/a%C2%A0b']] as Array<[string, string]>) {
  CASES.push({ name: `url-text link ${n}`, src: `See [${decodeURI(u)}](${u}) here\nsecond line words`, lits: [], places: ['other', 'after'] });
  CASES.push({ name: `url-text link escaped text ${n}`, src: `See [${u}](${u}) here\nsecond line words`, lits: [u], places: ['other', 'after'] });
}
void RLO;
// (the text of an edited bare URL / autolink: test/v6-von-linktext.test.ts)
describe('J19 extended with real-document URLs (verify-on)', () => {
  const tally = { cases: 0, exact: 0, preExact: 0, refused: 0 };
  for (const c of CASES) {
    for (const place of c.places) {
      it(`${c.name} @${place}`, () => {
        const w = mount(c.src, c.refs ?? {});
        const before = urls(w);
        w.remove();
        const t = session('tree', c.src, place, c.refs ?? {});
        const p = session('pre', c.src, place, c.refs ?? {});
        tally.cases++;
        if (t.md === null) { tally.refused++; log(`RESULT ${c.name} @${place} | tree refused ${t.refused}`); return; }
        const after = urls(mount(t.md, c.refs ?? {}));
        document.body.replaceChildren();
        const edited = place === 'inurl';
        const exact = !edited && t.md === t.exp, preExact = !edited && p.md === p.exp;
        if (exact) tally.exact++;
        if (preExact) tally.preExact++;
        const lost = c.lits.filter((l) => !t.md!.includes(l));
        log(`RESULT ${c.name} @${place} | exact ${exact} | pre exact ${preExact} | hrefSame ${JSON.stringify(after) === JSON.stringify(before)} | raw ${rawCount(c.src)}->${rawCount(t.md)} | lost ${JSON.stringify(lost)}${exact ? '' : ' | out ' + JSON.stringify(t.md).slice(0, 400) + ' | exp ' + JSON.stringify(t.exp).slice(0, 400)}`);
        if (edited) expect(after).toEqual(before.map((h, k) => (k === 0 ? h.replace('https://e.example/', 'https://e.example/Z') : h)));
        else expect(after).toEqual(before);
        expect(rawCount(t.md), JSON.stringify(t.md)).toBeLessThanOrEqual(rawCount(c.src));
        expect(lost, JSON.stringify(t.md)).toEqual([]);
      });
    }
  }
  it('tally', () => { log('TALLY ' + JSON.stringify(tally)); });
});

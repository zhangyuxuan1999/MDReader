// @vitest-environment jsdom
// test/v6-vr-diff.test.ts — verify-review (stage 2f, after fix round 5): unit-level differential of what a session writes,
// the tree's serialize.ts (stampAtoms + stamped, as inlineEdit begin() does) against the serializer before round 5 (since round 7, CONTRACT §11
// Checkpoint I, that snapshot is gone and the comparison is the frozen copy of the released 0.2.0, test/fixtures/src-0.2.0; as
// pre-r5's begin() did), over generated blocks of every container (paragraph, tight / loose / ordered / task / nested
// list, quote with two paragraphs, heading, table cell) holding every inline atom (formulas, images, links in every URL
// spelling, autolinks, bare URLs, e-mail and www links, reference links, raw HTML with and without presentation, code,
// emphasis, entities, escapes, hard breaks). Both sides prepare the DOM as begin() does (data-mdr-o on span / font /
// [style], contenteditable=false on formulas, the baseline and the fidelity gate).
// Edits per block: A a typed character after a word; B the last character of the last text deleted; C a join of the
// first two line containers (list items, quote paragraphs) done by MOVING the nodes, or, where there is none, a word
// typed at the start; R the same join with the moved nodes RE-CREATED from markup the way Chromium does it (KaTeX's
// <annotation> gone, a style attribute respelled, baked styles on the moved text and images).
// Classes (tree vs pre on A, B, C): same · url (equal once %XX are decoded: J19 extended / C1 / C2 / K5 spelling) ·
// task-own-box (C on a task list: the first item's own box decides, P-G d) · other (a finding unless explained).
// Tree-only invariants: R writes exactly what C writes (P-G a, c, d: atoms survive the browser); after a re-render the
// hrefs / srcs equal the block's before the edit (A, B); no raw stay-escaped character the source did not hold raw.
// Run: V6VR_N=900 V6VR_SEED=1 V6VR_OUT=<file> perl -e 'alarm 115; exec @ARGV' npx vitest run test/v6-vr-diff.test.ts
// (default N=150, about 6 s; verify-review ran seeds 1 to 6 at N=900: 5400 blocks, 19 478 cases, 0 BAD)
// Special characters are built from code points (no typed escapes).
import { writeFileSync } from 'node:fs';
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
const REFS: References = { R: { href: 'https://r.example/a%E2%80%8Bb', title: '' }, V: { href: 'https://r.example/%E4%B8%AD', title: '' } };

function mount(src: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(mdk.renderBlock(src, { references: { ...REFS } }).html));
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
const decodeAll = (s: string): string => s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
/** `[t](u)` whose text is its URL (once %XX are decoded) as `<u>`: the source's `<url>` kept where pre-r5 wrote a link. */
const formNorm = (s: string): string => s.replace(/\[([^\]\n]*)\]\(([^()\s]*)\)/g, (m, t: string, u: string) => (decodeAll(t) === decodeAll(u) ? u : m)).replace(/<(https?:[^<>\s]*|[^<>\s@]+@[^<>\s]+)>/g, '$1');
const show = (s: string | null): string => (s === null ? 'null' : JSON.stringify(s.replace(/[^\x20-\x7e\n]/g, (c) => '<' + c.codePointAt(0)!.toString(16) + '>')));

let seed = Number(process.env.V6VR_SEED ?? 1);
const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

const INVIS = [0x200b, 0xfeff, 0xa0, 0x202e, 0x3000, 0xad, 0x2060, 0xe000, 0x301, 0x3164, 0x2800, 0x1d159, 0xfe0f];
const VIS = [0x4e2d, 0xe9, 0x2603, 0x1f600, 0x20ac, 0x5f, 0x2a];
function piece(): string {
  const k = pick(['escInvis', 'escVis', 'rawVis', 'rawInvis', 'entInvis', 'entVis', 'bs', 'sp', 'plain', 'plain'] as const);
  const c = C(k.endsWith('Invis') ? pick(INVIS) : pick(VIS));
  switch (k) {
    case 'escInvis': case 'escVis': { const e = encodeURIComponent(c); return rnd() < 0.3 ? e.toLowerCase() : e; }
    case 'rawInvis': return c === C(0xa0) || c === C(0x3000) || c === C(0xfeff) ? C(0x200b) : c;
    case 'rawVis': return c === '_' || c === '*' ? 'q' : c;
    case 'entInvis': case 'entVis': return '&#x' + c.codePointAt(0)!.toString(16) + ';';
    case 'bs': return '\\_';
    case 'sp': return '%20';
    default: return 'p';
  }
}
const url = (): string => 'https://e.example/' + pick(['a', 'path/', '?q=', '#f', '']) + piece() + 'z' + (rnd() < 0.4 ? piece() + 'y' : '');
const bareUrl = (): string => url().replace(/&#x[0-9a-f]+;|\\_/g, 'k');
function atom(): string {
  const r = rnd();
  if (r < 0.08) return `[l](${url()})`;
  if (r < 0.11) return `[l](${url()} "t")`;
  if (r < 0.14) return `![i](${url()}.png)`;
  if (r < 0.17) return `<${bareUrl()}>`;
  if (r < 0.2) return `${bareUrl()} `;
  return pick([
    '$x$', '$x^2$', '$\\frac{a}{b}$', '$\\sqrt{2}+y$', '$$E=mc^2$$', '$a_1$', '$\\alpha$',
    '![alt](i.png)', '![alt](i.png "tt")', '![](e.png)',
    '[w](https://w.example/p)', '[t](https://w.example/q "ti")', '<https://w.example/auto>', 'https://w.example/bare ',
    'a@b.example', '<c@d.example>', 'www.example.com/p ', '[r][R]', '[v][V]',
    '<kbd>K</kbd>', '<sup>2</sup>', '<span style="color:red">red</span>', '<b style="color:blue">bb</b>',
    '<font color="green">ff</font>', '<img src="x.png" width="20">', '<a href="https://w.example/raw">raw</a>',
    '<span class="x">cs</span>', '<span style="background-color:yellow;font-weight:bold">hy</span>',
    '`co|de`', '`a`', '**bold**', '*em*', '~~del~~', '***be***', '_u_',
    '&amp;', '&copy;', '&lt;x&gt;', '\\*', '\\_', '中文', 'word', 'alpha', 'beta gamma',
  ]);
}
function body(): string {
  const n = 1 + Math.floor(rnd() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(atom());
  return 'Lead ' + parts.join(pick([' and ', ' ', ', '])) + ' words';
}
const SHAPES = ['p', 'p', 'li', 'li', 'task', 'task', 'loose', 'quote', 'quote', 'nested', 'ol', 'h', 'cell', 'hardbr'] as const;
function block(): { src: string; shape: string } {
  const shape = pick(SHAPES);
  const a = body(), b = body();
  const src = shape === 'p' ? `See ${a}\nsecond line ${b}`
    : shape === 'li' ? `- one ${a}\n- two ${b}\n- three words`
    : shape === 'task' ? `- ${pick(['[ ]', '[x]'])} one ${a}\n- ${pick(['[ ]', '[x]'])} two ${b}\n- [ ] three words`
    : shape === 'loose' ? `- one ${a}\n\n- two ${b}`
    : shape === 'quote' ? `> one ${a}\n>\n> two ${b}`
    : shape === 'nested' ? `- one ${a}\n  - nested ${b}\n- three words`
    : shape === 'ol' ? `1. one ${a}\n2. two ${b}`
    : shape === 'h' ? `## Head ${a}`
    : shape === 'cell' ? `| ${a.replace(/\|/g, '\\|')} | c |\n|:--|--:|\n| d | words |`
    : `- one ${a}  \n  more ${b}\n- two words`;
  return { src, shape };
}

/** begin()'s preparation of the wrapper (both sides alike; the tree also stamps). */
function prepare(w: HTMLElement, tree: boolean): void {
  for (const e of Array.from(w.querySelectorAll('span, font, [style]'))) e.setAttribute('data-mdr-o', '');
  for (const m of Array.from(w.querySelectorAll<HTMLElement>('.md-math'))) m.setAttribute('contenteditable', 'false');
  if (tree) stampAtoms(w);
}
function textsOf(w: Element): Text[] {
  const out: Text[] = [];
  const tw = document.createTreeWalker(w, 4, { acceptNode: (n) => ((n.parentElement?.closest('.md-math, a, code, kbd, sup, span, font, b')) ? 2 : 1) });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/\S/.test((n as Text).data)) out.push(n as Text);
  return out;
}
const BLOCKS = new Set(['UL', 'OL', 'P', 'PRE', 'BLOCKQUOTE', 'DIV', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
/** The first two line containers of the block: [target line, moved nodes' parent, element removed afterwards]. */
function joinPair(w: Element): { target: Element; from: Element; drop: Element } | null {
  const list = w.querySelector('ul, ol');
  if (list) {
    const [li1, li2] = [list.children[0], list.children[1]];
    if (!li1 || !li2 || li1.tagName !== 'LI' || li2.tagName !== 'LI') return null;
    if (li1.querySelector('ul, ol, pre, blockquote') || li2.querySelector('ul, ol, pre, blockquote')) return null;
    const ps1 = Array.from(li1.children).filter((e) => e.tagName === 'P');
    const ps2 = Array.from(li2.children).filter((e) => e.tagName === 'P');
    if (ps2.length > 1) return null;
    const target = ps1.length ? ps1[ps1.length - 1] : li1;
    const from = ps2.length ? ps2[0] : li2;
    if (!ps2.length && Array.from(li2.children).some((e) => BLOCKS.has(e.tagName))) return null;
    return { target, from, drop: li2 };
  }
  const bq = w.querySelector('blockquote');
  if (bq) {
    const ps = Array.from(bq.children).filter((e) => e.tagName === 'P');
    if (ps.length >= 2) return { target: ps[0], from: ps[1], drop: ps[1] };
  }
  return null;
}
/** Chromium's MoveParagraph as measured (bench/verify/r5-fa-recreate.mjs): the moved nodes are serialized and parsed
 *  again (every attribute survives, KaTeX's annotation does not, a document style is respelled), with style spans
 *  baked around moved text and a baked style on an image. */
function recreate(n: Node, k: number): Node[] {
  if (n.nodeType === 3) {
    const t = n as Text;
    if (k % 2 === 0 || !/\S/.test(t.data)) return [document.createTextNode(t.data)];
    const s = document.createElement('span');
    s.setAttribute('style', 'background-color: rgba(0, 0, 0, 0.04);');
    s.textContent = t.data;
    return [s];
  }
  if (n.nodeType !== 1) return [n.cloneNode(true)];
  const tpl = document.createElement('template');
  tpl.innerHTML = (n as Element).outerHTML;
  const out = Array.from(tpl.content.childNodes);
  for (const r of out) {
    if (r.nodeType !== 1) continue;
    const e = r as Element;
    for (const a of Array.from(e.querySelectorAll('annotation'))) a.remove();
    for (const x of [e, ...Array.from(e.querySelectorAll('[style]'))]) {
      const st = x.getAttribute('style');
      if (st !== null && !x.closest('.katex')) x.setAttribute('style', st.split(';').filter((p) => p.trim() !== '').map((p) => p.replace(/\s*:\s*/, ': ').trim() + ';').join(' ') + ' font-size: 16px;');
    }
    for (const img of [e, ...Array.from(e.querySelectorAll('img'))]) if (img.tagName === 'IMG') img.setAttribute('style', 'background-color: rgba(0, 0, 0, 0.04);');
  }
  return out;
}

type Ser = { serializeBlock: typeof serializeBlock; sourceStyleHints: typeof sourceStyleHints };
type Edit = 'A' | 'B' | 'C' | 'R';
interface Out { md: string | null; refused: boolean; before: string[]; joined: boolean; boxes: boolean[]; base?: string | null }
function run(which: 'tree' | 'pre', src: string, edit: Edit): Out {
  const w = mount(src);
  const before = urls(w);
  const kind = kindOf(w);
  const ser: Ser = which === 'tree' ? { serializeBlock, sourceStyleHints } : (pre5 as unknown as Ser);
  const boxes = Array.from(w.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).map((b) => b.checked);
  if (unsupportedReason(w, src) !== null) { w.remove(); return { md: null, refused: true, before, joined: false, boxes }; }
  prepare(w, which === 'tree');
  const hints = { ...ser.sourceStyleHints(src), ...(which === 'tree' ? { stamped: true } : {}) };
  try {
    const base = ser.serializeBlock(w, kind, { ...hints, editing: true });
    if (!baselineFaithful(w, kind, base)) { w.remove(); return { md: null, refused: true, before, joined: false, boxes, base }; }
  } catch { w.remove(); return { md: null, refused: true, before, joined: false, boxes, base: null }; }
  let joined = false;
  const texts = textsOf(w);
  if (edit === 'A') { const t = texts.find((x) => /[a-z]/.test(x.data)); if (t) t.data = t.data.replace(/([a-z])(?![\s\S]*[a-z])/, '$1X'); }
  else if (edit === 'B') { const t = [...texts].reverse().find((x) => x.data.trim().length > 1); if (t) t.data = t.data.replace(/\S(\s*)$/, '$1'); }
  else {
    const pair = joinPair(w);
    if (!pair) { const t = texts[0]; if (t) t.data = 'Yy ' + t.data; }
    else {
      joined = true;
      // a trailing newline text node of the target line goes, as the browser's join leaves none
      const last = pair.target.lastChild;
      if (last && last.nodeType === 3 && /^\s*$/.test((last as Text).data)) last.remove();
      const moved = Array.from(pair.from.childNodes);
      let k = 0;
      for (const n of moved) {
        if (n.nodeType === 3 && /^\n+$/.test((n as Text).data)) { n.remove(); continue; }
        if (edit === 'R') { for (const r of recreate(n, k++)) pair.target.appendChild(r); n.remove(); }
        else pair.target.appendChild(n);
      }
      pair.drop.remove();
    }
  }
  let md: string | null = null;
  try { md = ser.serializeBlock(w, kind, { ...hints, editing: true }); } catch (e) { md = null; if (process.env.V6VR_DEBUG) console.log('throw', which, edit, String(e)); }
  w.remove();
  return { md, refused: false, before, joined, boxes };
}

describe('session write differential (verify-review): tree vs pre-r5, and re-created joins', () => {
  it('classifies every difference', () => {
    const N = Number(process.env.V6VR_N ?? 150);
    const cls: Record<string, number> = {};
    const ex: Record<string, string[]> = {};
    const all: string[] = [];
    const add = (k: string, e: string): void => {
      cls[k] = (cls[k] ?? 0) + 1;
      if ((ex[k] ??= []).length < 10 && e) ex[k].push(e);
      if (e && (k.startsWith('other') || k.startsWith('BAD') || k.startsWith('refusal-differs') || k.startsWith('throw'))) all.push(`[${k}] ${e}`);
    };
    let cases = 0;
    const shapes: Record<string, number> = {};
    for (let i = 0; i < N; i++) {
      const { src, shape } = block();
      shapes[shape] = (shapes[shape] ?? 0) + 1;
      let treeC: Out | null = null;
      for (const e of ['A', 'B', 'C'] as const) {
        cases++;
        const t = run('tree', src, e);
        const p = run('pre', src, e);
        document.body.replaceChildren();
        if (e === 'C') treeC = t;
        if (t.refused || p.refused) { add(t.refused === p.refused ? 'refused-both' : `refusal-differs:tree=${t.refused}`, `${e} src=${show(src)} treeBase=${show(t.base ?? null)} preBase=${show(p.base ?? null)}`); continue; }
        const line = `${e} src=${show(src)}\n      tree=${show(t.md)}\n      pre =${show(p.md)}`;
        if (t.md === null || p.md === null) { add(t.md === p.md ? 'both-threw' : `throw-differs:tree=${t.md === null}`, line); continue; }
        if (e !== 'C') {
          const after = urls(mount(t.md));
          document.body.replaceChildren();
          if (JSON.stringify(after) !== JSON.stringify(t.before)) add('BAD-href-changed', line);
        }
        if (rawCount(t.md) > rawCount(src)) add('BAD-raw-added', line);
        if (t.md === p.md) { add(`same:${e}`, ''); continue; }
        if (decodeAll(t.md) === decodeAll(p.md)) { add(`url:${e}`, line); continue; }
        if (decodeAll(formNorm(t.md)) === decodeAll(formNorm(p.md))) { add(`url-form:${e}`, line); continue; }
        if (e === 'C' && t.joined && shape === 'task') {
          // P-G (d): the first item's own box decides, the text after the moved box keeps its space
          const mark = t.boxes[0] ? '- [x] ' : '- [ ] ';
          const ok = t.md.startsWith(mark) && !/\[[x ]\]\S/.test(t.md.split('\n')[0].slice(6));
          add(ok ? 'task-own-box:C' : 'other:task', line);
          continue;
        }
        add(`other:${e}`, line);
      }
      // R: the same join with re-created nodes writes what C writes (tree)
      if (treeC && treeC.joined && !treeC.refused && treeC.md !== null) {
        cases++;
        const r = run('tree', src, 'R');
        const pr = run('pre', src, 'R');
        document.body.replaceChildren();
        const line = `R src=${show(src)}\n      treeR=${show(r.md)}\n      treeC=${show(treeC.md)}\n      preR =${show(pr.md)}`;
        if (r.md === treeC.md) add(pr.md === r.md ? 'R-equal-C:pre-too' : 'R-equal-C:pre-differs', pr.md === r.md ? '' : line);
        else add(r.md === null ? 'BAD-R-threw' : 'BAD-R-differs', line);
      }
    }
    const fmt = (o: Record<string, string[]>): string => Object.entries(o).filter(([, v]) => v.length).map(([k, v]) => `  [${k}]\n` + v.map((x) => '    ' + x).join('\n')).join('\n');
    const res = `RESULT seed=${process.env.V6VR_SEED ?? 1} blocks=${N} cases=${cases} shapes=${JSON.stringify(shapes)} classes=${JSON.stringify(cls)}\nEXAMPLES\n${fmt(ex)}\n`;
    console.log(res.slice(0, 6000));
    if (process.env.V6VR_OUT) writeFileSync(process.env.V6VR_OUT, res + 'ALL\n' + all.join('\n') + '\n');
    // the tree's invariants: hrefs unchanged, no raw stay-escaped character added, a re-created join writes what the
    // clean one writes (every other class is printed for reading)
    expect(Object.keys(cls).filter((k) => k.startsWith('BAD')), all.filter((x) => x.startsWith('[BAD')).slice(0, 3).join('\n')).toEqual([]);
  }, 105_000);
});

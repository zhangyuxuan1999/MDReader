// @vitest-environment jsdom
// verify-fidelity (0.2.0 stage 2a): an independent property test of src/preview/serialize.ts.
// Structured random documents → render → mount like the preview → random DOM edits of the kind a
// browser makes (typed risky characters, NBSPs at node edges, deleted ranges) → serializeBlock with the
// hints an edit session passes → render again → the visible result (tags, hrefs, text with NBSP as
// space) must equal the edited DOM. I4: for list blocks the cached serialization must equal the
// uncached one after every edit of a sequence on the same live element.
// MDR_FID_N (default 1500) documents, MDR_FID_SEED (default 7). MDR_FID_VERBOSE=1 prints examples.
import { beforeAll, describe, expect, it } from 'vitest';
import { BlockKind, DEFAULT_RENDER_OPTIONS } from '../src/shared/types';
import { createMarkdown, type Markdown } from '../src/worker/md';
import { loadMath } from '../src/worker/math';
import { segmentAll } from '../src/worker/segmenter';
import { sanitizeToFragment } from '../src/preview/sanitize';
import { wrapCodeFences } from '../src/preview/createPreview';
import { normalizeHtml, serializeBlock, sourceStyleHints, unsupportedReason } from '../src/preview/serialize';

const N = Number(process.env.MDR_FID_N ?? 500);
const SEED = Number(process.env.MDR_FID_SEED ?? 7);
const VERBOSE = process.env.MDR_FID_VERBOSE === '1';

let mdk: Markdown;
beforeAll(async () => {
  expect(await loadMath()).toBe(true);
  mdk = createMarkdown(DEFAULT_RENDER_OPTIONS);
  mdk.enableMath();
});
const render = (src: string): string => mdk.renderBlock(src, { references: {} }).html;
function mountHtml(html: string): HTMLElement {
  const w = document.createElement('section');
  w.className = 'md-block';
  w.replaceChildren(sanitizeToFragment(html));
  wrapCodeFences(w);
  for (const e of Array.from(w.querySelectorAll('span, font'))) e.setAttribute('data-mdr-o', '');
  return w;
}
const kindOf = (src: string): BlockKind => { const s = segmentAll(src.split('\n')); return s.length ? s[0].kind : BlockKind.Prose; };

function rng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Visible form: element skeleton, href/src/start/checked, text with NBSP → space, spaces collapsed.
 *  Links linkify created from plain text (absent from `ref`) are unwrapped (typing an URL-like text is not
 *  this test's subject). */
function visible(el: Element, refHrefs?: Set<string>): string {
  const c = el.cloneNode(true) as Element;
  if (refHrefs) for (const a of Array.from(c.querySelectorAll('a'))) {
    const h = a.getAttribute('href') ?? '';
    if (!refHrefs.has(h) && (h.startsWith('http://') || h.startsWith('mailto:'))) a.replaceWith(...Array.from(a.childNodes));
  }
  for (const e of Array.from(c.querySelectorAll('input'))) e.setAttribute('checked', String((e as HTMLInputElement).checked));
  for (const m of Array.from(c.querySelectorAll('.md-math'))) { const ann = m.querySelector('annotation'); m.replaceWith(c.ownerDocument.createTextNode('[math:' + (ann?.textContent ?? m.textContent) + ']')); }
  // whitespace at the inside edge of an inline element renders like whitespace just outside it
  for (const e of Array.from(c.querySelectorAll('strong, em, s, del, a, kbd'))) {
    const f = e.firstChild, l = e.lastChild;
    if (f && f.nodeType === 3 && /^[ \u00a0]/.test((f as Text).data)) { (f as Text).data = (f as Text).data.replace(/^[ \u00a0]+/, ''); e.before(' '); }
    if (l && l.nodeType === 3 && /[ \u00a0]$/.test((l as Text).data)) { (l as Text).data = (l as Text).data.replace(/[ \u00a0]+$/, ''); e.after(' '); }
  }
  for (const e of Array.from(c.querySelectorAll('*'))) for (const a of Array.from(e.attributes)) {
    if (!['href', 'src', 'start', 'type', 'checked'].includes(a.name)) e.removeAttribute(a.name);
  }
  // KaTeX output: compare by its annotation only
  return normalizeHtml(c.innerHTML.replace(/\u00a0|&nbsp;/g, ' ')).replace(/ +/g, ' ').replace(/ <\/(p|li|h\d|td|th)>/g, '</$1>').replace(/<(p|li|h\d|td|th)> /g, '<$1>')
    .replace(/<br><\/br> /g, '<br></br>').replace(/ <br><\/br>/g, '<br></br>').replace(/<(\/?)del>/g, '<$1s>').replace(/(<input [^>]*><\/input>) ?/g, '$1 ');
}
const hrefs = (el: Element): Set<string> => new Set(Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? ''));

// ---------------------------------------------------------------- generator
const WORDS = ['alpha', 'beta', '中文', '编辑器', '测试一下', 'émoji😀', 'e\u0301clair', 'שלום', 'مرحبا', 'x', '42', 'snake_case', 'C:\\dir', 'a * b', '5 $ each', 'café'];
function inline(r: () => number, depth = 0, allowBreak = true): string {
  const parts: string[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const k = r();
    const w = WORDS[Math.floor(r() * WORDS.length)];
    if (k < 0.35 || depth > 1) parts.push(w);
    else if (k < 0.45) parts.push(`*${w}*`);
    else if (k < 0.53) parts.push(`**${w}**`);
    else if (k < 0.6) parts.push('`' + w + '`');
    else if (k < 0.67) parts.push(`[${w}](https://e.example/p${i})`);
    else if (k < 0.71) parts.push(`<https://e.example/q${i}>`);
    else if (k < 0.75) parts.push('$x^' + i + '$');
    else if (k < 0.79) parts.push(`~~${w}~~`);
    else if (k < 0.82) parts.push(`<kbd>K${i}</kbd>`);
    else if (k < 0.85) parts.push('&amp;');
    else if (k < 0.88) parts.push(`**a ${inline(r, depth + 1, false)}**`);
    else if (k < 0.91) parts.push('\\*lit\\*');
    else if (k < 0.94) parts.push('&nbsp;');
    else parts.push(w + '。');
  }
  let s = parts.join(r() < 0.8 ? ' ' : '');
  if (allowBreak && r() < 0.2) s += (r() < 0.5 ? '  \n' : '\n') + inline(r, depth + 1, false);
  return s;
}
function block(r: () => number): string {
  const k = r();
  if (k < 0.3) return inline(r);
  if (k < 0.42) return '#'.repeat(1 + Math.floor(r() * 3)) + ' ' + inline(r, 0, false) + (r() < 0.25 ? '\n' + inline(r) : '');
  if (k < 0.72) {
    const ord = r() < 0.4, task = !ord && r() < 0.3, loose = r() < 0.25;
    const start = ord ? 1 + Math.floor(r() * 9) : 1;
    const items: string[] = [];
    const n = 1 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const m = ord ? `${start + i}.` : '-';
      let it = `${m} ${task ? (r() < 0.5 ? '[ ] ' : '[x] ') : ''}${inline(r, 0, false)}`;
      const ind = ' '.repeat(m.length + 1);
      if (r() < 0.25) it += `\n${ind}${r() < 0.5 ? '-' : '1.'} ${inline(r, 1, false)}`;
      if (r() < 0.08) it += `\n\n${ind}> ${inline(r, 1, false)}`;
      if (r() < 0.06) it += `\n\n${ind}\`\`\`\n${ind}code ${i}\n${ind}\`\`\``;
      items.push(it);
    }
    return items.join(loose ? '\n\n' : '\n');
  }
  if (k < 0.85) return inline(r).split('\n').map((l) => '> ' + l).join('\n') + (r() < 0.2 ? '\n>\n> - ' + inline(r, 1, false) : '');
  const cols = 2 + Math.floor(r() * 2);
  const al = ['---', ':--', '--:', ':-:'];
  const row = (): string => '| ' + Array.from({ length: cols }, () => inline(r, 1, false).replace(/\|/g, '\\|')).join(' | ') + ' |';
  return [row(), '|' + Array.from({ length: cols }, () => al[Math.floor(r() * 4)]).join('|') + '|', row(), ...(r() < 0.5 ? [row()] : [])].join('\n');
}

// ---------------------------------------------------------------- edits
const TOKENS = ['*', '_', '`', '$', '[', ']', '~', '<', '>', '&', '#', '|', '\\', '!', '(', ')', '"', '**', '__', '~~', '$$', '[x]', '[ ]',
  '1. ', '- ', '+ ', '> ', '# ', '===', '---', '```', '~~~', '&amp;', '&copy;', '<b>', '</em>', '[a](b)', '![a](b)', '$x$', '\\*', 'a_b_', '*a*',
  ' ', '\u00a0', '中', '😀', 'x', '-- -', '***', '1)', ':-:', '|-|', '<!--', '[^1]', '%41'];
function textNodes(root: Element): Text[] {
  const out: Text[] = [];
  const tw = root.ownerDocument.createTreeWalker(root, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const p = (n as Text).parentElement;
    if (!p || p.closest('pre, code, .md-math, kbd, .md-codewrap')) continue;
    // text in front of a task checkbox: the browser cannot put the caret there
    const nx = (n as Text).nextSibling;
    if (nx && nx.nodeType === 1 && (nx as Element).tagName === 'INPUT') continue;
    if (/^[\s]*$/.test((n as Text).data) && p.closest('ul, ol, table') && !p.closest('li, td, th')) continue;
    const isB = (x: Node | null): boolean => !!x && x.nodeType === 1 && /^(P|UL|OL|PRE|BLOCKQUOTE|TABLE|DIV|H\d|LI|TR|TD|TH|THEAD|TBODY)$/.test((x as Element).tagName);
    if (/^\s*$/.test((n as Text).data) && (isB((n as Text).previousSibling) || isB((n as Text).nextSibling))) continue;
    if (/^\s*$/.test((n as Text).data) && ['UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TR', 'BLOCKQUOTE', 'SECTION'].includes(p.tagName)) continue;
    out.push(n as Text);
  }
  return out;
}
function edit(r: () => number, root: Element): string | null {
  const ts = textNodes(root);
  if (ts.length === 0) return null;
  const t = ts[Math.floor(r() * ts.length)];
  const k = r();
  if (k < 0.15 && t.data.length > 1) {
    const a = Math.floor(r() * t.data.length), b = Math.min(t.data.length, a + 1 + Math.floor(r() * 3));
    const d = t.data.slice(a, b);
    t.data = t.data.slice(0, a) + t.data.slice(b);
    // stage 2b (fix-serial-2), harness repair: Chromium removes an inline element whose whole text is deleted
    // (Backspace / Delete over <em>, <a>, <strong> leave no empty element; checked in Chromium 2026-11-20), so the
    // emptied text node and the inline elements it leaves empty go too
    if (t.data === '') {
      let e: Element | null = t.parentElement;
      t.remove();
      while (e && /^(A|EM|I|STRONG|B|DEL|S|STRIKE)$/.test(e.tagName) && !e.firstChild) { const up: Element | null = e.parentElement; e.remove(); e = up; }
    }
    return `del ${JSON.stringify(d)}`;
  }
  const tok = TOKENS[Math.floor(r() * TOKENS.length)];
  const where = r();
  const off = where < 0.3 ? 0 : where < 0.6 ? t.data.length : Math.floor(r() * (t.data.length + 1));
  // a browser keeps a typed space visible at a node edge / next to a space as NBSP
  let ins = tok;
  if (ins === ' ' && (off === 0 || off === t.data.length || t.data[off - 1] === ' ' || t.data[off] === ' ')) ins = '\u00a0';
  if (ins.endsWith(' ') && off === t.data.length) ins = ins.slice(0, -1) + '\u00a0';
  t.data = t.data.slice(0, off) + ins + t.data.slice(off);
  return `ins ${JSON.stringify(ins)}@${off}/${t.data.length}`;
}

interface Fail { cat: string; src: string; edits: string[]; md: string; a: string; b: string }
function category(f: { a: string; b: string; md: string; edits: string[] }): string {
  if (f.cat) return f.cat;
  return 'render-diff';
}

describe('verify-fidelity: random documents + random DOM edits', () => {
  it(`I3/I4 over ${N} documents (seed ${SEED})`, () => {
    const r = rng(SEED);
    const fails: Fail[] = [];
    let checked = 0, refused = 0, refusedOrdinary: string[] = [], cacheChecks = 0;
    const t0 = Date.now();
    for (let d = 0; d < N && Date.now() - t0 < 12_000; d++) {
      const src = block(r);
      const kind = kindOf(src);
      const w = mountHtml(render(src));
      document.body.appendChild(w);
      const why = unsupportedReason(w, src);
      if (why) { refused++; if (refusedOrdinary.length < 5) refusedOrdinary.push(`${why}: ${JSON.stringify(src)}`); w.remove(); continue; }
      const hints = { editing: true, ...sourceStyleHints(src) };
      const refH = hrefs(w);
      const edits: string[] = [];
      const steps = 1 + Math.floor(r() * 3);
      for (let s = 0; s < steps; s++) {
        const e = edit(r, w);
        if (!e) break;
        edits.push(e);
        let md: string;
        try { md = serializeBlock(w, kind, hints); } catch (err) { fails.push({ cat: 'throw', src, edits: [...edits], md: String(err), a: '', b: '' }); break; }
        if (kind === BlockKind.List) {
          cacheChecks++;
          const un = serializeBlock(w, kind, { ...hints, uncached: true });
          if (un !== md) { fails.push({ cat: 'I4-cache', src, edits: [...edits], md, a: un, b: '' }); break; }
        }
        if (/[\u200b\ufeff]|style=|<span|<font|<div/.test(md)) { fails.push({ cat: 'invisible', src, edits: [...edits], md, a: '', b: '' }); break; }
        const a = visible(w, refH);
        const b = visible(mountHtml(render(md)), refH);
        checked++;
        if (a !== b) { fails.push({ cat: '', src, edits: [...edits], md, a, b }); break; }
      }
      w.remove();
    }
    const byCat = new Map<string, Fail[]>();
    for (const f of fails) { const c = category(f); byCat.set(c, [...(byCat.get(c) ?? []), f]); }
    const summary = [...byCat].map(([c, fs]) => `${c}: ${fs.length}`).join(', ');
    console.log(`checked ${checked} serializations, ${cacheChecks} cache comparisons, refused ${refused}; failures: ${fails.length} (${summary})`);
    if (refusedOrdinary.length) console.log('refused:\n  ' + refusedOrdinary.join('\n  '));
    if (VERBOSE) for (const f of fails.slice(0, 60)) console.log(`--- ${category(f)}\nsrc ${JSON.stringify(f.src)}\nedits ${f.edits.join(' ; ')}\nmd  ${JSON.stringify(f.md)}\nA   ${f.a}\nB   ${f.b}`);
    expect(fails.length).toBe(0);
  }, 20_000);
});

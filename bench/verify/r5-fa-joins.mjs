// bench/verify/r5-fa-joins.mjs — fix-atoms (stage 2f, fix round 5): the proof table of P-G (CONTRACT §11, Round-4
// verification decisions): GESTURE x ATOM x CONTAINER. Three line containers (c1 "one first", c2 "Lead {A} two",
// c3 "three {B} end") in one block — a tight / loose / nested / ordered / task list, quote paragraphs, a list inside a
// quote, the paragraphs of one item — with atoms {A} and {B} (formulas, images, raw HTML, links, code …), opened in a
// session (switch on, the tree's dev server). Gestures: Backspace at the start of c2; Delete at the end of c1; the word
// and line deletes across the boundary (Alt-Backspace, Cmd-Backspace, Alt-Delete, Cmd-Delete); a selection from the
// middle of c1 into c2 followed by Backspace, Delete, a typed character, a cut, a paste; one from c1 into c3 followed by
// Backspace; Enter then Backspace; Enter, typing, two Backspaces; Backspace, typing, Cmd-Z, Shift-Cmd-Z; then Esc.
// Checks, every case: (1) screen = source: the preview's content (text, every formula's rendering, every image's
// src|alt|title, every checkbox's state, links, code, raw elements) before Esc equals it after Esc + re-render;
// (2) every atom still shown before Esc has its Markdown in the source byte for byte; (3) no style attribute, no <img
// and no zero-width character in the source that the document did not hold; (4) redo gives back the source the typing
// made; (5) U23: after Enter then Backspace (and Enter, typing, two Backspaces) the source is the document byte for byte.
// Prints PASS / FAIL per case and a summary line.
// Run: MDR_PORT=5461 node bench/verify/r5-fa-joins.mjs <container-regex> <atom-set 0..5> [gesture-regex]
// Global timeout 115 s (T_MS). Writes nothing into the tree. Invisible characters are built from code points.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const [cFilter = '', setArg = '0', gFilter = ''] = process.argv.slice(2);
const CONTAINERS = {
  tight: (a, b) => `- one first\n- Lead ${a} two\n- three ${b} end\n\nnext\n`,
  loose: (a, b) => `- one first\n\n- Lead ${a} two\n\n- three ${b} end\n\nnext\n`,
  nested: (a, b) => `- one first\n  - Lead ${a} two\n  - three ${b} end\n\nnext\n`,
  ordered: (a, b) => `1. one first\n2. Lead ${a} two\n3. three ${b} end\n\nnext\n`,
  task: (a, b) => `- [ ] one first\n- [x] Lead ${a} two\n- [ ] three ${b} end\n\nnext\n`,
  quote: (a, b) => `> one first\n>\n> Lead ${a} two\n>\n> three ${b} end\n\nnext\n`,
  quotelist: (a, b) => `> - one first\n> - Lead ${a} two\n> - three ${b} end\n\nnext\n`,
  itemparas: (a, b) => `- one first\n\n  Lead ${a} two\n\n  three ${b} end\n\nnext\n`,
};
// [Markdown of A, Markdown of B]; each atom's token in the screen signature is found from the first render
const SETS = [
  ['$x^2$', '![i](x.png)'],
  ['<kbd>K</kbd>', '<span style="color:red">r</span>'],
  ['[l](http://e.x/)', '`c`'],
  ['$\\frac{a}{b}$', '<http://e.x/a>'],
  ['![i](x.png "t")', '<span class="c">s</span>'],
  ['$\\alpha$ and $y$', '<img src="y.png" width="10">'],
];
const set = SETS[Number(setArg)] ?? SETS[0];
const ZWS = [0x200b, 0xfeff, 0x2060].map((c) => String.fromCharCode(c));

/** The preview's content as the user sees it (see the header). */
const signature = (page) => page.evaluate((zwCodes) => {
  const pv = document.querySelector('.mdr-preview');
  const zw = new RegExp('[' + zwCodes.map((c) => String.fromCharCode(c)).join('') + ']', 'g');
  const nb = new RegExp(String.fromCharCode(0xa0), 'g');
  let out = '';
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) { out += c.data; continue; }
      if (c.nodeType !== 1) continue;
      const e = c;
      if (e.matches('[data-mdr-ui], textarea, button, .md-code__lang, .mdr-preview__edit-hint')) continue;
      if (e.classList.contains('md-math')) { const h = e.querySelector('.katex-html'); out += '⟦m ' + (h ? h.textContent : e.textContent).replace(zw, '') + '⟧'; continue; }
      if (e.classList.contains('md-math-src')) { out += '⟦msrc ' + e.textContent + '⟧'; continue; }
      const t = e.tagName;
      if (t === 'IMG') { out += `⟦img ${e.getAttribute('src')}|${e.getAttribute('alt') ?? ''}|${e.getAttribute('title') ?? ''}|${e.getAttribute('width') ?? ''}⟧`; continue; }
      if (t === 'INPUT') { out += e.checked ? '⟦x⟧' : '⟦ ⟧'; continue; }
      if (t === 'BR') { out += '\n'; continue; }
      const block = /^(P|LI|H[1-6]|PRE|BLOCKQUOTE|TR|TD|TH|DIV|SECTION|UL|OL|TABLE)$/.test(t);
      if (block) out += '\n';
      const cls = (e.getAttribute('class') ?? '').split(/\s+/).filter((x) => x && !/^(hljs|md-|mdr-|is-|katex)/.test(x)).join('.');
      const open = t === 'A' ? `⟦a ${e.getAttribute('href')}⟧` : t === 'CODE' && !e.closest('pre') ? '⟦c⟧'
        : /^(KBD|SUP|SUB)$/.test(t) ? `⟦${t}⟧` : t === 'SPAN' && cls ? `⟦span.${cls}⟧` : '';
      out += open;
      walk(e);
      if (open) out += '⟦/⟧';
      if (block) out += '\n';
    }
  };
  walk(pv);
  // (a task box is followed by one space in Markdown whatever the session shows: `- [x] Lead`)
  return out.replace(zw, '').replace(nb, ' ').replace(/(⟦[x ]⟧) ?/g, '$1 ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}, [0x200b, 0xfeff, 0x2060]);

/** Caret (or selection) inside the session block at text offsets: [needle, k] = after k characters of needle. */
const selectAt = (page, a, b = a) => page.evaluate(({ a, b }) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  if (!el) throw new Error('no session');
  const at = ([needle, k]) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest('.md-math, [data-mdr-ui]') ? 2 : 1) });
    for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf(needle); if (i >= 0) return [n, i + k]; }
    throw new Error('selectAt: ' + needle);
  };
  const [an, ao] = at(a), [fn, fo] = at(b);
  getSelection().setBaseAndExtent(an, ao, fn, fo);
}, { a, b });

const GESTURES = [
  ['bs', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); }],
  ['del', async (p) => { await selectAt(p, ['first', 5]); await p.keyboard.press('Delete'); }],
  ['altbs', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Alt+Backspace'); }],
  ['cmdbs', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Meta+Backspace'); }],
  ['altdel', async (p) => { await selectAt(p, ['first', 5]); await p.keyboard.press('Alt+Delete'); }],
  ['cmddel', async (p) => { await selectAt(p, ['first', 5]); await p.keyboard.press('Meta+Delete'); }],
  ['sel2-bs', async (p) => { await selectAt(p, ['one', 2], ['Lead', 2]); await p.keyboard.press('Backspace'); }],
  ['sel2-del', async (p) => { await selectAt(p, ['one', 2], ['Lead', 2]); await p.keyboard.press('Delete'); }],
  ['sel2-type', async (p) => { await selectAt(p, ['one', 2], ['Lead', 2]); await p.keyboard.type('Q'); }],
  ['sel2-cut', async (p) => { await selectAt(p, ['one', 2], ['Lead', 2]); await p.keyboard.press('Meta+x'); }],
  ['sel2-paste', async (p) => { await p.evaluate(() => navigator.clipboard.writeText('PP')); await selectAt(p, ['one', 2], ['Lead', 2]); await p.keyboard.press('Meta+v'); }],
  ['sel3-bs', async (p) => { await selectAt(p, ['one', 2], ['three', 3]); await p.keyboard.press('Backspace'); }],
  ['enter-bs', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Enter'); await sleep(300); await p.keyboard.press('Backspace'); }],
  ['enter-type-bs2', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Enter'); await sleep(250); await p.keyboard.type('Q'); await sleep(250); await p.keyboard.press('Backspace'); await sleep(250); await p.keyboard.press('Backspace'); }],
  ['bs-type-undo-redo', null],
];
const count = (s, sub) => s.split(sub).length - 1;

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [cn, mk] of Object.entries(CONTAINERS)) {
    if (cFilter && !new RegExp(cFilter).test(cn)) continue;
    const doc = mk(set[0], set[1]);
    for (const [gn, g] of GESTURES) {
      if (gFilter && !new RegExp(gFilter).test(gn)) continue;
      const name = `${cn}/${setArg}/${gn}`;
      try {
        await prepare(A, doc);
        const sig0 = await signature(page);
        // the atoms' tokens, in document order: A's in c2, B's in c3
        const lines = sig0.split('\n');
        const tokOf = (needle) => { const l = lines.find((x) => x.includes(needle)) ?? ''; return l.match(/⟦(?:m|img|a|c|KBD|SUP|span\.[^ ⟧]*)[^⟧]*⟧/g) ?? []; };
        const toks = { A: tokOf('Lead'), B: tokOf('three') };
        await clickText(page, 'two', 1); await sleep(350);
        const live = await sessionOn(page);
        let redoOk = true;
        if (g) await g(page);
        else {
          await selectAt(page, ['Lead', 0]); await page.keyboard.press('Backspace'); await sleep(300);
          await page.keyboard.type('Z'); await A.settle(250);
          const typed = await A.source();
          await page.keyboard.press('Meta+z'); await A.settle(400);
          await page.keyboard.press('Shift+Meta+z'); await A.settle(400);
          redoOk = (await A.source()) === typed;
        }
        await sleep(400); await A.settle(200);
        const sig1 = await signature(page);
        await page.keyboard.press('Escape'); await A.settle(300);
        const src = await A.source();
        const sig2 = await signature(page);
        const problems = [];
        if (!live) problems.push('no session');
        if (sig1 !== sig2) problems.push('screen!=source');
        for (const [k, md] of [['A', set[0]], ['B', set[1]]]) {
          const shown = toks[k].length > 0 && toks[k].every((t) => sig1.includes(t));
          if (shown && !src.includes(md.includes(' and ') ? md.split(' and ')[1] : md)) problems.push(`${k} shown, Markdown lost`);
        }
        if (count(src, 'style=') > count(doc, 'style=')) problems.push('style written');
        if (count(src, '<img') > count(doc, '<img')) problems.push('raw img written');
        if (ZWS.some((z) => src.includes(z))) problems.push('zero-width written');
        if (!redoOk) problems.push('redo differs');
        if (/^enter-/.test(gn) && src !== doc) problems.push('U23: the source changed');
        check(name, problems.length === 0, `${problems.join(', ')} src=${show(src)}${sig1 !== sig2 ? ` screen=${J(sig1)} rerender=${J(sig2)}` : ''}`);
      } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;

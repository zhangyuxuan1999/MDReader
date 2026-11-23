// bench/verify/v6-von-joins.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): P-G (atoms survive the
// browser) as a class, VARIED from bench/verify/r5-fa-joins.mjs and bench/verify/r5-ca-joins.mjs: containers neither
// tried (three nesting levels, a quote in a quote, a task list in a quote, a quote in an item, "7)" ordered, a loose task
// list, "*" bullets, an item with a second paragraph, lines that START with the atom), atoms neither tried (\text with a
// space, <, \{, del / strong+em around a formula, an image with %20 and a title with parentheses, a link with
// parentheses in its destination, raw <a>, <img alt> without title, two formulas / two images adjacent, code holding
// $…$, CJK + emoji before a formula, matrix with &, a KaTeX error, a formula inside a styled raw span and inside <u>,
// a formula as link text with a %20 destination, an autolink with a percent-encoded CJK path), and gestures neither
// tried (a join then typing at the joint, a join then a second join with the other key, a join then bold across the
// old boundary, a join then a paste at the joint, a join then undo then typing, Backspace at the very start of the
// block (merge with the paragraph above), Delete at the very end of the block (merge with the paragraph below), a join
// while every re-render is held 1.5 s followed by typing and a second join, a selection of just the boundary replaced by
// a space, join + Enter + Backspace).
// Checks, every case: screen = source (the preview's content before Esc equals it after Esc + re-render: text,
// formulas, images src|alt|title, checkbox states, link hrefs); every atom still shown has its Markdown in the source
// byte for byte; no style attribute, no <img, no <a  the document did not hold; no invisible character the document did
// not hold; bs-enter-bs gives the joined source of plain bs back.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-joins.mjs <container-regex> <sets e.g. 0,4,8> [gesture-regex]
// Global timeout T_MS (default 115 s). Writes nothing into the tree. Invisible characters are built from code points.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn, invisibleExtra, none } from './v5-ptr-lib.mjs';

const [cFilter = '', setsArg = '0', gFilter = ''] = process.argv.slice(2);
const INTRO = 'intro para\n\n';
const CONTAINERS = {
  deep3: (a, b) => `- one first\n  - Lead ${a} two\n    - three ${b} end\n\nnext\n`,
  quotenest: (a, b) => `> one first\n>\n> > Lead ${a} two\n> >\n> > three ${b} end\n\nnext\n`,
  quotetask: (a, b) => `> - [x] one first\n> - [ ] Lead ${a} two\n> - [x] three ${b} end\n\nnext\n`,
  itemquote: (a, b) => `- one first\n\n  > Lead ${a} two\n  >\n  > three ${b} end\n\nnext\n`,
  olparen: (a, b) => `7) one first\n8) Lead ${a} two\n9) three ${b} end\n\nnext\n`,
  taskloose: (a, b) => `- [x] one first\n\n- [ ] Lead ${a} two\n\n- [x] three ${b} end\n\nnext\n`,
  star: (a, b) => `* one first\n* Lead ${a} two\n* three ${b} end\n\nnext\n`,
  item2para: (a, b) => `- one first\n- Lead ${a} two\n\n  three ${b} end\n\nnext\n`,
  atomstart: (a, b) => `- one first\n- ${a} Lead two\n- ${b} three end\n\nnext\n`,
};
const SETS = [
  ['$\\text{a b}$', '$x_1^{2}$'],
  ['$a<b$', '$\\{x\\}$'],
  ['~~$x$ d~~', '***$y$ e***'],
  ['![a b](p%20q.png "T (1)")', '[t](http://e.x/a_(b) "q")'],
  ['<a href="http://e.x/">raw</a>', '<img src="a.png" alt="x">'],
  ['$x$$y$', '![](e.png)![](f.png)'],
  ['`$x$`', '中文😀$\\beta$'],
  ['$\\begin{matrix}a&b\\end{matrix}$', '$\\mathrm{d}x$'],
  ['$\\frac{$', '$\\color{red}{x}$'],
  ['<span style="color:red">$x$</span>', '<u>$y$</u>'],
  ['[$a$](http://e.x/a%20b)', '<http://e.x/%E4%B8%AD>'],
];
const sets = setsArg.split(',').map(Number);

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
        : /^(KBD|SUP|SUB|U|DEL|S|STRONG|EM|B|I)$/.test(t) ? `⟦${t.replace(/^B$/, 'STRONG').replace(/^I$/, 'EM')}⟧` : t === 'SPAN' && (cls || (e.getAttribute('style') && (e.hasAttribute('data-mdr-o') || !e.closest('.is-editing')))) ? `⟦span.${cls}|${(e.hasAttribute('data-mdr-o') || !e.closest('.is-editing') ? (e.getAttribute('style') ?? '') : '').replace(/\s|;$/g, '')}⟧` : '';
      out += open;
      walk(e);
      if (open) out += '⟦/⟧';
      if (block) out += '\n';
    }
  };
  walk(pv);
  return out.replace(zw, '').replace(nb, ' ').replace(/(⟦[x ]⟧) ?/g, '$1 ').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ ?(⟦[^⟧]*⟧) ?/g, '$1').trim()).filter(Boolean).join('\n');
}, [0x200b, 0xfeff, 0x2060]);

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
/** The caret at the very start of the line container (li / p) whose text holds `needle` (before a leading atom). */
const lineStart = (page, needle) => page.evaluate((needle) => {
  const el = document.querySelector('.mdr-preview .is-editing');
  const c = [...el.querySelectorAll('li, p')].reverse().find((x) => x.textContent.includes(needle));
  if (!c) throw new Error('lineStart: ' + needle);
  let n = c.firstChild;
  while (n && n.nodeType === 1 && n.tagName === 'INPUT') n = n.nextSibling;
  if (n && n.nodeType === 3) getSelection().setBaseAndExtent(n, 0, n, 0);
  else getSelection().setBaseAndExtent(c, n ? [...c.childNodes].indexOf(n) : 0, c, n ? [...c.childNodes].indexOf(n) : 0);
}, needle);
const holdRenders = (p, ms) => p.evaluate((ms) => { const pv = window.__mdr.app.preview; if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); } pv.applyStructureDelta = (m) => { setTimeout(() => window.__origDelta(m), ms); return true; }; pv.applyHtml = (m) => { setTimeout(() => window.__origHtml(m), ms); }; }, ms);
const releaseRenders = (p) => p.evaluate(() => { const pv = window.__mdr.app.preview; if (window.__origDelta) { pv.applyStructureDelta = window.__origDelta; pv.applyHtml = window.__origHtml; } });
const joinAtLead = async (p, start) => { if (start) await lineStart(p, 'Lead'); else await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); };

const GESTURES = [
  ['bs', async (p, st) => { await joinAtLead(p, st); }],
  ['bs-type-joint', async (p, st) => { await joinAtLead(p, st); await sleep(300); await p.keyboard.type('Q'); await sleep(200); await p.keyboard.type(' R'); }],
  ['bs-then-del', async (p, st) => { await joinAtLead(p, st); await sleep(300); await selectAt(p, ['two', 3]); await p.keyboard.press('Delete'); }],
  ['del-then-bs', async (p, st) => { await selectAt(p, ['first', 5]); await p.keyboard.press('Delete'); await sleep(300); if (st) await lineStart(p, 'three'); else await selectAt(p, ['three', 0]); await p.keyboard.press('Backspace'); }],
  ['bs-bold-across', async (p, st) => { await joinAtLead(p, st); await sleep(300); await selectAt(p, ['first', 2], ['two', 2]); await p.keyboard.press('Meta+b'); }],
  ['bs-paste-joint', async (p, st) => { await p.evaluate(() => navigator.clipboard.writeText('P1 P2')); await joinAtLead(p, st); await sleep(300); await p.keyboard.press('Meta+v'); }],
  ['bs-undo-type', async (p, st) => { await joinAtLead(p, st); await sleep(400); await p.keyboard.press('Meta+z'); await sleep(500); await selectAt(p, ['two', 0]); await p.keyboard.type('W'); }],
  ['first-bs', async (p) => { await selectAt(p, ['one', 0]); await p.keyboard.press('Backspace'); }],
  ['last-del', async (p) => { await selectAt(p, ['end', 3]); await p.keyboard.press('Delete'); }],
  ['held-bs-type-del', async (p, st) => {
    await holdRenders(p, 1500);
    try { await joinAtLead(p, st); await sleep(120); await p.keyboard.type('Z'); await sleep(120); await selectAt(p, ['two', 3]); await p.keyboard.press('Delete'); await sleep(2600); }
    finally { await releaseRenders(p); }
  }],
  ['boundary-space', async (p, st) => { if (st) { await selectAt(p, ['first', 5]); await p.keyboard.press('Shift+ArrowRight'); } else await selectAt(p, ['first', 5], ['Lead', 0]); await p.keyboard.type(' '); }],
  ['bs-enter-bs', async (p, st) => { await joinAtLead(p, st); await sleep(300); await p.keyboard.press('Enter'); await sleep(300); await p.keyboard.press('Backspace'); }],
];
const count = (s, sub) => s.split(sub).length - 1;

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const { page } = A;
  const plainBs = {};
  for (const si of sets) {
    const set = SETS[si];
    for (const [cn, mk] of Object.entries(CONTAINERS)) {
      if (cFilter && !new RegExp(cFilter).test(cn)) continue;
      const doc = INTRO + mk(set[0], set[1]);
      const st = cn === 'atomstart';
      for (const [gn, g] of GESTURES) {
        if (gFilter && !new RegExp(gFilter).test(gn)) continue;
        const name = `${cn}/${si}/${gn}`;
        try {
          await prepare(A, doc);
          const sig0 = await signature(page);
          const lines = sig0.split('\n');
          const tokOf = (needle) => { const l = lines.find((x) => x.includes(needle)) ?? ''; return l.match(/⟦(?:m|img|a|c|KBD|SUP|SUB|U|DEL|STRONG|EM|span\.[^⟧]*)[^⟧]*⟧/g) ?? []; };
          const toks = { A: tokOf('Lead'), B: tokOf('three') };
          await clickText(page, 'two', 1); await sleep(350);
          const live = await sessionOn(page);
          await g(page, st);
          await sleep(400); await A.settle(200);
          const sig1 = await signature(page);
          const during = await A.source();
          await page.keyboard.press('Escape'); await A.settle(300);
          const src = await A.source();
          const sig2 = await signature(page);
          const stamps = await page.evaluate(() => document.querySelectorAll('.mdr-preview [data-mdr-tex], .mdr-preview [data-mdr-ps]').length);
          const problems = [];
          if (!live) problems.push('no session');
          if (sig1 !== sig2) problems.push('screen!=source');
          for (const [k, md] of [['A', set[0]], ['B', set[1]]]) {
            const shown = toks[k].length > 0 && toks[k].every((t) => sig1.includes(t));
            if (shown && !src.includes(md)) problems.push(`${k} shown, Markdown lost`);
          }
          if (count(src, 'style=') > count(doc, 'style=')) problems.push('style written');
          if (count(src, '<img') > count(doc, '<img')) problems.push('raw img written');
          if (count(src, '<a ') > count(doc, '<a ')) problems.push('raw a written');
          if (count(src, '<span') > count(doc, '<span')) problems.push('raw span written');
          const inv = invisibleExtra(src, doc);
          if (!none(inv)) problems.push('invisible written ' + J(inv));
          if (stamps) problems.push(`stamps left ${stamps}`);
          if (A.pageErrors.length) problems.push('pageerror ' + A.pageErrors.splice(0).join(' | ').slice(0, 200));
          if (gn === 'bs') plainBs[`${cn}/${si}`] = src;
          if (gn === 'bs-enter-bs' && plainBs[`${cn}/${si}`] !== undefined && src !== plainBs[`${cn}/${si}`]) problems.push('U23 after join: ' + show(plainBs[`${cn}/${si}`]));
          if (!/^(bs-undo-type|first-bs|last-del|boundary-space)$/.test(gn) && src === doc) problems.push('nothing written');
          if (during !== src && !/held/.test(gn)) problems.push('written only at Esc');
          check(name, problems.length === 0, `${problems.join(', ')} src=${show(src)}${sig1 !== sig2 ? ` screen=${J(sig1)} rerender=${J(sig2)}` : ''}`);
        } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
      }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;

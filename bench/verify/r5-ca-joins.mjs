// bench/verify/r5-ca-joins.mjs — challenge-atoms (stage 2f, fix round 5): attack on P-G (CONTRACT §11, Round-4
// verification decisions) beyond fix-atoms' table (bench/verify/r5-fa-joins.mjs, whose checks and signature this
// script reuses unchanged): atoms it did not list (a formula with a dollar, with CJK, ending in a backslash, in bold, in
// a link text, in kbd; an image with empty alt, inside a link, reference style; raw sub/sup and an img tag with alt and
// title; entities; inline code with backticks and pipes; a display formula next to a styled span; autolink and bare URL
// next to formulas), containers it did not list (task lists ordered and nested), and gestures it did not list (three
// containers joined by two Backspaces; a join then Enter; a join, undo, redo, undo; a join, Esc, a click back, typing;
// bold and italic across the boundary; a cut and a paste back; Enter and Shift-Enter right after an atom, then Backspace).
// Checks: those of r5-fa-joins (screen = source, atoms' Markdown kept, no style / raw img / zero-width written, redo,
// U23 for enter-*), plus: src-equal gestures (bs-enter, bs-undo3, cutpaste, atomenter-bs, atomsenter-bs) must give the
// document back byte for byte; bs-esc-click must write the joined text plus the typed Y.
// Run: MDR_PORT=5465 MDR_BASE_PORT=5476 node bench/verify/r5-ca-joins.mjs <container-regex> <atom-set 0..13> [gesture-regex]
// Global timeout 115 s (T_MS). Writes nothing into the tree. Invisible characters are built from code points.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn } from './v5-ptr-lib.mjs';

const [cFilter = '', setArg = '0', gFilter = ''] = process.argv.slice(2);
const CONTAINERS = {
  tight: (a, b) => `- one first\n- Lead ${a} two\n- three ${b} end\n\nnext\n`,
  quote: (a, b) => `> one first\n>\n> Lead ${a} two\n>\n> three ${b} end\n\nnext\n`,
  task: (a, b) => `- [ ] one first\n- [x] Lead ${a} two\n- [ ] three ${b} end\n\nnext\n`,
  taskordered: (a, b) => `1. [x] one first\n2. [ ] Lead ${a} two\n3. [x] three ${b} end\n\nnext\n`,
  tasknested: (a, b) => `- [ ] one first\n  - [x] Lead ${a} two\n  - [ ] three ${b} end\n\nnext\n`,
  giant: (a, b) => Array.from({ length: 150 }, (_, k) => `- item${k} $k_{${k}}$\n`).join('') + `- one first\n- Lead ${a} two\n- three ${b} end\n` + Array.from({ length: 150 }, (_, k) => `- tail${k} $t_{${k}}$\n`).join('') + '\nnext\n',
  loose: (a, b) => `- one first\n\n- Lead ${a} two\n\n- three ${b} end\n\nnext\n`,
};
// [Markdown of A, Markdown of B]; each atom's token in the screen signature is found from the first render
const SETS = [
  ["$a\\$b$", "$中文x$"],
  ["$a\\\\$", "$\\sqrt{x}\\,y$"],
  ["**$x$ b**", "[$y$ l](http://e.x/)"],
  ["![](e.png)", "[![i](x.png \"t\")](http://e.x/)"],
  ["<sub>s</sub><sup>p</sup>", "<img src=\"y.png\" alt=\"a\" title=\"t\">"],
  ["&amp; &copy; &#x41;", "`a|b` ``c`d``"],
  ["$$E=mc^2$$", "<span style=\"color:red\">r</span> $z$"],
  ["<http://e.x/a>$x$", "http://e.x/b $y$"],
  ["[r][ref] $x$", "![im][ref]"],
  ["<kbd>$x$</kbd>", "*$\\alpha$*"],
  ["<font color=\"red\">f</font> <u>u</u>", "<mark>m</mark> <small style=\"color:blue\">s</small>"],
  ["<span style=\"font-weight:bold\">w</span>", "<b style=\"color:red\">b</b> <span style=\"background:yellow\">y</span>"],
  ["k\\\nm $x$", "p  \nq $y$"],
  ["<br> $x$ <sup>2</sup>", "`` a`|`b `` $y$"],
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
  ['bs3', async (p) => { await selectAt(p, ['three', 0]); await p.keyboard.press('Backspace'); await sleep(300); await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); }],
  ['bs-enter', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); await sleep(300); await p.keyboard.press('Enter'); }],
  ['bs-undo3', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); await sleep(400); await p.keyboard.press('Meta+z'); await sleep(400); await p.keyboard.press('Shift+Meta+z'); await sleep(400); await p.keyboard.press('Meta+z'); }],
  ['bs-esc-click', async (p) => { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); await sleep(300); await p.keyboard.press('Escape'); await sleep(900); await p.evaluate(() => window.__mdr.waitIdle()); await clickText(p, 'end', 2); await sleep(400); await selectAt(p, ['end', 3]); await p.keyboard.type('Y'); }],
  ['bold-across', async (p) => { await selectAt(p, ['one', 2], ['three', 3]); await p.keyboard.press('Meta+b'); }],
  ['italic-across', async (p) => { await selectAt(p, ['one', 2], ['two', 2]); await p.keyboard.press('Meta+i'); }],
  ['cutpaste', async (p) => { await selectAt(p, ['one', 2], ['three', 3]); await p.keyboard.press('Meta+x'); await sleep(300); await p.keyboard.press('Meta+v'); }],
  ['atomenter-bs', async (p) => { await selectAt(p, [' two', 0]); await p.keyboard.press('Enter'); await sleep(300); await p.keyboard.press('Backspace'); }],
  ['atomsenter-bs', async (p) => { await selectAt(p, [' two', 0]); await p.keyboard.press('Shift+Enter'); await sleep(300); await p.keyboard.press('Backspace'); }],
  ['slow-bs-type-bs', async (p) => {
    await p.evaluate((ms) => { const pv = window.__mdr.app.preview; if (!window.__origDelta) { window.__origDelta = pv.applyStructureDelta.bind(pv); window.__origHtml = pv.applyHtml.bind(pv); } pv.applyStructureDelta = (m) => { setTimeout(() => window.__origDelta(m), ms); return true; }; pv.applyHtml = (m) => { setTimeout(() => window.__origHtml(m), ms); }; }, 1500);
    try { await selectAt(p, ['Lead', 0]); await p.keyboard.press('Backspace'); await sleep(150); await p.keyboard.type('Z'); await sleep(150); await selectAt(p, ['three', 0]); await p.keyboard.press('Backspace'); await sleep(2500); }
    finally { await p.evaluate(() => { const pv = window.__mdr.app.preview; if (window.__origDelta) { pv.applyStructureDelta = window.__origDelta; pv.applyHtml = window.__origHtml; } }); }
  }],
  ['ime-join', async (p) => {
    const cdp = await p.context().newCDPSession(p);
    await selectAt(p, ['Lead', 0]);
    await cdp.send('Input.imeSetComposition', { text: 'ka', selectionStart: 2, selectionEnd: 2 }); await sleep(150);
    await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 }); await sleep(150);
    await cdp.send('Input.insertText', { text: 'K' }); await sleep(300);
    await selectAt(p, ['KLead', 0]); await p.keyboard.press('Backspace');
  }],
  ['selover-type', async (p) => { await selectAt(p, ['Lead', 2], ['three', 2]); await p.keyboard.type('Q'); }],
  // task containers: tick the first item's own box in this session, then two Delete joins (two moved boxes on one line)
  ['tick-del2', async (p) => {
    const box = await p.evaluate(() => { const b = document.querySelector('.mdr-preview .is-editing li input[type="checkbox"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    if (box) { await p.mouse.click(box.x, box.y); await sleep(400); }
    await selectAt(p, ['first', 5]); await p.keyboard.press('Delete'); await sleep(300);
    await selectAt(p, ['two', 3]); await p.keyboard.press('Delete');
  }],
];
const count = (s, sub) => s.split(sub).length - 1;

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  for (const [cn, mk] of Object.entries(CONTAINERS)) {
    if (cFilter && !new RegExp(cFilter).test(cn)) continue;
    const doc = mk(set[0], set[1]) + (Number(setArg) === 8 ? "\n[ref]: http://e.x/r\n" : "");
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
        if (/^(bs-enter|bs-undo3|cutpaste|atomenter-bs|atomsenter-bs)$/.test(gn) && src !== doc) problems.push('source not given back');
        if (gn === 'bs-esc-click' && !src.includes('endY')) problems.push('typing after re-entry lost');
        check(name, problems.length === 0, `${problems.join(', ')} src=${show(src)}${sig1 !== sig2 ? ` screen=${J(sig1)} rerender=${J(sig2)}` : ''}`);
      } catch (e) { check(name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
    }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;

// bench/verify/v6-von-life.mjs — verify-on (0.2.0 stage 2f, fix round 5 verification): what fix-atoms' changes
// (stampAtoms / presentationAsPrepared / formulaTex / dropForeignBoxes / dropFreshBox / the clipboard take-off) may have
// broken in a session's ordinary life around formulas, images, links, styled spans and tasks (switch on, a dev server).
// Cases (each prints PASS / FAIL with the source):
//   copy-formula    ⌘C over text + a formula + a styled span: no data-mdr-tex / data-mdr-ps and no zero-width character
//                   on the clipboard (plain and html); the stamps are back on the elements afterwards.
//   cut-into-span   ⌘X of a part of a styled span (an element the cut does not delete whole), and of a part of an
//                   aligned table cell: the clipboard html (stamps?), then Esc: the span's style as the source had it.
//   copy-cell       ⌘C inside an aligned cell (the cell has a stamp).
//   drag-start      the dataTransfer of a dragstart over a formula (no stamps in text/html).
//   refuse-mid      in a session the formula loses its stamp and annotation (as a re-creation without attributes would
//                   leave it), then a typed character: nothing written, the toast, the session not stuck (a click on another
//                   block starts a session and typing arrives).
//   emptied         select-all + Delete in a block holding only a formula, then typing: the source.
//   undo-redo       typing next to a formula, ⌘Z, ⇧⌘Z: source equal to the typed state; the formula intact.
//   merge-blocks    Backspace at the start of a paragraph after a paragraph ending in a formula, and Delete at the end
//                   of it before a paragraph that starts with an image: atoms intact.
//   resume          typing, waiting for the re-render (resume), typing again: both characters, atoms intact, no stamps after Esc.
//   tick-esc        a task's box ticked in the session, then typing, then Esc: the marker the user saw.
//   img-bs          Backspace right after an image: only the image goes.
//   fresh-box       Enter at the end of a task item, typing, Esc: a fresh "- [ ] " item, stays one fresh box.
// Run: MDR_PORT=5482 MDR_BASE_PORT=5483 node bench/verify/v6-von-life.mjs [case-prefix ...]
// Global timeout T_MS (default 115 s). Writes nothing into the tree. Invisible characters are built from code points.
import { sleep, globalTimeout, J, check, summary, openAt, prepare, results, CP, show, clickText, sessionOn, invisibleExtra, none, readClip, clearClip } from './v5-ptr-lib.mjs';

const only = process.argv.slice(2);
const want = (n) => only.length === 0 || only.some((p) => n.startsWith(p));
const STAMP_RE = /data-mdr-(tex|ps)/;
const ZW_RE = new RegExp('[' + [0x200b, 0xfeff, 0x2060].map((c) => String.fromCharCode(c)).join('') + ']');
const hasZw = (s) => ZW_RE.test(s);

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
const stampsIn = (page) => page.evaluate(() => document.querySelectorAll('.mdr-preview [data-mdr-tex], .mdr-preview [data-mdr-ps]').length);
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.mdr-toast__text')].map((t) => t.textContent));

let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
async function start(doc, needle, k = 1) {
  await prepare(A, doc);
  await clickText(A.page, needle, k); await sleep(400);
  return sessionOn(A.page);
}
async function esc() { await A.page.keyboard.press('Escape'); await A.settle(350); return A.source(); }
const page = () => A.page;
try {
  A = await openAt(CP, !!process.env.MDR_PERFQ);
  const P = A.page;
  const DOC1 = 'Text $x^2$ and <span style="color:red">red words here</span> end words\n\n| a | b |\n|:-:|--:|\n| $y$ cell text | d |\n\nnext para\n';
  if (want('copy-formula')) {
    const live = await start(DOC1, 'Text', 1);
    const n0 = await stampsIn(P);
    await selectAt(P, ['Text', 1], ['red', 2]);
    await clearClip(P); await P.keyboard.press('Meta+c'); await sleep(250);
    const clip = await readClip(P);
    const n1 = await stampsIn(P);
    const src = await esc();
    check('copy-formula', live && n0 > 0 && !STAMP_RE.test(clip.html) && !hasZw(clip.plain) && !hasZw(clip.html) && n1 === n0 && src === DOC1,
      `live=${live} stamps ${n0}->${n1} htmlStamp=${STAMP_RE.test(clip.html)} zw plain=${hasZw(clip.plain)} html=${hasZw(clip.html)} plain=${show(clip.plain)} html=${show(clip.html.slice(0, 300))}`);
  }
  if (want('cut-into-span')) {
    const live = await start(DOC1, 'Text', 1);
    await selectAt(P, ['red words', 2], ['red words', 6]);
    await clearClip(P); await P.keyboard.press('Meta+x'); await sleep(300);
    const clip = await readClip(P);
    await A.settle(250);
    const during = await A.source();
    const src = await esc();
    const exp = DOC1.replace('red words here', 'rerds here');
    check('cut-into-span', live && !STAMP_RE.test(clip.html) && src === exp, `live=${live} htmlStamp=${STAMP_RE.test(clip.html)} html=${show(clip.html.slice(0, 400))} during=${show(during.split('\n')[0])} src=${show(src.split('\n')[0])}`);
  }
  if (want('cut-cell')) {
    const live = await start(DOC1, 'cell text', 1);
    await selectAt(P, ['cell text', 1], ['cell text', 5]);
    await clearClip(P); await P.keyboard.press('Meta+x'); await sleep(300);
    const clip = await readClip(P);
    const src = await esc();
    check('cut-cell', live && !STAMP_RE.test(clip.html) && src.includes('|:-:|--:|') && src.includes('$y$ ctext'), `live=${live} htmlStamp=${STAMP_RE.test(clip.html)} html=${show(clip.html.slice(0, 400))} src=${show(src)}`);
  }
  if (want('copy-cell')) {
    const live = await start(DOC1, 'cell text', 1);
    await selectAt(P, ['cell text', 1], ['cell text', 5]);
    await clearClip(P); await P.keyboard.press('Meta+c'); await sleep(250);
    const clip = await readClip(P);
    const src = await esc();
    check('copy-cell', live && !STAMP_RE.test(clip.html) && src === DOC1, `live=${live} htmlStamp=${STAMP_RE.test(clip.html)} html=${show(clip.html.slice(0, 300))}`);
  }
  if (want('drag-start')) {
    const live = await start(DOC1, 'Text', 1);
    await selectAt(P, ['Text', 1], ['and', 2]);
    const dt = await P.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      const d = new DataTransfer();
      const r = getSelection().getRangeAt(0);
      const div = document.createElement('div'); div.appendChild(r.cloneContents());
      d.setData('text/html', div.innerHTML); d.setData('text/plain', r.toString());
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: d });
      el.querySelector('p').dispatchEvent(ev);
      return { html: d.getData('text/html'), plain: d.getData('text/plain') };
    });
    const src = await esc();
    check('drag-start', live && !STAMP_RE.test(dt.html) && src === DOC1, `live=${live} htmlStamp=${STAMP_RE.test(dt.html)} html=${show(dt.html.slice(0, 300))}`);
  }
  if (want('refuse-mid')) {
    const doc = 'Alpha $x^2$ beta words\n\nOther para text\n';
    const live = await start(doc, 'Alpha', 1);
    await selectAt(P, ['beta', 4]); await P.keyboard.type('Q'); await A.settle(300);
    const typed1 = await A.source();
    await P.evaluate(() => { const m = document.querySelector('.mdr-preview .is-editing .md-math'); m.removeAttribute('data-mdr-tex'); for (const a of m.querySelectorAll('annotation')) a.remove(); });
    await selectAt(P, ['words', 5]); await P.keyboard.type('Z'); await sleep(600); await A.settle(300);
    const after = await A.source();
    const ts = await toasts(P);
    const stillOn = await sessionOn(P);
    await clickText(P, 'Other', 2); await sleep(400);
    const live2 = await sessionOn(P);
    if (live2) { await selectAt(P, ['text', 4]); await P.keyboard.type('W'); }
    const src = await esc();
    check('refuse-mid', live && typed1 === doc.replace('beta', 'betaQ') && after === typed1 && ts.some((t) => t.includes('此块请在源码中编辑')) && !stillOn && live2 && src === typed1.replace('para text', 'para textW'),
      `live=${live} typed1=${show(typed1)} after=${show(after)} toasts=${J(ts)} stillOn=${stillOn} live2=${live2} src=${show(src)}`);
  }
  if (want('emptied')) {
    const doc = 'intro\n\n$\\frac{a}{b}$\n\nnext\n';
    await prepare(A, doc);
    await P.evaluate(() => { const m = document.querySelector('.mdr-preview .md-math'); const r = m.getBoundingClientRect(); window.__pt = { x: r.right + 30, y: r.top + r.height / 2 }; });
    const pt = await P.evaluate(() => window.__pt);
    await P.mouse.click(pt.x, pt.y); await sleep(400);
    const live = await sessionOn(P);
    await P.keyboard.press('Meta+a'); await P.keyboard.press('Delete'); await sleep(300);
    await P.keyboard.type('New text'); await A.settle(300);
    const src = await esc();
    check('emptied', live && src === 'intro\n\nNew text\n\nnext\n', `live=${live} src=${show(src)}`);
  }
  if (want('undo-redo')) {
    const doc = 'Before $\\sqrt{x}$ after words\n';
    const live = await start(doc, 'Before', 1);
    await selectAt(P, [' after', 0]); await P.keyboard.type('MN'); await A.settle(300);
    const typed = await A.source();
    await P.keyboard.press('Meta+z'); await A.settle(400);
    const undone = await A.source();
    await P.keyboard.press('Shift+Meta+z'); await A.settle(400);
    const redone = await A.source();
    await P.keyboard.type('K'); await A.settle(300);
    const src = await esc();
    check('undo-redo', live && typed.includes('$\\sqrt{x}$MN after') && undone === doc && redone === typed && src.includes('$\\sqrt{x}$') && src.includes('K') && none(invisibleExtra(src, doc)),
      `live=${live} typed=${show(typed)} undone=${show(undone)} redone=${show(redone)} src=${show(src)}`);
  }
  if (want('merge-blocks')) {
    const doc = 'First para $e^{i\\pi}$\n\nSecond para words\n\n![im](p%20q.png "t") third para\n';
    const live = await start(doc, 'Second', 2);
    await selectAt(P, ['Second', 0]); await P.keyboard.press('Backspace'); await A.settle(400);
    const m1 = await A.source();
    const live2 = await sessionOn(P);
    if (live2) { await selectAt(P, ['words', 5]); await P.keyboard.press('Delete'); await A.settle(400); }
    const src = await esc();
    check('merge-blocks', live && m1.includes('$e^{i\\pi}$Second para') && src.includes('$e^{i\\pi}$') && src.includes('![im](p%20q.png "t")') && !src.includes('style=') && none(invisibleExtra(src, doc)),
      `live=${live} m1=${show(m1)} live2=${live2} src=${show(src)}`);
  }
  if (want('resume')) {
    const doc = '- item $a_1$ one\n- item ![i](x.png) two\n- [link](http://e.x/%E4%B8%AD) three words\n';
    const live = await start(doc, 'one', 1);
    await selectAt(P, ['one', 3]); await P.keyboard.type('A'); await sleep(1200); await A.settle(400);
    const live2 = await sessionOn(P);
    await selectAt(P, ['two', 3]); await P.keyboard.type('B'); await sleep(900); await A.settle(300);
    await selectAt(P, ['words', 5]); await P.keyboard.type('C'); await A.settle(300);
    const src = await esc();
    const n = await stampsIn(P);
    const exp = doc.replace('one', 'oneA').replace('two', 'twoB').replace('words', 'wordsC');
    check('resume', live && live2 && src === exp && n === 0, `live=${live} live2=${live2} stamps=${n} src=${show(src)}`);
  }
  if (want('tick-esc')) {
    const doc = '- [ ] one $x$ task\n- [x] two task\n- [ ] three task\n';
    const live = await start(doc, 'two', 1);
    const box = await P.evaluate(() => { const b = document.querySelectorAll('.mdr-preview .is-editing li input[type="checkbox"]')[2]; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await P.mouse.click(box.x, box.y); await sleep(500);
    await selectAt(P, ['one', 3]); await P.keyboard.type('Y'); await A.settle(300);
    const shown = await P.evaluate(() => [...document.querySelectorAll('.mdr-preview li input[type="checkbox"]')].map((b) => b.checked));
    const src = await esc();
    const shown2 = await P.evaluate(() => [...document.querySelectorAll('.mdr-preview li input[type="checkbox"]')].map((b) => b.checked));
    check('tick-esc', live && J(shown) === J(shown2) && src === '- [ ] oneY $x$ task\n- [x] two task\n- [x] three task\n', `live=${live} shown=${J(shown)} after=${J(shown2)} src=${show(src)}`);
  }
  if (want('img-bs')) {
    const doc = 'Pic ![a b](i%20m.png "T") after $q$ words\n';
    const live = await start(doc, 'after', 1);
    await selectAt(P, [' after', 0]); await P.keyboard.press('Backspace'); await A.settle(400);
    const src = await esc();
    check('img-bs', live && src === 'Pic  after $q$ words\n', `live=${live} src=${show(src)}`);
  }
  if (want('fresh-box')) {
    const doc = '- [x] one $y$ task\n- [ ] two\n';
    const live = await start(doc, 'task', 1);
    await selectAt(P, ['task', 4]); await P.keyboard.press('Enter'); await sleep(300); await P.keyboard.type('new'); await A.settle(300);
    const boxes = await P.evaluate(() => document.querySelectorAll('.mdr-preview .is-editing input[type="checkbox"]').length);
    const src = await esc();
    check('fresh-box', live && src === '- [x] one $y$ task\n- [ ] new\n- [ ] two\n' && boxes === 3, `live=${live} boxes=${boxes} src=${show(src)}`);
  }
  if (want('link-ui')) {
    const doc = 'Make a link words here\n';
    const live = await start(doc, 'words', 2);
    await selectAt(P, ['words', 0], ['words', 5]);
    await P.keyboard.press('Meta+k'); await sleep(300);
    const ui = await P.evaluate(() => !!document.querySelector('.mdr-preview__link-input input'));
    const nb = String.fromCharCode(0xa0), zw = String.fromCharCode(0x200b);
    await P.keyboard.insertText('https://e.example/a%E2%80%8Bb' + zw + 'c' + nb + 'd/%E4%B8%AD');
    await P.keyboard.press('Enter'); await A.settle(350);
    const href = await P.evaluate(() => document.querySelector('.mdr-preview .is-editing a')?.getAttribute('href') ?? null);
    const src = await esc();
    const href2 = await P.evaluate(() => document.querySelector('.mdr-preview a')?.getAttribute('href') ?? null);
    check('link-ui', live && ui && none(invisibleExtra(src, doc)) && href2 !== null && href2 === new URL(href).href.replace(/^(https:\/\/e\.example)\/?/, '$1/'), `live=${live} ui=${ui} hrefSession=${show(href)} hrefAfter=${show(href2)} src=${show(src)}`);
  }
  if (want('join-open-formula')) {
    const doc = '- one first\n- Lead $a+b$ two\n';
    const live = await start(doc, 'two', 1);
    await selectAt(P, ['first', 5]); await P.keyboard.press('Delete'); await A.settle(400);
    const pt = await P.evaluate(() => { const m = document.querySelector('.mdr-preview .is-editing .md-math'); const r = m.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tex: m.getAttribute('data-mdr-tex') }; });
    await P.mouse.click(pt.x, pt.y); await sleep(400);
    const srcEl = await P.evaluate(() => document.querySelector('.mdr-preview .is-editing .md-math-src')?.textContent ?? null);
    if (srcEl !== null) { await P.keyboard.type('+c'); await A.settle(300); }
    const src = await esc();
    check('join-open-formula', live && srcEl === 'a+b' && src === '- one firstLead $a+b+c$ two\n', `live=${live} stamp=${show(pt.tex)} opened=${show(srcEl)} src=${show(src)}`);
  }
  if (want('merge-into-list')) {
    const doc = '- a $x$\n- [x] b $\\frac{1}{2}$\n\nPara ![p](q%20r.png) words\n\n> quote $y$ end\n\nTail text\n';
    const live = await start(doc, 'Para', 2);
    await selectAt(P, ['Para', 0]); await P.keyboard.press('Backspace'); await A.settle(450);
    const m1 = await A.source();
    const live2 = await sessionOn(P);
    await esc();
    await clickText(P, 'Tail', 2); await sleep(400);
    const live3 = await sessionOn(P);
    if (live3) { await selectAt(P, ['Tail', 0]); await P.keyboard.press('Backspace'); await A.settle(450); }
    const src = await esc();
    const ok = src.includes('$x$') && src.includes('$\\frac{1}{2}$') && src.includes('![p](q%20r.png)') && src.includes('$y$') && src.includes('[x]') && !src.includes('style=') && none(invisibleExtra(src, doc));
    check('merge-into-list', live && ok && m1 !== doc, `live=${live} live2=${live2} live3=${live3} m1=${show(m1)} src=${show(src)}`);
  }
  if (want('held-esc')) {
    const doc = '- one first\n- Lead $\\sqrt[3]{x}$ ![i](a%20b.png) two\n- three\n\nOther para text\n';
    const live = await start(doc, 'two', 1);
    await P.evaluate(() => { window.__toasts = []; if (!window.__toastHook) { window.__toastHook = 1; window.__mdr.app.bus.on('toast', (t) => window.__toasts.push(t.text)); } });
    let live2 = null, typedW = null;
    await P.evaluate((ms) => { const pv = window.__mdr.app.preview; window.__oD = pv.applyStructureDelta.bind(pv); window.__oH = pv.applyHtml.bind(pv); pv.applyStructureDelta = (m) => { setTimeout(() => window.__oD(m), ms); return true; }; pv.applyHtml = (m) => { setTimeout(() => window.__oH(m), ms); }; }, 1500);
    try {
      await selectAt(P, ['Lead', 0]); await P.keyboard.press('Backspace'); await sleep(60); await P.keyboard.type('Z'); await sleep(80);
      await P.keyboard.press('Escape'); await sleep(100);
      await clickText(P, 'Other', 2); await sleep(150);
      live2 = await sessionOn(P);
      if (live2) { await selectAt(P, ['text', 4]); await P.keyboard.type('W'); typedW = await P.evaluate(() => document.querySelector('.mdr-preview .is-editing')?.textContent ?? null); }
      await sleep(2500);
    } finally { await P.evaluate(() => { const pv = window.__mdr.app.preview; pv.applyStructureDelta = window.__oD; pv.applyHtml = window.__oH; }); }
    await A.settle(400);
    const src = await esc();
    const n = await stampsIn(P);
    const ts = await P.evaluate(() => window.__toasts.slice());
    check('held-esc', live && src === '- one firstZLead $\\sqrt[3]{x}$ ![i](a%20b.png) two\n- three\n\nOther para textW\n' && n === 0, `live=${live} live2=${live2} shownAfterW=${show(typedW)} toasts=${J(ts)} stamps=${n} src=${show(src)}`);
  }
  if (want('switch-block')) {
    const doc = '- one first\n- Lead $e^x$ two\n\nOther para text\n';
    const live = await start(doc, 'two', 1);
    await selectAt(P, ['first', 5]); await P.keyboard.press('Delete');
    await clickText(P, 'Other', 2); await sleep(30);
    await P.keyboard.type('W'); await A.settle(400);
    const src = await esc();
    check('switch-block', live && src.startsWith('- one firstLead $e^x$ two\n') && src.includes('OtWher') && none(invisibleExtra(src, doc)), `live=${live} src=${show(src)}`);
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;

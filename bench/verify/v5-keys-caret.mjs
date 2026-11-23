// bench/verify/v5-keys-caret.mjs — verify-session-keys: variations of r3 J6 (P-D: the resume caret after Cmd-Z,
// Shift-Cmd-Z and a Backspace merge counts atoms; no key is swallowed). Switch ON, dev server on MDR_PORT.
// For every block and every caret position (text gaps and the two sides of each inline element): type QR, pause
// (a new history group), then
//   undo : Cmd-Z, type W       -> expected: the source with QR replaced by W
//   redo : Cmd-Z, Shift-Cmd-Z, type W -> expected: QR replaced by QRW
// and for the merge group: Backspace at the start of the paragraph after the block, type W -> W at the join.
//   MDR_PORT=5481 node bench/verify/v5-keys-caret.mjs <block-filter|all> [undo|redo|merge] [--max N]
// Global timeout 110 s.
import { open, sleep, J } from './v5-keys-lib.mjs';

const args = process.argv.slice(2);
const bf = args[0] ?? 'all';
const mode = args[1] ?? 'undo';
const mi = args.indexOf('--max'); const MAX = mi >= 0 ? Number(args[mi + 1]) : 99;
const K = await open();
const { page } = K;
const KILL = setTimeout(async () => { console.log('GLOBAL TIMEOUT'); try { await K.close(); } catch { /* */ } process.exit(3); }, 110_000);
const BLOCKS = {
  math: 'a1 $x^2$ b1 $y$c1',
  image: 'see ![i](x.png) b1 ![j](y.png)c1',
  linkimg: 'go [![i](x.png)](https://e.x) b1',
  refs: 'r1 [ref][r] b1 [r] c1',
  auto: 'u1 <https://e.x> b1 https://f.x c1',
  esc: 'e1 \\* b1 \\_ c1 &amp; d1 &copy; e2',
  emph: 'm1 **bo** b1 *it* c1 ~~st~~ d1 `co` e1',
  foot: 'f1[^1] b1',
  hard: 'h1  \nh2\\\nh3',
  item: '- one $x$\n- two ![i](x.png)\n- [ ] task $z$',
  heading: '## head $x$ b1',
  cell: '| a $x$ | b ![i](x.png) |\n| --- | --- |\n| c1 $y$ | d1 |',
};
const DEFS = '\n\n[r]: https://r.x\n\n[^1]: note\n';
let bad = 0, n = 0;
try {
  for (const [bname, block] of Object.entries(BLOCKS)) {
    if (bf !== 'all' && !bname.startsWith(bf)) continue;
    const doc = `top para\n\n${block}\n\nnext para${DEFS}`;
    await K.load(doc);
    // the caret positions of this block, computed once in a session on it
    const firstWord = block.replace(/^(#+ |- \[ \] |- |\| )/, '').split(/[ $!\[]/)[0];
    await K.clickText(firstWord, 0); await sleep(300);
    const npos = await page.evaluate(() => {
      const el = document.querySelector('.mdr-preview .is-editing');
      if (!el) return -1;
      const pts = [];
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let t = w.nextNode(); t; t = w.nextNode()) {
        if (t.parentElement.closest('.md-math, .katex, [contenteditable=false]')) continue;
        if (!t.data.trim()) continue;
        for (let i = 0; i <= t.data.length; i++) pts.push(['t', t, i]);
      }
      el.querySelectorAll('.md-math, img, a, code, strong, em, s, del, sup, input').forEach((e) => { pts.push(['b', e]); pts.push(['a', e]); });
      window.__pts = pts;
      return pts.length;
    });
    if (npos < 0) { console.log(`RESULT ${bname} ERROR no session`); bad++; continue; }
    const step = Math.max(1, Math.ceil(npos / MAX));
    for (let p = 0; p < npos; p += step) {
      n++;
      try {
        await K.load(doc);
        await K.clickText(firstWord, 0); await sleep(250);
        // rebuild the same point list in the new session and set the caret at point p
        const desc = await page.evaluate((p) => {
          const el = document.querySelector('.mdr-preview .is-editing');
          const pts = [];
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let t = w.nextNode(); t; t = w.nextNode()) {
            if (t.parentElement.closest('.md-math, .katex, [contenteditable=false]')) continue;
            if (!t.data.trim()) continue;
            for (let i = 0; i <= t.data.length; i++) pts.push(['t', t, i]);
          }
          el.querySelectorAll('.md-math, img, a, code, strong, em, s, del, sup, input').forEach((e) => { pts.push(['b', e]); pts.push(['a', e]); });
          const q = pts[p]; if (!q) return null;
          const r = document.createRange();
          if (q[0] === 't') r.setStart(q[1], q[2]); else if (q[0] === 'b') r.setStartBefore(q[1]); else r.setStartAfter(q[1]);
          r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          return q[0] === 't' ? `text ${JSON.stringify(q[1].data.slice(0, q[2]))}|${JSON.stringify(q[1].data.slice(q[2]))}` : `${q[0] === 'b' ? 'before' : 'after'} <${q[1].tagName.toLowerCase()}${q[1].className ? '.' + String(q[1].className).split(' ')[0] : ''}>`;
        }, p);
        if (!desc) continue;
        if (mode === 'merge') {
          // the block after: Backspace at its start joins it to this block (U3); W must land at the join
          await page.keyboard.press('Escape'); await K.idle(300);
          await K.clickText('next para', 0); await sleep(250);
          await K.caretAfter('next', 'before');
          await page.keyboard.press('Backspace'); await K.idle(300);
          const joined = await K.src();
          await page.keyboard.type('W'); await K.idle(300);
          await page.keyboard.press('Escape'); await K.idle(300);
          const after = await K.src();
          const ok = after.includes('Wnext para') && after.replace('W', '') === joined;
          if (!ok) bad++;
          console.log(`RESULT ${bname} merge ${ok ? 'ok' : 'BAD'} ${J({ joined, after })}`);
          break;   // one merge per block
        }
        await page.keyboard.type('QR'); await sleep(900);
        const withQR = await K.src();
        if (!withQR.includes('QR')) { bad++; console.log(`RESULT ${bname} #${p} ${desc} BAD-TYPE QR not written ${J(withQR)}`); continue; }
        await page.keyboard.press('ControlOrMeta+z'); await K.idle(350);
        let expected = withQR.replace('QR', 'W');
        if (mode === 'redo') { await page.keyboard.press('ControlOrMeta+Shift+z'); await K.idle(350); expected = withQR.replace('QR', 'QRW'); }
        const sess = await K.session();
        await page.keyboard.type('W'); await K.idle(350);
        await page.keyboard.press('Escape'); await K.idle(300);
        const after = await K.src();
        const ok = after === expected;
        if (!ok) bad++;
        console.log(`RESULT ${bname} #${p} ${mode} ${desc} ${ok ? 'ok' : 'BAD'}${ok ? '' : ' ' + J({ expected, after, before: sess && sess.before })}`);
      } catch (e) { bad++; console.log(`RESULT ${bname} #${p} ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally { clearTimeout(KILL); await K.close().catch(() => {}); console.log(`DONE n=${n} bad=${bad}`); process.exit(bad ? 1 : 0); }

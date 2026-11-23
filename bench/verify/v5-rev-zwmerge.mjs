// bench/verify/v5-rev-zwmerge.mjs — verify-review (0.2.0 round 4): J2 / P-A at the code level. In a block whose own
// DOM holds zero-width characters (KaTeX's \frac output does), scrubHelpers removes only REGISTERED helpers. This
// probe makes Chromium move a U21 spacer into another text node (Backspace at the start of a line that begins with a
// formula joins the lines) and then counts the zero-width characters outside KaTeX in the wrapper: in the session,
// right after Esc (before the re-render mounts: the slow-worker hook holds it), and what a copy of the block puts on the
// clipboard then. Switch ON (dev server default).
// Run: MDR_PORT=5487 node bench/verify/v5-rev-zwmerge.mjs [runs=1]. Writes nothing into the tree. Global timeout 100 s.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const RUNS = Number(process.argv[2] || 1);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BS = String.fromCharCode(92);
const DOCS = {
  'frac-hardbreak': 'Intro ' + '$' + BS + 'frac{a}{b}$ text  \n$y$ after words\n',
  'nofrac-hardbreak': 'Intro $x$ text  \n$y$ after words\n',
  'frac-item': '- Intro $' + BS + 'frac{a}{b}$ text  \n  $y$ after words\n',
};
const ZW = (s) => Array.from(s).filter((c) => c === String.fromCharCode(0x200b) || c === String.fromCharCode(0xfeff)).length;
const outsideKatex = () => {
  const w = document.querySelector('.md-block.is-editing') || window.__revW;
  if (!w) return -1;
  let k = 0;
  const tw = document.createTreeWalker(w, 4);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.parentElement?.closest('.katex, .md-math')) continue;
    for (const c of n.data) if (c.charCodeAt(0) === 0x200b || c.charCodeAt(0) === 0xfeff) k++;
  }
  return k;
};
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/?mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  for (const [name, doc] of Object.entries(DOCS)) for (let run = 0; run < RUNS; run++) {
    await page.evaluate(() => { const pv = window.__mdr.app.preview; if (window.__origHtml) { pv.applyHtml = window.__origHtml; } window.__revW = null; });
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'zw.md'), [doc]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(600);
    const p = await page.evaluate(() => {
      const tw = document.createTreeWalker(window.__mdr.app.preview.el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const i = n.data.indexOf('after');
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; }
      }
      return null;
    });
    if (!p) { console.log(name, 'no target'); continue; }
    await page.mouse.click(p.x, p.y);
    await sleep(250);
    const inSession = await page.evaluate(outsideKatex);
    // caret to the start of the second line (before the U21 spacer of its leading formula), then Backspace
    await page.evaluate(() => {
      const w = document.querySelector('.md-block.is-editing');
      window.__revW = w;
      const br = w.querySelector('br');
      const sel = document.getSelection();
      const r = document.createRange();
      r.setStartAfter(br); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    });
    await page.keyboard.press('Backspace');
    await sleep(150);
    const afterJoin = await page.evaluate(outsideKatex);
    // hold the re-render, end the session
    await page.evaluate(() => {
      const pv = window.__mdr.app.preview;
      window.__origHtml = window.__origHtml || pv.applyHtml.bind(pv);
      pv.applyHtml = (m) => setTimeout(() => window.__origHtml(m), 1500);
    });
    await page.keyboard.press('Escape');
    await sleep(100);
    const afterEsc = await page.evaluate(outsideKatex);
    // copy the whole wrapper's content in that window
    await page.evaluate(() => { const w = window.__revW; const r = document.createRange(); r.selectNodeContents(w); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Meta+c');
    await sleep(100);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => 'ERR ' + e));
    await sleep(1800);
    const src = await page.evaluate(() => window.__mdr.app.getText());
    const katexZw = await page.evaluate(() => { const w = window.__revW; let k = 0; for (const e of w.querySelectorAll('.katex, .md-math')) for (const c of e.textContent) if (c.charCodeAt(0) === 0x200b) k++; return k; });
    const leaked = afterEsc > 0;
    if (leaked) bad++;
    console.log(`${leaked ? 'FAIL' : 'ok  '} ${name} run${run} outsideKatex: session=${inSession} afterJoin=${afterJoin} afterEsc=${afterEsc}; clipboard ZW=${ZW(clip)} (KaTeX's own in the wrapper=${katexZw}); source ZW=${ZW(src)} source=${JSON.stringify(src)}`);
  }
  console.log(`${bad} leaking`);
} finally {
  clearTimeout(killer);
  await browser.close();
}

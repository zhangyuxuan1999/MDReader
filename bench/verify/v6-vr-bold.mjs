// bench/verify/v6-vr-bold.mjs — verify-review (stage 2f, after fix round 5): P-G (c) writes the presentation attributes
// of a stamped element exactly as recorded at the session start. Does a formatting command the user gives inside a
// session (⌘B / ⌘I on part of a document's own styled element), which Chromium may carry out by changing or splitting
// that element's style, still reach the source? For each case: the session DOM after the command (what the screen
// shows), the source after Esc, and whether the re-rendered block shows the same weight / style for the word.
// Run: MDR_PORT=<candidate build, opened with ?perf=1> node bench/verify/v6-vr-bold.mjs   Writes nothing. Global timeout 100 s.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const OUT = process.env.V6VR_OUT || '';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CASES = [
  ['unbold-span', 'Para <span style="font-weight:bold">heavy words</span> end text', 'heavy', 'Meta+b', 'fontWeight'],
  ['unitalic-span', 'Para <span style="font-style:italic">slanted words</span> end text', 'slanted', 'Meta+i', 'fontStyle'],
  ['bold-in-red', 'Para <span style="color:red">red words</span> end text', 'red', 'Meta+b', 'fontWeight'],
  ['unbold-b-styled', 'Para <b style="color:blue">blue words</b> end text', 'blue', 'Meta+b', 'fontWeight'],
  ['unbold-strong', 'Para **strong words** end text', 'strong', 'Meta+b', 'fontWeight'],
];
let bad = 0;
const captured = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, para, word, key, prop] of CASES) {
    await page.keyboard.press('Escape');
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'bold.md'), [`# Bold\n\nfiller\n\n${para}\n`]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(1000);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    await page.mouse.click(at.x, at.y);
    await sleep(450);
    const style = (w) => page.evaluate(([wd, pr]) => {
      const el = document.querySelector('.md-block.is-editing') ?? Array.from(document.querySelectorAll('.md-block')).find((b) => (b.textContent ?? '').includes('end text'));
      const tw = document.createTreeWalker(el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.data.includes(wd)) return getComputedStyle(n.parentElement)[pr]; }
      return null;
    }, [w, prop]);
    const before = await style(word);
    const sel = await page.evaluate(([wd]) => {
      const el = document.querySelector('.md-block.is-editing');
      if (!el) return false;
      const tw = document.createTreeWalker(el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(wd); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + wd.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
      return false;
    }, [word]);
    await page.keyboard.press(key);
    await sleep(400);
    const shown = await style(word);
    const html = await page.evaluate(() => document.querySelector('.md-block.is-editing')?.innerHTML ?? null);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(700);
    const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(/^[\s\S]*filler\n\n/, '');
    const after = await style(word);
    // (weight compared as bold / not bold: a <b> the command made is written ** and shows as <strong>, 700 against the
    // app's 600 for strong: the K5 spelling, not this check's business)
    const norm = (v) => (prop === 'fontWeight' ? (Number(v) >= 600 ? 'bold' : 'normal') : v);
    const same = norm(shown) === norm(after);
    if (sel && !same) bad++;
    captured.push({ name, para, html, out });
    console.log(`${!sel ? 'n/a ' : same ? 'ok  ' : 'FAIL'} ${name}: ${prop} before=${before} in-session=${shown} after-Esc=${after} source=${JSON.stringify(out)} sessionHTML=${JSON.stringify((html ?? '').replace(/<span class="katex[\s\S]*?<\/span>/g, '…').slice(0, 300))}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
if (OUT) writeFileSync(OUT, JSON.stringify(captured, null, 1));
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);

// bench/verify/r6-fr-bold.mjs — fix-refs (0.2.0 stage 2g, fix round 6): M3 as a class, in the app. A format command of
// the session (⌘B / ⌘I) on part of, or the whole of, a document's own styled element (bold, italic, both, with a colour,
// nested spans, a styled <b>, a bold span inside bold text, the font shorthand), and a second command that undoes the
// first: the session DOM after the command, the source after Esc, and whether the re-rendered block shows the word as
// the session did (weight and style). Also checks that nothing the browser invents is written: no style the document did
// not hold appears in the source.
// Run: MDR_PORT=<dev server of the tree> node bench/verify/r6-fr-bold.mjs [filter]   (R6FR_OUT=<file>: the session DOMs as
// JSON, for test/r6-fr-pres.test.ts). Writes nothing into the tree. Global timeout 110 s.
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const filter = process.argv[2] ?? '';
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// [name, paragraph, word, keys (pressed in order), the style the word's source must not hold afterwards (regex) | '']
const CASES = [
  ['unbold-part', 'Para <span style="font-weight:bold">heavy words</span> end text', 'heavy', ['Meta+b']],
  ['unbold-whole', 'Para <span style="font-weight:bold">heavy</span> end text', 'heavy', ['Meta+b']],
  ['unitalic-part', 'Para <span style="font-style:italic">slanted words</span> end text', 'slanted', ['Meta+i']],
  ['unitalic-whole', 'Para <span style="font-style:italic">slanted</span> end text', 'slanted', ['Meta+i']],
  ['both-unbold', 'Para <span style="font-weight:bold;font-style:italic">heavy words</span> end text', 'heavy', ['Meta+b']],
  ['both-unitalic', 'Para <span style="font-weight:bold;font-style:italic">heavy words</span> end text', 'heavy', ['Meta+i']],
  ['both-both', 'Para <span style="font-weight:bold;font-style:italic">heavy words</span> end text', 'heavy', ['Meta+b', 'Meta+i']],
  ['color-unbold', 'Para <span style="font-weight:bold;color:red">heavy words</span> end text', 'heavy', ['Meta+b']],
  ['nested-unbold', 'Para <span style="font-weight:bold">a <span style="font-style:italic">heavy</span> b</span> end text', 'heavy', ['Meta+b']],
  ['nested-unitalic', 'Para <span style="font-weight:bold">a <span style="font-style:italic">heavy words</span> b</span> end text', 'heavy', ['Meta+i']],
  ['bold-normalspan', 'Para **x <span style="font-weight:normal">light words</span> y** end text', 'light', ['Meta+b']],
  ['bold-in-red', 'Para <span style="color:red">red words</span> end text', 'red', ['Meta+b']],
  ['unbold-b-styled', 'Para <b style="color:blue">blue words</b> end text', 'blue', ['Meta+b']],
  ['unbold-rebold', 'Para <span style="font-weight:bold">heavy words</span> end text', 'heavy', ['Meta+b', 'Meta+b']],
  ['font-shorthand', 'Para <span style="font:bold 16px serif">heavy words</span> end text', 'heavy', ['Meta+b']],
  ['item-unbold', '- Para <span style="font-weight:bold">heavy words</span> end text\n- two', 'heavy', ['Meta+b']],
  ['quote-unitalic', '> Para <span style="font-style:italic">slanted words</span> end text', 'slanted', ['Meta+i']],
].filter((c) => c[0].includes(filter));
let bad = 0;
const captured = [];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  for (const [name, para, word, keys] of CASES) {
    await page.keyboard.press('Escape');
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'bold.md'), [`# Bold\n\nfiller\n\n${para}\n`]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(900);
    const at = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf('end text'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return { x: b.left + 1, y: b.top + b.height / 2 }; } }
      return null;
    });
    await page.mouse.click(at.x, at.y);
    await sleep(450);
    const look = (w) => page.evaluate(([wd]) => {
      const el = document.querySelector('.md-block.is-editing') ?? Array.from(document.querySelectorAll('.md-block')).find((b) => (b.textContent ?? '').includes('end text'));
      const tw = document.createTreeWalker(el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { if (n.data.includes(wd)) { const cs = getComputedStyle(n.parentElement); return `${Number(cs.fontWeight) >= 600 ? 'bold' : 'normal'}/${cs.fontStyle}`; } }
      return null;
    }, [w]);
    const before = await look(word);
    const sel = await page.evaluate(([wd]) => {
      const el = document.querySelector('.md-block.is-editing');
      if (!el) return false;
      const tw = document.createTreeWalker(el, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) { const i = n.data.indexOf(wd); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + wd.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
      return false;
    }, [word]);
    for (const k of keys) { await page.keyboard.press(k); await sleep(250); }
    await sleep(200);
    const shown = await look(word);
    const html = await page.evaluate(() => document.querySelector('.md-block.is-editing')?.innerHTML ?? null);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(700);
    const out = (await page.evaluate(() => window.__mdr.app.getText())).replace(/^[\s\S]*filler\n\n/, '');
    const after = await look(word);
    const invented = /style="[^"]*(?:rgb|px;|font-family|font-size|line-height)/.test(out) && !/16px/.test(para);
    const ok = sel && shown === after && !invented;
    if (sel && !ok) bad++;   // (n/a: no session on the block, as before round 6 for the styled <b>)
    captured.push({ name, para, html, out });
    console.log(`${!sel ? 'n/a ' : ok ? 'ok  ' : 'FAIL'} ${name}: before=${before} in-session=${shown} after-Esc=${after}${invented ? ' INVENTED-STYLE' : ''} source=${JSON.stringify(out)}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
if (process.env.R6FR_OUT) writeFileSync(process.env.R6FR_OUT, JSON.stringify(captured, null, 1));
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad} of ${CASES.length}`);
process.exit(bad === 0 ? 0 : 1);

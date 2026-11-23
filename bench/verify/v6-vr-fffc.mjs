// bench/verify/v6-vr-fffc.mjs — verify-review (stage 2f, after fix round 5): U+FFFC OBJECT REPLACEMENT CHARACTER is a
// symbol (So), so rule J19 extended's predicate (rawInUrl: L / N / P / S minus the blank list) lets it stand raw in a URL,
// but Chromium draws it with no ink (bench/verify/v6-vr-blank.mjs: the one blank code point of the 157 064 allowed).
// (a) ink: the editor line and the preview text holding "a<U+FFFC>b" are screenshotted and the pixels between a and b
//     counted against the background; (b) the write: a block with a reference link whose definition (in another block)
//     has the href …a%EF%BF%BCb (no source spelling in the block: the predicate path); a click at the end of "words"
//     starts a session, "X" is typed, Esc ends it. FAIL when the source then holds a raw U+FFFC.
// Run: MDR_PORT=<candidate build, opened with ?perf=1> node bench/verify/v6-vr-fffc.mjs   (MDR_RUNS, default 2)
// Writes nothing into the tree. Global timeout 100 s. The character is built from its code point.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const RUNS = Number(process.env.MDR_RUNS || 2);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OBJ = String.fromCodePoint(0xfffc);
let bad = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
  await page.goto(`http://localhost:${port}/?perf=1&mode=split`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  await page.addStyleTag({ content: '[class*="mdr-perf"] { visibility: hidden !important; pointer-events: none !important; }' });
  // (a) ink of U+FFFC in the editor and in the preview, next to a control gap of the same width
  await page.evaluate(([t]) => window.__mdr.loadText(t, 'fffc.md'), [`# Ink\n\nfiller\n\nseeA${OBJ}Bsee\n`]);
  await page.evaluate(() => window.__mdr.waitIdle());
  await sleep(900);
  for (const where of ['.cm-content', '.md-block']) {
    const box = await page.evaluate(([sel, ch]) => {
      for (const root of Array.from(document.querySelectorAll(sel))) {
        const tw = document.createTreeWalker(root, 4);
        for (let n = tw.nextNode(); n; n = tw.nextNode()) {
          const i = n.data.indexOf(ch);
          if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }
        }
      }
      return null;
    }, [where, OBJ]);
    if (!box || box.w < 1) { console.log(`info ink ${where}: width ${box ? box.w : 'none'} (no box to look at)`); continue; }
    const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.max(1, box.w), height: Math.max(1, box.h) } });
    // count pixels that differ from the top-left pixel (the background) in the decoded PNG through the page itself
    const ink = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) n++;
      return { n, w: c.width, h: c.height };
    }, png.toString('base64'));
    console.log(`info ink ${where}: U+FFFC box ${box.w.toFixed(1)}x${box.h.toFixed(1)} px, inked pixels ${ink.n} of ${ink.w * ink.h}`);
  }
  // (b) the write through the predicate path
  const DOC = `# Ref\n\nfiller one\n\nfiller two\n\nSee [r][R] here\nsecond line words\n\n[R]: https://e.example/a%EF%BF%BCb\n`;
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(([t]) => window.__mdr.loadText(t, 'fffc.md'), [DOC]);
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(1200);
    const p = await page.evaluate(() => {
      const root = window.__mdr.app.preview.el;
      const tw = document.createTreeWalker(root, 4);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const i = n.data.indexOf('words');
        if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 4); r.setEnd(n, i + 5); const b = r.getBoundingClientRect(); return { x: b.right - 1, y: b.top + b.height / 2 }; }
      }
      return null;
    });
    if (!p) { console.log('no target'); bad++; continue; }
    await page.mouse.click(p.x, p.y);
    await sleep(450);
    const live = await page.evaluate(() => !!document.querySelector('.md-block.is-editing'));
    await page.keyboard.type('X');
    await sleep(250);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__mdr.waitIdle());
    await sleep(400);
    const out = await page.evaluate(() => window.__mdr.app.getText());
    const typed = out.includes('wordsX');
    const raw = out.includes(OBJ);
    if (typed && raw) bad++;
    const showS = (s) => JSON.stringify(s.replace(/[^\x20-\x7e\n]/gu, (c) => '<' + c.codePointAt(0).toString(16) + '>'));
    console.log(`${typed && raw ? 'FAIL' : typed ? 'ok  ' : 'n/a '} ref-fffc run${run} session=${live} typed=${typed} rawFFFC=${raw} source=${showS(out)}`);
  }
} finally { await browser.close(); clearTimeout(killer); }
console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'} bad=${bad}`);
process.exit(bad === 0 ? 0 : 1);

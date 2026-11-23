// bench/verify/v6-vo-tickscroll.mjs — verify-off (0.2.0 stage 2f, round 5): where the EDITOR's scroll goes when a task box
// in the preview is ticked while the editor shows another part of the document (a REAL USER, no ?perf=1, switch off).
// The editor is scrolled to the end by typing there; the preview is scrolled to the top; then a box near the top is
// clicked (and, as a control, a plain paragraph is clicked). Prints both scroll positions before and after, the line at
// the editor's top, and the source change, for every port given (candidate, 0.1.1, the last candidate).
//   node bench/verify/v6-vo-tickscroll.mjs <port> [<port> ...]      Global timeout 110 s. Writes nothing.
import { chromium } from '@playwright/test';

const ports = process.argv.slice(2);
const NL = String.fromCharCode(10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOC = ['# Tick scroll', '', '- [ ] alpha task', '- [ ] beta task', '', 'Top paragraph.', '', ...Array.from({ length: 90 }, (_, i) => `Filler paragraph ${i} with some words.` + NL)].join(NL);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const browser = await chromium.launch({ headless: true });
try {
  for (const port of ports) {
    for (const what of ['box', 'para', 'box-wait1s']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.removeItem('mdr.previewEdit'); } catch {} });
      const page = await ctx.newPage();
      await page.goto(`http://localhost:${port}/`);
      await page.waitForSelector('.cm-content');
      await sleep(500);
      const dt = await page.evaluateHandle((t) => { const d = new DataTransfer(); d.items.add(new File([t], 'ts.md', { type: 'text/markdown' })); return d; }, DOC);
      for (const ev of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent('.mdr-preview', ev, { dataTransfer: dt });
      await page.waitForFunction(() => /Filler paragraph 5/.test(document.querySelector('.mdr-preview')?.textContent || ''));
      await sleep(800);
      const pos = () => page.evaluate(() => {
        const sc = document.querySelector('.cm-scroller');
        let p = document.querySelector('.mdr-preview'); while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
        const c = document.querySelector('.cm-content');
        const v = c.cmTile.root.view;
        const top = v.lineBlockAtHeight(sc.scrollTop);
        return { eTop: Math.round(sc.scrollTop), eTopLine: v.state.doc.lineAt(top.from).number, pTop: p ? Math.round(p.scrollTop) : null, caret: v.state.doc.lineAt(v.state.selection.main.head).number, ticked: (v.state.doc.toString().match(/- \[x\]/g) || []).length };
      });
      await page.click('.cm-content'); await page.keyboard.press('Meta+End'); await page.keyboard.type('end text');
      await sleep(what === 'box-wait1s' ? 1000 : 300);
      await page.evaluate(() => { let p = document.querySelector('.mdr-preview'); while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement; if (p) p.scrollTop = 0; });
      await sleep(700);
      const before = await pos();
      if (what === 'para') await page.locator('.mdr-preview p', { hasText: 'Top paragraph' }).click();
      else await page.click('.mdr-preview input[type=checkbox] >> nth=1');
      await sleep(900);
      const after = await pos();
      console.log(`${port} ${what.padEnd(10)} before ${JSON.stringify(before)}  after ${JSON.stringify(after)}`);
      await ctx.close();
    }
  }
} finally {
  clearTimeout(KILL);
  await browser.close();
}

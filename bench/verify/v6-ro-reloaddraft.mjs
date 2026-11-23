// bench/verify/v6-ro-reloaddraft.mjs — regress-off (stage 2f, round 5): the reload-editor control of
// bench/verify/v5-sw-user.mjs measured more closely. A user's production build (no ?perf=1, nothing stored: the
// switch off), an untitled document typed into the editor (insertText), "ZQ" typed with real keys, a reload <wait> ms
// later; then for 8 s: when the draft offer appears, what the stored drafts hold (the document? ZQ?), and the editor's
// text. Each run uses a fresh browser context (fresh storage).
//   node bench/verify/v6-ro-reloaddraft.mjs <runs> <wait-ms> <port> [<port> ...]
// Prints one line per run and port and a summary per port: runs whose stored draft lacks the document itself, runs
// with no offer within 8 s, runs whose ZQ is missing. Global timeout 110 s. Writes nothing.
import { chromium } from '@playwright/test';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const [runsArg, waitArg, ...ports] = process.argv.slice(2);
const RUNS = Number(runsArg || 3), WAIT = Number(waitArg || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOC = '# Head\n\nAlpha paragraph words here.\n\nBeta paragraph more words.\n\nGamma paragraph last words.\n';
const browser = await chromium.launch({ headless: true });
const sum = {};
try {
  for (let r = 0; r < RUNS; r++) {
    for (const port of ports) {
      const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
      try {
        const page = await ctx.newPage();
        page.on('dialog', (d) => d.accept().catch(() => {}));
        await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.cm-content', { timeout: 20000 }); await sleep(600);
        await page.click('.cm-content'); await page.keyboard.press('Meta+a'); await page.keyboard.insertText(DOC); await sleep(1000);
        await page.keyboard.press('Meta+ArrowDown'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Home');
        for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
        await page.keyboard.type('ZQ');
        const before = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mdr.draft')).map((k) => localStorage.getItem(k) || '').join('|'));
        if (WAIT) await sleep(WAIT);
        const t0 = Date.now();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.cm-content', { timeout: 20000 });
        let offerMs = null;
        for (let i = 0; i < 80; i++) { if (await page.$('button:has-text("恢复")')) { offerMs = Date.now() - t0; break; } await sleep(100); }
        const drafts = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mdr.draft')).map((k) => localStorage.getItem(k) || '').join('|'));
        // as v5-sw-user does: 1.4 s after the reload, is the offer still there; accept it; what does the editor hold
        while (Date.now() - t0 < 1400) await sleep(50);
        const btn = await page.$('button:has-text("恢复")');
        const offerAt1400 = !!btn;
        if (btn) { await btn.click(); await sleep(800); }
        const editor = await page.evaluate(() => [...document.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join('\n'));
        const row = { offerMs, offerAt1400, draftHasDoc: drafts.includes('Gamma paragraph'), draftHasZQ: drafts.includes('ZQ'), beforeReloadDraftHasDoc: before.includes('Gamma paragraph'), editorHasDoc: editor.includes('Beta paragraph'), editorHasZQ: editor.includes('ZQ') };
        console.log(`run ${r} port ${port} wait ${WAIT}: ${JSON.stringify(row)}`);
        const s = (sum[port] ??= { runs: 0, noOffer: 0, offerGoneAt1400: 0, docLost: 0, zqLost: 0 });
        s.runs++; if (offerMs === null) s.noOffer++; if (!offerAt1400) s.offerGoneAt1400++; if (!row.editorHasDoc) s.docLost++; if (!row.editorHasZQ) s.zqLost++;
      } catch (e) { console.log(`run ${r} port ${port}: ERROR ${String(e && e.message).split('\n')[0]}`); }
      finally { await ctx.close().catch(() => {}); }
    }
  }
} finally { clearTimeout(KILL); await browser.close().catch(() => {}); }
for (const [p, s] of Object.entries(sum)) console.log(`SUMMARY port ${p}: ${JSON.stringify(s)}`);

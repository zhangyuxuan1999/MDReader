// bench/verify/r5-int-copyprobe.mjs — integrate (round 5): headless stand-in for bench/electron/v5-offk-copy.mjs's
// DOM-range cases (that script uses the SYSTEM clipboard; this one never does). Two production builds (switch off,
// ?perf=1 with mdr.previewEdit = '0', document loaded through window.__mdr.loadText), the same ranges in the same
// order; for each: what the selection holds, where focus is, and what a copy event would carry (the data a handler
// set, or the selection when no handler set any).
//   [BLUR=1] node bench/verify/r5-int-copyprobe.mjs <portA> <portB> [runs=2]      Starts no server. Global timeout 110 s.
// BLUR=1: the focused element (the editor, after loadText) is blurred before the ranges are made.
import { chromium } from '@playwright/test';
const [pa, pb] = process.argv.slice(2, 4).map(Number);
const RUNS = Number(process.argv[4] || 2);
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
// the very document of v5-offk-copy.mjs (its array literal, evaluated here)
import fs from 'node:fs';
const SRC = fs.readFileSync(new URL('../electron/v5-offk-copy.mjs', import.meta.url), 'utf8');
const DOC = new Function('return ' + SRC.slice(SRC.indexOf('const DOC = [') + 12, SRC.indexOf(".join('", SRC.indexOf('const DOC = ['))) + '.join(String.fromCharCode(10))')();
const ranges = { all: null, 'p-to-table': ['p', 'table'], 'math-to-list': ['.katex-display, .md-math', 'ul'], 'list-only': ['ul', 'ul'], 'code-to-end': ['pre', 'p:last-of-type'] };
const browser = await chromium.launch();
try {
  for (let run = 0; run < RUNS; run++) for (const port of [pa, pb]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { localStorage.setItem('mdr.previewEdit', '0'); } catch { /* */ } });
    const page = await ctx.newPage();
    try {
      await page.goto(`http://localhost:${port}/?perf=1`);
      await page.waitForFunction(() => !!window.__mdr, null, { timeout: 20000 });
      await page.evaluate((t) => window.__mdr.loadText(t, 'copy.md'), DOC);
      await page.waitForFunction(() => /最后一段/.test(document.querySelector('.mdr-preview')?.textContent || ''), null, { timeout: 15000 });
      await page.waitForTimeout(1500);
      if (process.env.BLUR) await page.evaluate(() => document.activeElement?.blur?.());
      await page.evaluate(() => {
        window.__copies = [];
        window.addEventListener('copy', (e) => {
          const set = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
          window.__copies.push({ target: (e.target.closest?.('.cm-content') ? 'editor' : e.target.closest?.('.mdr-preview') ? 'preview' : e.target.nodeName), set, prevented: e.defaultPrevented, sel: String(getSelection()) });
        });
      });
      const res = [];
      for (const [name, r] of Object.entries(ranges)) {
        await page.evaluate((rr) => {
          const root = document.querySelector('.mdr-preview'); const s = getSelection(); const g = document.createRange();
          if (!rr) g.selectNodeContents(root); else { const a = root.querySelector(rr[0]); const b = [...root.querySelectorAll(rr[1])].pop(); g.setStartBefore(a); g.setEndAfter(b); }
          s.removeAllRanges(); s.addRange(g);
        }, r);
        await page.waitForTimeout(100);
        const before = await page.evaluate(() => ({ sel: String(getSelection()).slice(0, 30), active: document.activeElement?.className?.toString().slice(0, 30) || document.activeElement?.nodeName }));
        await page.keyboard.press('Meta+c');
        await page.waitForTimeout(500);
        const c = await page.evaluate(() => window.__copies.pop() || null);
        const got = c ? (c.prevented ? c.set : c.sel) : '(no copy event)';
        res.push(`${name}: active=${before.active} selBefore=${JSON.stringify(before.sel)} copyTarget=${c?.target} text=${JSON.stringify(got.slice(0, 30))}`);
      }
      console.log(`RUN ${run} port ${port}\n  ` + res.join('\n  '));
    } catch (e) { console.log(`RUN ${run} port ${port} THREW ${String(e).split('\n')[0]}`); } finally { await ctx.close(); }
  }
} finally { clearTimeout(KILL); await browser.close(); }

// bench/verify/v2-app-stale-gap.mjs — verify-app: gap sweep for v2-app-stale.mjs S2 (emptied block, then a
// checkbox click elsewhere): for each mousedown→mouseup gap prints which task got toggled, and whether the
// clicked <input> element survived until mouseup.  Run: MDR_PORT=5283 node bench/verify/v2-app-stale-gap.mjs
import { openBrowser, sleep, readRoot } from './v2-app-lib.mjs';
// MDR_TAIL=large: append test-data/large.md after the tasks (slower worker round trip)
const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 100_000);
const B = await openBrowser(); const { page } = B;
const TASKS = ['甲段落文字。', '', '- [ ] 任务一', '- [ ] 任务二', '- [ ] 任务三', '- [ ] 任务四', ''].join('\n') + (process.env.MDR_TAIL ? '\n' + readRoot(`test-data/${process.env.MDR_TAIL}.md`) : '');
try {
  await B.boot('mode=split');
  for (const gap of [0, 5, 10, 20, 30, 45, 60, 90, 150]) {
    await B.loadDoc(TASKS);
    await B.clickLine(1, 'first', '甲段'); await B.caretAt('甲段落文字。');
    await page.evaluate(() => { const el = document.querySelector('.mdr-preview .is-editing'); const r = document.createRange(); r.selectNodeContents(el.querySelector('p')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press('Backspace'); await sleep(120);
    const p = await page.evaluate(() => { const b = [...document.querySelectorAll('.mdr-preview li')].find((li) => li.textContent.includes('任务二')).querySelector('input'); window.__v2box = b; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(p.x, p.y); await page.mouse.down(); if (gap) await sleep(gap);
    const same = await page.evaluate(() => window.__v2box.isConnected);
    await page.mouse.up(); await B.settle(400);
    const s = await B.source();
    const tasks = s.split('\n').slice(0, 8).filter((l) => l.includes('任务')).map((l) => (l.startsWith('- [x]') ? 'X' : '.')).join('');
    console.log(`gap ${String(gap).padStart(3)} ms: tasks ${tasks} (want .X..)  clicked input still connected at mouseup: ${same}`);
  }
} finally { clearTimeout(KILL); await B.browser.close().catch(() => {}); }

// bench/verify/v5-chc-shapes.mjs — challenge-c: task items whose source line the tick's TASK_LINE test does not
// recognise (a task inside a nested container that starts on the same line: "- > - [ ] x", "1. - [ ] x", "- - [ ] x",
// a task whose box is on the line after its marker), at rest, switch OFF: what a click on each box does (source change,
// toast, the box shown afterwards). Run: MDR_PORT=5487 node bench/verify/v5-chc-shapes.mjs cand | MDR_BASE_PORT=5497 ... base
import { openPage, install, load, judge, sleep, J } from './v5-chc-lib.mjs';
const target = process.argv[2] || 'cand';
const killer = setTimeout(() => { console.log('TIMEOUT'); process.exit(3); }, 100000);
const DOC = 'Intro\n\n- > - [ ] q1 quote in item\n\n1. - [ ] q2 bullet in ordered\n\n- - [ ] q3 bullet in bullet\n\n-\n  [ ] q4 box on next line\n\n- [ ] q5 plain\n';
const { browser, page } = await openPage(target);
try {
  for (const tok of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    await load(page, DOC); await install(page);
    const p = await page.evaluate((tok) => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').includes(tok)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tok);
    if (!p) { console.log(tok, 'nobox'); continue; }
    await page.mouse.click(p.x, p.y);
    const j = await judge(page, 800);
    const shown = await page.evaluate((tok) => { const b = Array.from(document.querySelectorAll('.mdr-preview input[type="checkbox"]')).find((x) => (x.closest('li')?.textContent || '').includes(tok)); return b ? b.checked : null; }, tok);
    const toasts = await page.evaluate(() => window.__chc.toasts.map((t) => t.text));
    console.log(tok, J({ verdict: j.verdict, toasts, shownAfter: shown, src: (await page.evaluate(() => window.__mdr.app.getText())).split('\n').filter((l) => l.includes('[x]')) }));
  }
} finally { clearTimeout(killer); await browser.close(); }

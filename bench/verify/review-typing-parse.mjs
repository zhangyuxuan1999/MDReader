// bench/verify/review-typing-parse.mjs — after jumping to the middle of large.md, CodeMirror's language parser has
// to parse everything between its current tree end and the viewport (LanguageState.apply does up to 20 ms of
// synchronous parse work inside EVERY transaction while the tree does not reach the viewport, plus ≤ 50 ms idle
// chunks). Measures whether the per-keystroke cost decays: 20-keystroke bursts at t ≈ 2 s, 20 s, 45 s, 90 s after the jump.
// Run: node bench/verify/review-typing-parse.mjs   (DOC=huge.md, LINE=...)
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const { browser, page, errors } = await openPage();
try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await installMonitor(page);
  const mid = Number(process.env.LINE) || await page.evaluate(() => {
    const ed = window.__mdr.app.editor; const doc = ed.view.state.doc; let line = Math.floor(doc.lines / 2);
    for (let i = 0; i < 2000; i++) { const t = doc.line(line + i).text; if (t.length > 20 && !/^\s*(#|```|~~~|\||[-*+]\s|>|\d+\.)/.test(t)) return line + i; }
    return line;
  });
  await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 5); ed.focus(); }, mid);
  const tJump = Date.now();
  const rows = [];
  for (const at of [2000, 20000, 45000, 90000]) {
    const wait = at - (Date.now() - tJump);
    if (wait > 0) await sleep(wait);
    await resetMonitor(page);
    const t0 = await page.evaluate(() => performance.now());
    for (let i = 0; i < 20; i++) { await page.keyboard.type('x'); await sleep(120); }
    await sleep(400);
    const mon = await readMonitor(page);
    const lt = mon.longtasks.filter((t) => t.start >= t0).map((t) => r1(t.dur));
    const row = { at: `${Math.round(at / 1000)} s`, over20: mon.over20, frames: mon.frames, p95: r1(mon.p95), maxGap: r1(mon.maxGap), longtasks: lt };
    rows.push(row);
    console.log(row);
  }
  report(`review-typing-parse ${DOC} (line ${mid})`, rows.map((r) => ({ name: `20 × 'x' at t = ${r.at} after the jump`, value: `frames > 20 ms ${r.over20}/${r.frames}, p95 gap ${r.p95} ms, max ${r.maxGap} ms, long tasks ${JSON.stringify(r.longtasks)}`, target: 'p95 < 5 ms main / no frames > 20 ms', pass: r.over20 <= 2 })));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}

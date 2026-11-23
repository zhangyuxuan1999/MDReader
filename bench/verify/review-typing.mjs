// bench/verify/review-typing.mjs — P5-style typing on large.md: per-keystroke main-thread task time via
// CDP Performance metrics (TaskDuration / LayoutCount / LayoutDuration deltas), keystroke→mount latency,
// frame gaps, long tasks. Run: node bench/verify/review-typing.mjs  (server must run on :5205)
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, metrics, sleep, pct, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const N = Number(process.env.N || 120);
const { browser, page, cdp, errors } = await openPage();
try {
  await cdp.send('Performance.enable');
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await installMonitor(page);

  // cursor to the middle of the document, inside a prose paragraph
  const mid = await page.evaluate(() => {
    const ed = window.__mdr.app.editor;
    const n = ed.lineCount();
    let line = Math.floor(n / 2);
    const doc = ed.view.state.doc;
    // find a non-empty line that is not a fence/heading
    for (let i = 0; i < 2000; i++) {
      const t = doc.line(line + i).text;
      if (t.length > 20 && !/^\s*(#|```|~~~|\||[-*+]\s|>|\d+\.)/.test(t)) { line = line + i; break; }
    }
    ed.gotoLine(line, 5);
    return line;
  });
  await sleep(600);
  await resetMonitor(page);

  const perKey = [];
  let m0 = await metrics(cdp);
  const chars = '这是一个测试段落 the quick brown fox 跳过了 lazy dog. '.repeat(10).slice(0, N);
  for (const ch of chars) {
    const t0 = Date.now();
    await page.keyboard.type(ch);
    // wait one animation frame so the structure/mount work of this keystroke lands before sampling
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
    const m1 = await metrics(cdp);
    perKey.push({
      task: (m1.TaskDuration - m0.TaskDuration) * 1000,
      script: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
      layout: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
      layouts: m1.LayoutCount - m0.LayoutCount,
      style: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
    });
    m0 = m1;
    const left = 200 - (Date.now() - t0);
    if (left > 0) await sleep(left);
  }
  await sleep(500);
  const mon = await readMonitor(page);
  const samples = await page.evaluate(() => window.__mdr.samples());
  const mounts = samples.filter((s) => s.name === 'mount');
  // keystroke→mount: approximate with perf overlay's method is unavailable; use mount sample ms (sanitize+replaceChildren)
  const task = perKey.map((k) => k.task), layout = perKey.map((k) => k.layout), layouts = perKey.map((k) => k.layouts);
  const results = [
    { name: `${DOC} main-thread task time per keystroke p95 (CDP TaskDuration delta, incl. frame)`, value: `${r1(pct(task, 0.95))} ms (max ${r1(Math.max(...task))}, median ${r1(pct(task, 0.5))})`, target: '< 5 ms p95 / < 10 ms max', pass: pct(task, 0.95) < 5 && Math.max(...task) < 10 },
    { name: 'layout time per keystroke p95', value: `${r1(pct(layout, 0.95))} ms (layouts/keystroke median ${pct(layouts, 0.5)}, max ${Math.max(...layouts)})`, target: 'informational', pass: true },
    { name: 'frames > 20 ms during typing', value: `${mon.over20} / ${mon.frames} (max gap ${r1(mon.maxGap)} ms)`, target: '~0', pass: mon.over20 <= 2 },
    { name: 'long tasks (> 50 ms) during typing', value: `${mon.longtasks.length} ${JSON.stringify(mon.longtasks.map((t) => r1(t.dur)))}`, target: '0', pass: mon.longtasks.length === 0 },
    { name: 'mount sample ms p95', value: `${r1(pct(mounts.map((s) => s.ms), 0.95))} ms over ${mounts.length} mounts`, target: '< 2 ms', pass: pct(mounts.map((s) => s.ms), 0.95) < 2 },
  ];
  report(`review-typing ${DOC} (cursor line ${mid})`, results);
  console.log('per-key task ms:', task.map(r1).join(' '));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}

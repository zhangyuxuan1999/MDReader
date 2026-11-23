// bench/verify/inline-verify-perf.mjs — verifier: in-preview editing performance (CONTRACT §11).
//   · large.md: session start (mousedown → previewEdit:session) < 50 ms
//   · per-keystroke main-thread work of the preview path (rAF flush = serialize + source.replace, minus
//     CodeMirror's own dispatch) p95 < 10 ms, plus input/keydown handler durations
//   · a 300-line list block: one keystroke's serialize + write
//   · medium.md: 20 table blocks edited one after another
// Run: node bench/verify/inline-verify-perf.mjs   (own vite :5263, killed at exit). Dev build (vite), so numbers
// are pessimistic vs the production bundle.
import { startServer, stopServer, openBrowser, readRoot, check, note, step, assert, finish, sleep, measure } from './inline-verify-lib.mjs';

await startServer();
const B = await openBrowser();
const { page } = B;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));

async function instrument() {
  await page.evaluate(() => {
    if (window.__perfInst) { window.__pf = { flush: [], dispatch: [], ev: [], lt: [], sess: [] }; return; }
    window.__perfInst = true;
    window.__pf = { flush: [], dispatch: [], ev: [], lt: [], sess: [] };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      if (cb.name !== 'flush') return cb(t);
      const d0 = window.__pf.dispatchSum = 0;
      const t0 = performance.now();
      try { return cb(t); } finally { window.__pf.flush.push({ total: performance.now() - t0, cm: window.__pf.dispatchSum - d0 }); }
    });
    const view = window.__mdr.app.editor.view;
    const disp = view.dispatch.bind(view);
    view.dispatch = (...a) => { const t0 = performance.now(); try { return disp(...a); } finally { const d = performance.now() - t0; window.__pf.dispatch.push(d); window.__pf.dispatchSum = (window.__pf.dispatchSum ?? 0) + d; } };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__pf.ev.push({ name: e.name, proc: e.processingEnd - e.processingStart, dur: e.duration }); }).observe({ type: 'event', durationThreshold: 16, buffered: false });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__pf.lt.push(e.duration); }).observe({ type: 'longtask' });
    // session start: mousedown (window capture, first) → previewEdit:session
    window.addEventListener('mousedown', () => { window.__pf.md = performance.now(); }, true);
    window.__mdr.app.bus.on('previewEdit:session', (x) => { if (x.id !== null && window.__pf.md) { window.__pf.sess.push(performance.now() - window.__pf.md); window.__pf.md = 0; } });
    // input handler cost (all listeners): input event capture at window → bubble end at window
    let tin = 0;
    window.addEventListener('input', () => { tin = performance.now(); }, true);
    window.addEventListener('input', () => { if (tin) window.__pf.inputH = (window.__pf.inputH ?? []).concat(performance.now() - tin); tin = 0; }, false);
  });
}
const pf = () => page.evaluate(() => window.__pf);

async function largeParagraph(line0) {
  return page.evaluate((l0) => {
    const pv = window.__mdr.app.preview; const d = window.__mdr.app.editor.view.state.doc;
    let l = l0;
    for (let i = 0; i < 400; i++) { const b = pv.blockAtLine(l); if (b.kind === 0 && d.line(b.startLine).text.includes('The quick brown fox')) return b.startLine; l = b.startLine + b.lineCount; }
    return null;
  }, line0);
}

try {
  await B.boot(process.env.MDR_DIST ? 'mode=split&perf=1' : 'mode=split');
  await instrument();

  // ------------------------------------------------------------ large.md session start + keystrokes
  await B.loadDoc(readRoot('test-data/large.md'), 'large.md');
  await sleep(1500);
  const starts = [];
  for (const l0 of [100, 20000, 50000, 80000, 100000]) {
    const line = await largeParagraph(l0);
    await instrument();
    // put the editor caret into the block first so the (separate) scroll-jump bug does not interfere
    await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(l).from } }); }, line);
    await B.clickLine(line, 'first', 'quick');
    const p = await pf();
    if (p.sess.length) starts.push(p.sess[0]);
    await B.esc();
  }
  measure('large.md session start (mousedown → session), 5 blocks', `${starts.map(f1).join(' / ')} ms, max ${f1(Math.max(...starts))}`, '< 50 ms', Math.max(...starts) < 50);

  const line = await largeParagraph(50000);
  await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(l).from } }); }, line);
  await B.clickLine(line, 'first', 'quick');
  await B.caretAt('quick');
  await instrument();
  await page.keyboard.type('abcdefghijklmnopqrstuvwxyz0123456789ABCD', { delay: 40 });
  await B.settle(400);
  let p = await pf();
  await B.esc();
  const own = p.flush.map((x) => x.total - x.cm);
  const cm = p.flush.map((x) => x.cm);
  const inH = p.inputH ?? [];
  measure('large.md per-keystroke preview work (flush − CM dispatch) p50/p95/max', `${f1(pct(own, 0.5))} / ${f1(pct(own, 0.95))} / ${f1(Math.max(...own))} ms over ${own.length} flushes`, 'p95 < 10 ms', pct(own, 0.95) < 10);
  measure('large.md CodeMirror dispatch per write p50/p95', `${f1(pct(cm, 0.5))} / ${f1(pct(cm, 0.95))} ms`, 'info (CM own cost)', true);
  measure('large.md input handlers per keystroke p95', `${f1(pct(inH, 0.95))} ms`, '< 2 ms', pct(inH, 0.95) < 2);
  measure('large.md long tasks during 40 keystrokes', `${p.lt.length} (max ${f1(Math.max(0, ...p.lt))} ms)`, '0', p.lt.length === 0);
  const slowProc = p.ev.filter((e) => e.proc > 16);
  measure('large.md events with handler processing > 16 ms during typing', `${slowProc.length} (of ${p.ev.length} events whose duration incl. next paint ≥ 16 ms; max processing ${f1(Math.max(0, ...p.ev.map((e) => e.proc)))} ms)`, '0', slowProc.length === 0);

  // ------------------------------------------------------------ 300-line list block
  const items = Array.from({ length: 300 }, (_, i) => `- 列表项 ${i + 1}：这是一段用于测试序列化性能的中文文字 **粗体** 与 \`code\``);
  const LIST = `# 大列表\n\n${items.join('\n')}\n\n尾段\n`;
  await B.loadDoc(LIST, 'list300.md');
  await instrument();
  await B.clickLine(3, 'first', '列表项 150');
  await B.caretAt('列表项 150');
  const pStart = await pf();
  await instrument();
  await page.keyboard.type('xyzxyzxyzx', { delay: 40 });
  await B.settle(400);
  p = await pf();
  const src = await B.source();
  await B.esc();
  const lt = p.flush.map((x) => x.total);
  const own2 = p.flush.map((x) => x.total - x.cm);
  measure('300-line list: session start', `${f1(pStart.sess[0])} ms`, '< 50 ms', pStart.sess[0] < 50);
  measure('300-line list: per-keystroke flush total (serialize 300 items + write) p50/p95/max', `${f1(pct(lt, 0.5))} / ${f1(pct(lt, 0.95))} / ${f1(Math.max(...lt))} ms (preview part p95 ${f1(pct(own2, 0.95))})`, 'p95 < 10 ms', pct(own2, 0.95) < 10);
  check('300-line list: only item 150 changed', src.split('\n').filter((l, i) => l !== LIST.split('\n')[i]).length === 1 && src.includes('- 列表项 150xyzxyzxyzx：'), '');

  // ------------------------------------------------------------ medium.md: 20 tables in a row
  const MED = readRoot('test-data/medium.md');
  await B.loadDoc(MED, 'medium.md');
  const tables = await page.evaluate(() => { const pv = window.__mdr.app.preview; const n = window.__mdr.app.editor.view.state.doc.lines; const o = []; let l = 1; while (l <= n && o.length < 20) { const b = pv.blockAtLine(l); if (b.kind === 3) o.push(b.startLine); l = b.startLine + b.lineCount; } return o; });
  await instrument();
  const tStarts = [], tFlush = [];
  let bad = 0;
  for (const tl of tables) {
    await page.evaluate((l) => { const v = window.__mdr.app.editor.view; v.dispatch({ selection: { anchor: v.state.doc.line(l).from } }); }, tl);
    await instrument();
    await B.clickLine(tl + 2, 'first');
    await B.caretEnd();
    await page.keyboard.type('9');
    await B.settle(150);
    const q = await pf();
    if (q.sess[0] !== undefined) tStarts.push(q.sess[0]);
    for (const f of q.flush) tFlush.push(f.total);
    await B.esc();
    const rows = (await B.source()).split('\n').slice(tl - 1, tl + 3);
    if (!rows.every((r) => r.trim().startsWith('|') && r.trim().endsWith('|'))) bad++;
  }
  measure('medium.md 20 tables: session start p95', `${f1(pct(tStarts, 0.95))} ms (n=${tStarts.length})`, '< 50 ms', pct(tStarts, 0.95) < 50);
  measure('medium.md 20 tables: flush p95', `${f1(pct(tFlush, 0.95))} ms`, '< 10 ms', pct(tFlush, 0.95) < 10);
  check(`medium.md: ${tables.length} tables edited, all still valid pipe tables`, bad === 0 && tables.length === 20, `${bad} broken`);
  const t2 = await B.tiles();
  check('medium.md: structure tiles after 20 table edits', t2.ok, JSON.stringify(t2));

  check('no console errors', B.consoleErrors.length === 0, B.consoleErrors.slice(0, 3).join(' | '));
  check('no page errors', B.pageErrors.length === 0, B.pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  check('run', false, err.stack);
} finally {
  await B.browser.close().catch(() => {});
  stopServer();
}
finish();

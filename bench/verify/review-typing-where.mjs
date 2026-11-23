// bench/verify/review-typing-where.mjs — isolates why review-typing.mjs sees 50–90 ms tasks per keystroke at the
// middle of large.md while an ASCII burst at line 3 costs < 20 ms: runs the same burst (rAF gap monitor + longtask)
// for {ASCII, CJK} × {line 3, middle}, then a CDP sampling profile of the middle/CJK case aggregated by source file.
// Run: node bench/verify/review-typing-where.mjs
import { openPage, gotoApp, loadDoc, waitIdle, installMonitor, resetMonitor, readMonitor, sleep, pct, r1, report } from './review-lib.mjs';

const DOC = process.env.DOC || 'large.md';
const N = Number(process.env.N || 40);
const CJK = '这是一个测试段落跳过了懒狗的快速棕色狐狸测试段落跳过了懒狗的快速棕色狐狸测试段落跳过了懒狗';
const { browser, page, cdp, errors } = await openPage();

async function prep(line) {
  await page.evaluate((l) => { const ed = window.__mdr.app.editor; ed.gotoLine(l, 5); ed.focus(); }, line);
  await sleep(1500); // let CodeMirror's background parser and the preview settle
  await resetMonitor(page);
}
async function burst(text) {
  const t0 = await page.evaluate(() => performance.now());
  for (const ch of text.slice(0, N)) { await page.keyboard.type(ch); await sleep(120); }
  await sleep(500);
  const mon = await readMonitor(page);
  const lt = mon.longtasks.filter((t) => t.start >= t0);
  return { over20: mon.over20, over50: mon.over50, frames: mon.frames, maxGap: r1(mon.maxGap), p95: r1(mon.p95), longtasks: lt.map((t) => r1(t.dur)) };
}

try {
  await gotoApp(page, 'mode=split');
  await loadDoc(page, DOC);
  await waitIdle(page);
  await installMonitor(page);
  const mid = await page.evaluate(() => {
    const ed = window.__mdr.app.editor; const doc = ed.view.state.doc; let line = Math.floor(doc.lines / 2);
    for (let i = 0; i < 2000; i++) { const t = doc.line(line + i).text; if (t.length > 20 && !/^\s*(#|```|~~~|\||[-*+]\s|>|\d+\.)/.test(t)) return line + i; }
    return line;
  });
  const cases = [];
  for (const [label, line] of [['line 3', 3], [`middle (line ${mid})`, mid]]) {
    for (const [kind, text] of [['ASCII', 'x'.repeat(N)], ['CJK', CJK]]) {
      await prep(line);
      const r = await burst(text);
      cases.push({ label: `${kind} ×${N} @ ${label}`, ...r });
      console.log(`${kind} @ ${label}:`, r);
    }
  }
  // profile: CJK at the middle
  await prep(mid);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  for (const ch of CJK.slice(0, N)) { await page.keyboard.type(ch); await sleep(120); }
  await sleep(300);
  const { profile } = await cdp.send('Profiler.stop');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const byFile = new Map(); const byFn = new Map(); let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); const dt = profile.timeDeltas[i] / 1000; total += dt;
    const cf = n.callFrame; const url = (cf.url || '').split('?')[0];
    const file = url.includes('node_modules') ? 'node_modules/' + url.split('node_modules/')[1].split('/').slice(0, 2).join('/') : url.split('/').slice(-2).join('/') || '(native)';
    byFile.set(file, (byFile.get(file) || 0) + dt);
    const fn = `${cf.functionName || '(anon)'} @ ${file}:${cf.lineNumber + 1}`;
    byFn.set(fn, (byFn.get(fn) || 0) + dt);
  }
  console.log(`\nprofile (CJK ×${N} @ middle): total ${r1(total)} ms; self time by file:`);
  for (const [k, v] of Array.from(byFile.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${r1(v).toString().padStart(7)} ms  ${k}`);
  console.log('top functions:');
  for (const [k, v] of Array.from(byFn.entries()).sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${r1(v).toString().padStart(7)} ms  ${k}`);
  report(`review-typing-where ${DOC}`, cases.map((c) => ({ name: c.label, value: `frames > 20 ms: ${c.over20}/${c.frames}, > 50 ms: ${c.over50}, max gap ${c.maxGap} ms, p95 gap ${c.p95} ms, long tasks ${JSON.stringify(c.longtasks)}`, target: 'no long tasks; p95 main < 5 ms', pass: c.longtasks.length === 0 && c.over20 <= 2 })));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
}

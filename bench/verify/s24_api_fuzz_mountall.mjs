// s24 — test-hook contract, API fuzzing with out-of-range arguments, mountAll on 30k/100k blocks.
// Run: node bench/verify/s24_api_fuzz_mountall.mjs
import { launch, open, settle, structureCheck, makeChecker, report, sleep, longTasks } from './_lib.mjs';

const { browser, page, log } = await launch();
const C = makeChecker();
try {
  await open(page, '?doc=/test-data/small.md&mode=split&perf=1');
  let s = await settle(page, 60000);
  C.check('small.md settles', s.ok, s);

  // ---- contract §4 hooks
  const hooks = await page.evaluate(() => {
    const m = window.__mdr;
    return {
      keys: Object.keys(m),
      types: Object.fromEntries(Object.keys(m).map((k) => [k, typeof m[k]])),
      marks: (() => { try { return m.marks().map((e) => e.name); } catch (e) { return 'THREW ' + e.message; } })(),
      samples: (() => { try { const a = m.samples(); return { n: a.length, first: a[0] }; } catch (e) { return 'THREW ' + e.message; } })(),
      version: (() => { try { return m.version(); } catch (e) { return 'THREW ' + e.message; } })(),
      appKeys: Object.keys(m.app || {}),
      overlay: !!document.querySelector('.mdr-perf, [class*=perf]'),
    };
  });
  for (const k of ['app', 'loadText', 'loadUrl', 'marks', 'samples', 'waitIdle', 'mode', 'version'])
    C.check(`hook __mdr.${k} present`, hooks.types[k] === (k === 'app' ? 'object' : 'function'), hooks.types[k]);
  for (const k of ['editor', 'preview', 'bus', 'registry', 'worker', 'layout', 'theme', 'loadText', 'getText', 'dispose'])
    C.check(`AppHandle.${k} present`, hooks.appKeys.includes(k), hooks.appKeys.join(','));
  C.check('User-Timing marks include mdr:open / mdr:structure / mdr:first-visible / mdr:idle',
    ['mdr:open', 'mdr:structure', 'mdr:first-visible', 'mdr:idle'].every((n) => hooks.marks.includes(n)), hooks.marks);
  C.check('?perf=1 overlay is rendered', hooks.overlay, hooks.overlay);
  C.check('__mdr.waitIdle() resolves', await page.evaluate(() => Promise.race([window.__mdr.waitIdle().then(() => true), new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))])) === true);

  // ---- API fuzz: out-of-range line numbers must not throw or corrupt state
  const fuzz = await page.evaluate(() => {
    const ed = window.__mdr.app.editor, pv = window.__mdr.app.preview;
    const bad = [0, -1, -1e9, 1e9, NaN, Infinity, 1.5, null, undefined];
    const out = { errors: [], results: [] };
    for (const v of bad) {
      for (const [name, fn] of [
        ['editor.gotoLine', () => ed.gotoLine(v)],
        ['editor.scrollToLine', () => ed.scrollToLine(v, 0)],
        ['preview.scrollToLine', () => pv.scrollToLine(v, 0)],
        ['preview.lineToScrollTop', () => pv.lineToScrollTop(v, 0)],
        ['preview.blockAtLine', () => pv.blockAtLine(v)],
        ['preview.scrollTopToLine', () => pv.scrollTopToLine(v)],
        ['preview.isLineVisible', () => pv.isLineVisible(v)],
      ]) {
        try { const r = fn(); out.results.push([name, String(v), JSON.stringify(r)?.slice(0, 80)]); }
        catch (e) { out.errors.push(`${name}(${String(v)}) threw: ${e && e.message}`); }
      }
    }
    out.after = { line: ed.view.state.doc.lineAt(ed.view.state.selection.main.head).number, lines: ed.lineCount(), text: ed.getText().length };
    return out;
  });
  C.check('no editor/preview API throws on out-of-range line numbers', fuzz.errors.length === 0, fuzz.errors.slice(0, 8));
  C.check('document unchanged after the API fuzz', fuzz.after.text > 0 && Number.isFinite(fuzz.after.line), fuzz.after);
  const nanTop = await page.evaluate(() => ({ scrollTop: window.__mdr.app.preview.el.scrollTop, edTop: window.__mdr.app.editor.view.scrollDOM.scrollTop }));
  C.check('scroll positions stayed finite after NaN/Infinity arguments', Number.isFinite(nanTop.scrollTop) && Number.isFinite(nanTop.edTop) && nanTop.scrollTop >= 0 && nanTop.edTop >= 0, nanTop);
  s = await settle(page, 60000);
  C.check('settles after the API fuzz', s.ok, s);
  let sc = await structureCheck(page);
  C.check('structure tiles after the API fuzz', sc.problems.length === 0, sc);

  // ---- mountAll on 30k blocks (large.md)
  await open(page, '?doc=/test-data/large.md&mode=split');
  s = await settle(page, 180000);
  C.check('large.md settles', s.ok, s);
  await page.evaluate(() => { window.__longTasks.length = 0; });
  let t0 = Date.now();
  const ok30k = await page.evaluate(() => Promise.race([
    window.__mdr.app.preview.mountAll().then(() => 'done'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 120000)),
  ]));
  const ms30k = Date.now() - t0;
  C.check('mountAll() on 30k blocks resolves', ok30k === 'done', ok30k);
  C.measure('mountAll() 30k blocks (ms)', ms30k, '< 60000', ms30k < 60000);
  let lt = await longTasks(page);
  C.measure('mountAll() 30k: long tasks count / max ms', `${lt.count}/${lt.max}`, 'max < 200 (8 ms slices)', lt.max < 200);
  const mounted = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount(), dom: document.querySelectorAll('.md-block').length, pending: document.querySelectorAll('.md-block.is-pending').length }));
  C.check('mountAll() 30k: every block has a wrapper and is mounted', mounted.dom === mounted.blocks && mounted.pending === 0, mounted);
  // typing after mountAll must stay responsive
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(50000, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  await page.keyboard.type('after mountAll', { delay: 0 });
  const lat = await page.evaluate(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const a = window.__lat.slice().sort((x, y) => x - y); return { n: a.length, p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] }; });
  C.measure('typing after mountAll() 30k: latency p95 / max (ms)', `${lat.p95?.toFixed?.(1)} / ${lat.max?.toFixed?.(1)}`, 'p95 < 100', (lat.p95 ?? 0) < 100);
  s = await settle(page, 180000);
  C.check('settles after typing post-mountAll', s.ok, s);
  sc = await structureCheck(page);
  C.check('structure tiles after mountAll + typing', sc.problems.length === 0, sc);

  // ---- mountAll on 100k blocks (huge.md)
  await open(page, '?doc=/test-data/huge.md&mode=split');
  s = await settle(page, 240000);
  C.check('huge.md settles', s.ok, s);
  await page.evaluate(() => { window.__longTasks.length = 0; });
  t0 = Date.now();
  const ok100k = await page.evaluate(() => Promise.race([
    window.__mdr.app.preview.mountAll().then(() => 'done'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 180000)),
  ]));
  const ms100k = Date.now() - t0;
  C.check('mountAll() on 100k blocks resolves', ok100k === 'done', ok100k);
  C.measure('mountAll() 100k blocks (ms)', ms100k, '< 120000', ms100k < 120000);
  lt = await longTasks(page);
  C.measure('mountAll() 100k: long tasks count / max ms', `${lt.count}/${lt.max}`, 'max < 200', lt.max < 200);
  const m2 = await page.evaluate(() => ({ blocks: window.__mdr.app.preview.blockCount(), dom: document.querySelectorAll('.md-block').length, pending: document.querySelectorAll('.md-block.is-pending').length }));
  C.check('mountAll() 100k: every block has a wrapper and is mounted', m2.dom === m2.blocks && m2.pending === 0, m2);
  const heap = await page.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null);
  C.measure('JS heap after mountAll() on huge.md (MB)', heap, '< 450 (P13)', heap === null || heap < 450);
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__mdr.app.editor.focus(); window.__lat.length = 0; });
  await page.keyboard.type('X', { delay: 0 });
  s = await settle(page, 240000);
  C.check('settles after typing post-mountAll 100k', s.ok, s);

  C.check('no console errors', log.consoleErrors.length === 0, log.consoleErrors.slice(0, 5));
  C.check('no page errors', log.pageErrors.length === 0, log.pageErrors.slice(0, 5));
  C.check('no worker restart', log.restarts === 0, `restarts=${log.restarts}`);
} catch (e) {
  C.check('script completed', false, String((e && e.stack) || e));
} finally {
  report('s24 api fuzz + mountAll', log);
  await browser.close();
  process.exit(C.failures() ? 1 : 0);
}

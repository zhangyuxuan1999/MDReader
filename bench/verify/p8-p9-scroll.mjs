// bench/verify/p8-p9-scroll.mjs — (monitor loop disabled: it starves rendering and fakes 100 ms frames)
// P8: preview wheel scrolling 20 screens (rAF gaps > 20 ms, editor
// follows within a frame); P9: editor PageDown ×100 (same, reverse). large.md, split mode.
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/large.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await sleep(500);
  const pv = await page.locator('.mdr-preview').boundingBox();
  const ed = await page.locator('.cm-scroller').boundingBox();
  const H = await page.evaluate(() => window.__mdr.app.preview.el.clientHeight);

  // ---- P8 preview wheel 20 screens, 5 ticks per screen
  await page.mouse.move(pv.x + pv.width / 2, pv.y + pv.height / 2);
  await page.evaluate(() => { window.__probeFrames(true);  window.__follow = []; });
  await resetProbe(page);
  await sleep(200);
  const t0 = await page.evaluate(() => performance.now());
  const follow = [];
  for (let s = 0; s < 20; s++) {
    for (let k = 0; k < 5; k++) { await page.mouse.wheel(0, H / 5); await sleep(16); }
    // after each screen, sample how far the editor lags, over the next few frames
    const lag = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        out.push({ p: window.__mdr.app.preview.topVisible().line, e: window.__mdr.app.editor.topVisible().line, t: performance.now() });
      }
      return out;
    });
    follow.push(lag);
  }
  await sleep(600);
  const t1 = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__probeFrames(false);  });
  let probe = await readProbe(page);
  let frames = probe.frames.filter((f) => f >= t0 && f <= t1);
  let gapsF = []; for (let i = 1; i < frames.length; i++) gapsF.push(frames[i] - frames[i - 1]);
  let slow = gapsF.filter((g) => g > 20);
  const lts8 = probe.longTasks.filter((x) => x.start >= t0 && x.start <= t1);
  const loaf8 = probe.loaf.filter((x) => x.start >= t0 && x.start <= t1);
  const st8 = await page.evaluate(() => ({ p: window.__mdr.app.preview.topVisible(), e: window.__mdr.app.editor.topVisible(), mounted: document.querySelectorAll('.md-block:not(.is-pending)').length }));
  // editor follow: frames (after settle) where |e - p| > 3 lines → count in how many frames the lag persisted
  const lagFrames = follow.map((seq) => seq.findIndex((s) => Math.abs(s.e - s.p) <= 3)).map((i) => (i < 0 ? 99 : i));
  console.log(`[P8] preview wheel 20 screens: frames ${gapsF.length}, >20 ms: ${slow.length} (${(100 * slow.length / Math.max(1, gapsF.length)).toFixed(1)} %), max gap ${fmt(max(gapsF))} ms, p95 ${fmt(pct(gapsF, 95))}`);
  console.log(`[P8] long tasks: ${lts8.map((x) => x.dur.toFixed(0)).join(',') || 'none'}; LoAF: ${loaf8.map((x) => `${x.dur.toFixed(0)}ms ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ') || 'none'}`);
  console.log(`[P8] end: preview top ${st8.p.line}, editor top ${st8.e.line}, mounted ${st8.mounted}; editor-follow frames needed per screen: ${lagFrames.join(',')}`);
  console.log(`[P8] follow detail (last screen): ${JSON.stringify(follow.at(-1).map((s) => [s.p, s.e]))}`);
  report('P8 frames > 20 ms during preview wheel', `${(100 * slow.length / Math.max(1, gapsF.length)).toFixed(1)} % (${slow.length}/${gapsF.length}, max ${fmt(max(gapsF))} ms)`, '< 3 %', slow.length / Math.max(1, gapsF.length) < 0.03);
  report('P8 editor follows within ≤ 1 frame', `worst ${max(lagFrames)} frames (per screen: ${lagFrames.join(',')})`, '≤ 1', max(lagFrames) <= 1);
  report('P8 final editor/preview top line delta', `${Math.abs(st8.p.line - st8.e.line)} lines`, '≤ 3', Math.abs(st8.p.line - st8.e.line) <= 3);

  // ---- P9 editor PageDown x100
  await page.evaluate(() => { window.__mdr.app.editor.gotoLine(1, 0); window.__mdr.app.editor.focus(); });
  await sleep(800);
  await page.mouse.move(ed.x + ed.width / 2, ed.y + ed.height / 2);
  await page.evaluate(() => { window.__probeFrames(true);  });
  await resetProbe(page);
  await sleep(200);
  const t2 = await page.evaluate(() => performance.now());
  const follow9 = [];
  for (let i = 0; i < 100; i++) {
    await page.keyboard.press('PageDown');
    await sleep(30);
    if (i % 10 === 9) {
      follow9.push(await page.evaluate(async () => { const out = []; for (let i = 0; i < 6; i++) { await new Promise((r) => requestAnimationFrame(r)); out.push({ p: window.__mdr.app.preview.topVisible().line, e: window.__mdr.app.editor.topVisible().line }); } return out; }));
    }
  }
  await sleep(600);
  const t3 = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__probeFrames(false);  });
  probe = await readProbe(page);
  frames = probe.frames.filter((f) => f >= t2 && f <= t3);
  gapsF = []; for (let i = 1; i < frames.length; i++) gapsF.push(frames[i] - frames[i - 1]);
  slow = gapsF.filter((g) => g > 20);
  const lts9 = probe.longTasks.filter((x) => x.start >= t2 && x.start <= t3);
  const st9 = await page.evaluate(() => ({ p: window.__mdr.app.preview.topVisible(), e: window.__mdr.app.editor.topVisible(), cursor: window.__mdr.app.editor.view.state.doc.lineAt(window.__mdr.app.editor.view.state.selection.main.head).number }));
  const lag9 = follow9.map((seq) => seq.findIndex((s) => Math.abs(s.e - s.p) <= 3)).map((i) => (i < 0 ? 99 : i));
  console.log(`\n[P9] editor PageDown x100: frames ${gapsF.length}, >20 ms: ${slow.length} (${(100 * slow.length / Math.max(1, gapsF.length)).toFixed(1)} %), max gap ${fmt(max(gapsF))} ms; long tasks ${lts9.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
  console.log(`[P9] end: editor top ${st9.e.line} (cursor ${st9.cursor}), preview top ${st9.p.line}; preview-follow frames per 10 PageDowns: ${lag9.join(',')}`);
  report('P9 frames > 20 ms during PageDown x100', `${(100 * slow.length / Math.max(1, gapsF.length)).toFixed(1) } % (${slow.length}/${gapsF.length}, max ${fmt(max(gapsF))} ms)`, '< 3 %', slow.length / Math.max(1, gapsF.length) < 0.03);
  report('P9 preview follows within ≤ 1 frame', `worst ${max(lag9)} frames`, '≤ 1', max(lag9) <= 1);
  report('P9 final delta', `${Math.abs(st9.p.line - st9.e.line)} lines`, '≤ 3', Math.abs(st9.p.line - st9.e.line) <= 3);
  report('P9 PageDown moved the editor', `top line ${st9.e.line}`, '> 1000', st9.e.line > 1000);
} finally {
  dumpErrors(errors);
  await browser.close();
}

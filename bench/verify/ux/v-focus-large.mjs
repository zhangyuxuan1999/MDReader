// bench/verify/ux/v-focus-large.mjs — lazy mount / eviction / remount, medium.md + large.md,
// and the layout-thrash budget over 200 preview clicks.
// Run: MDR_UX_BASE=http://localhost:5242 node bench/verify/ux/v-focus-large.mjs
import { launch, open, step, expect, check, measure, sleep, getFailures } from './lib.mjs';

const { browser, page, errors } = await launch();
const probe = () => page.evaluate(() => {
  const foci = [...document.querySelectorAll('.is-focus')];
  const peers = [...document.querySelectorAll('.cm-peerLine')];
  const view = window.__mdr.app.editor.view;
  const ln = (el) => { try { return el ? view.state.doc.lineAt(view.posAtDOM(el)).number : null; } catch { return null; } };
  return {
    focusCount: foci.length, focusTag: foci[0]?.tagName ?? null, focusText: foci[0]?.textContent?.slice(0, 26) ?? null,
    peerCount: peers.length, peerLine: ln(peers[0]),
    // CodeMirror only renders lines in its viewport, so `.cm-peerLine` can be absent while the peer line IS
    // set. `mdr-peer-active` comes from editorAttributes and is the viewport-independent truth.
    peerSet: !!view.dom.classList.contains('mdr-peer-active'),
    cmViewport: [view.state.doc.lineAt(view.viewport.from).number, view.state.doc.lineAt(view.viewport.to).number],
    previewScrollTop: document.querySelector('.mdr-preview').scrollTop,
    editorScrollTop: view.scrollDOM.scrollTop,
    mounted: document.querySelectorAll('.md-block:not(.is-pending)').length,
    blocks: window.__mdr.app.preview.blockCount(),
  };
});

// ---------------------------------------------------------------- medium.md
await open(page, '?doc=/test-data/medium.md&mode=split');
await sleep(600);
await step('medium.md: preview click far down tints exactly one element document-wide', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 40000; });
  await sleep(900);
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body .md-block:not(.is-pending) p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  expect(pos, 'no mounted paragraph in view');
  await page.mouse.click(pos.x, pos.y);
  await sleep(350);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount} of ${p.blocks} blocks`);
  expect(p.peerSet, `peer line not set (mdr-peer-active absent); DOM .cm-peerLine=${p.peerCount}`);
  return JSON.stringify({ focusCount: p.focusCount, peerSet: p.peerSet, peerLine: p.peerLine, cmViewport: p.cmViewport, mounted: p.mounted, blocks: p.blocks });
});

// ---------------------------------------------------------------- large.md lazy mount round trip
await open(page, '?doc=/test-data/large.md&mode=split');
await sleep(1200);
let targetLine = null, targetText = null;
await step('large.md: click a paragraph deep in the document', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 900000; });
  await sleep(1400);
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body .md-block:not(.is-pending) p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 150; });
    if (!el) return null;
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6, text: el.textContent.slice(0, 26) };
  });
  expect(pos, 'no mounted paragraph in view after the deep scroll');
  await page.mouse.click(pos.x, pos.y);
  await sleep(500);
  const p = await probe();
  targetLine = p.peerLine; targetText = p.focusText;
  expect(p.focusCount === 1, `.is-focus ${p.focusCount} across ${p.blocks} blocks`);
  expect(p.peerSet, `peer line not set (mdr-peer-active absent)`);
  return JSON.stringify({ focusCount: p.focusCount, peerSet: p.peerSet, peerLine: p.peerLine, cmViewport: p.cmViewport, blocks: p.blocks, text: p.focusText });
});

await step('large.md: scroll FAR away (tinted block evicted) → nothing tinted, no leftovers', async () => {
  await page.evaluate(() => { document.querySelector('.mdr-preview').scrollTop = 0; });
  await sleep(1500);
  const p = await probe();
  expect(p.focusCount <= 1, `.is-focus ${p.focusCount} after scrolling away`);
  return JSON.stringify({ focusCount: p.focusCount, peerSet: p.peerSet, tag: p.focusTag });
});

await step('large.md: scroll BACK → the tint is re-applied to the same element (lazy remount)', async () => {
  const back = await page.evaluate(() => { const sc = document.querySelector('.mdr-preview'); sc.scrollTop = 900000; return sc.scrollTop; });
  await sleep(2000);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount} after scrolling back — the tint did not survive the remount`);
  expect(p.focusText === targetText, `tint moved: ${JSON.stringify(p.focusText)} vs ${JSON.stringify(targetText)}`);
  expect(p.peerSet, `peer line lost (mdr-peer-active absent)`);
  return JSON.stringify({ focusCount: p.focusCount, text: p.focusText, peerLine: p.peerLine, want: targetLine });
});

await step('large.md: mountAll (全部渲染) keeps exactly one tint', async () => {
  const n = await page.evaluate(async () => {
    await window.__mdr.app.preview.mountAll();
    return document.querySelectorAll('.is-focus').length;
  });
  await sleep(600);
  const p = await probe();
  expect(p.focusCount === 1, `.is-focus ${p.focusCount} after mountAll (immediately: ${n})`);
  return JSON.stringify({ immediate: n, settled: p.focusCount, text: p.focusText });
});

// ---------------------------------------------------------------- layout thrash over 200 clicks
await open(page, '?doc=/test-data/large.md&mode=split');
await sleep(1200);
await step('200 preview clicks: forced reflows and long tasks', async () => {
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  const longTasks = await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(+e.duration.toFixed(1)); })
      .observe({ entryTypes: ['longtask'] });
    return true;
  });
  const before = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const targets = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.mdr-preview__body .md-block:not(.is-pending) [data-l]')]
      .filter((e) => { const r = e.getBoundingClientRect(); return r.top > 80 && r.bottom < innerHeight - 80 && r.height > 6; });
    return els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left + 10, y: r.top + Math.min(6, r.height / 2) }; });
  });
  expect(targets.length >= 4, `only ${targets.length} clickable elements in view`);
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    const t = targets[i % targets.length];
    await page.mouse.click(t.x, t.y + (i % 3));
  }
  const ms = Date.now() - t0;
  await sleep(500);
  const after = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const long = await page.evaluate(() => window.__long);
  const p = await probe();
  const layoutMs = ((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000;
  const recalcMs = ((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000;
  const layoutCount = (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0);
  const styleCount = (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0);
  expect(p.focusCount === 1, `.is-focus ${p.focusCount} after 200 clicks`);
  measure('layout count / 200 clicks', layoutCount, '< 400', layoutCount < 400);
  measure('layout ms / 200 clicks', layoutMs.toFixed(1), '< 400 ms', layoutMs < 400);
  measure('long tasks > 200 ms', long.filter((d) => d > 200).length, '0', long.filter((d) => d > 200).length === 0);
  return JSON.stringify({ clicks: 200, wallMs: ms, layoutCount, layoutMs: +layoutMs.toFixed(1), styleCount,
                          recalcMs: +recalcMs.toFixed(1), longTasks: long.length, maxLong: Math.max(0, ...long),
                          focusCount: p.focusCount, obs: longTasks });
});

// ---------------------------------------------------------------- no scroll / focus theft on large.md
await step('a preview click on large.md moves neither scroller and does not focus the editor', async () => {
  const before = await probe();
  const wasFocused = await page.evaluate(() => window.__mdr.app.editor.hasFocus());
  const pos = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.mdr-preview__body .md-block:not(.is-pending) p')].find((e) => { const r = e.getBoundingClientRect(); return r.top > 200 && r.bottom < innerHeight - 200; });
    const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 6 };
  });
  await page.mouse.click(pos.x, pos.y);
  await sleep(400);
  const after = await probe();
  const nowFocused = await page.evaluate(() => window.__mdr.app.editor.hasFocus());
  expect(Math.abs(after.previewScrollTop - before.previewScrollTop) < 2, `preview scrolled ${before.previewScrollTop}→${after.previewScrollTop}`);
  expect(Math.abs(after.editorScrollTop - before.editorScrollTop) < 2, `editor scrolled ${before.editorScrollTop}→${after.editorScrollTop}`);
  expect(!nowFocused, 'the click focused the editor');
  return JSON.stringify({ previewDelta: after.previewScrollTop - before.previewScrollTop,
                          editorDelta: after.editorScrollTop - before.editorScrollTop, wasFocused, nowFocused });
});

check('no console / page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(`failures=${getFailures()}`);
await browser.close();
process.exit(getFailures() ? 1 : 0);

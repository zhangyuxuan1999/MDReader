// bench/verify/p5-typing.mjs — P5: type 200 chars mid-document in large.md (line ≈ 50000) with
// 100 ms between keys. Measures per-keystroke main-thread busy time (event-loop monitor + LoAF),
// keystroke → block mounted latency (perf:sample 'mount'), and asserts the DOM architecture via a
// MutationObserver on .mdr-preview__body (one .md-block's children replaced, no wrapper churn).
// Then scrolls both panes to the end and reports memory (P13).
// Usage: node bench/verify/p5-typing.mjs [large|huge] [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, memory, report, dumpErrors, sleep, fmt, pct, max, mean } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 200);
const DELAY = Number(process.argv[4] ?? 100);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = Math.floor(src.length / 2);
if (which === 'large') target = 50000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
// pick a prose line whose block is a plain paragraph: previous line blank, next line blank
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;
console.log(`[p5] ${which}.md target line ${target}: "${src[target - 1].slice(0, 60)}…"`);

const { browser, page, cdp, errors } = await launch();
const measurements = [];
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await sleep(500);

  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(800);
  await waitIdle(page).catch(() => {});
  await sleep(300);
  const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), target);
  console.log(`[p5] block ${JSON.stringify(b)}`);
  const state0 = await page.evaluate((id) => {
    const el = document.querySelector(`.md-block[data-id="${id}"]`);
    el.__marker = 'orig';
    return { pending: el.classList.contains('is-pending'), text: el.textContent.slice(0, 80), children: el.children.length, editorTop: window.__mdr.app.editor.topVisible().line, previewTop: window.__mdr.app.preview.topVisible().line };
  }, b.id);
  console.log('[p5] before:', JSON.stringify(state0));

  // instrumentation: mutation observer + perf:sample tap + monitors
  await page.evaluate(() => {
    const body = document.querySelector('.mdr-preview__body');
    const rec = { mutations: [], samples: [], updates: [] };
    window.__rec = rec;
    const isBlock = (n) => n.nodeType === 1 && (n.classList.contains('md-block') || n.querySelector?.('.md-block'));
    new MutationObserver((list) => {
      const t = performance.now();
      for (const m of list) {
        const blockEl = m.target.nodeType === 1 ? m.target.closest('.md-block') : m.target.parentElement?.closest('.md-block');
        rec.mutations.push({
          t, type: m.type,
          target: m.target.nodeType === 1 ? (m.target.className || m.target.tagName) : '#text',
          blockId: blockEl?.dataset.id ?? null,
          directChildOfBlock: m.target === blockEl,
          addedBlocks: Array.from(m.addedNodes).filter(isBlock).length,
          removedBlocks: Array.from(m.removedNodes).filter(isBlock).length,
          added: m.addedNodes.length, removed: m.removedNodes.length,
          attr: m.attributeName ?? null,
        });
      }
    }).observe(body, { childList: true, subtree: true, attributes: true, characterData: true });
    window.__mdr.app.bus.on('perf:sample', (s) => rec.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
    // CM update timing: measure the dispatch cost by wrapping view.dispatch
    const view = window.__mdr.app.editor.view;
    const orig = view.dispatch.bind(view);
    view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); rec.updates.push({ t: t0, ms: performance.now() - t0 }); return r; };
    window.__probeMonitor(true);
    window.__probeFrames(true);
  });
  await resetProbe(page);
  await sleep(300);

  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  const tStart = await page.evaluate(() => performance.now());
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(600);
  const tEnd = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__probeMonitor(false); window.__probeFrames(false); });

  const probe = await readProbe(page);
  const rec = await page.evaluate(() => window.__rec);
  const after = await page.evaluate(({ id, l }) => {
    const el = document.querySelector(`.md-block[data-id="${id}"]`);
    return {
      sameEl: el?.__marker === 'orig', stale: el?.classList.contains('is-stale'), text: el?.textContent ?? '',
      line: window.__mdr.app.editor.view.state.doc.line(l).text,
      wrappers: document.querySelectorAll('.md-block').length, blocks: window.__mdr.app.preview.blockCount(),
      editorTop: window.__mdr.app.editor.topVisible().line, previewTop: window.__mdr.app.preview.topVisible().line,
    };
  }, { id: b.id, l: target });

  // ---- per keystroke analysis
  const keys = probe.keys.filter((k) => k.t >= tStart && k.t <= tEnd).map((k) => k.t);
  const gaps = probe.gaps.filter((g) => g.start >= tStart && g.end <= tEnd + 100);
  const mounts = rec.samples.filter((s) => s.name === 'mount' && s.at >= tStart);
  const perKeyWork = [], perKeyMaxGap = [], latencies = [], cmUpdate = [];
  let keysWithoutMount = 0;
  for (let i = 0; i < keys.length; i++) {
    const from = keys[i], to = i + 1 < keys.length ? keys[i + 1] : from + DELAY;
    let work = 0, mg = 0;
    for (const g of gaps) { if (g.end > from && g.start < to) { work += g.gap; mg = Math.max(mg, g.gap); } }
    perKeyWork.push(work); perKeyMaxGap.push(mg);
    const m = mounts.find((s) => s.at >= from);
    if (m && m.at < to) latencies.push(m.at - from); else keysWithoutMount++;
    const u = rec.updates.find((x) => x.t >= from && x.t < to);
    if (u) cmUpdate.push(u.ms);
  }
  const loaf = probe.loaf.filter((x) => x.start >= tStart && x.start <= tEnd);
  const lts = probe.longTasks.filter((x) => x.start >= tStart && x.start <= tEnd);
  const frames = probe.frames.filter((f) => f >= tStart && f <= tEnd);
  const frameGaps = []; for (let i = 1; i < frames.length; i++) frameGaps.push(frames[i] - frames[i - 1]);

  console.log(`\n[p5] keys=${keys.length} mounts=${mounts.length} keysWithoutMountBeforeNextKey=${keysWithoutMount}`);
  console.log(`[p5] typed text present in block: ${after.text.includes(text)}; source line ok: ${after.line.endsWith(text)}; same wrapper element: ${after.sameEl}; stale at end: ${after.stale}`);
  console.log(`[p5] blocks ${b ? '' : ''}${after.blocks} wrappers ${after.wrappers}; editorTop ${state0.editorTop}→${after.editorTop}, previewTop ${state0.previewTop}→${after.previewTop}`);
  console.log(`[p5] main busy per key: p50 ${fmt(pct(perKeyWork, 50))} p95 ${fmt(pct(perKeyWork, 95))} max ${fmt(max(perKeyWork))} ms; longest single gap per key p95 ${fmt(pct(perKeyMaxGap, 95))} max ${fmt(max(perKeyMaxGap))} ms`);
  console.log(`[p5] CM dispatch per key: p50 ${fmt(pct(cmUpdate, 50))} p95 ${fmt(pct(cmUpdate, 95))} max ${fmt(max(cmUpdate))} ms (n=${cmUpdate.length})`);
  console.log(`[p5] key→mount latency: p50 ${fmt(pct(latencies, 50))} p95 ${fmt(pct(latencies, 95))} max ${fmt(max(latencies))} ms (n=${latencies.length})`);
  console.log(`[p5] mount sample ms: p50 ${fmt(pct(mounts.map((m) => m.ms), 50))} p95 ${fmt(pct(mounts.map((m) => m.ms), 95))} max ${fmt(max(mounts.map((m) => m.ms)))}`);
  console.log(`[p5] LoAF during typing: ${loaf.length} ${loaf.slice(0, 8).map((x) => `${x.dur.toFixed(0)}ms ${x.scripts.map((s) => s.name + ':' + s.dur.toFixed(0)).join('|')}`).join('; ')}`);
  console.log(`[p5] long tasks during typing: ${lts.length} ${lts.slice(0, 8).map((x) => x.dur.toFixed(0)).join(', ')}`);
  console.log(`[p5] rAF frame gaps: n=${frameGaps.length} >20ms: ${frameGaps.filter((g) => g > 20).length} max ${fmt(max(frameGaps))}`);

  // ---- mutation analysis
  const muts = rec.mutations.filter((m) => m.t >= tStart && m.t <= tEnd + 600);
  const childList = muts.filter((m) => m.type === 'childList');
  const wrapperChurn = childList.filter((m) => m.addedBlocks || m.removedBlocks);
  const otherBlocks = new Set(childList.filter((m) => m.blockId && m.blockId !== String(b.id)).map((m) => m.blockId));
  const targetDirect = childList.filter((m) => m.blockId === String(b.id) && m.directChildOfBlock).length;
  const targetDeep = childList.filter((m) => m.blockId === String(b.id) && !m.directChildOfBlock).length;
  const noBlock = childList.filter((m) => !m.blockId);
  const attrMuts = muts.filter((m) => m.type === 'attributes');
  const attrByName = {}; for (const m of attrMuts) attrByName[`${m.attr}@${m.target}`] = (attrByName[`${m.attr}@${m.target}`] ?? 0) + 1;
  console.log(`\n[p5] mutations: total ${muts.length}, childList ${childList.length}: on target block (direct replaceChildren) ${targetDirect}, inside target ${targetDeep}, on OTHER blocks ${otherBlocks.size} [${[...otherBlocks].slice(0, 10).join(',')}], outside any block ${noBlock.length}`);
  console.log(`[p5] wrapper churn (md-block added/removed): ${wrapperChurn.length} ${wrapperChurn.slice(0, 5).map((m) => `${m.target}+${m.addedBlocks}-${m.removedBlocks}`).join('; ')}`);
  console.log(`[p5] attribute mutations: ${JSON.stringify(attrByName)}`);

  measurements.push(report('P5 main-thread busy per keystroke p95', `${fmt(pct(perKeyWork, 95))} ms`, '< 5 ms', pct(perKeyWork, 95) < 5));
  measurements.push(report('P5 main-thread busy per keystroke max', `${fmt(max(perKeyWork))} ms`, '< 10 ms', max(perKeyWork) < 10));
  measurements.push(report('P5 keystroke → block mounted p95', `${fmt(pct(latencies, 95))} ms (n=${latencies.length}/${keys.length})`, '< 40 ms', pct(latencies, 95) < 40 && latencies.length >= keys.length * 0.9));
  measurements.push(report('ARCH typing: no .md-block wrapper insert/remove', `${wrapperChurn.length}`, '0', wrapperChurn.length === 0));
  measurements.push(report('ARCH typing: childList mutations only inside the edited block', `other blocks: ${otherBlocks.size}, outside blocks: ${noBlock.length}`, '0 / 0', otherBlocks.size === 0 && noBlock.length === 0));
  measurements.push(report('ARCH typing: wrapper element identity kept', `${after.sameEl}`, 'true', after.sameEl));
  measurements.push(report('P5 text echoed in preview', `${after.text.includes(text)}`, 'true', after.text.includes(text)));

  // ---- P13: scroll to end + memory
  const memTyping = await memory(page, cdp);
  await page.evaluate(() => { const p = window.__mdr.app.preview; p.scrollToLine(window.__mdr.app.editor.lineCount(), 0); });
  await sleep(1500);
  await page.evaluate(() => { const e = window.__mdr.app.editor; e.gotoLine(e.lineCount(), 0); });
  await sleep(2500);
  const memEnd = await memory(page, cdp);
  const mountedEnd = await page.evaluate(() => ({ mounted: document.querySelectorAll('.md-block:not(.is-pending)').length, nodes: document.getElementsByTagName('*').length }));
  console.log(`\n[p13] after typing: heap ${fmt(memTyping.jsHeapUsedMB)} MB, DOM nodes ${memTyping.nodes}`);
  console.log(`[p13] after scroll to end: heap ${fmt(memEnd.jsHeapUsedMB)} MB used / ${fmt(memEnd.jsHeapTotalMB)} MB total, DOM nodes ${memEnd.nodes}, mounted ${mountedEnd.mounted}, elements ${mountedEnd.nodes}, UA-specific: ${memEnd.uaSpecificMB}`);
  measurements.push(report('P13 JS heap after load+typing+scroll-to-end', `${fmt(memEnd.jsHeapUsedMB)} MB (DOM nodes ${memEnd.nodes})`, '< 450 MB renderer', memEnd.jsHeapUsedMB < 450));
} finally {
  dumpErrors(errors);
  await browser.close();
}

// bench/verify/p6-detail.mjs — P6 with direct measurements: for a 300-line and a 5000-line ts fence
// (doc built via __mdr.loadText) type 18 chars mid-fence at 100 ms; record view.dispatch per key,
// mount ms per mount, Event Timing durations, long tasks; then poll every 50 ms (up to 15 s) until
// the typed text appears in the preview block, recording the .is-slow / children timeline so the
// giant-guard behaviour ("old content stays visible") can be checked.
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const makeDoc = (fenceLines) => {
  const paras = (n, p) => Array.from({ length: n }, (_, i) => `段落 ${p}-${i} 这是一些中文文本 with some English words, line ${i}.\n`).join('\n');
  const fence = '```ts\n' + Array.from({ length: fenceLines }, (_, i) => `export function fn${i}(a: number, b: string): string { return b + a * ${i}; } // line ${i}`).join('\n') + '\n```\n';
  return `# Fence test ${fenceLines}\n\n${paras(200, 'a')}\n${fence}\n${paras(200, 'b')}`;
};
const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  for (const n of [300]) {
    await page.goto(`${BASE}/?mode=split`);
    await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
    await page.evaluate((t) => window.__mdr.loadText(t, `fence${t.length}.md`), makeDoc(n));
    await waitFirstVisible(page, 60_000);
    await waitIdle(page);
    const fenceStart = 2 + 200 * 2 + 1;
    const line = fenceStart + Math.floor(n / 2);
    const b = await page.evaluate((l) => window.__mdr.app.preview.blockAtLine(l), line);
    await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), line);
    await sleep(800);
    const before = await page.evaluate((id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { mounted: !el.classList.contains('is-pending'), children: el.children.length, chars: el.textContent.length, pre: el.querySelector('pre')?.className }; }, b.id);
    console.log(`\n[P6 ${n}] block id ${b.id} lines ${b.lineCount} before: ${JSON.stringify(before)}`);
    await page.evaluate((id) => {
      window.__rec = { dispatch: [], events: [], samples: [], timeline: [] };
      const view = window.__mdr.app.editor.view; const orig = view.dispatch.bind(view); view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); window.__rec.dispatch.push(performance.now() - t0); return r; };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rec.events.push({ name: e.name, dur: e.duration, start: e.startTime }); }).observe({ type: 'event', durationThreshold: 16 });
      window.__mdr.app.bus.on('perf:sample', (s) => window.__rec.samples.push({ name: s.name, ms: s.ms, at: performance.now() }));
      const el = document.querySelector(`.md-block[data-id="${id}"]`);
      new MutationObserver(() => window.__rec.timeline.push({ t: performance.now(), cls: el.className, children: el.children.length })).observe(el, { attributes: true, childList: true });
    }, b.id);
    await resetProbe(page);
    const typed = ' // typed here abcdefghijklmnopqrstuvwxyz0123456789 and more text to type here ok';
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.type(typed, { delay: 100 });
    const tLast = await page.evaluate(() => performance.now());
    let appearedAt = -1;
    for (let i = 0; i < 300; i++) {
      const has = await page.evaluate(({ id, s }) => document.querySelector(`.md-block[data-id="${id}"]`)?.textContent.includes(s), { id: b.id, s: typed });
      if (has) { appearedAt = (await page.evaluate(() => performance.now())) - tLast; break; }
      await sleep(50);
    }
    const rec = await page.evaluate(() => window.__rec);
    const probe = await readProbe(page);
    const lts = probe.longTasks.filter((x) => x.start >= t0);
    const mounts = rec.samples.filter((s) => s.name === 'mount').map((s) => s.ms);
    const ev = rec.events.filter((e) => e.start >= t0 && (e.name === 'keydown' || e.name === 'input')).map((e) => e.dur);
    const after = await page.evaluate((id) => { const el = document.querySelector(`.md-block[data-id="${id}"]`); return { cls: el.className, children: el.children.length, pre: el.querySelector('pre')?.className, hl: !!el.querySelector('.hljs-keyword') }; }, b.id);
    const tl = rec.timeline.map((x) => `${(x.t - t0).toFixed(0)}:${x.cls.replace('md-block', '').trim() || '-'}/${x.children}`);
    console.log(`[P6 ${n}] dispatch p50 ${fmt(pct(rec.dispatch, 50))} p95 ${fmt(pct(rec.dispatch, 95))} max ${fmt(max(rec.dispatch))} ms (n=${rec.dispatch.length}); mount ms n=${mounts.length} p50 ${fmt(pct(mounts, 50))} p95 ${fmt(pct(mounts, 95))} max ${fmt(max(mounts))}; Event Timing ≥16: n=${ev.length} max ${fmt(max(ev))}; long tasks ${lts.map((x) => x.dur.toFixed(0)).join(',') || 'none'}`);
    console.log(`[P6 ${n}] typed text appeared ${appearedAt < 0 ? 'NEVER (15 s)' : appearedAt.toFixed(0) + ' ms after last key'}; after: ${JSON.stringify(after)}`);
    console.log(`[P6 ${n}] block mutation timeline (ms after first key: classes/children): ${tl.slice(0, 40).join('  ')}${tl.length > 40 ? ' …' + tl.length : ''}`);
    const t = n === 300 ? 8 : 16;
    report(`P6 ${n}-line fence view.dispatch p95 (synchronous main work per key)`, `${fmt(pct(rec.dispatch, 95))} ms`, `< ${t} ms`, pct(rec.dispatch, 95) < t);
    report(`P6 ${n}-line fence mount task max`, `${fmt(max(mounts))} ms`, `< ${t} ms (main p95 target)`, max(mounts) < t);
    report(`P6 ${n}-line fence dispatch+mount per key p95`, `${fmt(pct(rec.dispatch, 95) + pct(mounts, 95))} ms`, `< ${t} ms`, pct(rec.dispatch, 95) + pct(mounts, 95) < t);
    report(`P6 ${n}-line fence typed text reaches preview`, appearedAt < 0 ? 'never' : `${appearedAt.toFixed(0)} ms after last key`, n === 5000 ? '≈ 500 ms (giant guard)' : '< 100 ms', appearedAt >= 0 && appearedAt < (n === 5000 ? 1500 : 200));
  }
} finally {
  dumpErrors(errors);
  await browser.close();
}

// bench/verify/p5-burst.mjs — user-visible consequence of the per-keystroke cost measured by
// p5-trace.mjs: type N chars with a SHORT inter-key delay (fast typist / key repeat) and record
// rAF frame gaps, dropped frames and how far the echoed text lags behind the injected keys.
// Usage: node bench/verify/p5-burst.mjs [large|small] [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, readProbe, resetProbe, report, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 200);
const DELAY = Number(process.argv[4] ?? 30);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : Math.floor(src.length / 2);
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1200);
  await waitIdle(page).catch(() => {});
  await sleep(400);
  await page.evaluate(() => { window.__probeFrames(true); });
  await resetProbe(page);
  await sleep(300);
  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  const t0 = await page.evaluate(() => performance.now());
  await page.keyboard.type(text, { delay: DELAY });
  const t1 = await page.evaluate(() => performance.now());
  await sleep(1500);
  await page.evaluate(() => { window.__probeFrames(false); });
  const probe = await readProbe(page);
  const frames = probe.frames.filter((f) => f >= t0 && f <= t1 + 200);
  const gaps = []; for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const lts = probe.longTasks.filter((x) => x.start >= t0 && x.start <= t1 + 200);
  const loaf = probe.loaf.filter((x) => x.start >= t0 && x.start <= t1 + 200);
  const st = await page.evaluate(({ l, txt }) => ({
    line: window.__mdr.app.editor.view.state.doc.line(l).text.endsWith(txt),
    preview: (document.querySelector(`.md-block[data-id="${window.__mdr.app.preview.blockAtLine(l).id}"]`)?.textContent ?? '').includes(txt),
  }), { l: target, txt: text });
  const wall = t1 - t0, expected = CHARS * DELAY;
  console.log(`[burst ${which} ${CHARS}@${DELAY}ms] injection wall time ${fmt(wall)} ms (nominal ${expected} ms, ${fmt(100 * wall / expected - 100)} % over)`);
  console.log(`[burst] frames ${gaps.length}: >20 ms ${gaps.filter((g) => g > 20).length} (${(100 * gaps.filter((g) => g > 20).length / Math.max(1, gaps.length)).toFixed(1)} %), >33 ms ${gaps.filter((g) => g > 33).length}, p95 ${fmt(pct(gaps, 95))} max ${fmt(max(gaps))} ms`);
  console.log(`[burst] long tasks ${lts.length} (${lts.map((x) => x.dur.toFixed(0)).join(',')}); LoAF ${loaf.length} (${loaf.map((x) => x.dur.toFixed(0)).join(',')})`);
  console.log(`[burst] all chars in source line: ${st.line}; all chars echoed in preview: ${st.preview}`);
  report(`P5-burst ${which} ${CHARS}@${DELAY}ms frames > 20 ms`, `${(100 * gaps.filter((g) => g > 20).length / Math.max(1, gaps.length)).toFixed(1)} % (max ${fmt(max(gaps))} ms)`, '< 3 %', gaps.filter((g) => g > 20).length / Math.max(1, gaps.length) < 0.03);
  report(`P5-burst ${which} text integrity`, `source ${st.line}, preview ${st.preview}`, 'true/true', st.line && st.preview);
} finally {
  dumpErrors(errors);
  await browser.close();
}

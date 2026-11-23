// bench/verify/p5-profile.mjs — attribute per-keystroke main-thread JS time with the V8 sampling
// profiler (CDP Profiler) while typing in large.md at line ≈ 50000. Prints self-time by function.
// Usage: node bench/verify/p5-profile.mjs [large|huge] [chars] [delayMs] [line]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt, pct, max } from './common.mjs';

const which = process.argv[2] ?? 'large';
const CHARS = Number(process.argv[3] ?? 60);
const DELAY = Number(process.argv[4] ?? 100);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = Number(process.argv[5] ?? (which === 'large' ? 50000 : Math.floor(src.length / 2)));
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
if (!process.argv[5]) while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;

const { browser, page, cdp, errors } = await launch();
try {
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 90_000 });
  await waitFirstVisible(page, 90_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1000);
  // in-page timers around the pieces we can reach: view.dispatch, onChanges handlers (via bus tap not possible) -> wrap dispatch only
  await page.evaluate(() => {
    const view = window.__mdr.app.editor.view;
    const rec = (window.__rec = { dispatch: [], changesHandler: [] });
    const orig = view.dispatch.bind(view);
    view.dispatch = (...a) => { const t0 = performance.now(); const r = orig(...a); rec.dispatch.push(performance.now() - t0); return r; };
    window.__mdr.app.editor.onChanges(() => { rec.changesHandler.push(performance.now()); });
  });
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const text = Array.from({ length: CHARS }, (_, i) => (i % 7 === 6 ? ' ' : String.fromCharCode(97 + (i % 26)))).join('');
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(400);
  const { profile } = await cdp.send('Profiler.stop');
  const rec = await page.evaluate(() => window.__rec);
  console.log(`[profile ${which} line ${target}] view.dispatch per key: p50 ${fmt(pct(rec.dispatch, 50))} p95 ${fmt(pct(rec.dispatch, 95))} max ${fmt(max(rec.dispatch))} ms (n=${rec.dispatch.length})`);

  // self time per node
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas; let total = 0;
  for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const d = (dt[i] ?? 0) / 1000; total += d; self.set(n.id, (self.get(n.id) ?? 0) + d); }
  const key = (n) => { const cf = n.callFrame; const url = (cf.url || '').replace(/^.*\/node_modules\//, 'nm/').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, ''); return `${cf.functionName || '(anon)'} @ ${url}:${cf.lineNumber + 1}`; };
  const agg = new Map();
  for (const [id, ms] of self) { const n = byId.get(id); const k = key(n); agg.set(k, (agg.get(k) ?? 0) + ms); }
  // inclusive time by file (module) — walk parents
  const parent = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byFile = new Map();
  for (const [id, ms] of self) { let cur = id; const seen = new Set(); while (cur !== undefined) { const n = byId.get(cur); const f = (n.callFrame.url || '(native/' + n.callFrame.functionName + ')').replace(/^.*\/node_modules\//, 'nm/').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, ''); if (!seen.has(f)) { seen.add(f); byFile.set(f, (byFile.get(f) ?? 0) + ms); } cur = parent.get(cur); } }
  const totalMs = total;
  console.log(`[profile] total sampled ${fmt(totalMs)} ms over ${CHARS} keys → ${fmt(totalMs / CHARS)} ms/key of JS (incl. idle/gc nodes)`);
  console.log('[profile] top self-time functions (ms total / per key):');
  for (const [k, v] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`   ${fmt(v).padStart(8)}  ${fmt(v / CHARS).padStart(6)}  ${k}`);
  console.log('[profile] inclusive time by file (ms per key):');
  for (const [k, v] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${fmt(v / CHARS).padStart(6)}  ${k}`);
} finally {
  dumpErrors(errors);
  await browser.close();
}

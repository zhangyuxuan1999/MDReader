// bench/verify/r6-frb-cost.mjs — fix-refs-b (0.2.0 stage 2g, fix round 6): what rule T (fidelity.ts sanitizerKept) costs
// at a session start in Chromium, on large blocks whose source holds raw HTML (a block without `<` does not call it): a
// 300-item list with a <kbd> in every item, a 59 KB paragraph with a <br> every 40 words, a 200-row table with a <br> in
// every row. The module is imported from the dev server (its own instance, the same code); each run changes one
// character of the block so that the one-entry rendering memo does not answer. Medians of REPS runs, in milliseconds;
// the first call (the renderer is built) is reported apart.
// Run: MDR_PORT=<dev server of the tree> node bench/verify/r6-frb-cost.mjs   (REPS, default 7; T_MS, default 100000)
// Writes nothing into the tree.
import { chromium } from '@playwright/test';

const port = process.env.MDR_PORT;
if (!port) { console.log('pass MDR_PORT'); process.exit(2); }
const REPS = Number(process.env.REPS ?? 7);
const T_MS = Number(process.env.T_MS ?? 100000);
const killer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, T_MS);
const list = Array.from({ length: 300 }, (_, i) => `- item ${i} <kbd>k${i}</kbd> lorem ipsum text`).join('\n');
let p = '';
for (let i = 0; p.length < 59000; i++) p += (i % 40 === 39 ? 'lorem<br>' : 'lorem' + (i % 10)) + ' ';
const table = '| a | b |\n| --- | --- |\n' + Array.from({ length: 200 }, (_, i) => `| row ${i}<br>two | cell ${i} text |`).join('\n');
const CASES = [['list300-kbd', list], ['para59k-br', p.trim()], ['table200-br', table]];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/?perf=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 60000 });
  const res = await page.evaluate(async ([cases, reps]) => {
    const f = await import('/src/preview/fidelity.ts');
    const out = [];
    const t0 = performance.now();
    f.sanitizerKept('first <kbd>k</kbd>');
    out.push(`first call (renderer built): ${(performance.now() - t0).toFixed(1)} ms`);
    for (const [name, src] of cases) {
      const ts = [];
      let kept = true;
      for (let r = 0; r < reps; r++) {
        const s = src + ' ' + r;
        const a = performance.now();
        kept = f.sanitizerKept(s) && kept;
        ts.push(performance.now() - a);
      }
      ts.sort((x, y) => x - y);
      out.push(`COST ${name} (${src.length} chars): sanitizerKept median=${ts[Math.floor(ts.length / 2)].toFixed(1)} ms max=${ts[ts.length - 1].toFixed(1)} kept=${kept}`);
    }
    return out;
  }, [CASES, REPS]);
  for (const l of res) console.log(l);
} finally { await browser.close(); clearTimeout(killer); }

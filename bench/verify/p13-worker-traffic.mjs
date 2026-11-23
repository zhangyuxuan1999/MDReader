// bench/verify/p13-worker-traffic.mjs — how much does ONE keystroke cost in worker→main traffic?
// Wraps window.Worker before navigation and counts, per keystroke, the `structure` messages (and the
// bytes of their transferred Int32Arrays) and the `html` batches (item count + utf8 bytes).
// Usage: node bench/verify/p13-worker-traffic.mjs [large|huge] [chars] [delayMs]
import { readFileSync } from 'node:fs';
import { BASE, launch, warmUp, waitFirstVisible, waitIdle, dumpErrors, sleep, fmt } from './common.mjs';

const which = process.argv[2] ?? 'huge';
const CHARS = Number(process.argv[3] ?? 10);
const DELAY = Number(process.argv[4] ?? 200);
const src = readFileSync(new URL(`../../test-data/${which}.md`, import.meta.url), 'utf8').split('\n');
let target = which === 'large' ? 50000 : 170000;
const isProse = (l) => l.trim() && !/^[#\-*>|`$ \d<\[]/.test(l);
while (target < src.length && !(isProse(src[target - 1]) && src[target - 2] === '' && src[target] === '')) target++;
console.log(`[traffic] ${which}.md line ${target}: ${JSON.stringify(src[target - 1].slice(0, 70))}`);

const TAP = `
(() => {
  const Orig = window.Worker;
  window.__wt = { structure: 0, structBytes: 0, changed: 0, html: 0, items: 0, bytes: 0, idle: 0, events: [] };
  window.Worker = class extends Orig {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (e) => {
        const d = e.data, w = window.__wt;
        if (!d || typeof d !== 'object') return;
        if (d.type === 'structure') { w.structure++; w.structBytes += d.blocks.byteLength; w.changed += d.changed.length; w.events.push({ t: performance.now(), k: 's', n: d.changed.length, b: d.blocks.byteLength }); }
        else if (d.type === 'structureDelta') { w.structure++; w.structBytes += d.inserted.byteLength; w.changed += d.changed.length; w.events.push({ t: performance.now(), k: 'd', n: d.changed.length, b: d.inserted.byteLength }); }
        else if (d.type === 'html') { w.html++; w.items += d.batch.ids.length; w.bytes += d.batch.utf8.byteLength; w.events.push({ t: performance.now(), k: 'h', n: d.batch.ids.length, b: d.batch.utf8.byteLength }); }
        else if (d.type === 'idle') { w.idle++; w.events.push({ t: performance.now(), k: 'i', n: 0, b: 0 }); }
      });
    }
  };
})();
`;

const { browser, page, errors } = await launch();
try {
  await page.context().addInitScript(TAP);
  await warmUp(page);
  await page.goto(`${BASE}/?doc=/test-data/${which}.md&mode=split`);
  await page.waitForFunction(() => !!window.__mdr, null, { timeout: 120_000 });
  await waitFirstVisible(page, 120_000);
  await waitIdle(page);
  await page.evaluate((l) => window.__mdr.app.editor.gotoLine(l, 100000), target);
  await sleep(1500);
  await waitIdle(page).catch(() => {});
  await sleep(500);
  const before = await page.evaluate(() => ({ ...window.__wt, events: undefined }));
  await page.evaluate(() => { window.__wt.events.length = 0; });
  const t0 = await page.evaluate(() => performance.now());
  const text = Array.from({ length: CHARS }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  await page.keyboard.type(text, { delay: DELAY });
  await sleep(3000);
  const w = await page.evaluate(() => window.__wt);
  const after = { structure: w.structure - before.structure, structBytes: w.structBytes - before.structBytes, changed: w.changed - before.changed, html: w.html - before.html, items: w.items - before.items, bytes: w.bytes - before.bytes };
  console.log(`[traffic ${which}] ${CHARS} keystrokes →`);
  console.log(`   structure msgs ${after.structure} (${fmt(after.structBytes / 1048576)} MB of Int32Array, ${fmt(after.structBytes / 1048576 / Math.max(1, after.structure))} MB each), changed ids total ${after.changed} (${fmt(after.changed / Math.max(1, after.structure))} per edit)`);
  console.log(`   html batches ${after.html}, items ${after.items} (${fmt(after.items / CHARS)} blocks re-rendered per keystroke), ${fmt(after.bytes / 1048576)} MB utf8 (${fmt(after.bytes / 1048576 / CHARS)} MB per keystroke)`);
  const ev = w.events.filter((e) => e.t >= t0);
  const big = ev.filter((e) => e.k === 'h' && e.n > 50).slice(0, 10);
  console.log(`   largest html batches: ${big.map((e) => `${e.n} items/${(e.b / 1024).toFixed(0)} KB @+${(e.t - t0).toFixed(0)} ms`).join(', ') || 'none > 50 items'}`);
} finally {
  dumpErrors(errors);
  await browser.close();
}

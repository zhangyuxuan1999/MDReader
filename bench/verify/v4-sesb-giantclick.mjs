// bench/verify/v4-sesb-giantclick.mjs — verify-session-b: keystrokes lost after clicking back into a block whose
// session just ended, when that block's re-render is "giant" (worker HTML > GIANT_BYTES = 256 KB: it mounts only after
// GIANT_SETTLE_MS = 500 ms). U19 marks the released block `lost` until the re-render mounts, so the click waits as a
// click resume bounded by CLICK_WAIT_MS = 300 ms; the resume expires first and cancelResume() drops the keys typed
// meanwhile — no session, no toast, nothing written. Natural timing (no hooks). The block: a paragraph (or a list)
// with N inline formulas (a few kB of source, > 256 KB of KaTeX HTML).
// Run (candidate server up on MDR_PORT, default 5432, else started): node bench/verify/v4-sesb-giantclick.mjs [filter]
import { sleep, globalTimeout, J, check, summary, openAt, prepare, requireServer, view, pointOf, results } from './v4-sesb-lib.mjs';

const filter = process.argv[2] || '';
const CP = Number(process.env.MDR_PORT || 5432);
await requireServer(CP);
const N = Number(process.env.N || 400);
const PARA = 'MARKER start ' + Array.from({ length: N }, (_, i) => `$a_{${i}}$ and`).join(' ') + ' end.';
const LIST = '- MARKER item\n' + Array.from({ length: N / 4 }, (_, i) => `- item $b_{${i}}$ $c_{${i}}$ $d_{${i}}$ $e_{${i}}$`).join('\n');
const C = [];
for (const [kind, block] of [['para', PARA], ['list', LIST]]) {
  for (const how of ['esc', 'click-other']) {
    for (const gap of [0, 150, 1200]) C.push({ name: `${kind}-${how}-gap${gap}`, block, how, gap });
  }
}
let A = null;
const stop = globalTimeout(Number(process.env.T_MS ?? 115_000), async () => { await A?.close(); });
try {
  A = await openAt(CP, false);
  const { page } = A;
  await page.evaluate(() => { const pv = window.__mdr.app.preview; window.__sizes = []; const o = pv.applyHtml.bind(pv); pv.applyHtml = (m) => { const off = m.batch.offsets; for (let k = 0; k < off.length - 1; k++) window.__sizes.push(off[k + 1] - off[k]); return o(m); }; });
  for (const c of C) {
    if (filter && !new RegExp(filter).test(c.name)) continue;
    const doc = 'Top para.\n\n' + c.block + '\n\nEnd para.\n';
    try {
      await prepare(A, doc);
      await sleep(1500);
      const size = await page.evaluate(() => Math.max(...window.__sizes));
      const p = await pointOf(page, 'MARKER', 2); await page.mouse.click(p.x, p.y); await sleep(800);
      const v0 = await view(page);
      if (!v0.editing) throw new Error('no first session');
      if (c.how === 'esc') await page.keyboard.press('Escape');
      else { const q = await pointOf(page, 'Top para', 2); await page.mouse.click(q.x, q.y); }
      await sleep(c.gap);
      const p2 = await pointOf(page, 'MARKER', 4); await page.mouse.click(p2.x, p2.y);
      await page.keyboard.type('QRS');
      await sleep(2000);
      const v1 = await view(page);
      await page.keyboard.press('Escape'); await A.settle(300);
      const src = await A.source();
      const want = doc.replace('MARKER', 'MARKQRSER');
      check(c.name, src === want, `htmlBytes=${size} session=${!!v1.editing} written=${src.includes('QRS')} toast=${J(v1.toast)} line=${J(src.split('\n').find((l) => l.includes('MARK')).slice(0, 24))}`);
    } catch (e) { check(c.name, false, 'threw ' + String(e && e.message ? e.message : e).split('\n')[0]); }
  }
  summary();
} finally { stop(); await A?.close(); }
process.exitCode = results.fail ? 1 : 0;

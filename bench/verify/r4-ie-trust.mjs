// bench/verify/r4-ie-trust.mjs — fix-session-e (0.2.0 stage 2e): U24 as amended in a real Chromium, the candidate
// (switch off, MDR_PORT) against 0.1.1 (MDR_BASE_PORT, vite preview of release/baseline-0.1.1.noindex/dist):
//   press-<Key>-release: mouse down on a task's box, the key pressed and released while the button is held, mouse up
//     on the box (RVT-4: the key does not clear the press; 0.1.1 ticks).
//   edge-left / edge-top: a press and release on the integer pixel just left of / above the box's fractional rectangle
//     at page zoom 1.25 (OFFC-1: Chromium's hit region is larger than the rectangle); the press must go down on the box.
//   raw-in-item: a raw-HTML checkbox inside a task item (RVT-3: it ticks nothing on the candidate; 0.1.1 ticked the item).
//   own-after-raw: the same document, the own box of that item: ticked on both builds.
// Prints one line per case and build and a verdict per case: SAME, or the difference with the rule that decides it.
//   MDR_PORT=5468 MDR_BASE_PORT=5478 node bench/verify/r4-ie-trust.mjs [case ...]
// Starts no server, writes nothing into the tree; global timeout 110 s.
import { open, loadDoc, source, idle, sleep, globalTimeout } from './v5-atp-lib.mjs';

let cur = null;
globalTimeout(110_000, () => cur?.close());
const DOC = ['# trust', '', '- [ ] alpha task', '- [ ] beta task', '- [ ] victim <input type="checkbox"> raw', '- [ ] after', ''].join('\n');
const changed = (a, b) => { const x = a.split('\n'), y = b.split('\n'); const o = []; for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) o.push(`${i + 1}:${y[i]}`); return o.join(' | ') || '(unchanged)'; };
const rect = (B, k) => B.page.evaluate((k) => { const b = document.querySelectorAll('.mdr-preview input[type=checkbox]')[k]; const r = b.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; }, k);
const hitTarget = (B, x, y) => B.page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? e.tagName.toLowerCase() + (e.type ? '[' + e.type + ']' : '') : 'none'; }, [x, y]);

const CASES = {};
for (const key of ['Shift', 'Escape', 'Alt', 'a']) {
  CASES[`press-${key}-release`] = async (B) => {
    const r = await rect(B, 0);
    const x = (r.l + r.r) / 2, y = (r.t + r.b) / 2;
    await B.page.mouse.move(x, y);
    await B.page.mouse.down();
    await sleep(60);
    await B.page.keyboard.down(key);
    await B.page.keyboard.up(key);
    await sleep(60);
    await B.page.mouse.up();
    return null;
  };
}
for (const [name, at] of [['edge-left', (r) => [Math.floor(r.l), Math.round((r.t + r.b) / 2)]], ['edge-top', (r) => [Math.round((r.l + r.r) / 2), Math.floor(r.t)]]]) {
  CASES[name] = async (B) => {
    const r = await rect(B, 0);
    const [x, y] = at(r);
    const on = await hitTarget(B, x, y);
    await B.page.mouse.click(x, y);
    return `rect ${JSON.stringify(r)} point ${x},${y} hit ${on}`;
  };
}
CASES['raw-in-item'] = async (B) => {
  const r = await rect(B, 3);
  await B.page.mouse.click((r.l + r.r) / 2, (r.t + r.b) / 2);
  return null;
};
CASES['own-after-raw'] = async (B) => {
  const r = await rect(B, 2);
  await B.page.mouse.click((r.l + r.r) / 2, (r.t + r.b) / 2);
  return null;
};
const ZOOM = { 'edge-left': 1.25, 'edge-top': 1.25 };

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
const res = {};
for (const build of ['cand', 'base']) {
  for (const n of names) {
    const B = await open(build, ZOOM[n] ? { deviceScaleFactor: 1 } : {});
    cur = B;
    try {
      if (ZOOM[n]) await B.page.evaluate((z) => { document.body.style.zoom = String(z); }, ZOOM[n]);
      await loadDoc(B, DOC);
      const s0 = await source(B);
      const note = await CASES[n](B);
      await idle(B, 300);
      const d = changed(s0, await source(B));
      res[n] = { ...(res[n] || {}), [build]: d };
      console.log(build, n, '->', d, note ? `(${note})` : '');
    } catch (e) { console.log(build, n, 'ERROR', String(e).slice(0, 200)); res[n] = { ...(res[n] || {}), [build]: 'ERROR' }; } finally { await B.close(); cur = null; }
  }
}
for (const n of names) {
  const r = res[n] || {};
  const same = r.cand === r.base;
  const decided = n === 'raw-in-item' && r.cand === '(unchanged)';
  console.log('RESULT', n, same ? 'SAME' : decided ? 'DIFF decided (RVT-3: a raw checkbox in a task item ticks nothing)' : 'DIFF', JSON.stringify(r));
}
process.exit(0);

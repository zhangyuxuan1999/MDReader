// bench/verify/r3-ia-drag.mjs — fix-session-a (round 3): decision U20 against the shipped renderer. Four gestures
// that leave a block the user clicked into (a session in 0.2.0, a plain caret in 0.1.1): a forward drag, a backward
// drag, a drag across a list / formula / code block, and a Shift-click into another block; then ⌘C. The copied text
// is written to $MDR_SCRATCH/r3-ia-drag-<port>.json; when the file of the other port named by MDR_OTHER exists too,
// the two are compared case by case (PASS = byte-identical copies).
// Run: candidate  MDR_PORT=5404 node bench/verify/r3-ia-drag.mjs
//      baseline   npx vite preview --outDir release/baseline-0.1.1.noindex/dist --port 5414 --strictPort, then
//                 MDR_PORT=5414 MDR_PERF=1 MDR_OTHER=5404 node bench/verify/r3-ia-drag.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { openB, sleep, globalTimeout, J, check, summary, pointOf, loadDocAny, PORT, SCRATCH } from './v3-ses-lib.mjs';

const B = await openB({ clipboard: true });
const stop = globalTimeout(Number(process.env.T_MS ?? 110_000), B.close);
const { page } = B;
const DOC = 'First para alpha words here.\n\nSecond para beta words here.\n\nThird para gamma words here.\n\n- [ ] task one\n- [ ] task two\n\nInline $x^2$ formula here.\n\n```js\nconst code = 1;\n```\n\nLast para omega words.\n';
async function load() {
  await page.evaluate(() => { window.__mdr.app.preview.setPreviewEditable?.(true); getSelection().removeAllRanges(); });
  await loadDocAny(B, DOC); await sleep(700);
}
async function copied() {
  await page.evaluate(() => navigator.clipboard.writeText('<<none>>'));
  await page.keyboard.press('Meta+c');
  await sleep(150);
  return page.evaluate(() => navigator.clipboard.readText());
}
async function clickAt(needle, k) { const p = await pointOf(page, needle, k); await page.mouse.click(p.x, p.y); await sleep(350); }
async function drag(a, b, steps = 14) {
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await sleep(15); }
  await page.mouse.up();
  await sleep(600);                              // the released block re-renders meanwhile
}
const CASES = [
  ['drag-forward', async () => { await clickAt('beta', 1); await drag(await pointOf(page, 'beta', 2), await pointOf(page, 'gamma', 3)); }],
  ['drag-backward', async () => { await clickAt('gamma', 1); await drag(await pointOf(page, 'gamma', 2), await pointOf(page, 'alpha', 1)); }],
  ['drag-across-list-math-code', async () => { await clickAt('task one', 2); await drag(await pointOf(page, 'task one', 3), await pointOf(page, 'omega', 2)); }],
  ['shift-click-other-block', async () => {
    await clickAt('words here', 7);              // (in the first paragraph: before "ere.")
    const p = await pointOf(page, 'gamma', 2);
    await page.keyboard.down('Shift'); await page.mouse.click(p.x, p.y); await page.keyboard.up('Shift');
    await sleep(600);
  }],
];
const out = {};
try {
  await B.boot(process.env.MDR_PERF ? 'mode=split&perf=1' : 'mode=split');
  for (const [name, fn] of CASES) {
    await load();
    try { await fn(); out[name] = await copied(); } catch (e) { out[name] = 'threw ' + String(e.message).split('\n')[0]; }
    console.log(`${name}: ${J(out[name])}`);
    try { await page.keyboard.press('Escape'); await B.settle(60); } catch { /* */ }
  }
  writeFileSync(`${SCRATCH}/r3-ia-drag-${PORT}.json`, JSON.stringify(out));
  const other = process.env.MDR_OTHER ? `${SCRATCH}/r3-ia-drag-${process.env.MDR_OTHER}.json` : null;
  if (other && existsSync(other)) {
    const o = JSON.parse(readFileSync(other, 'utf8'));
    for (const [name] of CASES) check(name, o[name] === out[name], `port ${PORT}=${J(out[name])} port ${process.env.MDR_OTHER}=${J(o[name])}`);
    summary();
  }
} finally { stop(); await B.close(); }

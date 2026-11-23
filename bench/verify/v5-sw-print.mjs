// bench/verify/v5-sw-print.mjs — verify-switch (round 4 verification): what an editing session leaves on the PAGE
// (outside the preview's block content) once the switch is off again. Two candidate pages with the same document and
// the same clicks: A never had the switch on; B turned it on, used a session (typed, Enter, a formula opened, Esc), and
// turned it off. Compared: every attribute and inline style of every element outside the preview body's blocks and the
// editor's lines, document-level editing settings (queryCommandValue), designMode, the selection's place, the
// preview's and editor's scroll geometry.
//   MDR_PORT=<candidate with test hooks (dev server)> node bench/verify/v5-sw-print.mjs
// Exit 0 same, 1 different. Global timeout 110 s. Writes nothing.
import { open, loadDoc, pointOf, pointOfSel, must, clickAt, sleep, DOC_ALL, PORT } from './v5-offc-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 110_000);
const print = (B) => B.page.evaluate(() => {
  const skip = (e) => e.closest('.mdr-preview__body section.md-block') || e.closest('.cm-line') || e.closest('.mdr-toast, .mdr-toasts, [class*="toast"]');
  const out = [];
  const all = [document.documentElement, ...document.querySelectorAll('*')];
  for (const e of all) {
    if (skip(e)) continue;
    const attrs = Array.from(e.attributes).filter((a) => !['data-id'].includes(a.name)).map((a) => `${a.name}=${a.name === 'style' ? a.value.replace(/top:\s*[\d.]+px/g, 'top:N').replace(/height:\s*[\d.]+px/g, 'height:N') : a.value.slice(0, 60)}`).join(' ');
    out.push(`${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(/\s+/).filter((c) => c !== 'is-focus' && c !== 'cm-focused').join('.') : ''} ${attrs}`);
  }
  const cmds = ['defaultParagraphSeparator', 'styleWithCSS', 'insertBrOnReturn', 'enableObjectResizing', 'enableInlineTableEditing', 'useCSS'];
  const q = {};
  for (const c of cmds) { try { q[c] = String(document.queryCommandValue(c)) + '/' + String(document.queryCommandState(c)); } catch (err) { q[c] = 'ERR'; } }
  const pv = document.querySelector('.mdr-preview');
  return { els: out, q, designMode: document.designMode, pv: { sh: pv.scrollHeight, cw: pv.clientWidth, st: getComputedStyle(pv).cssText.length }, bodyStyle: document.body.getAttribute('style') };
});
let C1 = null, C2 = null;
try {
  C1 = await open(PORT, { pref: '0' });
  C2 = await open(PORT, { pref: '0' });
  for (const C of [C1, C2]) await loadDoc(C, DOC_ALL);
  // B: on, a session, off
  await C2.page.keyboard.press('Meta+Shift+KeyE'); await sleep(200);
  await clickAt(C2.page, await must(await pointOf(C2.page, 'Clickhere', 4), 'Clickhere')); await sleep(400);
  await C2.page.keyboard.type('T'); await C2.page.keyboard.press('Enter'); await sleep(500);
  await C2.page.keyboard.type('U'); await sleep(300);
  await clickAt(C2.page, await must(await pointOfSel(C2.page, '.katex', { n: 0 }), 'katex')); await sleep(500);
  await C2.page.keyboard.press('Escape'); await sleep(300);
  await C2.page.keyboard.press('Meta+Shift+KeyE'); await sleep(300);
  await loadDoc(C2, DOC_ALL);
  // the same clicks on both: a paragraph in the preview, then the editor
  for (const C of [C1, C2]) {
    await clickAt(C.page, await must(await pointOf(C.page, 'Second last', 3), 'second')); await sleep(300);
    await clickAt(C.page, await must(await pointOf(C.page, 'Heading Alpha', 2, 'left', '.cm-content'), 'editor')); await sleep(300);
    await C.idle(200);
  }
  const a = await print(C1), b = await print(C2);
  const setA = new Set(a.els), setB = new Set(b.els);
  const onlyA = a.els.filter((x) => !setB.has(x)), onlyB = b.els.filter((x) => !setA.has(x));
  let diff = 0;
  for (const k of ['q', 'designMode', 'pv', 'bodyStyle']) {
    const same = JSON.stringify(a[k]) === JSON.stringify(b[k]);
    if (!same) diff++;
    console.log(`${same ? 'SAME' : 'DIFF'}  ${k}  never-on ${JSON.stringify(a[k])}  after-session ${JSON.stringify(b[k])}`);
  }
  console.log(`${onlyA.length || onlyB.length ? 'DIFF' : 'SAME'}  elements outside the blocks: ${a.els.length} vs ${b.els.length}`);
  if (onlyA.length || onlyB.length) diff++;
  for (const x of onlyA.slice(0, 12)) console.log(`   never-on only: ${x.slice(0, 220)}`);
  for (const x of onlyB.slice(0, 12)) console.log(`   after-session only: ${x.slice(0, 220)}`);
  process.exitCode = diff ? 1 : 0;
} catch (e) {
  console.log('ERROR', String(e && e.stack || e).slice(0, 400)); process.exitCode = 2;
} finally {
  clearTimeout(KILL);
  await C1?.close(); await C2?.close();
}

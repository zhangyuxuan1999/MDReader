// bench/verify/v2-ses-undo-far.mjs — verify-session: ⌘Z inside a session whose history step lands in a block
// that is far away (an earlier edit at the top of the document, made in another session or in the editor pane).
// U1: "the session must show exactly what the source now holds: it continues … on the block containing the
// returned line". Checks: after the step, is the block with the live session (the caret) visible in the preview
// viewport? Where does the next typed character go, and can the user see it?
// Run: MDR_PORT=5282 node bench/verify/v2-ses-undo-far.mjs [preview|split]
import { openB, sleep, globalTimeout, J, check, results } from './v2-ses-lib.mjs';

const mode = process.argv[2] ?? 'split';
const B = await openB();
const stop = globalTimeout(110_000, B.close);
const { page } = B;
const N = Number(process.env.N ?? 120);
const paras = Array.from({ length: N }, (_, i) => `para${i} text here`);
const doc = paras.join('\n\n') + '\n';
const where = () => page.evaluate(() => {
  const pv = document.querySelector('.mdr-preview');
  const ed = pv.querySelector('.is-editing');
  if (!ed) return { editing: null, active: document.activeElement?.className };
  const r = ed.getBoundingClientRect(), b = pv.getBoundingClientRect();
  return { editing: ed.textContent.trim().slice(0, 30), visible: r.bottom > b.top && r.top < b.bottom, top: Math.round(r.top - b.top), pvH: Math.round(b.height), scrollTop: Math.round(pv.scrollTop) };
});
try {
  await B.boot(`mode=${mode}`);
  for (const via of ['preview-session', 'editor-pane']) {
    await B.loadDoc(doc);
    if (via === 'preview-session') {
      await B.clickLine(1, 'first', 'para0'); await B.caretAt('para0'); await page.keyboard.type('TOP'); await sleep(300); await page.keyboard.press('Escape');
    } else if (mode === 'split') {
      await page.evaluate(() => { const v = window.__mdr.app.editor.view; v.focus(); v.dispatch({ selection: { anchor: 5 } }); });
      await page.keyboard.type('TOP');
    } else continue;
    await sleep(700); await B.settle();
    const FARI = Number(process.env.FAR ?? 100);
    const far = 2 * FARI + 1;
    await B.clickLine(far, 'first', `para${FARI}`); await B.caretAt(`para${FARI}`);
    await page.keyboard.type('BOT'); await sleep(700); await B.settle();
    const before = await where();
    await page.keyboard.press('Meta+z'); await sleep(400); await B.settle();
    const s1 = await where();
    await page.keyboard.press('Meta+z'); await sleep(400); await B.settle();
    const s2 = await where();
    await page.keyboard.type('Q'); await sleep(3000); await B.settle();
    const s25 = await where();
    await page.keyboard.type('R'); await sleep(400); await B.settle();
    console.log(`  3 s later: ${J(s25)}; R in source: ${(await B.source()).includes('R')}`);
    check(`${via}: Q typed right after the far ⌘Z is in the source`, (await B.source()).includes('Q'));
    check(`${via}: 3 s after the far ⌘Z there is a live session (keyboard still works)`, !!s25.editing, J(s25));
    const src = await B.source();
    const qLine = src.split('\n').findIndex((l) => l.includes('Q')) + 1;
    const s3 = await where();
    console.log(`${via}: before ${J(before)}\n  after 1st ⌘Z ${J(s1)}\n  after 2nd ⌘Z ${J(s2)}\n  typed Q went to line ${qLine}: ${J(src.split('\n')[qLine - 1])}; ${J(s3)}`);
    check(`${via}: after the 2nd ⌘Z the live session block is on screen`, !s2.editing || s2.visible, J(s2));
    check(`${via}: TOP undone, BOT undone`, !src.includes('TOP') && !src.includes('BOT'));
    await page.keyboard.press('Escape');
  }
} finally { console.log(`${results.pass}/${results.pass + results.fail} passed; fails: ${results.fails.join(' | ')}`); stop(); await B.close(); }

// bench/verify/v4-app-redo.mjs — verify-app (0.2.0 stage 2d). A block between two blocks that MERGE once it is
// gone (two lists of the same type, two indented code blocks) is emptied in the preview (U9 deletion). Then a
// step that starts a session on the block above — Backspace in the emptied element (U18 (a) leaveGone), or
// ⌘Z + ⇧⌘Z (history resume) — and one typed character. The neighbour below must survive in the source.
// Prints RESULT lines; `lostBelow: true` means the text of the block below vanished from the source.
//   MDR_PORT=5436 node bench/verify/v4-app-redo.mjs [filter]     (MDR_RUNS=3 repeats every case)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const RUNS = Number(process.env.MDR_RUNS) || 1;
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const CASES = [
  ['lists', '- aaa\n\n乙段落文字。\n\n- zzz\n', 'zzz'],
  ['lists-quote', '- aaa\n\n> 乙引用文字\n\n- zzz\n', 'zzz'],
  ['ordered', '1. aaa\n\n乙段落文字。\n\n2. zzz\n', 'zzz'],
  ['tight-lists', '- aaa\n- bbb\n\n乙段落文字。\n\n- zzz\n- yyy\n', 'zzz'],
  ['indented-code', '    aaa code\n\n乙段落文字。\n\n    zzz code\n', 'zzz'],
  ['control-paras', 'aaa\n\n乙段落文字。\n\nzzz\n', 'zzz'],
];
const view = () => page.evaluate(() => {
  const pv = document.querySelector('.mdr-preview');
  return { editing: pv.querySelector('.is-editing')?.textContent.replace(/\s+/g, ' ').trim() ?? null, all: pv.textContent.replace(/\s+/g, ' ').trim() };
});
try {
  await B.boot('mode=split');
  for (let run = 1; run <= RUNS; run++) {
    for (const [name, doc, below] of CASES) {
      for (const act of ['backspace', 'undo-redo']) {
        const k = `${name} ${act}`;
        if (only && !k.startsWith(only)) continue;
        try {
          await page.keyboard.press('Escape');
          await B.loadDoc(doc);
          await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
          await sleep(600);
          const line = doc.split('\n').findIndex((l) => l.includes('乙')) + 1;
          await B.clickLine(line, 'first', '乙');
          await sleep(120);
          await page.evaluate(() => {
            const el = document.querySelector('.mdr-preview .is-editing');
            const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
          });
          await page.keyboard.press('Backspace');
          await B.settle(400);
          const deleted = await B.source();
          if (act === 'backspace') {
            await page.keyboard.press('Backspace'); await B.settle(400);
          } else {
            await page.keyboard.press('ControlOrMeta+z'); await B.settle(400);
            await page.keyboard.press('ControlOrMeta+Shift+z'); await B.settle(500);
          }
          const before = await B.source();
          const v = await view();
          await page.keyboard.type('Q'); await B.settle(400);
          const after = await B.source();
          out(`${k} #${run}`, { deleted, beforeQ: before, sessionShows: v.editing, afterQ: after, lostBelow: !after.includes(below) });
        } catch (e) { out(`${k} #${run}`, `ERROR ${String(e.message).split('\n')[0]}`); }
      }
    }
  }
  // Variation without an emptied block: an editor-pane insertion splits one list block in two; a session on
  // the first list, ⌘Z twice (the session's typing, then the insertion: the lists merge back), then Q.
  for (const [name, doc, ins, at, below] of [
    ['undo-merge-lists', '- aaa\n\n- zzz\n', 'mid para\n\n', '- zzz', 'zzz'],
    ['undo-merge-code', '    aaa code\n\n    zzz code\n', 'mid para\n\n', '    zzz', 'zzz'],
    ['undo-merge-control', 'aaa\n\nzzz\n', 'mid para\n\n', 'zzz', 'zzz'],
  ]) {
    for (let run = 1; run <= RUNS; run++) {
      if (only && !name.startsWith(only)) continue;
      try {
        await page.keyboard.press('Escape');
        await B.loadDoc(doc);
        await sleep(400);
        await page.evaluate(([ins, at]) => { const v = window.__mdr.app.editor.view; const pos = v.state.doc.toString().indexOf(at); v.focus(); v.dispatch({ changes: { from: pos, insert: ins }, userEvent: 'input.type' }); }, [ins, at]);
        await B.settle(900);
        await page.evaluate(() => { document.activeElement?.blur?.(); getSelection().removeAllRanges(); });
        await sleep(600);
        await B.clickLine(1, 'first', 'aaa');
        await B.caretAt('aaa');
        await page.keyboard.type('X'); await B.settle(800);
        const typed = await B.source();
        await page.keyboard.press('ControlOrMeta+z'); await B.settle(500);
        await page.keyboard.press('ControlOrMeta+z'); await B.settle(600);
        const before = await B.source();
        const v = await view();
        await page.keyboard.type('Q'); await B.settle(400);
        const after = await B.source();
        out(`${name} #${run}`, { typed, beforeQ: before, beforeIsDoc: before === doc, sessionShows: v.editing, afterQ: after, lostBelow: !after.includes(below) });
      } catch (e) { out(`${name} #${run}`, `ERROR ${String(e.message).split('\n')[0]}`); }
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}

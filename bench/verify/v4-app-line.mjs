// bench/verify/v4-app-line.mjs — verify-app (0.2.0 stage 2d). Which source line an editor command (标题 2,
// 切换任务项) acts on after the user clicked (and typed in) a line of a multi-line preview block, reached the way
// a user reaches it: the toolbar H2 button, the command palette (⌘⇧P + Enter), or Esc then the shortcut.
// Prints RESULT lines with the changed source lines and the editor's caret line.
//   Candidate:  MDR_PORT=5436 node bench/verify/v4-app-line.mjs [filter]
//   Baseline:   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-line.mjs [filter]   (no session: same gestures)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE, lineDiff } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOCS = {
  task: ['前文。', '', '- [ ] 任务甲 aaa', '- [ ] 任务乙 bbb', '- [ ] 任务丙 ccc', '', '后文。', ''].join('\n'),
  list: ['前文。', '', '- 项目甲 aaa', '- 项目乙 bbb', '- 项目丙 ccc', '', '后文。', ''].join('\n'),
  para: ['前文。', '', '第一行 aaa', '第二行 bbb', '第三行 ccc', '', '后文。', ''].join('\n'),
};
const caretLine = () => page.evaluate(() => { const v = window.__mdr.app.editor.view; return v.state.doc.lineAt(v.state.selection.main.head).number; });
const runPalette = async (title) => {
  await page.keyboard.press('ControlOrMeta+Shift+p'); await sleep(250);
  await page.keyboard.type(title); await sleep(200);
  await page.keyboard.press('Enter'); await B.settle(300);
};
const probe = async (k, fn) => { if (only && !k.startsWith(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
try {
  await B.boot('mode=split');
  out('shim', await shimBaseline(page));
  for (const [dn, doc] of Object.entries(DOCS)) {
    for (const target of ['甲', '乙']) {
      for (const how of ['click-palette', 'type-palette', 'type-toolbarH2', 'click-toolbarH2', 'click-esc-palette']) {
        if (dn !== 'task' && how.endsWith('palette') && how !== 'click-palette') continue;
        await probe(`${dn} ${target} ${how}`, async () => {
          await page.keyboard.press('Escape');
          await B.loadDoc(doc);
          await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
          await sleep(700);
          const line = doc.split('\n').findIndex((l) => l.includes(target)) + 1;
          const pt = await B.textPoint(line, 'first', target);
          await page.mouse.click(pt.x + 2, pt.y); await sleep(250);
          const session = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
          if (how.startsWith('type')) {
            if (session) { await page.keyboard.type('XY'); await sleep(50); }
          }
          if (how === 'click-esc-palette') { await page.keyboard.press('Escape'); await B.settle(200); }
          const before = await B.source();
          const cl0 = await caretLine();
          if (how.endsWith('palette')) await runPalette(dn === 'task' ? '切换任务' : '标题 2');
          else { await page.click('.mdr-toolbar button[data-cmd="edit.heading2"]'); await B.settle(300); }
          const after = await B.source();
          const d = lineDiff(before, after);
          return { session, clickedLine: line, caretBefore: cl0, changed: d.before.length || d.after.length ? { line: d.first, after: d.after } : null };
        });
      }
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}

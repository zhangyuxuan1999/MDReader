// bench/verify/v4-app-focus.mjs — verify-app (0.2.0 stage 2d). U20's selection restore (restoreKept after the
// re-render of an ended session's block) against keyboard flows that move the focus elsewhere while ending the
// session: palette, mode switch, 预览可编辑 off, TOC, theme, toolbar find, Esc then palette. After each, the
// keys typed next must reach the place the flow opened (or, with no such place, change nothing).
// Prints RESULT lines.
//   Candidate:  MDR_PORT=5436 node bench/verify/v4-app-focus.mjs [filter]
//   Baseline:   MDR_PERF=1 MDR_PORT=5446 node bench/verify/v4-app-focus.mjs [filter]   (no session: same keys)
// Needs the renderer already listening. Writes nothing into the tree.
import { openBrowser, sleep, BASE } from './v2-app-lib.mjs';
import { shimBaseline } from './v4-app-lib.mjs';

const KILL = setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(3); }, 115_000);
const only = process.argv[2] ?? '';
const B = await openBrowser();
const { page } = B;
const out = (k, v) => console.log(`RESULT ${k} = ${JSON.stringify(v)}`);
const DOC = ['# 标题', '', '甲段落文字 alpha 结尾。', '', '乙段落文字 beta 结尾。', '', '丙段落文字 gamma 结尾。', ''].join('\n');
const st = () => page.evaluate(() => {
  const a = document.activeElement;
  return {
    active: (a?.tagName ?? '') + '.' + String(a?.className ?? '').split(' ')[0],
    session: !!document.querySelector('.mdr-preview .is-editing'),
    palette: !!document.querySelector('.mdr-palette:not([hidden]) input, .mdr-palette input'),
    sel: getSelection().toString().slice(0, 20),
    mode: document.querySelector('.mdr-app, #app, body')?.dataset?.mode ?? null,
  };
});
const probe = async (k, fn) => { if (only && !k.startsWith(only)) return; try { out(k, await fn()); } catch (e) { out(k, `ERROR ${String(e.message).split('\n')[0]}`); } };
async function start(selMode) {
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await B.loadDoc(DOC);
  await page.evaluate(() => { getSelection().removeAllRanges(); document.activeElement?.blur?.(); });
  await sleep(700);
  await B.clickLine(5, 'first', '乙段');
  await sleep(150);
  const s = await page.evaluate(() => !!document.querySelector('.mdr-preview .is-editing'));
  if (s) {
    if (selMode === 'typed') { await B.caretAt('beta'); await page.keyboard.type('XY'); }
    else if (selMode === 'word') await B.selectText('beta');
    else await B.caretAt('beta');
  } else if (selMode === 'word') {
    // 0.1.1: select the same word by double click
    const pt = await B.textPoint(5, 'first', 'beta');
    await page.mouse.dblclick(pt.x + 4, pt.y);
  }
  return s;
}
const ACTIONS = {
  palette: async () => { await page.keyboard.press('ControlOrMeta+Shift+p'); },
  modeSwitch: async () => { await page.keyboard.press('ControlOrMeta+/'); },
  toggleEdit: async () => { await page.keyboard.press('ControlOrMeta+Shift+e'); },
  toc: async () => { await page.keyboard.press('ControlOrMeta+Shift+o'); },
  theme: async () => { await page.keyboard.press('ControlOrMeta+Shift+l'); },
  toolbarFind: async () => { await page.evaluate(() => window.__mdr.app.registry.run('edit.find')); },
  escPalette: async () => { await page.keyboard.press('Escape'); await sleep(30); await page.keyboard.press('ControlOrMeta+Shift+p'); },
};
try {
  await B.boot('mode=split');
  out('shim', await shimBaseline(page));
  for (const [an, act] of Object.entries(ACTIONS)) {
    for (const selMode of ['typed', 'word', 'caret']) {
      await probe(`${an} ${selMode}`, async () => {
        const s = await start(selMode);
        const before = await B.source();
        await act();
        await sleep(120);
        const t1 = await st();
        await sleep(700);   // the released block's re-render has mounted
        const t2 = await st();
        await page.keyboard.type('qz');
        await sleep(300);
        const after = await B.source();
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          return a && 'value' in a ? `input:${a.value}` : null;
        });
        const srcDelta = after === before ? null : after.split('\n').find((l, i) => l !== before.split('\n')[i]) ?? 'lines';
        // put the app back
        await page.keyboard.press('Escape'); await sleep(100);
        if (an === 'modeSwitch') { await page.evaluate(() => window.__mdr.mode('split')); }
        if (an === 'toggleEdit') { await page.keyboard.press('ControlOrMeta+Shift+e'); }
        if (an === 'toc') { await page.keyboard.press('ControlOrMeta+Shift+o'); }
        await sleep(200);
        return { s, t1: { a: t1.active, ses: t1.session, sel: t1.sel }, t2: { a: t2.active, ses: t2.session, sel: t2.sel }, typedInto: where, srcDelta };
      });
    }
  }
} finally {
  clearTimeout(KILL);
  await B.browser.close().catch(() => {});
  if (B.pageErrors.length) console.log('PAGEERRORS', B.pageErrors.slice(0, 5).join('\n'));
  console.log('BASE', BASE);
}
